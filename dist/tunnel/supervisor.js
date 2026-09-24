/**
 * Ciclo de vida do `cloudflared` — uma INSTANCIACAO de `createProcessSupervisor`.
 *
 * O que este ficheiro NAO tem: backoff, jitter, orcamento, tree-kill,
 * `AbortController` de ciclo de vida — e tudo de `src/proc/**`, partilhado byte a
 * byte com o supervisor do worker. O que ele TEM e a politica so do tunel: PROBE
 * FAIL-CLOSED como pre-condicao de `STOPPED -> STARTING` (`./probe.ts`), PIDFILE
 * (`./pidfile.ts`), TTL (`./ttl.ts`) e `argv`/spec seguros (`./args.ts`).
 *
 * Descoberta e readiness sao INJETADOS (contrato congelado, implementados por
 * T3.2). Readiness responde "a URL ja e utilizavel?" e corre DEPOIS; o probe
 * responde "o gate esta armado?" e corre ANTES — confundir as duas expos o DSH
 * real durante ~40 s. A maquina de intencoes (D29) e de T5.1; o que esta aqui e o
 * minimo para o estado observado nunca mentir: nunca `READY` sem URL, nunca `info`
 * fora de `READY`, nunca um `cloudflared` fora da contabilidade do disposer.
 */
