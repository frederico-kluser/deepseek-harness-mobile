/**
 * SMOKE HEADLESS do bundle `lib/client.js` (dsh.client) + a cobertura do CSRF
 * novo (HIGH-2): a fonte `GET /__guard-ui/api/csrf` em vez do meta antigo.
 *
 * O QUE ESTA SUITE PROVA (as perguntas falsificaveis):
 *  1. O bundle compilado registra-se no `window.__ModuleLoader__` do harness e
 *     o `apply(ctx)` com um `ctx.slots` stub regista SEM excecao o slot
 *     `settings.section` (a aba "Telegram Guard") — o botao da sidebar
 *     `sidebar.footer.action` foi REMOVIDO e NAO deve mais ser registado. O
 *     smoke do docs/PANEL-TELEGRAM.md ("COMO TESTAR var-smoke headless"), agora
 *     num teste `test/unit/**` em vez do executavel ad-hoc.
 *  2. A fonte de CSRF preferida do bundle e a GET `/csrf` (HIGH-2): o
 *     `buscarTokenCsrf()` chama `/__guard-ui/api/csrf` e usa o `token`
 *     devolvido — NAO o meta do chrome antigo.
 *  3. O fallback correto: se a GET /csrf falhar, o bundle cai no
 *     `<meta name="dsh-guard-ui-csrf">` (compat reversa com o chrome antigo);
 *     se nem isso der, devolve '' e o `apiPost` recusa com
 *     `csrfIndisponivel:true` (mensagem clara no painel).
 *  4. O `apiPost()` envia o token NOVO no header `x-dsh-csrf` — o fetch stub
 *     regista o header e a suite confirma que e o token/`csrf` recém-buscado.
 *  5. O cartao "Como criar o bot" (@BotFather) faz parte do bundle: as strings
 *     chave dos passos numerados e da nota constam no `lib/client.js` — como o
 *     smoke nao renderiza React, a fidelidade do conteudo e verificada na
 *     string compilada.
 *
 * EXECUCAO: precisa de `pnpm run build:client` ANTES (gera `lib/client.js`).
 * O `pnpm test` roda depois do gate `build:client`; se o ficheiro faltar, a
 * suite salta (skip) em vez de falhar — a verificacao do bundle e no gate,
 * nao num checkout sem build.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

const ROOT = resolve(import.meta.dirname, '../../..')
const BUNDLE_PATH = resolve(ROOT, 'lib/client.js')
const BUNDLE_AUSENTE = !existsSync(BUNDLE_PATH)

/** O dom-fake minimo que o `apply` precisa (asegurarCss). */
function fakeDocument(): { getElementById(): null; createElement(): { id: string; textContent: string }; head: { appended: unknown[]; appendChild(n: unknown): void } } {
  const head = { appended: [] as unknown[], appendChild(n: unknown) { this.appended.push(n) } }
  return {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head,
  }
}

/** Um adereco de `documento` com um meta de CSRF (`querySelector` controlado). */
function documentoComMeta(token: string | null): { querySelector: (sel: string) => { getAttribute(name: string): string | null } | null } {
  return {
    querySelector: (sel: string) => {
      if (sel === 'meta[name="dsh-guard-ui-csrf"]' && token !== null) {
        return { getAttribute: (name: string) => (name === 'content' ? token : null) }
      }
      return null
    },
  }
}

/** Uma resposta fetch fake. */
function fakeResposta(status: number, corpo: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  } as unknown as Response
}

/** Captura as chamadas de fetch: `chamadas[i].url`, `.init`. */
interface ChamadaFetch {
  readonly url: string
  readonly init: RequestInit | undefined
}

function capturarFetch(respostas: Array<{ urlContem: string; metodo?: string; resposta: Response }>): {
  chamadas: ChamadaFetch[]
  fetchStub: typeof fetch
} {
  const chamadas: ChamadaFetch[] = []
  const fetchStub = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    chamadas.push({ url, init })
    const alvo = respostas.find(
      (r) => url.includes(r.urlContem) && (r.metodo === undefined || init?.method === r.metodo),
    )
    if (alvo === undefined) return fakeResposta(404, {})
    return alvo.resposta
  }) as typeof fetch
  return { chamadas, fetchStub }
}

/** Carrega `lib/client.js` num sandbox e devolve `module.exports` do factory. */
function carregarBundle(fetchStub: typeof fetch): Record<string, unknown> {
  const MODULE_LOADER_KEY = '__ModuleLoader__'
  const windowHost: Record<string, unknown> = {}
  let exportsDoModulo: Record<string, unknown> | undefined

  ;(globalThis as Record<string, unknown>).fetch = fetchStub
  ;(globalThis as Record<string, unknown>).window = windowHost

  // O sandbox do Onda 2 (docs/PANEL-TELEGRAM.md §smoke): estica o
  // `__ModuleLoader__.load` para capturar o factory e invoca-lo com um
  // `require` das palavras-seed do harness.
  windowHost[MODULE_LOADER_KEY] = {
    load(registro: { id: string; factory: (requireFn: (id: string) => unknown) => Record<string, unknown> }) {
      assert.equal(registro.id, 'dsh-guarded-bot-orchestrator')
      const seeds: Record<string, unknown> = {
        react: { createElement: () => ({}) },
        'react/jsx-runtime': {},
        'react-dom': {},
        'react-dom/client': {},
        '@deepseek-ai/cordis': {},
        '@deepseek-ai/dsh-client-ui-slots': {},
        '@deepseek-ai/dsh-client-ui-primitives': {},
      }
      exportsDoModulo = registro.factory((id: string) => seeds[id] ?? {})
    },
  }

  // `document` global para o `apply` (asegurarCss).
  const doc = fakeDocument()
  ;(globalThis as Record<string, unknown>).document = doc

  const codigo = readFileSync(BUNDLE_PATH, 'utf8')
  const avaliar = new Function('window', codigo) as (w: Record<string, unknown>) => void
  avaliar(windowHost)

  assert.ok(exportsDoModulo !== undefined, 'o bundle nao registou o factory no __ModuleLoader__')
  return exportsDoModulo
}

