/**
 * =============================================================================
 * dsh-guard-messenger -- RAIZ DE COMPOSICAO
 * Plugin Cordis v4 para o DeepSeek Harness (DSH) v0.1
 * =============================================================================
 *
 * Este ficheiro FIA MODULOS. Nao implementa regra: cada decisao vive no seu
 * modulo (`src/http/**`, `src/proc/**`, `src/config/**`, ...) e este ponto de
 * entrada limita-se a `name`, `inject` e `apply`. Enquanto tudo isto era um so
 * ficheiro de 1836 linhas, toda onda do plano tinha paralelismo 1.
 *
 * TRES RESPONSABILIDADES, na ordem em que `apply()` as instala:
 *
 *   1. ENDURECIMENTO DO PLANO DE CONTROLO
 *      Bind de loopback obrigatorio, allowlist de origens remotas fail-closed e
 *      o veto de elevacoes para `danger-full-access` como DEFESA EM PROFUNDIDADE
 *      -- nao como travao principal: ver a nota extensa no ouvinte
 *      `security/permission-elevate` mais abaixo.
 *
 *   2. BARREIRA HTTP REVERSIVEL
 *      Troca de dono do despacho no `node:http.Server` do `ctx.webServer`, com
 *      Basic Auth avaliada por `ctx.waterfall('http/auth-check', ...)`. Nenhuma
 *      biblioteca externa: so `node:http` (tipos) e `node:crypto`. A mecanica
 *      esta em `src/http/intercept.ts`, e o PORQUE de nao ser `ctx.intercept`
 *      esta la, no cabecalho.
 *
 *   3. ORQUESTRACAO ATOMICA DO WORKER DE LONG-POLLING
 *      O processo filho vive dentro de um `ctx.effect()`, cujo disposer SINCRONO
 *      aborta, mata a arvore processual e cancela o temporizador de reinicio. A
 *      Fiber do Cordis erradica tudo em LIFO.
 *
 *   4. O DISPATCHER DE AGENTES (EMENDA ONDA-4-AGENTS-HOST)
 *      O `AgentRegistry` (`src/agents/registry.ts`) vive num `ctx.effect`
 *      proprio, entre o controlador e o worker: o disposer SINCRONO mata os
 *      runs ativos em LIFO (fire-and-forget no dispose do harness — a garantia
 *      LIFO da Fiber nao admite Promise no disposer, Q-2). O dispatch so corre
 *      com `ctx.subagents` (INJETADO — o nome real do servico do harness) e
 *      `ctx.agents`/`ctx.skills` (lidos LAZY, nunca injetados: a ausencia
 *      deles nao pode segurar a Fiber deste plugin — o mesmo perigo do
 *      `logger` documentado abaixo).
 *
 * PORQUE E QUE ISTO EXISTE
 *   A discussao oficial #853 ("unauthenticated local/remote code execution via
 *   the dsh web UI control plane", verificada em 0.1.0-rc.6) demonstra que a
 *   sub-estacao `/api` do DSH responde a sockets SEM qualquer credencial. Entre
 *   as suas mais de 60 rotas RPC esta `commands/execute`, capaz de injetar
 *   `/permission danger-full-access` e derrubar o confinamento `workspace-write`
 *   do Sandbox (fuga documentada em #1769). Este plugin e o portao que fecha
 *   essa superficie.
 *
 * CONVENCOES APLICADAS AQUI
 *   - "fail loud at load" (Q-3): configuracao invalida ou bind inseguro fazem
 *     `throw` no `apply()`. Nunca `?? valor_por_omissao` numa decisao de
 *     seguranca.
 *   - "explicit > implicit": tudo o que e politica de seguranca vem da
 *     configuracao, nada e inferido.
 *   - Reversibilidade atomica (Q-2): TODO registo propaga um disposer SINCRONO.
 * =============================================================================
 */
