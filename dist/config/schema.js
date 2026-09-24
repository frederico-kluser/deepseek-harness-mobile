/**
 * `interface Config` -- contrato congelado da entrada `config` do
 * `cordis.patch.yml` (id `guard-messenger`).
 *
 * COMO O MOTOR DE PATCHES RESOLVE ISTO (corrigido: a versao anterior deste
 * comentario dizia *whole-entry replace*, e esta errado). O `replace` do
 * `dsh-app-boot` e um SHALLOW MERGE das chaves de topo da entrada
 * (`lib/index.js:100-103`); so o objeto `config`, QUANDO fornecido, e substituido
 * inteiro. Consequencia pratica para este ficheiro, que nao muda: se a entrada
 * trouxer `config`, cada chave obrigatoria abaixo tem de existir literalmente
 * nesse objeto -- uma chave omitida DENTRO de `config` e uma chave apagada, nao
 * herdada.
 *
 * DUAS CHAVES DEIXARAM DE SER OBRIGATORIAS NESTA ONDA, e a razao e do manifesto,
 * nao de preferencia (medicao de T1.3 contra um `$DSH_HOME` limpo com
 * `dsh@0.1.0-rc.7`): o `cordis.patch.yml` passou a ser CAMADA 1 / BUNDLE, isto e,
 * viaja dentro do pacote npm e e aplicado em qualquer instalacao.
 *
 *   - `worker.cwd`: um caminho absoluto fixo num ficheiro empacotado quebra
 *     TODA a instalacao por npm -- o caminho da maquina de quem publicou nao
 *     existe na de quem instala. Passa a ser opcional, com default resolvido a
 *     partir do proprio pacote ({@link resolveWorkerCwd}).
 *   - `encodedAuthString`: uma credencial NAO pode existir num ficheiro
 *     versionavel (D19). Passa a ser opcional; a Onda 2 gera-a por CSPRNG e
 *     persiste apenas o digest. Enquanto for ausente, NINGUEM se autentica --
 *     ver a nota fail-closed em `src/http/auth-basic.ts`.
 *
 * ACRESCENTAR uma chave obriga a acrescentar a mesma chave ao `cordis.patch.yml`
 * na MESMA onda -- as duas coisas casam ou o plugin recusa arrancar.
 */
import { fileURLToPath } from 'node:url';
/**
 * Resolve o diretorio `worker/` EMPACOTADO a partir da localizacao DESTE MODULO
 * -- nunca do `process.cwd()`.
 *
 * `09-DECISOES-CANONICAS.md:200`, `06-REPO-E-CI.md:283` e `01-ARQUITETURA.md:522`
 * dizem a mesma frase: *"O `argv` do spawn resolve `dist/worker/telegram-bot.js`
 * relativo a `import.meta.url`, nunca por `cwd`."* O `cwd` do processo hospedeiro
 * e o workspace do utilizador; nao tem relacao nenhuma com onde o pacote foi
 * instalado.
 *
 * UMA SO EXPRESSAO NAO SERVE OS DOIS LAYOUTS. A versao anterior deste comentario
 * afirmava que "os dois caminhos sobem exatamente dois niveis" -- a aritmetica
 * estava certa e a conclusao errada, porque o `worker/` esta FORA da arvore de
 * fonte e DENTRO da arvore emitida:
 *
 *   carregado de | import.meta.url                | worker/ efetivo
 *   -------------|--------------------------------|------------------------
 *   fonte (dev)  | <repo>/src/config/schema.ts    | <repo>/worker/      (../../)
 *   tarball      | <pkg>/dist/config/schema.js    | <pkg>/dist/worker/  (../)
 *
 * Medido: com `../../worker/` a partir do tarball instalado o caminho resolvia
 * para `<pkg>/worker/`, que NAO EXISTE (`dist/worker/` existe). Com o `cwd`
 * absoluto fora do manifesto (entrega de T1.3), esse default deixou de estar
 * mascarado e TODA a instalacao por npm arrancava com `assertExistingDirectory`
 * a lancar.
 *
 * PORQUE PUBLICAR `worker/**` EM VEZ DISTO NAO ERA CORRECCAO: o Node RECUSA
 * tirar tipos a `.ts` dentro de `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, medido em v24.15.0). Enviar o
 * fonte do worker no tarball so trocaria uma falha ruidosa no arranque por uma
 * falha de spawn mais tarde. E `dist/worker/` que tem de existir, e e ele que
 * este caminho tem de apontar.
 *
 * @param moduleUrl `import.meta.url` do modulo que resolve (parametrizado para
 * que os DOIS layouts sejam verificaveis sem publicar nada).
 */