test('smoke headless: o bundle exporta apply/inject e o apply regista SÓ settings.section', { skip: BUNDLE_AUSENTE }, () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  assert.equal(typeof modulo.apply, 'function')
  assert.deepEqual(modulo.inject, ['slots'])

  const registrados: string[] = []
  const ctx = {
    slots: {
      inject(key: string, cb: () => unknown): void {
        assert.equal(typeof cb, 'function')
        const options = cb() as { name?: string }
        // o cb devolve o resultado de `ctx.slots.register`
        void options
      },
      register(options: { name: string }, _component: unknown): unknown {
        registrados.push(options.name)
        return options
      },
    },
  }
  ;(modulo.apply as (c: unknown) => void)(ctx)
  assert.deepEqual(registrados.toSorted(), ['settings.section'], 'deve registar SÓ a aba settings.section (sem sidebar.footer.action)')
  void chamadas
})

test('bundle: o botão da sidebar foi removido e o cartão @BotFather está presente', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = readFileSync(BUNDLE_PATH, 'utf8')

  // O botão `sidebar.footer.action` não pode mais estar no bundle (removido).
  assert.ok(!codigo.includes('sidebar.footer.action'), 'sidebar.footer.action deve ter sido removido do bundle')
  assert.ok(!codigo.includes('guard-bot-button'), 'guard-bot-button não pode mais existir no bundle')

  // O cartão "Como criar o bot" (@BotFather) tem de existir como conteúdo.
  assert.ok(codigo.includes('Como criar o bot'), 'o bundle deve conter o título do cartão "Como criar o bot"')
  assert.ok(codigo.includes('@BotFather'), 'o bundle deve referenciar o @BotFather')
  assert.ok(codigo.includes('/newbot'), 'o bundle deve conter o passo /newbot')
  assert.ok(codigo.includes('Validar e configurar'), 'o bundle deve conter o botão "Validar e configurar"')
  assert.ok(codigo.includes('use /token no @BotFather'), 'o bundle deve conter a nota de revogação /token')
})

test('CSRF HIGH-2: buscarTokenCsrf busca /__guard-ui/api/csrf e usa o token novo', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetch([
    { urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, { token: 'TOKEN-FRESCO-ABC' }) },
  ])
  const modulo = carregarBundle(fetchStub)
  const buscar = modulo.buscarTokenCsrf as (doc: { querySelector: (s: string) => unknown | null }) => Promise<string>

  const token = await buscar(documentoComMeta('METO-ANTIGO'))
  assert.equal(token, 'TOKEN-FRESCO-ABC', 'deve preferir o token da GET /csrf')
  assert.equal(chamadas[0]?.url, '/__guard-ui/api/csrf', 'a fonte preferida e a GET /csrf')
})

test('CSRF HIGH-2: GET /csrf indisponivel -> fallback ao meta (chrome antigo)', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const buscar = modulo.buscarTokenCsrf as (doc: { querySelector: (s: string) => unknown | null }) => Promise<string>

  // Sem /csrf na colecao: o stub responde 404, e o fallback le o meta.
  const token = await buscar(documentoComMeta('DO-META'))
  assert.equal(token, 'DO-META', 'a GET /csrf falhou e o meta do chrome antigo valera a pena')
  assert.ok(chamadas[0]?.url.includes('/csrf'))
})

test('CSRF HIGH-2: sem /csrf E sem meta -> apiPost recusa com csrfIndisponivel', { skip: BUNDLE_AUSENTE }, async () => {
  const { fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const post = modulo.apiPost as (
    caminho: string,
    corpo: Record<string, unknown>,
    doc: { querySelector: (s: string) => unknown | null },
  ) => Promise<{ status: number; csrfIndisponivel: boolean }>

  const r = await post('/token', { token: 'x:y' }, documentoComMeta(null))
  assert.equal(r.status, 0)
  assert.equal(r.csrfIndisponivel, true)
})

test('CSRF HIGH-2: apiPost envia o token NOVO no header x-dsh-csrf', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetch([
    { urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, { token: 'NOVO-TOKEN' }) },
    { urlContem: '/__guard-ui/api/token', metodo: 'POST', resposta: fakeResposta(200, { ok: true, handle: 'bot' }) },
  ])
  const modulo = carregarBundle(fetchStub)
  const post = modulo.apiPost as (
    caminho: string,
    corpo: Record<string, unknown>,
    doc: { querySelector: (s: string) => unknown | null },
  ) => Promise<{ status: number; csrfIndisponivel: boolean }>

  const r = await post('/token', { token: '123:ABC' }, documentoComMeta('ANTIGO'))
  assert.equal(r.status, 200)
  assert.equal(r.csrfIndisponivel, false)

  const postChamada = chamadas.find((c) => c.url.includes('/api/token') && c.init?.method === 'POST')
  assert.ok(postChamada !== undefined, 'o POST /token deve ter saido')
  const cabecalhos = (postChamada!.init!.headers ?? {}) as Record<string, string>
  assert.equal(cabecalhos['x-dsh-csrf'], 'NOVO-TOKEN', 'o header deve carregar o token NOVO da GET /csrf')
})