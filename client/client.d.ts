/**
 * Declaração de tipos do subpath `dsh-guard-messenger/client`
 * (`exports["./client"]` — o bundle do dsh.client, `lib/client.js`).
 *
 * PORQUE ESTE FICHEIRO EXISTE
 * ----------------------------------------------------------------------------
 * `lib/client.js` é gerado por `scripts/build-client.mjs` no formato
 * closure-factory do harness DSH:
 *
 *     window.__ModuleLoader__.load({ id: "<pkg>", factory: (require) => {
 *       var module = { exports: {} }; var exports = module.exports;
 *       ...
 *       module.exports = __toCommonJS(index_exports);   // apply, inject, ...
 *       return module.exports;
 *     } });
 *
 * O tarball tem de expor TIPOS ao lado do ficheiro — sem um `lib/client.d.ts`
 * o `attw` reprova o subpath com `UntypedResolution` ("No types"). Por isso o
 * `exports["./client"]` referencia este `.d.ts` como o seu bloco `types`.
 *
 * Este ficheiro em `client/` (FONTE, commited) é COPIADO pelo
 * `build-client.mjs` para `lib/client.d.ts` (PRODUTO de build, gitignored) —
 * a mesma viagem que `lib/client.js` — de modo que o tarball leva ambos de
 * forma determinística (`prepare`/`prepack` correm `build:client`). Editar
 * aqui e re-correr `pnpm build:client`; NUNCA editar `lib/client.d.ts` à mão.
 *
 * O CONTRATO TIPADO
 * ----------------------------------------------------------------------------
 * O consumidor (o harness) resolve `dsh-guard-messenger/client` para obter o
 * plugin Cordis do browser: `apply(ctx)` + `inject`. Como `lib/client.js` é
 * tratado como ESM (`"type": "module"` + extensão `.js`), e o runtime devolve
 * `module.exports` com `__esModule: true`, o interop expõe estes EXPORTS
 * NOMEADOS. Os helpers (`buscarTokenCsrf`, `apiPost`, `normalizarUserAgent`,
 * `tempoRelativo`, `encurtarIdentidade`, `formatarContagem`) são funções puras
 * exportadas do fonte `client/index.ts` para o smoke de teste; entram no
 * bundle e ficam declarados aqui para a superfície corresponder ao que o
 * bundle realmente exporta (`module.exports = __toCommonJS(index_exports)`).
 *
 * Ver `client/index.ts` (a única fonte de verdade das assinaturas) e
 * `docs/SPIKE-CLIENT-SLOTS.md`.
 */

/** Serviços Cordis que o `apply` exige no `ctx` (o plugin injeta `slots`). */
export const inject: readonly ['slots']

/** Contrato do contexto raiz Cordis do browser, reduzido ao que o plugin toca. */
export interface DshClientCtx {
  readonly slots: {
    inject(key: string, cb: () => unknown): unknown
    register(options: unknown, component: unknown): unknown
  }
}

/**
 * Resposta unificada dos POSTs do painel. `csrfIndisponivel` marca o POST que
 * NÃO chegou a sair porque nenhuma fonte de CSRF deu (recusa clara).
 */
export interface RespostaPost {
  readonly status: number
  readonly dados: Record<string, unknown>
  readonly csrfIndisponivel: boolean
}

/** Regista a contribuição do painel: injeta o CSS e a aba "Remote Access". */
export function apply(ctx: DshClientCtx): void

/**
 * O token anti-CSRF a usar num POST: fonte preferida `GET /__guard-ui/api/csrf`
 * (HIGH-2), com fallback ao `<meta name="dsh-guard-ui-csrf">` do chrome antigo.
 * `''` = nenhuma fonte deu → o POST recusa com mensagem clara.
 */
export function buscarTokenCsrf(documento: Document): Promise<string>

/** POST JSON com o header `x-dsh-csrf`. Rede falhou ⇒ `{status:0}`; sem CSRF ⇒ `{status:0, csrfIndisponivel:true}`. */
export function apiPost(caminho: string, corpo: Record<string, unknown>, documento: Document): Promise<RespostaPost>

/** Normaliza o userAgent → `<navegador> no <aparelho/OS>`; devolve o userAgent cru como fallback. */
export function normalizarUserAgent(userAgent: string): string

/** "agora", "3 min atrás", "2 h atrás", "5 d atrás" — relativo a `agora`. */
export function tempoRelativo(milissegundos: number, agora: number): string

/** O hash truncado a 8 chars — a identidade visual da sessão, nunca o ?key nem o id. */
export function encurtarIdentidade(hash: string): string

/** "agora", "3 min atrás"… Contagem regressiva `m:ss` a partir de um prazo epoch ms. */
export function formatarContagem(expiraEm: number, agoraMs: number): string