import { type Config } from './config/schema.ts';
import type { Context } from './dsh/adapter.ts';
import type { TunnelSnapshot } from './contracts/tunnel.ts';
/**
 * O RESOLUTOR DE ORIGEM DO PAINEL -- reexportado, e agora o UNICO que existe.
 *
 * `PanelDeps.resolveOrigin` precisa de decidir o ESQUEMA do pedido para poder
 * emitir o cookie `__Host-dsh_sid`, e a decisao correcta depende de
 * `exposure.mode` -- que o painel nao conhece e esta raiz sim. O JSDoc de
 * {@link createRequestOriginResolver} explica porque a condicao e o MODO (mais
 * "chegou pelo nome do tunel") e nao o HOST: uma instalacao em LAN e
 * nao-loopback e nao tem borda nenhuma a frente, e a medicao R10 que legitima o
 * `X-Forwarded-Proto` e sobre a BORDA da Cloudflare, nao sobre "vir de fora".
 *
 * O QUE MUDOU NA COSTURA DA ONDA 3: `src/panel/routes.ts` tinha um
 * `defaultResolveOrigin` local, com a condicao larga e errada, e
 * `PanelDeps.resolveOrigin` era OPCIONAL -- ou seja, o painel usava o resolutor
 * errado por omissao. O default foi eliminado e o campo passou a OBRIGATORIO:
 * quem compuser o painel (T5.3) nao consegue esquecer-se, porque o `tsc` recusa.
 *
 * A INSTANCIACAO nao acontece nesta raiz porque o painel ainda NAO E MONTADO em
 * producao -- nenhuma rota `/__guard/*` esta servida nesta arvore; a montagem e
 * de T5.3, na Onda 5. Instanciar aqui um resolutor sem chamador seria o mesmo
 * codigo dormente que esta onda removeu do portao. O que a costura garante e que
 * a montagem, quando vier, so pode usar este.
 */
export { createRequestOriginResolver } from './http/session-auth.ts';
import { type GuardLogger } from './logging/logger.ts';
import { type OrphanSweepDeps } from './tunnel/pidfile.ts';
export { PLUGIN_NAME } from './errors.ts';
export type { Config, BackoffConfig, ControlConfig } from './config/schema.ts';
export { shouldAutoStartTunnel, resolveExposure } from './config/schema.ts';
/**
 * As UNICAS portas que o portao deixa passar sem credencial.
 *
 * PORQUE EXISTEM, e porque sao exatamente estas tres. A barreira e dona do
 * despacho e guarda a superficie INTEIRA -- incluindo o painel. Sem excecao
 * nenhuma nao haveria como AUTENTICAR: as tres rotas abaixo sao os passos que
 * ANTECEDEM a existencia de uma sessao, e cada uma traz a sua propria credencial
 * de uso unico em vez de depender da que ainda nao existe.
 *
 *   `/__guard/magic`     GET inerte + POST que consome o `mk` do link do Telegram;
 *   `/__guard/secret`    mostra o segredo UMA vez, destrancado por um `ott`;
 *   `/__guard/api/login` cria a sessao a partir do segredo (rota de T3.4).
 *
 * ISENCAO DE L3, E SO DE L3: `trustedRemotes` (L2) e o `Host` (L2.5) continuam a
 * correr sobre elas. Uma porta sem credencial aberta a rede inteira nao e uma
 * porta, e um buraco.
 *
 * >>> QUEM ACRESCENTAR UMA LINHA AQUI ESTA A ABRIR UMA ROTA SEM CREDENCIAL. <<<
 * A lista e curta de proposito, e a comparacao e por SEGMENTO (`isGuardedPath`):
 * `/__guard/magic` NAO cobre `/__guard/magico`.
 */
export declare const UNAUTHENTICATED_PANEL_PREFIXES: readonly string[];
/**
 * CANAL LOCAL APENAS -- 404 quando o pedido nao chega por um nome de loopback.
 *
 * ===========================================================================
 * ISTO FECHA UM FURO REAL, e vale a pena o furo ficar escrito.
 * ===========================================================================
 * `/__guard/secret` esta -- e continua -- na lista de isencao acima, porque quem
 * o vem buscar e precisamente quem ainda NAO tem o segredo: exigir credencial ali
 * era um ciclo. Eu tinha justificado a isencao com "L2 (`trustedRemotes`) e L2.5
 * (`Host`) continuam a correr". O raciocinio estava certo; a PREMISSA nao:
 *
 *   sob `cloudflared`, quem abre o socket e o `cloudflared`, que corre em
 *   `127.0.0.1` e portanto passa L2; e a origem do tunel e DELIBERADAMENTE
 *   acrescentada a allowlist de `Host` enquanto ele esta `READY`, logo passa
 *   L2.5. As duas camadas defendem de outros processos locais e de DNS
 *   rebinding -- nao da internet que o tunel deixa entrar de proposito.
 *
 * O resultado era `GET https://<x>.trycloudflare.com/__guard/secret?ott=<token>`
 * a servir o SEGREDO PERSISTENTE em texto claro, da internet publica, sem
 * credencial. `02-SEGURANCA.md` 4.4 e literal em sentido contrario: **"Canal
 * local apenas, sem excecao"**.
 *
 * O `ott` nao salva isto sozinho, e e por isso que a invariante importa mais do
 * que a aritmetica dele: 128 bits, uso unico e 10 minutos tornam a forca bruta
 * inviavel, mas o token e impresso no STDOUT DO TERMINAL -- vive em scrollback,
 * em multiplexador, em gravacao de sessao, em captura de ecra, no historico de
 * quem faz copiar-colar. O desenho inteiro tolera isso PORQUE a rota so e
 * alcancavel de quem ja esta na maquina.
 *
 * >>> AS OUTRAS DUAS ENTRADAS NAO ENTRAM AQUI, E ISSO E DELIBERADO. <<<
 * `/__guard/magic` existe precisamente para ser aberto do telemovel PELO TUNEL,
 * e `/__guard/api/login` TEM de ser alcancavel de fora ou nao ha como
 * autenticar. Trancar qualquer uma das duas no loopback nao endurecia nada --
 * partia o produto.
 */