function workerTreeLayout(moduleUrl) {
    // O discriminador e a EXTENSAO deste proprio modulo: a arvore de fonte e
    // `.ts`, a arvore emitida e `.js` (o `rewriteRelativeImportExtensions` do
    // build garante-o). NAO se sonda o sistema de ficheiros a procura de qual dos
    // dois existe: escolher o que existir seria adivinhar, e esconderia um layout
    // errado em vez de o expor no arranque -- o oposto de "fail loud at load".
    //
    // O ENTRYPOINT muda de extensao com o layout exatamente como o diretorio muda
    // de profundidade: `worker/telegram-bot.ts` em dev, `dist/worker/telegram-bot.js`
    // publicado. Um so discriminador decide as duas coisas.
    const isEmittedTree = /\.[cm]?js$/u.test(new URL(moduleUrl).pathname);
    return {
        dir: isEmittedTree ? '../worker/' : '../../worker/',
        extension: isEmittedTree ? '.js' : '.ts',
    };
}
export function resolvePackagedWorkerDir(moduleUrl) {
    return fileURLToPath(new URL(workerTreeLayout(moduleUrl).dir, moduleUrl));
}
/** Nome do modulo de entrada do worker, sem extensao (`worker/telegram-bot`). */
const WORKER_ENTRY_BASENAME = 'telegram-bot';
/**
 * Resolve o ENTRYPOINT do worker -- o ficheiro que vai para o `argv` do spawn.
 *
 * Mesma disciplina, mesma razao canonica (`09-DECISOES-CANONICAS.md:200`,
 * `01-ARQUITETURA.md:522`, `06-REPO-E-CI.md:283`):
 * *"O `argv` do spawn resolve `dist/worker/telegram-bot.js` relativo a
 * `import.meta.url`, nunca por `cwd`."*
 *
 *   carregado de | import.meta.url             | entrypoint
 *   -------------|-----------------------------|--------------------------------------
 *   fonte (dev)  | <repo>/src/config/schema.ts | <repo>/worker/telegram-bot.ts
 *   tarball      | <pkg>/dist/config/schema.js | <pkg>/dist/worker/telegram-bot.js
 *
 * @param moduleUrl `import.meta.url` do modulo que resolve (parametrizado para
 * que os DOIS layouts sejam verificaveis sem publicar nada).
 */
export function resolveWorkerEntrypoint(moduleUrl) {
    const { dir, extension } = workerTreeLayout(moduleUrl);
    return fileURLToPath(new URL(`${dir}${WORKER_ENTRY_BASENAME}${extension}`, moduleUrl));
}
/** Diretorio `worker/` empacotado desta instalacao. */
export const PACKAGED_WORKER_DIR = resolvePackagedWorkerDir(import.meta.url);
/** Entrypoint do worker desta instalacao, para o `argv` do spawn. */
export const PACKAGED_WORKER_ENTRYPOINT = resolveWorkerEntrypoint(import.meta.url);
/**
 * Resolve o diretorio de trabalho efetivo do worker.
 *
 * NAO e um `?? valor_padrao` proibido por Q-3: `worker.cwd` nao participa de
 * autenticacao, bind, allowlist, TTL nem rate limit -- e a localizacao de um
 * ficheiro dentro do proprio pacote. A ausencia e benigna E VERIFICADA: o
 * caminho resolvido passa por `assertExistingDirectory` no arranque, tal como o
 * caminho explicito passava.
 */
export function resolveWorkerCwd(config) {
    const declared = config.worker.cwd;
    if (typeof declared === 'string' && declared.trim().length > 0)
        return declared;
    return PACKAGED_WORKER_DIR;
}
/* ========================================================================== */
/* Os eixos da Onda 3, resolvidos                                             */
/* ========================================================================== */
/**
 * A leitura de `exposure` AUSENTE. Os tres valores sao os fechados.
 *
 * NAO E O `?? valor_por_omissao` PROIBIDO POR Q-3, e a distincao e a mesma que
 * `resolveWorkerCwd` ja documenta -- mas aqui ela precisa de ser feita com mais
 * cuidado, porque esta chave PARTICIPA de politica de seguranca. O que Q-3
 * proibe e preencher uma ausencia com um valor que ABRE alguma coisa. Aqui a
 * ausencia e preenchida com a recusa de tudo:
 *
 *   mode: 'loopback'        -> nenhum tunel pode subir;
 *   autoStart: false        -> nada arranca sozinho;
 *   trustEdgeHeaders: false -> nenhum cabecalho de IP e acreditado.
 *
 * Um `exposure` em falta nao pode, por construcao, tornar o sistema mais aberto
 * do que um `exposure` declarado. E o arranque grita (`src/index.ts`), para que
 * a ausencia seja vista.
 */
