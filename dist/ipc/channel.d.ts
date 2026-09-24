/**
 * =============================================================================
 * Lado HOST do canal JSONL host <-> worker. Especificacao: `../contracts/ipc.ts`.
 * =============================================================================
 *
 * NEUTRO POR NATUREZA: este canal transporta apenas mensagens do contrato IPC e
 * nao conhece o provedor de mensageria (telegram hoje, outros no futuro). Este
 * ficheiro foi extirpado da antiga pasta `src/telegram/` (onde se chamava
 * `ipc.ts`) para `src/ipc/channel.ts` no desacoplamento do bot -> provedores
 * (Onda 5b) — o "telegram" no nome era legado da altura em que o canal era o
 * transporte do bot do Telegram.
 *
 * TRES CAMADAS, e a separacao e o que torna S4 testavel:
 *
 *   1. CODEC   -- `serializeIpcMessage` / `parseIpcLine`: uma linha <-> uma
 *                 mensagem. Sem I/O, sem estado.
 *   2. FRAMING -- `createIpcLineDecoder`: o acumulador que reconstroi uma linha
 *                 partida entre dois `data`, e que corta uma linha sem fim.
 *   3. CANAL   -- `createHostIpcChannel`: liga as duas ao `stdout`/`stdin` do
 *                 filho, com backpressure LIMITADA e disposer sincrono.
 *
 * -----------------------------------------------------------------------------
 * PORQUE ESTE CODEC ESTA DUPLICADO EM `worker/ipc.ts` — e porque isso NAO e a
 * duplicacao que `proc/retry.ts` proibe.
 * -----------------------------------------------------------------------------
 * `05-QUALIDADE-CODIGO.md` 5.5 autoriza o worker a importar de `src/` UMA coisa
 * e so uma: `src/contracts/ipc.ts`. Importar ESTE ficheiro arrastaria
 * `src/logging/**` e `src/errors.ts` para dentro do grafo de modulos do processo
 * que fala com a internet — exatamente o acoplamento que a separacao de
 * processos existe para impedir. A duplicacao e imposta pela fronteira, nao
 * escolhida.
 *
 * O que a torna segura e um GATE e nao uma promessa: `test/unit/worker/ipc.test.ts`
 * corre a MESMA tabela de linhas malformadas pelos DOIS analisadores e assere
 * veredito identico. No dia em que um divergir, o teste fica vermelho.
 *
 * -----------------------------------------------------------------------------
 * S4 E UM TIPO DE RETORNO, NAO UMA EXCECAO — e o codigo obedece.
 * -----------------------------------------------------------------------------
 * Nada no caminho de LEITURA lanca: linha malformada vira `{ ok: false, reason }`,
 * o canal regista e continua. A razao esta no contrato — a outra ponta pode ter
 * sido reiniciada a meio de uma escrita, e derrubar o canal por um byte perdido
 * transforma um glitch numa queda de servico. O caminho de ESCRITA lanca, porque
 * ali um erro e defeito NOSSO e o silencio seria pior.
 */
import type { Readable, Writable } from 'node:stream';
import { type IpcIntentMessage, type IpcMessage, type IpcMessageToWorker, type IpcNonceRequestMessage, type IpcPairingSuccessMessage, type IpcParseResult } from '../contracts/ipc.ts';
import type { GuardLogger } from '../logging/logger.ts';
/**
 * Teto de UMA linha. Acima disto a linha e cortada e o analisador RESSINCRONIZA
 * no `\n` seguinte.
 *
 * PORQUE EXISTE: sem teto, uma ponta que escreve bytes e nunca escreve `\n`
 * (defeito, ou outra coisa qualquer no lugar do worker) faz o acumulador crescer
 * ate o host ficar sem memoria. E a imagem ao espelho do `stderr` sem leitor que
 * a Onda 3 mediu: ali congelava o FILHO, aqui morria o PAI. 64 KiB e ~16x a
 * maior mensagem legal (um `error` com 4096 carateres).
 */
export declare const IPC_MAX_LINE_BYTES: number;
/**
 * Teto do que pode ficar POR ESCREVER no `stdin` do filho.
 *
 * MEDIDO (`test/integration/proc/ipc-backpressure.test.ts`): um worker que para
 * de ler NAO bloqueia o host — `Writable.write()` sobre um pipe e assincrono e
 * devolve `false`; o que cresce sem limite e a fila INTERNA do stream. Crescer
 * ali ate ao OOM seria um plugin que mata o DSH inteiro por causa de um filho
 * preguicoso. Acima deste teto a mensagem e DESCARTADA com aviso: perder uma
 * difusao de estado e recuperavel (a proxima traz `seq` novo), perder o processo
 * hospedeiro nao e.
 */
