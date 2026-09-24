/**
 * =============================================================================
 * A SONDA — o unico I/O de rede do onboarding, agora POR PROVEDOR.
 * =============================================================================
 *
 * Duas camadas num ficheiro, e elas nao se separam:
 *
 *   1. o TRANSPORTE TELEGRAM (portado de `src/telegram/onboarding.ts`): o
 *      `criarSondaHttp` com `getMe`/`getUpdates` e a classificacao de falha
 *      MEDIDA (`docs/spikes/telegram.md`). NAO ha duplicacao: quem quiser a
 *      sonda telegram completa importa daqui (o `src/telegram/onboarding.ts`
 *      re-exporta para o CLI e os testes continuarem a encontrar a MESMA
 *      origem — o mesmo padrao da extracao de `texts.ts`);
 *   2. `criarSonda(provider, ...)`: a FABRICA provider-aware que devolve o
 *      probe comum `{ ok, botNome? }` — a superficie que o painel de T5.3
 *      consome sem saber com que provedor esta a falar.
 *
 * -----------------------------------------------------------------------------
 * PORQUE UM PROBE COMUM E NAO `criarSondaHttp` DIRETO NO PAINEL
 * -----------------------------------------------------------------------------
 * O painel pergunta "o token deste provedor vale? o bot tem nome publico?" —
 * e so isso. O `getUpdates` do Telegram (a sondagem de pareamento do CLI) e
 * especifico do canal e NAO faz parte dessa pergunta. O probe comum devolve o
 * minimo que a UI precisa: `ok`, `botNome` e um `erro` curto (nao prosa, nao
 * segredo). Quem precisar de mais (o CLI de pareamento) continua a usar a
 * sonda telegram completa — por injecao, nunca por duplicacao.
 *
 * -----------------------------------------------------------------------------
 * A RAIZ DA API E CONFIGURAVEL POR PROVEDOR (TELEGRAM_API_ROOT)
 * -----------------------------------------------------------------------------
 * O worker telegram le `TELEGRAM_API_ROOT` (`API_ROOT_ENV_VAR`) e a sonda le a
 * MESMA variavel. E a disciplina do `tokenVar`: o nome e DUPLICADO do lado do
 * worker e a paridade e um teste, nao um import — o worker so pode importar
 * `src/contracts/ipc.ts` de `src/` (`05-QUALIDADE-CODIGO.md` 5.5). Omissa,
 * cada provedor usa a raiz publica.
 */
import type { ProviderId } from '../proc/env.ts';
/** Raiz da Bot API. SEM barra final. */
export declare const API_ROOT_PADRAO = "https://api.telegram.org";
/** Teto de espera de uma chamada. Curto: isto e um CLI, nao um servico. */
export declare const TIMEOUT_DA_SONDA_MS = 10000;
/**
 * Quantos updates uma sondagem pede. O teto da propria Bot API e 100
 * (`Client.cpp` clampa `limit` a 1-100).
 *
 * E EXPORTADO porque e um LIMITE OBSERVAVEL, nao um detalhe: com `offset: 0` a
 * fila nunca e confirmada, logo uma resposta com exatamente
 * `LIMITE_DE_UPDATES` elementos significa "ha pelo menos mais alguns que nunca
 * veremos". Quem espera pelo `/parear` tem de reconhecer esse caso e dize-lo —
 * ver A2 no cabecalho de `bin/dsh-guard-setup.ts`.
 */
export declare const LIMITE_DE_UPDATES = 100;
/** O que interessa do `User` devolvido por `getMe` (`#getme`). */
export interface IdentidadeDoBot {
    readonly id: number;
    readonly username: string;
}
/** Porque o `getMe` nao confirmou o token. Cada causa tem um texto proprio. */
export type CausaDeFalha = 
/** `401 Unauthorized: invalid token specified` — revogado ou errado. */
'recusado'
/** `404 Not Found` — o token nem chega a formar uma rota valida. */
 | 'rota-inexistente'
/** `409 Conflict` — ja ha outra ligacao a usar este bot. */
 | 'conflito'