import { readFileSync } from 'node:fs';
import { createGuardLogger } from "../logging/logger.js";
import { createProcessSupervisor, defaultSupervisorDeps, } from "../proc/supervisor.js";
import { buildCloudflaredSpec, DEFAULT_TUNNEL_BACKOFF, toTunnelFailure } from "./args.js";
import { clearTunnelProcess, recordTunnelProcess } from "./pidfile.js";
import { auditProbeDecision, runGateProbe } from "./probe.js";
import { assertValidTtlMinutes, createTtlEffects, createTunnelTtl, } from "./ttl.js";
/** Timeout do warmup. `>= 30_000` por contrato (a URL levou 6-7 s em T0.2). */
export const DEFAULT_WARMUP_TIMEOUT_MS = 60_000;
export function createTunnelSupervisor(options) {
    const { config, store } = options;
    const log = createGuardLogger(options.ctx);
    const procDeps = options.proc ?? defaultSupervisorDeps;
    const warmupTimeoutMs = options.warmupTimeoutMs ?? DEFAULT_WARMUP_TIMEOUT_MS;
    // Q-3, FAIL LOUD AT LOAD: `ttlMinutes` invalido LANCA na construcao e nao no
    // `start()` — assim `start()` continua a nunca rejeitar.
    assertValidTtlMinutes(config.ttlMinutes);
    let state = 'STOPPED';
    let info;
    let failure;
    let proc;
    let ttl;
    let warmup;
    let unlinkWarmup;
    let probeAbort;
    /** O reinicio corrente veio de um warmup falhado, e nao de uma queda. */
    let warmupFailed = false;
    /** Instante em que a JANELA abriu — nao o do ultimo `spawn`. Ver `onSpawned`. */
    let windowStartedAt = 0;
    /** `start()` em curso. Ver {@link start}: sem isto, dois sobem dois tuneis. */
    let inFlightStart;
    let disposed = false;
    const snapshot = () => ({
        state,
        // A URL so e divulgada em `READY` — o contrato torna impossivel entrega-la a
        // partir de `STARTING` ou de `DEGRADED`, e esta projeccao respeita-o.
        info: state === 'READY' ? info : undefined,
        failure,
        attempts: proc?.attempts ?? 0,
        expiresAt: state === 'READY' ? ttl?.expiresAt : undefined,
    });
    /**
     * Poe a allowlist de `Host`/`Origin` a par do estado OBSERVADO.
     *
     * A REGRA E A MESMA DE `snapshot()`, e e literalmente a mesma expressao, de
     * proposito: `READY` publica a URL, TUDO O RESTO retira-a. Escrever
     * `publish(url)` num sitio e `publish(undefined)` nos outros seis (queda,
     * `STOPPING`, `STOPPED`, `FAILED`, warmup falhado, expiracao de TTL) era
     * garantir que a proxima transicao a nascer se esquecia de um deles — e o
     * esquecimento que importa e sempre o mesmo, o de RETIRAR: uma entrada morta
     * na allowlist e um bypass silencioso, enquanto uma entrada em falta e apenas
     * um 403 visivel.
     *
     * Idempotente (o registo tambem o e), pelo que e chamada a CADA transicao sem
     * ninguem ter de saber de que estado se vinha.
     */
    const syncTunnelOrigin = () => {
        options.tunnelOrigin.publish(state === 'READY' ? info?.url : undefined);
    };
    /** Apaga o registo sem deixar uma falha de disco derrubar um disposer. */
    const forgetProcessRecord = () => {
        try {
            clearTunnelProcess(store);
        }
        catch (error) {
            log.error(`nao foi possivel apagar o registo do tunel no estado: ${error instanceof Error ? error.message : String(error)}. O boot seguinte vai varrer um pid que ja nao e nosso.`);
        }
    };
    const cancelWarmup = () => {
        // O ouvinte de abort e REMOVIDO, nao so esquecido: sao ate `maxAttempts + 1`
        // warmups no MESMO `AbortSignal`, e o `EventTarget` do Node avisa a partir do
        // decimo — ruido que treina o operador a ignorar avisos.
        unlinkWarmup?.();
        unlinkWarmup = undefined;
        warmup?.abort();
        warmup = undefined;
    };
    /** Derruba o processo e devolve o estado a `STOPPED`. Sincrono, idempotente. */
    const teardown = (reason) => {
        if (proc === undefined && state === 'STOPPED')
            return;
        state = 'STOPPING';
        log.info(`A derrubar o tunel: ${reason}`);
        cancelWarmup();
        // LIFO: o TTL foi armado DEPOIS do processo, entao e cancelado ANTES dele.
        ttl?.dispose();
        ttl = undefined;
        proc?.dispose();
        proc = undefined;
        forgetProcessRecord();
        info = undefined;
        state = 'STOPPED';
        // `STOPPING` e `STOPPED` sao os dois estados desta funcao, e nenhum deles
        // pode deixar o nome publico na allowlist.
        syncTunnelOrigin();
    };
    const ttlEffects = createTtlEffects({
        stopTunnel: () => {
            teardown('o TTL expirou');
        },
        sessions: options.sessions,
        audit: options.audit,
        notifyOwner: options.notifyOwner.bind(options),
    });
    /* -- Warmup: descoberta da URL e readiness, DEPOIS de o processo subir -- */
    const failWarmup = (detail) => {
        if (disposed || proc === undefined)
            return;
        failure = {
            code: 'READINESS_TIMEOUT',
            message: 'o tunel subiu mas nunca ficou utilizavel a tempo. A tentar de novo automaticamente; ' +
                'se persistir, verifique a ligacao a Internet desta maquina.',
            retryable: true,
        };
        state = 'DEGRADED';
        syncTunnelOrigin();
        // Reinicio POR INTENCAO pelo MESMO orcamento da queda espontanea: um processo
        // vivo e inutil consome tentativa, senao o `maxAttempts` nao conta este caso.
        warmupFailed = true;
        proc.restart(`Warmup do tunel falhou: ${detail}.`);
    };
    const beginWarmup = (handle, metricsPort, spawnedAt) => {
        const controller = new AbortController();
        warmup = controller;
        // O sinal do ciclo de vida aborta o warmup: sem isto, o polling esperava o
        // deadline inteiro por uma URL que ja nao vai chegar.
        const onLifecycleAbort = () => controller.abort();
        const lifecycle = proc?.signal;
        lifecycle?.addEventListener('abort', onLifecycleAbort, { once: true });
        unlinkWarmup = () => lifecycle?.removeEventListener('abort', onLifecycleAbort);
        void (async () => {
            try {
                /**
                 * >>> QUEM DRENA O `stderr` NAO E ESTA CHAMADA. <<<
                 *
                 * `discover()` e LEITOR OPORTUNISTA por desenho (ver
                 * `createStderrScanner` em `./discover.ts`): acrescenta e remove so o
                 * listener dele, e o `dispose()` NAO faz `resume()` de proposito —
                 * faze-lo descartava em silencio o log de arranque que este supervisor
                 * quer registar.
                 *
                 * O consumidor DURAVEL — o logger com `redact()` de
                 * `../proc/stream-log.ts` — e ligado por `createProcessSupervisor` no
                 * `spawn`, ANTES de `onSpawned` (e portanto antes desta chamada), e so e
                 * desligado na terminacao do processo. A ordem esta escrita la, e ha
                 * teste que a falsifica nos dois lados.
                 *
                 * O MODO DE FALHA SE NINGUEM DRENAR, medido nesta arvore: um filho que
                 * escreve em `stderr` sem leitor para de progredir depois de 190 464
                 * bytes (o buffer do pipe do SO, 64 KiB por omissao no Linux, mais a
                 * fila interna do Node). Para o `cloudflared`, que escreve em Go direto
                 * no descritor, o tecto e o buffer do pipe — e o efeito e um tunel que
                 * CONGELA no `write`, sem erro, sem log e sem sinal nenhum.
                 *
                 * UMA `discover()` POR PROCESSO SPAWNADO, e nao por tunel: ela nao e
                 * reentrante, e um retry e processo NOVO com `stderr` NOVO. E o que este
                 * caminho garante — `beginWarmup` so e chamado de `onSpawned`, uma vez
                 * por `spawn`, com o `handle` desse `spawn`; o warmup anterior ja foi
                 * abortado por `cancelWarmup()` em `onTerminated`.
                 */
                const discovered = await options.discovery.discover({
                    metricsPort,
                    // `stderr`, nao `stdout`: medido, o `cloudflared` deixa `stdout` com
                    // ZERO bytes e escreve o banner da URL em `stderr`.
                    stderr: handle.stderr ?? null,
                    signal: controller.signal,
                    timeoutMs: warmupTimeoutMs,
                });
                const outcome = await options.readiness.waitUntilUsable({
                    url: discovered.url,
                    signal: controller.signal,
                    timeoutMs: warmupTimeoutMs,
                });
                if (controller.signal.aborted || disposed)
                    return;
                if (!outcome.usable) {
                    failWarmup(`a URL respondeu ${String(outcome.status)} e nao ficou utilizavel`);
                    return;
                }
                info = { url: discovered.url, startedAt: spawnedAt, mode: config.mode };
                failure = undefined;
                state = 'READY';
                // A ENTRADA NA ALLOWLIST, e o unico sitio que a faz. So depois de a URL
                // existir E de a readiness ter passado: publicar em `STARTING` abria o
                // nome publico antes de haver o que servir por ele.
                syncTunnelOrigin();
                log.info(`Tunel pronto (URL obtida via ${discovered.via}).`);
            }
            catch (error) {
                if (controller.signal.aborted || disposed)
                    return;
                failWarmup(error instanceof Error ? error.message : String(error));
            }
        })();
    };
    /* -- Camada 1 do `redact()`: os literais que nenhuma FORMA adivinha ---- */
    /**
     * >>> O `cloudflared` CORRIA COM `secrets: []`. ESTA E A CORRECCAO. <<<
     *
     * `SECRET_SHAPES` (`../logging/redact.ts`) cobre `*.trycloudflare.com`, ou
     * seja o modo `quick` — o unico cujo dominio se conhece a priori. Em
     * `mode: 'named'` nao ha forma nenhuma a que agarrar:
     *
     *   - o HOSTNAME e o dominio do PROPRIO DONO. Nenhuma regex o adivinha, e ele
     *     so passa a existir depois de a descoberta correr;
     *   - o TOKEN e o pior caso. Nos entregamo-lo por `--token-file` precisamente
     *     para ele nao viver em `argv` (TUN-014, legivel em `/proc/<pid>/cmdline`
     *     e no `ps`) — e depois nao o davamos a camada literal do `redact()`.
     *     Bastava o `cloudflared` ecoa-lo em `stderr`, por um erro de parsing ou
     *     um aviso de expiracao, para ele ir INTEIRO para o log do operador.
     *
     * A URL DO QUICK TUNNEL NAO ENTRA AQUI, e a ausencia e deliberada:
     * `02-SEGURANCA.md` 2.2 mediu que ela NAO e segredo (uma amostragem publica
     * devolveu dezenas de hostnames vivos), e a forma em `SECRET_SHAPES` ja a
     * corta no log. Duplica-la na camada literal so tirava legibilidade.
     */
    let namedTunnelToken;
    /**
     * Rele o token do disco. Chamado de `buildSpec`, ou seja UMA VEZ POR
     * TENTATIVA de spawn — e nao uma vez no arranque.
     *
     * PORQUE POR TENTATIVA, e nao por linha de log: o segredo que interessa
     * redigir e o que o processo VIVO recebeu. Um token rodado no disco so passa a
     * ser o token do `cloudflared` no spawn seguinte, e e exatamente ai que esta
     * leitura acontece. Reler a cada chunk de `stderr` seria um `read(2)` por
     * linha para nunca mudar de resposta dentro da vida do processo.
     */
    const refreshNamedTunnelToken = () => {
        namedTunnelToken = undefined;
        if (config.mode !== 'named')
            return;
        const file = config.tokenFile?.trim();
        if (file === undefined || file.length === 0)
            return;
        try {
            const conteudo = readFileSync(file, 'utf8').trim();
            if (conteudo.length > 0)
                namedTunnelToken = conteudo;
        }
        catch (error) {
            // NAO se transforma isto em falha de arranque. `buildCloudflaredArgv` ja
            // recusa `named` sem `tokenFile` com uma mensagem accionavel, e o spawn
            // falha com o seu proprio diagnostico. Lancar daqui trocava uma falha
            // legivel por uma excecao vinda de dentro do redator de logs — e o redator
            // de logs e a ultima coisa que pode derrubar o supervisor.
            log.debug(`nao foi possivel ler o token do named tunnel para o redator de logs: ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    /** Ver {@link refreshNamedTunnelToken}. Avaliado a CADA linha encaminhada. */
    const tunnelSecrets = () => {
        const literais = [];
        if (namedTunnelToken !== undefined)
            literais.push(namedTunnelToken);
        // O hostname so existe depois de `READY`, e e por isso que isto e um
        // fornecedor: uma lista capturada no `spawn` nunca o teria.
        if (config.mode === 'named' && info !== undefined) {
            literais.push(info.url);
            // `URL.parse` e nao `new URL`: uma URL malformada vinda da descoberta
            // devolve `null` em vez de LANCAR. Um `throw` daqui calava o log inteiro,
            // e o redator de logs e a ultima coisa que pode derrubar o supervisor.
            const host = URL.parse(info.url)?.host;
            if (host !== undefined && host.length > 0)
                literais.push(host);
        }
        return literais;
    };
    /* -- O processo -------------------------------------------------------- */
    const createProcess = () => {
        // A porta e escolhida UMA vez por janela de tunel: mudar de porta entre
        // reinicios deixaria a descoberta a ler o servidor de metricas anterior.
        const metricsPort = options.allocateMetricsPort();
        return createProcessSupervisor(options.ctx, {
            name: 'cloudflared',
            backoff: config.backoff ?? DEFAULT_TUNNEL_BACKOFF,
            secrets: tunnelSecrets,
            buildSpec: (signal) => {
                // O token e relido AQUI, no instante do uso e a cada tentativa, pela
                // mesma doutrina que ja governa a posse da origem duas linhas abaixo.
                refreshNamedTunnelToken();
                return buildCloudflaredSpec({
                    config,
                    metricsPort,
                    // Posse da origem verificada NO INSTANTE DO USO, a cada tentativa.
                    origin: options.resolveOrigin(),
                    signal,
                });
            },
            onSpawned: (handle) => {
                /**
                 * >>> O `startedAt` NAO DESLIZA COM O REINICIO. <<<
                 *
                 * Este gancho corre em TODOS os spawns. Gravar `now()` aqui — e re-armar
                 * o TTL dele — dava prazo NOVO a cada queda: medido, uma queda aos 59 min
                 * empurrava o prazo de 3601000 para 7141000, e 10 ciclos com uptime
                 * saudavel (o orcamento zera, o ciclo nunca esgota) davam +9,83 h. Um
                 * `cloudflared` que reinicia de hora a hora tinha TTL INFINITO — a ameaca
                 * T10 do `./ttl.ts`, e era fechar o `renew()` na API e deixa-lo aberto no
                 * ciclo de vida do processo. Muda o `pid`, e so ele.
                 */
                recordTunnelProcess(store, {
                    pid: handle.pid,
                    startedAt: windowStartedAt,
                    mode: config.mode,
                });
                beginWarmup(handle, metricsPort, windowStartedAt);
            },
            onTerminated: (event) => {
                cancelWarmup();
                info = undefined;
                // ANTES do `return` de `!willRetry`: o processo morreu, logo a URL
                // deixou de valer — haja ou nao reinicio a seguir.
                syncTunnelOrigin();
                if (!event.willRetry)
                    return;
                state = 'DEGRADED';
                // A causa PRECISA sobrevive a generica: quando o reinicio veio de um
                // warmup falhado, `READINESS_TIMEOUT` diz o que aconteceu e
                // `PROCESS_EXITED` diria uma coisa que nao aconteceu.
                if (warmupFailed) {
                    warmupFailed = false;
                    return;
                }
                failure = {
                    code: 'PROCESS_EXITED',
                    message: 'o tunel caiu e vai ser reiniciado automaticamente.',
                    retryable: true,
                };
            },
            onFailed: (processFailure) => {
                state = 'FAILED';
                syncTunnelOrigin();
                failure = toTunnelFailure(processFailure);
                forgetProcessRecord();
                ttl?.dispose();
                ttl = undefined;
                options.notifyOwner(failure.message);
            },
        }, procDeps);
    };
    /* -- start(): o probe primeiro, o spawn depois ------------------------- */
    const runStart = async () => {
        /**
         * >>> O PROBE CORRE AQUI, ANTES DE EXISTIR QUALQUER `spawn`. <<<
         *
         * Se corresse depois nao seria fail-closed: a janela de exposicao ja estaria
         * aberta e o controlo seria um relatorio em vez de um portao. O controlador e
         * proprio do probe, para o disposer poder aborta-lo a meio.
         */
        probeAbort = new AbortController();
        const result = await runGateProbe({
            transport: options.probe.transport,
            canaryToken: options.probe.newCanaryToken(),
            signal: probeAbort.signal,
            apiReadPath: options.probe.apiReadPath,
        });
        // O `await` acima e um ponto de suspensao: o disposer pode ter corrido entre
        // o inicio do probe e esta linha, e sem esta leitura um plugin ja descarregado
        // ainda spawnava o tunel.
        if (disposed)
            return snapshot();
        try {
            auditProbeDecision(options.audit, result);
        }
        catch (error) {
            // Nao consigo registar a decisao => nao subo (ver `auditProbeDecision`).
            failure = {
                code: 'PROBE_FAILED',
                message: 'o tunel NAO subiu: nao foi possivel registar em auditoria a verificacao do portao. ' +
                    'Sem registo nao ha prova de que a verificacao aconteceu, e sem prova o tunel nao abre.',
                retryable: false,
            };
            state = 'FAILED';
            syncTunnelOrigin();
            log.error(`Auditoria do probe falhou: ${error instanceof Error ? error.message : String(error)}`);
            options.notifyOwner(failure.message);
            return snapshot();
        }
        if (!result.passed) {
            // `STOPPED -> FAILED`, SEM passar por `STARTING`: nunca houve processo.
            failure = result.failure;
            state = 'FAILED';
            syncTunnelOrigin();
            log.error(`Probe fail-closed reprovou; o tunel NAO sobe. ${failure?.message ?? ''}`);
            if (failure !== undefined)
                options.notifyOwner(failure.message);
            return snapshot();
        }
        // REDE DE SEGURANCA: nenhum caminho substitui `proc`, `ttl` ou o registo em
        // disco sem LIBERTAR o anterior — sobrepor a variavel deixava um `cloudflared`
        // vivo que nem o disposer nem a varredura de boot alcancavam.
        if (proc !== undefined || ttl !== undefined) {
            teardown('havia um tunel anterior por libertar antes de abrir janela nova');
        }
        failure = undefined;
        state = 'STARTING';
        syncTunnelOrigin();
        // A JANELA abre AQUI, e uma so vez. E este instante que vai para o disco e
        // que arma o TTL; os spawns seguintes herdam-no em vez de o renovar.
        windowStartedAt = procDeps.now();
        ttl = createTunnelTtl({
            ttlMinutes: config.ttlMinutes,
            scheduler: procDeps.scheduler,
            now: procDeps.now,
            effects: ttlEffects,
            log,
        });
        ttl.arm(windowStartedAt);
        proc = createProcess();
        proc.start();
        return snapshot();
    };
    /**
     * A INTENCAO E MARCADA ANTES DO `await` — dai uma promessa em curso, e nao uma
     * bandeira lida no topo. A guarda de estado sozinha NAO serve: e lida antes do
     * `await` do probe e o estado so muda depois dele.
     *
     * MEDIDO antes desta correccao: dois `start()` no mesmo tick faziam 2 spawns
     * (`pids [6001, 6002]`) e o segundo sobrescrevia `proc`, `ttl` e o pidfile do
     * primeiro sem os libertar — `state.json` com 6002, kills apos `dispose()` so
     * `[[-6002]]`, 1 temporizador de TTL orfao a derrubar o tunel errado. O 6001
     * ficava publico e fora do alcance de TODO controlo: do disposer (so conhece o
     * `proc` corrente), da varredura de boot (so le o registo sobrescrito) e do TTL.
     * A exposicao de ~40 s do incidente original, mas permanente e invisivel.
     */
    const start = () => {
        if (disposed)
            return Promise.resolve(snapshot());
        if (inFlightStart !== undefined)
            return inFlightStart;
        if (state !== 'STOPPED' && state !== 'FAILED')
            return Promise.resolve(snapshot());
        const running = runStart().finally(() => {
            inFlightStart = undefined;
        });
        inFlightStart = running;
        return running;
    };
    return {
        start,
        stop: () => {
            teardown('paragem pedida');
        },
        dispose: () => {
            if (disposed)
                return;
            disposed = true;
            probeAbort?.abort();
            teardown('o plugin esta a ser descarregado');
        },
        snapshot,
    };
}
//# sourceMappingURL=supervisor.js.map