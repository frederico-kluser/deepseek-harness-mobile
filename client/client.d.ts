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
 * NOMEADOS. Os helpers (`buscarTokenCsrf`, `apiPost`, `formatarContagem`,
 * `chipDoBot`, `rotulosDoProvider`, `normalizarProvider`) são funções puras
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

/** "agora", "3 min atrás"… Contagem regressiva `m:ss` a partir de um prazo epoch ms. */
export function formatarContagem(expiraEm: number, agoraMs: number): string

/**
 * O provedor de mensageria ATIVO do host. O host ainda NÃO emite o campo
 * `provider` no GET /telegram (a paridade vem na onda do host); o painel
 * consome-o quando existir e cai no default `'telegram'` sem ele.
 */
export type TipoProvider = 'telegram' | 'discord'

/**
 * Os rótulos de ONBOARDING por provedor (o mapa local do client, com fallback
 * 'telegram'). O passo 1 ("Criar o bot") e todo texto que cita o canal de
 * criação, a variável de ambiente do token ou a conversa do provedor saem
 * daqui. Os valores do discord são GENÉRICOS apontando para a documentação
 * oficial (a Onda 3/6 refina os textos exatos). Placeholders de render:
 * `{codigo}`, `{ref}` e `{handle}` são substituídos no ponto de uso.
 */
export interface RotulosDoProvider {
  /** O canal/portal onde se cria o bot do provedor (ex.: `@BotFather`). */
  readonly botFather: string
  /** A variável de ambiente do token do provedor. */
  readonly tokenVar: string
  /** O placeholder do campo do token. */
  readonly tokenPlaceholder: string
  /** O texto do formulário do Passo 1 ("Cole o token…"). */
  readonly coleToken: string
  /** O rótulo do campo do token. */
  readonly rotuloCampoToken: string
  /** O loading do botão "Salvar bot" (ex.: "A conectar ao Telegram…"). */
  readonly conectando: string
  /** Os passos numerados do cartão "Como criar o bot do zero". */
  readonly criacao: readonly string[]
  /** Nota curta do fim do cartão de criação (trocar/revogar o token). */
  readonly notaCriacao: string
  /** Nota OPCIONAL de bot privado do cartão de criação. */
  readonly notaPrivado: string
  /** Erro 400 de formato (ex.: "Formato errado. O token vem assim…"). */
  readonly formatoInvalido: string
  /** Erro 422 — o provedor recusou o token. */
  readonly tokenRecusado: string
  /** Aviso 409 — a variável de ambiente do provedor manda. */
  readonly envManda: string
  /** A linha curta antes do código ("No Telegram, envia:"). */
  readonly naConversa: string
  /** A instrução final do pareamento; placeholders `{codigo}` e `{ref}`. */
  readonly parearNoBot: string
  /** O intro da aba ("Acesso remoto ao Harness pelo Telegram…"). */
  readonly acessoIntro: string
  /** Aviso de descoberta com handle; placeholder `{handle}`. */
  readonly encontravel: string
  /** Badge "não encontrável na busca". */
  readonly naoEncontravel: string
  /** Os passos de remoção do username (cartão Privacidade). */
  readonly passosRemoverUsername: readonly string[]
  /** Nota "Sem username o bot deixa de aparecer…"; placeholder `{handle}`. */
  readonly semUsernameNota: string
  /** O texto do `<details>` "E minha conversa?" (checkpoint 3). */
  readonly ckpt3Conversas: string
}

/**
 * Os rótulos do provedor ATIVO, com fallback 'telegram': um valor ausente ou
 * desconhecido cai no telegram — o único provedor real hoje.
 */
export function rotulosDoProvider(provider?: TipoProvider | null): RotulosDoProvider

/**
 * Normaliza o campo `provider` do GET /telegram (opcional; o host ainda não o
 * emite) para um TipoProvider: só `'discord'` e `'telegram'` passam; qualquer
 * outro valor (incl. `undefined`) cai no `'telegram'`.
 */
export function normalizarProvider(valor: unknown): TipoProvider

/**
 * O estado do token devolvido por `GET /token-state`. O `fonte` é o literal do
 * backend (`env`/`secrets`/`nenhum`), mantido em linha aqui porque o alias
 * `FonteDoToken` do fonte não é exportado.
 */
export interface EstadoDoToken {
  readonly configurado: boolean
  readonly handle?: string | null
  readonly fonte: 'env' | 'secrets' | 'nenhum'
}

/**
 * O estado AO VIVO do bot devolvido por `GET /telegram` (online/offline +
 * motivo/handle). O `provider` é OPCIONAL: o host ainda não o emite; quando o
 * emitir, o painel usa-o para escolher os rótulos de onboarding (fallback
 * 'telegram').
 */
export interface EstadoTelegrama {
  readonly online: boolean
  readonly motivo?: string
  readonly handle?: string
  readonly provider?: TipoProvider
}

/** Um chip de estado do cabeçalho (tom + rótulo + detalhe opcional). */
export type EstadoChip =
  | { readonly tom: 'ok'; readonly rotulo: string; readonly detalhe?: string }
  | { readonly tom: 'aviso'; readonly rotulo: string; readonly detalhe?: string }
  | { readonly tom: 'neutro'; readonly rotulo: string; readonly detalhe?: string }

/**
 * O chip do cabeçalho, estendido com o estado AO VIVO do bot: verde "Online"
 * quando `/telegram` está online (detalhe `@handle` ou a fonte do token),
 * aviso "Offline" com o `motivo` quando não; "verificando…" enquanto carrega;
 * comportamento atual do chip de token quando o token não está configurado.
 * O `<provider>` (opcional, default 'telegram') só troca o rótulo da variável
 * de ambiente no detalhe de env — o estado do bot é provider-agnóstico.
 */
export function chipDoBot(token: EstadoDoToken | null, telegrama: EstadoTelegrama | null, provider?: TipoProvider): EstadoChip