export declare const IPC_MAX_PENDING_BYTES: number;
/**
 * Teto DURO: acima dele o canal declara-se INVIAVEL.
 *
 * PORQUE UM SEGUNDO TETO. O primeiro governa so as difusoes de `state`, porque
 * so elas podem ser coalescidas sem violar o contrato -- `ack` e `error` sao "a
 * unica resposta que aquele `requestId` vai ter" e escrevem sempre. Mas "sempre"
 * sem limite nenhum reabre exatamente o OOM que o primeiro teto fechou: um filho
 * que nunca le e continua a mandar intencoes faz crescer a fila um `ack` de cada
 * vez.
 *
 * Este teto nao descarta em silencio: ele torna a condicao TERMINAL e
 * OBSERVAVEL (`log.error` uma vez + `stats.overwhelmed`), que e a mesma forma
 * que `../proc/retry.ts` usa para o orcamento esgotado -- e pela mesma razao,
 * "continuar a tentar contra uma coisa que nao esta a responder nao e
 * resiliencia, e ruido".
 *
 * 4 MiB = 16x o teto suave: e preciso que o worker esteja MESMO parado.
 */
export declare const IPC_OVERWHELMED_BYTES: number;
/**
 * Codigos estaveis do canal.
 *
 * VIVEM AQUI e nao em `src/errors.ts` por fronteira de onda: `GuardErrorCode` e
 * uma uniao partilhada e quatro sub-tarefas escrevem em paralelo nesta onda. A
 * FORMA e a de `GuardError` (nome, `code`, mensagem prefixada pelo plugin), que
 * e o que `05-QUALIDADE-CODIGO.md` 6.1 exige.
 */
export type IpcChannelErrorCode = 
/** A mensagem nao respeita o contrato (ex.: `url` fora de `READY`). */
'IPC_MESSAGE_INVALID'
/** `JSON.stringify` recusou o valor (ciclo, `BigInt`). */
 | 'IPC_SERIALIZE_FAILED';
export declare class IpcChannelError extends Error {
    readonly name = "IpcChannelError";
    readonly code: IpcChannelErrorCode;
    constructor(code: IpcChannelErrorCode, detail: string);
}
/** Sentido em que a linha viaja. `to-host` = o que o worker pode enviar. */
export type IpcDirection = 'to-host' | 'to-worker';
/** As razoes de recusa, extraidas do contrato para poderem ser nomeadas. */
export type IpcParseFailureReason = Extract<IpcParseResult, {
    ok: false;
}>['reason'];
/**
 * Valida um valor ja desserializado e RECONSTROI a mensagem.
 *
 * >>> RECONSTROI, e e isso o controlo. <<< O que sai daqui e um objeto NOVO com
 * exatamente os campos do contrato: um campo a mais na linha (injetado por quem
 * escreve do outro lado) nao chega ao consumidor, e um `"__proto__"` vindo do
 * `JSON.parse` fica no objeto descartado em vez de viajar para dentro do host.
 */
export declare function validateIpcMessage(value: unknown, direction: IpcDirection): IpcParseResult;
/**
 * Teto de runs numa UNICA mensagem `agent.report` — o teto do TRANSPORTE
 * (S1: uma linha de 64 KiB), acima do qual o codec recusa a mensagem com
 * `IPC_MESSAGE_INVALID` do lado da escrita.
 *
 * EXPORTADO por causa da EMENDA ONDA-4-FIX-REPORT-CAPS: o registry
 * (`src/agents/registry.ts`) usa o MESMO numero para capar a lista antes de
 * emitir (`relatorio()`) e o assert deriva dele o teto de `agents.maxRuns`.
 * Um so numero, uma so fonte de verdade — nunca um literal repetido.
 *
 * O valor (64) e o dobro do historico do registry (32): 32 vivos + 32
 * terminais cabem na linha; acima disso a lista nao cabe no contrato.
 */
export declare const MAX_RUNS_PER_REPORT = 64;
/**
 * Le UMA linha (ja sem o `\n`). NUNCA lanca (S4): o veredito e o retorno.
 */
export declare function parseIpcLine(line: string, direction: IpcDirection): IpcParseResult;
/**
 * Escreve UMA linha: JSON compacto + `\n` (S1).
 *
 * LANCA quando a mensagem viola o contrato, e e deliberado — do lado da ESCRITA
 * um erro e defeito nosso, e `createHostIpcChannel` converte-o em `log.error` +
 * `false`. Deixar passar uma mensagem invalida seria entregar ao worker
 * exatamente o ruido que S2 existe para impedir.
 *
 * `JSON.stringify` escapa `\n` e `\r` DENTRO de qualquer string, pelo que o
 * enquadramento nao pode ser partido por conteudo. A guarda final confirma-o em
 * vez de o assumir.
 */
