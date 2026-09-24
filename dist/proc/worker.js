/**
 * `createWorkerSupervisor` -- o worker de long-polling do Telegram, expresso como
 * UMA INSTANCIACAO de `createProcessSupervisor`.
 *
 * O QUE ESTE FICHEIRO NAO TEM, e essa e a prova de que a generalizacao e real:
 * nada de ciclo de vida. Backoff com jitter, orcamento em janela deslizante,
 * `AbortController` unico, tree-kill do grupo, disposer sincrono LIFO e evento
 * terminal unico vivem em `./supervisor.ts` e sao partilhados com o supervisor
 * do `cloudflared`. Aqui esta SO o que distingue o worker de qualquer outro
 * processo longo: o `argv`, o `cwd`, o `stdio`, o ambiente -- e, desde a Onda 4,
 * o CANAL.
 *
 * O ficheiro cresceu nesta onda (de ~90 para ~225 linhas) e a razao esta toda
 * numa frase: o worker passou a ser o unico processo do repositorio com um
 * PROTOCOLO. `stdin` passou de `'ignore'` a `'pipe'`, e com isso vieram o
 * sentido host -> worker (`send`), o decisor de intencoes e o dead-man's switch.
 * O `cloudflared` nao tem nada disto e continua a nao ter -- pelo que a
 * alternativa (empurrar o canal para a superficie generica) tornaria a
 * generalizacao MENOS real, nao mais.
 *
 * `src/proc/supervisor.ts` reexporta este simbolo, e nao ao contrario: quem
 * importava `createWorkerSupervisor` de la (`src/index.ts`) continua a compilar
 * sem tocar em nada.
 */
import { PACKAGED_WORKER_ENTRYPOINT, resolveWorkerCwd, } from "../config/schema.js";
import { IPC_PROTOCOL_VERSION } from "../contracts/ipc.js";
import { createGuardLogger } from "../logging/logger.js";
import { createHostIpcChannel } from "../ipc/channel.js";
import { buildWorkerEnv, DEFAULT_PROVIDER } from "./env.js";
import { createProcessSupervisor, defaultSupervisorDeps, } from "./supervisor.js";
/**
 * Resposta do canal quando NENHUM controlador esta montado.
 *
 * A maquina de controlo (transicoes legais, nonce, TTL) e da Onda 5. Ate la a
 * unica resposta honesta e `INTERNAL`: e o codigo do vocabulario fechado cuja
 * `message` "nao pode denunciar topologia", e responder e obrigatorio -- calar
 * seria deixar o dono a olhar para uma barra de progresso que nunca acaba.
 */
function rejeitarSemControlador(log, intent) {
    log.warn(`Intencao '${intent.intent}' recebida sem controlador montado; respondida com INTERNAL.`);
    return {
        v: IPC_PROTOCOL_VERSION,
        type: 'error',
        requestId: intent.requestId,
        code: 'INTERNAL',
        message: 'Este comando ainda nao esta disponivel nesta instalacao.',
    };
}
/**
 * Resposta do canal quando NENHUM tratador de nonce esta montado (EMENDA-
 * COSTURA-5). Fail-closed: sem nonce nao ha confirmacao, e sem confirmacao
 * nao ha intent que aumente exposicao (CTL-023).
 */