export const LOOPBACK_ONLY_EXPOSURE = {
    mode: 'loopback',
    autoStart: false,
    trustEdgeHeaders: false,
};
/** O eixo `exposure` efetivo. Ver {@link LOOPBACK_ONLY_EXPOSURE}. */
export function resolveExposure(config) {
    return config.exposure ?? LOOPBACK_ONLY_EXPOSURE;
}
/** A leitura de `control` ausente: a confirmacao de duas etapas fica LIGADA. */
export const CONFIRMATION_REQUIRED_CONTROL = { requireConfirmation: true };
/** O eixo `control` efetivo. */
export function resolveControl(config) {
    return config.control ?? CONFIRMATION_REQUIRED_CONTROL;
}
/**
 * A leitura de `agents` AUSENTE: NENHUM agente disparavel, teto 1.
 *
 * NAO E O `?? valor_por_omissao` PROIBIDO POR Q-3 — a mesma distincao de
 * {@link LOOPBACK_ONLY_EXPOSURE}: a ausencia e preenchida com a RECUSA DE
 * TUDO. Um `agents` em falta nao pode, por construcao, tornar o sistema mais
 * aberto do que um `agents` declarado: sem allowlist nao ha dispatch, e sem
 * dispatch nao ha execucao de codigo no host pelo dono.
 */
export const AGENTS_FAIL_CLOSED = { skills: [], maxRuns: 1 };
/** O eixo `agents` efetivo. Ver {@link AGENTS_FAIL_CLOSED}. */
export function resolveAgents(config) {
    return config.agents ?? AGENTS_FAIL_CLOSED;
}
/**
 * O tunel pode SUBIR SOZINHO no arranque?
 *
 * TRES condicoes, todas necessarias, e a terceira e a que fecha `04-TESTES.md`
 * RL-015 do lado do arranque: com o MODO RESTRITO ativo no `state.json`, o boot
 * NAO sobe o tunel. Reiniciar o DSH nao pode ser o bypass do modo restrito --
 * se fosse, o controlo que o teto NIST aciona duraria ate ao proximo `Ctrl-C`.
 *
 * PORQUE E UMA FUNCAO E NAO UM `if` DENTRO DO SUPERVISOR: o supervisor do tunel
 * e de T3.1 e este predicado e de politica, nao de processo. Escrito aqui, e
 * verificavel sem spawnar nada -- que e a unica forma de o testar sem invocar o
 * `cloudflared` verdadeiro (D10).
 */
export function shouldAutoStartTunnel(config, restrictedModeActive) {
    if (restrictedModeActive)
        return false;
    const exposure = resolveExposure(config);
    return exposure.mode === 'tunnel' && exposure.autoStart;
}
/**
 * O cabecalho de IP da borda pode ser lido NESTE pedido?
 *
 * ---------------------------------------------------------------------------
 * MEDIDO (spike S2, `docs/spikes/cloudflared.md` VEREDITO S2: CONFIRMADO)
 * ---------------------------------------------------------------------------
 * A borda da Cloudflare entrega `CF-Connecting-IP` a origem com o IP real do
 * cliente e RECUSA NA PROPRIA BORDA (HTTP 403, `error code: 1000`) qualquer
 * requisicao em que o CLIENTE envie esse cabecalho. O valor que chega a origem
 * nunca e escolhido pelo cliente -- a borda faz MELHOR do que sobrescrever, ela
 * recusa o pedido forjado. Foi assim medido, caso a caso:
 *
 *   R1 (sem forja)                -> 200, `Cf-Connecting-Ip: <ip real>`
 *   R2 (X-Forwarded-For: 1.2.3.4) -> 200, `X-Forwarded-For: 1.2.3.4,<ip real>`
 *   R3 (CF-Connecting-IP: 1.2.3.4)-> 403 NA BORDA; nada chegou a origem
 *
 * >>> R2 E A RAZAO DE `X-Forwarded-For` ESTAR PROIBIDO EM TODOS OS MODOS. <<<
 * Ele e ACRESCENTADO ao valor do cliente, com o valor forjado PRIMEIRO. Quem
 * ler o primeiro elemento deixa o atacante escolher o proprio IP -- e nesse
 * mundo o rate limit por IP e o audit log por IP passam a ser controlados por
 * ele. O mesmo vale para `X-Real-Ip`. A lista de cabecalhos acreditados tem
 * EXATAMENTE UM elemento, e e por isso.
 *
 * A proxima pessoa vai olhar para `CF-Connecting-IP` e para `X-Forwarded-For` e
 * concluir que sao equivalentes. Nao sao, e a diferenca esta medida acima.
 * ---------------------------------------------------------------------------
 *
 * DUAS CONDICOES ALEM DA CHAVE, e nenhuma e decorativa:
 *
 *   - `mode: 'tunnel'`: em `loopback` nao ha borda nenhuma a frente, logo o
 *     cabecalho so pode ter sido escrito por um processo LOCAL -- exatamente
 *     quem nao pode escolher o proprio IP;
 *   - o pedido tem de ter CHEGADO pelo tunel (`viaTunnel`): um processo local
 *     que se ligue direto ao `127.0.0.1:<porta>` nao passou pela borda, e a
 *     recusa dela nao o protege.
 */
export function mayTrustEdgeClientIp(exposure, viaTunnel) {
    return exposure.trustEdgeHeaders && exposure.mode === 'tunnel' && viaTunnel;
}
//# sourceMappingURL=schema.js.map