/** `429` com `retry_after`. */
 | 'limite-de-taxa'
/** Nao houve resposta: DNS, proxy, cabo. */
 | 'rede'
/** Houve resposta e nao se percebeu — HTTP inesperado ou corpo nao-JSON. */
 | 'resposta-ininteligivel';
export interface FalhaDoGetMe {
    readonly causa: CausaDeFalha;
    /** `0` quando nao houve resposta HTTP nenhuma. */
    readonly httpStatus: number;
    readonly errorCode?: number | undefined;
    /** `description` da API. NAO e apresentada em cru: ver {@link diagnostico}. */
    readonly description?: string | undefined;
    /** Segundos pedidos por um `429` (`ResponseParameters.retry_after`). */
    readonly retryAfter?: number | undefined;
}
export type RespostaGetMe = {
    readonly ok: true;
    readonly bot: IdentidadeDoBot;
} | {
    readonly ok: false;
    readonly falha: FalhaDoGetMe;
};
/**
 * Classifica um par (HTTP, corpo) da Bot API.
 *
 * Os valores vem MEDIDOS, nao presumidos (`docs/spikes/telegram.md` 2.1 e 6):
 *   - `401 {"ok":false,"error_code":401,"description":"Unauthorized: invalid
 *     token specified"}` — token bem formado sem conta por tras;
 *   - `404 {"ok":false,"error_code":404,"description":"Not Found"}` — token sem
 *     `:`, que cai fora da rota `/bot<token>/<metodo>`;
 *   - `409 Conflict: terminated by other getUpdates request...` — ha outra
 *     instancia a fazer long polling com o MESMO token.
 */
export declare function classificarFalha(httpStatus: number, corpo: unknown): FalhaDoGetMe;
/** Le um `User` de `{"ok":true,"result":{...}}`, sem confiar na forma. */
export declare function lerIdentidade(corpo: unknown): IdentidadeDoBot | undefined;
export type ResultadoDeUpdates = {
    readonly ok: true;
    readonly updates: readonly unknown[];
} | {
    readonly ok: false;
    readonly falha: FalhaDoGetMe;
};
/**
 * O transporte, injetavel.
 *
 * PORQUE E UMA INTERFACE E NAO UM `fetch` solto: e por aqui que o motor de
 * pareamento deixa de depender de rede nenhuma. Hoje o CLI passa
 * {@link criarSondaHttp}; no dia em que o IPC host<->worker (T4.3) existir, a
 * fonte dos updates passa a ser o WORKER e nada no pareamento muda. Ver o
 * comentario de {@link SondaTelegram.getUpdates} para a razao dura.
 */