function rejeitarSemNonce(log, request) {
    log.warn(`Pedido de nonce (${request.acao}) recebido sem tratador montado; respondido com INTERNAL.`);
    return {
        v: IPC_PROTOCOL_VERSION,
        type: 'error',
        requestId: request.requestId,
        code: 'INTERNAL',
        message: 'Este comando ainda nao esta disponivel nesta instalacao.',
    };
}
/** Cria o supervisor do processo filho do worker do Telegram. */
export function createWorkerSupervisor(ctx, config, deps = defaultSupervisorDeps, options = {}) {
    const { worker } = config;
    const log = createGuardLogger(ctx);
    /**
     * O token do bot: o da costura (`options.token`, resolvido de
     * `config.worker.token`/`secrets.env`) ou o do proprio `config` quando
     * aquele e omitido (os testes, por exemplo). Uma so fonte para o segredo,
     * o env do filho E a mascara de logs.
     *
     * `let` e NAO `const` de proposito: a rota POST /__guard-ui/api/token grava
     * um token novo em `secrets.env` e chama {@link WorkerSupervisor.definirToken}
     * + `restart()`. O `buildSpec` e a `secrets()` fecham sobre ESTA variavel, e
     * o `definirToken` repinta-a para o proximo spawn usar o valor novo.
     */
    let tokenDoBot = options.token ?? worker.token;
    /**
     * O provedor ATIVO do worker: o da costura (`options.provider`, resolvido de
     * `config.worker.provider`) ou o default fechado `telegram` quando aquele e
     * omitido. Rotula o env do filho (`DSH_GUARD_PROVIDER`) e escolhe o
     * `tokenVar` de destino do token.
     */
    const providerDoBot = options.provider ?? DEFAULT_PROVIDER;
    /**
     * FORNECEDOR de segredos, PARTILHADO pelo encaminhamento de log do filho e
     * pelo canal IPC.
     *
     * Uma so definicao de proposito: enquanto o `attachStreamLogging` tinha
     * `redact()` e o canal nao, o MESMO token do bot saia mascarado quando era o
     * filho a imprimi-lo e EM CLARO quando era o host a registar a excecao de um
     * decisor de intencoes. Duas listas eram duas politicas.
     */
    const secrets = () => [tokenDoBot];
    /**
     * O canal da INSTANCIA CORRENTE. Estado de CLOSURE, nunca de modulo: dois
     * supervisores no mesmo processo (o teste corre dezenas) teriam de partilhar
     * um canal, e o `send` de um acabaria no `stdin` do filho do outro.
     */
    let channel;
    const supervisor = createProcessSupervisor(ctx, {
        name: 'worker',
        backoff: worker.backoff,
        // Q-4: o token entra no ambiente, nunca em `argv`. Passa-lo tambem aqui faz
        // com que qualquer eco dele em stdout/stderr saia do log mascarado.
        // FORNECEDOR (ver `SupervisedProcess.secrets`). O token do bot vem da
        // configuracao e nao muda em runtime, mas a superficie e uma so para os
        // dois supervisores -- duas assinaturas para o mesmo campo era a fenda por
        // onde a generalizacao deixaria de ser real.
        secrets,
        buildSpec: (signal) => ({
            /**
             * ARGV: `[command, entrypoint, ...args]` -- o entrypoint e ANTEPOSTO aqui
             * e NAO vem do manifesto. Nao pode vir: um caminho relativo no
             * `cordis.patch.yml` resolveria contra o `cwd` do HOST (o workspace do
             * utilizador) e o absoluto so e conhecido em runtime. As tres decisoes
             * canonicas dizem a mesma frase: *"O `argv` do spawn resolve
             * `dist/worker/telegram-bot.js` relativo a `import.meta.url`, nunca por
             * `cwd`."*
             *
             * `worker.command` e `process.execPath` (o MESMO Node do host, sem
             * depender do `PATH`) e `worker.args` sao argumentos EXTRA, valor normal
             * `[]`. Montar `[command, ...args]` dava, com o manifesto real,
             * `argv: ['/caminho/para/node']`: um REPL do Node, nao o worker.
             */
            argv: [worker.command, PACKAGED_WORKER_ENTRYPOINT, ...worker.args],
            cwd: resolveWorkerCwd(config),
            /**
             * OS TRES CANAIS EM `'pipe'` -- e o `stdin` e a mudanca estrutural da
             * Onda 4.
             *
             * Ate aqui `stdin` era `'ignore'` (fd 0 em `/dev/null`), com a
             * justificacao "um long-poller nao le do operador". Continua a ser
             * verdade que ele nao le do OPERADOR; o que ele passa a ler e o
             * PROTOCOLO -- e o pipe compra duas coisas que `/dev/null` nao dava:
             *
             *   1. o sentido host -> worker do canal JSONL, sem abrir porta nenhuma
             *      nem ficheiro nenhum (`../contracts/ipc.ts`);
             *   2. o DEAD-MAN'S SWITCH: morto o `dsh` com `SIGKILL`, o nucleo fecha
             *      este descritor, o worker ve EOF e termina sozinho. E a UNICA
             *      defesa que sobrevive a um `SIGKILL` no supervisor, porque
             *      `detached` + `kill(-pid)` no disposer depende de o disposer
             *      chegar a correr.
             *
             * MEDIDO -- e a pergunta que a revisao exigiu: passar `stdin` a `'pipe'`
             * NAO altera o tree-kill nem o `detached`. `ps -o pid,ppid,pgid,sid`
             * mostra o filho como lider do seu proprio grupo e da sua propria sessao
             * (`pgid === sid === pid`) com os dois `stdio`, e o neto continua a
             * morrer com o grupo. Evidencia em
             * `test/integration/proc/stdio-pipe-nao-regride-tree-kill.test.ts`.
             *
             * `'pipe'` entrega os streams crus: `stdout` vai para o canal (S2 -- so
             * JSONL) e `stderr` continua a ir para o log do host.
             */
            stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
            // Janela de cortesia da escalada SIGTERM -> grace -> SIGKILL do assento.
            graceMs: worker.graceMs,
            // A intencao de anulacao transita nativamente para a arvore do filho.
            signal,
            // Ambiente CONSTRUIDO a partir de uma allowlist, nunca herdado inteiro:
            // `process.env` levava `ADMIN_USER`/`ADMIN_PASS` do plano de controlo
            // para dentro do worker. Ver `buildWorkerEnv`.
            env: buildWorkerEnv(process.env, tokenDoBot, providerDoBot),
        }),
        /**
         * O CANAL, ligado e desligado pelo supervisor generico -- ver
         * `SupervisedProcess.attachChannel`. Aqui so se diz QUEM decide as
         * intencoes; o QUANDO (antes de `onSpawned`, desarmado no fecho) e
         * garantia da camada de cima.
         */
        attachChannel: (handle) => {
            const corrente = createHostIpcChannel({
                input: handle.stdout,
                output: handle.stdin,
                log,
                secrets,
                onIntent: (intent) => options.onIntent?.(intent) ?? rejeitarSemControlador(log, intent),
                onNonceRequest: (request) => options.onNonceRequest?.(request) ?? rejeitarSemNonce(log, request),
                onPairingSuccess: (msg) => options.onPairingSuccess
                    ? options.onPairingSuccess(msg)
                    : {
                        v: IPC_PROTOCOL_VERSION,
                        type: 'error',
                        code: 'INTERNAL',
                        message: 'O pareamento nao foi gravado. Reinicie o plugin e tente de novo.',
                    },
            });
            channel = corrente;
            return () => {
                corrente.dispose();
                // So limpa se ainda for o corrente: numa substituicao, o canal NOVO ja
                // esta em `channel` e apaga-lo aqui deixava o `send` mudo com um filho
                // vivo -- o mesmo defeito que `releaseCurrentHandle` corrigiu para o
                // handle.
                if (channel === corrente)
                    channel = undefined;
            };
        },
    }, deps);
    /**
     * Delegacao CAMPO A CAMPO, e nao `{ ...supervisor }`: o espalhamento copia
     * VALORES, e `attempts`, `exhausted` e `failure` sao getters -- ficariam
     * congelados no valor que tinham no instante da copia, e um teste de orcamento
     * passaria a ler sempre `0`.
     */
    return {
        start: supervisor.start,
        restart: supervisor.restart,
        dispose: supervisor.dispose,
        signal: supervisor.signal,
        get attempts() {
            return supervisor.attempts;
        },
        get exhausted() {
            return supervisor.exhausted;
        },
        get failure() {
            return supervisor.failure;
        },
        send: (message) => channel?.send(message) ?? false,
        definirToken: (token) => {
            tokenDoBot = token;
        },
    };
}
//# sourceMappingURL=worker.js.map