export declare const LOOPBACK_ONLY_PREFIXES: readonly string[];
/** Nome do PLUGIN (identidade do modulo perante o motor Cordis). */
export declare const name = "dsh-guard-messenger";
/**
 * Injecao de dependencias (composicao espacial). O motor so ativa a Fiber deste
 * plugin depois de `ctx.webServer` e `ctx.subprocess` estarem disponiveis -- e
 * descarta-a de novo se alguma desaparecer.
 *
 * `webServer` (e nao `httpServer`) e o nome REAL do servico na linha que o
 * harness resolve. Ver o cabecalho de `src/dsh/adapter.ts`.
 *
 * E esta injeccao que garante a PRECONDICAO da barreira: o `WebServer` ja passou
 * por `[Service.init]` e o seu `node:http.Server` ja esta a escutar, portanto ja
 * tem despacho para nos tomarmos.
 *
 * -----------------------------------------------------------------------------
 * PORQUE `logger` NAO ESTA AQUI -- e nao pode voltar a estar.
 *
 * `LoggerService` NAO estende `Service` (`types/cordis/logger.d.ts:96`:
 * `export declare class LoggerService {`, contra `class WebServer extends
 * Service`). Nao entra no reflect store: o Context raiz cria-o como propriedade
 * PROPRIA (`this.logger = new LoggerService(self)`), pelo que `ctx.get('logger')`
 * devolve `undefined`. Uma Fiber que injecte `'logger'` fica PENDING para sempre
 * -- `apply()` NUNCA corre, e nao ha erro nem log.
 *
 * Medido contra o cordis real: `inject: ['webServer','subprocess']` -> fiber
 * ACTIVE; acrescentando `'logger'` -> fiber PENDING, `_store` so com
 * `['webServer','subprocess']`, e o E2E responde 200 sem credencial nenhuma.
 *
 * E a MESMA CLASSE DE FALHA que a barreira desta onda existe para corrigir:
 * `inject: string[]` aceita qualquer string em silencio, o `tsc` passa, e o
 * defeito e invisivel -- tal como `ctx.intercept(name, config: any)` aceitava um
 * objeto de metodos e nao fazia nada. `ctx.logger` continua acessivel sem
 * injeccao, que e como todos os pacotes DSH publicados o usam.
 * -----------------------------------------------------------------------------
 */
export declare const inject: string[];
/**
 * Ativa o plugin na Fiber corrente.
 *
 * A ORDEM DOS `ctx.effect` E DELIBERADA, porque os disposers correm em LIFO: o
 * worker e o primeiro a ser erradicado quando a Fiber transita para DISPOSED, e
 * so depois a barreira e levantada. Levantar a barreira primeiro deixaria uma
 * janela em que o plano de controlo responde sem credencial enquanto o worker
 * ainda esta vivo.
 */
/**
 * O FAN-OUT de estado para as superficies assinantes (a UI nativa de T5.5).
 *
 * W2 da revisao T5.5: o REPLAY IMEDIATO e CONTRATO — assinar entrega o
 * estado corrente JA, e depois cada difusao chega por `emitir`. O desassinar
 * e sincrono e idempotente; um observador que lance nao derruba o fan-out
 * (best-effort, registado).
 */
export declare function criarFanoutDeEstado(lerAtual: () => {
    readonly seq: number;
    readonly snapshot: TunnelSnapshot;
}, log: GuardLogger): {
    assinar(listener: (broadcast: {
        readonly seq: number;
        readonly snapshot: TunnelSnapshot;
    }) => void): () => void;
    emitir(): void;
};
export declare function apply(ctx: Context, config: Config, options?: {
    readonly bootSweep?: OrphanSweepDeps;
}): void;
//# sourceMappingURL=index.d.ts.map