export interface SondaTelegram {
    getMe(token: string): Promise<RespostaGetMe>;
    /**
     * Le updates SEM OS CONFIRMAR, e sem pendurar long poll.
     *
     * DUAS DECISOES, e as duas vem de medicao (`docs/spikes/telegram.md` 6 e 7):
     *
     *   1. `offset` NUNCA AVANCA. `getUpdates` com um `offset` maior que um
     *      `update_id` CONFIRMA e APAGA esse update no servidor — para sempre,
     *      para toda a gente. Se o onboarding confirmasse, os comandos que o
     *      worker precisava de ver desapareciam antes de ele nascer. Com
     *      `offset: 0` le-se a mesma fila as vezes que forem precisas e nao se
     *      apaga nada: o custo e reler updates ja vistos, que se descartam por
     *      `update_id` aqui dentro, e o beneficio e nao destruir a fila alheia.
     *   2. `timeout: 0` — sondagem curta, nunca long poll. Assim ESTA ferramenta
     *      nunca fica pendurada a espera, e nunca e ELA a vitima de um `409`
     *      quando o worker chegar depois.
     *
     * >>> O QUE ESTA POR CONFIRMAR, e fica escrito como tal <<<
     * Uma versao anterior deste comentario concluia que, por nao pendurar long
     * poll, esta ferramenta nao derrubaria o worker. ISSO NAO SE SEGUE. Pela
     * semantica do servidor oficial (`Client.cpp`, `abort_long_poll`), quem
     * termina o long poll pendente e a CHEGADA de um `getUpdates` novo, nao a
     * duracao dele — e esta ferramenta, chegando depois, e a que chega por
     * ultimo. O efeito de ~150 sondagens curtas ao longo do TTL sobre um worker
     * ja a fazer long polling NAO FOI MEDIDO: medi-lo exige trafego autenticado
     * contra `api.telegram.org`, que este repositorio proibe.
     *
     * O QUE SUSTENTAMOS, e que e o essencial: com `offset: 0` esta ferramenta
     * NUNCA CONFIRMA nada, logo nunca apaga do servidor um update de que o
     * worker precise. Nenhuma mensagem se perde por causa dela.
     *
     * O QUE SE FAZ COM A PARTE POR CONFIRMAR: a saida do CLI DECLARA a
     * pre-condicao ("o harness nao deve estar a correr com este mesmo bot") em
     * vez de a presumir resolvida, e um `409` que apareca e detectado e explicado
     * em portugues. `docs/spikes/telegram.md` 7 aponta a saida definitiva — o
     * update chega pelo IPC do worker (T4.3) — e e para isso que a sonda entra
     * por injecao.
     */
    getUpdates(token: string): Promise<ResultadoDeUpdates>;
}
export interface OpcoesDaSonda {
    /** Raiz da API. Os testes apontam-na para um servidor local. SEM barra final. */
    readonly apiRoot?: string | undefined;
    /** `fetch` injetavel. Omitido: o global do Node 24. */
    readonly buscar?: typeof fetch | undefined;
    readonly timeoutMs?: number | undefined;
}
export declare function criarSondaHttp(opcoes?: OpcoesDaSonda): SondaTelegram;
/**
 * Resolve a raiz da API do provedor a partir do ambiente.
 *
 * Omissa (ou vazia) = a raiz publica do provedor — o valor que o painel usa
 * quando ninguem apontou para um duplo de teste. Configuravel por
 * `TELEGRAM_API_ROOT` (telegram).
 */
export declare function apiRootDe(provider: ProviderId, ambiente?: Readonly<Record<string, string | undefined>>): string | undefined;
/** Porque o token do provedor nao foi confirmado. Curto e estavel (UI). */
export type MotivoDeFalhaDaProva = 'token-invalido' | 'rede' | 'indisponivel';
/**
 * O probe COMUM: a resposta a "este token vale? o bot tem nome publico?".
 *
 *   - `ok: true` + `botNome` — o token vale e o bot tem nome publico;
 *   - `ok: true` sem `botNome` — o bot EXISTE mas nao tem nome publico (no
 *     Telegram, o `getMe` com HTTP 200 sem `username` — ver {@link criarSonda});
 *   - `ok: false` + `erro` — o token foi recusado, a rede falhou, ou a resposta
 *     nao se interpretou. `erro` e um codigo curto, nunca prosa nem segredo.
 */
export interface ResultadoDeProva {
    readonly ok: boolean;
    readonly botNome?: string | undefined;
    readonly erro?: MotivoDeFalhaDaProva | undefined;
}
/** O probe que a UI consome: confirma o token do provedor ativo. */
export interface SondaDeProvedor {
    verificar(token: string): Promise<ResultadoDeProva>;
}
export interface OpcoesDeSondaDeProvedor {
    /** Raiz da API (duplo de teste). Omissa: a raiz publica do provedor. */
    readonly apiRoot?: string | undefined;
    /** `fetch` injetavel. Omitido: o global do Node 24. */
    readonly buscar?: typeof fetch | undefined;
    readonly timeoutMs?: number | undefined;
}
/**
 * A FABRICA provider-aware: devolve o probe comum para o provedor ativo.
 *
 * O dispatcher e o `ProviderId` FECHADO de `src/proc/env.ts` — um provedor
 * novo acrescenta aqui o ramo e a sua implementacao. Nada no chamador muda.
 */
export declare function criarSonda(provider: ProviderId, opcoes?: OpcoesDeSondaDeProvedor): SondaDeProvedor;
//# sourceMappingURL=sonda.d.ts.map