export declare function serializeIpcMessage(message: IpcMessage, direction: IpcDirection): string;
export interface IpcLineDecoder {
    /** Consome um chunk e devolve o veredito de CADA linha que ele fechou. */
    push(chunk: Buffer | string): readonly IpcParseResult[];
    /** Bytes retidos a espera do `\n` (observabilidade). */
    readonly pending: number;
}
/**
 * Acumulador de linhas sobre um fluxo de chunks.
 *
 * DUAS COISAS QUE UM `chunk.toString().split('\n')` INGENUO ERRA:
 *
 *   1. UMA LINHA PARTIDA ENTRE DOIS `data`. O `stdout` de um filho e um pipe e o
 *      SO parte onde quiser. Sem acumulador, metade das mensagens vira
 *      `json-invalido` sob carga — e de forma INTERMITENTE, que e o pior modo de
 *      falha possivel.
 *   2. UM CARATER UTF-8 PARTIDO ENTRE DOIS `data`. `Buffer.toString()` sobre
 *      metade de uma sequencia multibyte produz U+FFFD e corrompe a linha; o
 *      `StringDecoder` retem o resto da sequencia ate ela fechar (S1 diz UTF-8).
 */
export declare function createIpcLineDecoder(options: {
    readonly direction: IpcDirection;
    readonly maxLineBytes?: number | undefined;
}): IpcLineDecoder;
export interface HostIpcChannelOptions {
    /** `stdout` do filho: EXCLUSIVAMENTE JSONL (S2). */
    readonly input: Readable | undefined;
    /** `stdin` do filho. Ausente = o `stdio` regrediu para `'ignore'`. */
    readonly output: Writable | undefined;
    readonly log: GuardLogger;
    /**
     * Decide UMA intencao e devolve a resposta a enviar.
     *
     * SINCRONO e obrigatorio, e os dois adjetivos sao contrato:
     *
     *   - OBRIGATORIO porque o contrato diz que o `ack` e "sempre emitido —
     *     inclusive nos caminhos de erro"; sem ele o cliente do Telegram fica com
     *     a barra de progresso eterna e o dono nao sabe se o comando chegou.
     *     Devolver a resposta (em vez de a mandar por um `send` opcional) poe essa
     *     obrigacao no TIPO.
     *   - SINCRONO por Q-5: o trabalho lento (subir tunel, sondar) responde
     *     `accepted` JA e difunde o resto depois por {@link HostIpcChannel.send}.
     */
    readonly onIntent: (intent: IpcIntentMessage) => IpcMessageToWorker;
    /**
     * Decide UM pedido de nonce (EMENDA-COSTURA-5) e devolve a resposta.
     *
     * AUSENTE, o canal responde `error INTERNAL` ao pedido — fail-closed: um
     * nonce que nao chega ao worker nao autoriza nada (CTL-023). Em producao a
     * fiacao (`src/index.ts`) liga-o ao `ConfirmService` de T5.1 via
     * `criarRespondedorDeNonce`; o nonce NUNCA e logado (S3).
     */
    readonly onNonceRequest?: ((request: IpcNonceRequestMessage) => IpcMessageToWorker) | undefined;
    /**
     * Decide UM `pairing.success` (EMENDA ONDA-1-PAREAR-VIA-PAINEL) e devolve a
     * resposta — tipicamente `pairing.owner`, que fecha o handshake e liberta a
     * allowlist no ato (a costura tambem grava o dono no `state.json`).
     *
     * AUSENTE, o canal responde `error INTERNAL` ao aviso — o pareamento ainda
     * fica valido no worker (ele ja autorizou), mas o host nao aprende o dono e
     * a allowlist nao liberta ate reiniciar. Fail-closed: o host NUNCA persiste
     * um dono que nao confirmou.
     */
    readonly onPairingSuccess?: ((msg: IpcPairingSuccessMessage) => IpcMessageToWorker) | undefined;
    /**
     * Segredos a mascarar em TUDO o que este canal escreve no log.
     *
     * >>> FORNECEDOR, avaliado a cada linha -- nao uma lista capturada aqui. <<<
     * E a mesma superficie de `SupervisedProcess.secrets` e pela mesma razao: o
     * conjunto muda depois do arranque.
     *
     * PORQUE E OBRIGATORIO E NAO OPCIONAL. Este canal regista `error.message` de
     * codigo de TERCEIROS -- o decisor de intencoes, o serializador, o absorvedor
     * de `'error'` do stream. A API do Telegram poe o token DENTRO do caminho do
     * URL, pelo que um `ECONNRESET em https://api.telegram.org/bot<n>:<token>/...`
     * escapa por qualquer `throw` que passe por aqui.
     *
     * A ASSIMETRIA QUE ISTO FECHA: `attachStreamLogging` ja aplicava `redact()` a
     * cada linha de `stderr` do FILHO. O mesmo token impresso pelo HOST ficava em
     * claro. Um campo opcional com valor por omissao reproduziria o buraco no
     * primeiro chamador que se esquecesse dele; obrigatorio, o `tsc` recusa.
     */
    readonly secrets: () => readonly string[];
    readonly maxLineBytes?: number | undefined;
    readonly maxPendingBytes?: number | undefined;
    /** Teto DURO. Ver {@link IPC_OVERWHELMED_BYTES}. */
    readonly overwhelmedBytes?: number | undefined;
}
export interface HostIpcChannel {
    /**
     * Envia host -> worker.
     *
     * `false` significa "nao vai ser entregue": canal ausente, mensagem invalida,
     * ou canal declarado INVIAVEL. Uma difusao de `state` COALESCIDA devolve
     * `true` -- ela vai ser entregue, so que a proxima substitui-a.
     */
    send(message: IpcMessageToWorker): boolean;
    /** Desarme SINCRONO e IDEMPOTENTE: 3 chamadas = 1 desarme. */
    dispose(): void;
    readonly stats: IpcChannelStats;
}
export interface IpcChannelStats {
    readonly sent: number;
    readonly dropped: number;
    readonly received: number;
    readonly malformed: number;
    /** Difusoes de `state` substituidas por uma mais recente (nunca `ack`/`error`). */
    readonly coalesced: number;
    /** `true` depois de o teto DURO ser ultrapassado: estado observavel, nao silencio. */
    readonly overwhelmed: boolean;
}
/**
 * Liga o codec aos pipes do filho.
 *
 * NAO E ELE QUE MATA O PROCESSO. O ciclo de vida (abort, tree-kill, orcamento) e
 * do supervisor; este objeto so fala e ouve. Um segundo dono do kill seria a
 * forma mais rapida de partir a garantia LIFO do disposer.
 *
 * ---------------------------------------------------------------------------
 * A POLITICA DE SATURACAO, E PORQUE ELA NAO PODE SER UMA SO
 * ---------------------------------------------------------------------------
 * Um teto unico que descartasse tudo por igual estaria a violar o contrato. Ele
 * diz de `IpcAckMessage`: *"Sempre emitida -- inclusive nos caminhos de erro.
 * Sem `ack`, o cliente do Telegram fica com a barra de progresso eterna, e o
 * dono nao sabe se o comando chegou."*
 *
 * E a justificacao de descartar -- "perde-se uma difusao, a proxima traz `seq`
 * novo" -- so vale para `state`. Para um `ack` NAO EXISTE "a proxima": ele e a
 * unica resposta que aquele `requestId` vai ter. Descarta-lo significa
 * `/emergencia` a executar no host e o dono a nunca saber, exatamente no estado
 * degradado para o qual o teto existe.
 *
 * Por isso ha TRES regimes, e nenhum deles e silencioso:
 *
 *   1. `state` acima do teto SUAVE -> COALESCE. Nao se descarta a mais recente:
 *      guarda-se, e a difusao seguinte substitui-a. `state` e idempotente por
 *      construcao (o worker e uma PROJECCAO e ja descarta `seq` fora de ordem),
 *      pelo que entregar so a ultima e a entrega CERTA, nao uma degradacao.
 *   2. `ack` e `error` -> ESCREVEM SEMPRE. Nao ha teto suave para eles.
 *   3. Acima do teto DURO -> o canal declara-se INVIAVEL. Deixar `ack`/`error`
 *      crescerem sem limite nenhum reabria o OOM que mediu o teto em primeiro
 *      lugar (um filho que nunca le e continua a mandar intencoes). O que se faz
 *      nao e calar: e `log.error` uma vez, `stats.overwhelmed` a `true`, e
 *      `send` a devolver `false` -- um estado TERMINAL OBSERVAVEL, na mesma
 *      forma que `./retry.ts` usa para o orcamento esgotado.
 */
export declare function createHostIpcChannel(options: HostIpcChannelOptions): HostIpcChannel;
//# sourceMappingURL=channel.d.ts.map