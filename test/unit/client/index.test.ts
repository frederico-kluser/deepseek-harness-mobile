/**
 * SMOKE HEADLESS do bundle `lib/client.js` (dsh.client) + a cobertura do CSRF
 * novo (HIGH-2): a fonte `GET /__guard-ui/api/csrf` em vez do meta antigo.
 *
 * O QUE ESTA SUITE PROVA (as perguntas falsificaveis):
 *  1. O bundle compilado registra-se no `window.__ModuleLoader__` do harness e
 *     o `apply(ctx)` com um `ctx.slots` stub regista SEM excecao o slot
 *     `settings.section` (a aba "Remote Access") — o botao da sidebar
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
      assert.equal(registro.id, 'dsh-guard-messenger')
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

  // O cartão "Como criar o bot" (@BotFather) tem de existir como conteúdo
  // dobrado num <details> "Como criar o bot do zero" (progressive disclosure).
  assert.ok(codigo.includes('Como criar o bot'), 'o bundle deve conter o título do cartão "Como criar o bot"')
  assert.ok(codigo.includes('@BotFather'), 'o bundle deve referenciar o @BotFather')
  assert.ok(codigo.includes('/newbot'), 'o bundle deve conter o passo /newbot')
  assert.ok(codigo.includes('Salvar bot'), 'o bundle deve conter o CTA primário "Salvar bot" do Passo 1')
  assert.ok(codigo.includes('use /token no @BotFather'), 'o bundle deve conter a nota de revogação /token')
  // O passo opcional de privacidade (remover username) tem de estar no cartão do BotFather.
  assert.ok(codigo.includes('bot privado'), 'o bundle deve conter a nota de privacidade do BotFather')
})

/**
 * O cartão "Privacidade — só para você" (Onda 2 — bot privado), nos TRÊS
 * estados, verificado como conteúdo compilado do bundle (mesma fidelidade de
 * smoke dos restantes cartões — o repo não monta React em DOM; ver a nota
 * "FORA DE ESCOPO" do docs/PANEL-TELEGRAM.md).
 *
 * O esbuild foge os caracteres não-ASCII (ex.: `\xE1`, `\u2014`) no bundle,
 * por isso as assertions usam SUBSTRINGS ASCII-ONLY present e distintivos.
 *
 *  - ok + handle presente  → aviso "encontrável na busca" + passo `/setusername`;
 *  - ok + handle ausente   → badge verde "Não encontrável na busca" (getMe real
 *    confirmou sem username);
 *  - !ok                   → estado neutro "não foi possível verificar agora" +
 *    botão "Verificar de novo" (nunca um verde mentiroso).
 * É o cartão ao VIVO: o client NÃO decide a descoberta por `token?.handle`,
 * consulta a rota `/api/privacidade` (com `?forcar=true` no botão).
 */
test('bundle: o cartão Privacidade existe nos TRÊS estados (ao vivo, não por token-state)', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = readFileSync(BUNDLE_PATH, 'utf8')

  // Título fixo do cartão.
  assert.ok(codigo.includes('Privacidade'), 'o bundle deve conter o título do cartão Privacidade')

  // O cartão consulta AO VIVO: a rota /api/privacidade e o forcar do botão.
  assert.ok(codigo.includes('/privacidade'), 'o bundle deve consultar a rota /api/privacidade')
  assert.ok(codigo.includes('forcar=true'), 'o botão "Verificar de novo" deve forçar o recálculo')

  // Estado A — handle presente: aviso + passo-a-passo de remoção do username.
  assert.ok(codigo.includes('na busca do Telegram como @'), 'aviso de descoberta com handle')
  assert.ok(codigo.includes('/setusername'), 'o passo de remoção deve referenciar /setusername do BotFather')
  assert.ok(codigo.includes('remova o username'), 'o aviso/passo deve mandar remover o username')

  // Estado B — handle ausente/null: badge positivo (verde legítimo).
  assert.ok(codigo.includes('acha o bot no Telegram'), 'o bundle deve conter o badge positivo sem handle')

  // Estado C — !ok (indisponível): estado NEUTRO honesto + botão "Verificar de novo".
  assert.ok(codigo.includes('verificar agora'), 'o bundle deve conter o estado neutro de indisponível')
  assert.ok(codigo.includes('Verificar de novo'), 'o bundle deve conter o botão "Verificar de novo"')

  // Bloco de garantias, presente em TODOS os estados.
  assert.ok(codigo.includes('Se algu'), 'o bloco de garantias tem de existir')
  assert.ok(codigo.includes('default deny'), 'a garantia de deny-by-default deve estar listada')
  assert.ok(codigo.includes('contados na auditoria'), 'a garantia de recusa silenciosa/contada deve estar listada')

  // O @handle é público (mostrado noutro ponto do painel); mas o bundle nunca
  // contém um valor real de código/token (só a placeholder estática do input,
  // pre-existente — que não é um valor real).
  assert.ok(!/TELEGRAM_BOT_TOKEN\s*=\s*[0-9]+:[A-Za-z0-9_-]+/u.test(codigo), 'nenhum valor de token real no bundle')
})

/**
 * A logo do plugin entra no topo da aba "Remote Access" (Onda 3). Verificado
 * como conteúdo compilado do bundle — o smoke não renderiza React (mesma nota
 * do docs/PANEL-TELEGRAM.md). O esbuild foge não-ASCII, por isso as assertions
 * usam SUBSTRINGS ASCII-ONLY: o alt `dsh-guard-messenger` e o prefixo da data
 * URL `data:image/png;base64` (loader `dataurl` do esbuild embrutece o PNG).
 * NÃO há assert de tamanho (o tamanho exato do base64 depende da codificação).
 */
test('bundle: a logo aparece embutida (data URL PNG) com o alt ASCII', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = readFileSync(BUNDLE_PATH, 'utf8')

  // A logo deve estar EMBUTIDA no bundle como data URL base64 — o harness serve
  // SÓ lib/client.js, sem side-cars, por isso é `data:image/png;base64`, nunca
  // um caminho externo para logo.png.
  assert.ok(codigo.includes('data:image/png;base64'), 'o bundle deve conter a logo embutida como data:image/png;base64')
  // A primeira linha do header do PNG (`\x89PNG`) base64 é sempre `iVBOR`.
  assert.ok(codigo.includes('iVBORw0KGgo'), 'o base64 deve começar pelo magic byte padrão do PNG')

  // O alt ASCII da logo está no render do bloco de marca.
  assert.ok(codigo.includes('guard-brand'), 'o bundle deve conter o bloco de marca guard-brand')
  assert.ok(codigo.includes('dsh-guard-messenger'), 'o bundle deve conter o alt ASCII dsh-guard-messenger')

  // Rebrand "Remote Access" (Onda 1 — nome e botões): o nome VISÍVEL do painel
  // mudou para "Remote Access"; o id/registrant ASCCI `telegram-guard` segue.
  assert.ok(codigo.includes('Remote Access'), 'o bundle deve conter o nome visível "Remote Access"')
  assert.ok(codigo.includes('telegram-guard'), 'o bundle deve manter o id/registrant ASCII telegram-guard')
  assert.ok(!codigo.includes('Telegram Guard'), 'o antigo nome visível "Telegram Guard" deve ter saído do bundle')

  // O bundle NÃO referencia o ficheiro como caminho externo (side-car).
  assert.ok(!/src=["']logo\.png["']/u.test(codigo), 'a logo não pode ser referenciada por caminho externo no bundle')
})

test('bundle: a trilha de 3 checkpoints está presente e o pareamento NÃO loga o código', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = readFileSync(BUNDLE_PATH, 'utf8')

  // A trilha (só o passo atual aberto). O cabeçalho é `Passo ${indice} de 3 ·
  // <titulo>` — os títulos dos checkpoints entram como literais; o "de 3" é a
  // parte estática da template que o esbuild mantém junta.
  assert.ok(codigo.includes('Criar o bot'), 'o bundle deve conter o título do Passo 1 "Criar o bot"')
  assert.ok(codigo.includes('de 3'), 'o bundle deve conter o sufixo do cabeçalho "Passo N de 3"')
  assert.ok(codigo.includes('Passo 2: parear'), 'o bundle deve conter o incentivo "Passo 2: parear" do vazio do Passo 1')

  // Passo 1 — CTA primário "Salvar bot" e o loading honesto.
  assert.ok(codigo.includes('Salvar bot'), 'o bundle deve conter o CTA "Salvar bot"')
  assert.ok(codigo.includes('A conectar ao Telegram'), 'o bundle deve conter o loading "A conectar ao Telegram…"')
  assert.ok(codigo.includes('Revisar token'), 'o bundle deve conter a ação de erro "Revisar token"')

  // Passo 2 — pareamento VIA PAINEL.
  assert.ok(codigo.includes('Gerar novo'), 'o bundle deve conter as ações "Gerar novo" / "Gerar novo código"')
  assert.ok(codigo.includes('Copiar'), 'o bundle deve conter o botão "Copiar" do código')
  assert.ok(codigo.includes('Aguardando'), 'o bundle deve conter o status ao vivo "Aguardando…"')
  assert.ok(codigo.includes('No Telegram, envia'), 'o bundle deve conter a instrução UMA final do pareamento')
  // CONVERSA INTELIGENTE (04): o Passo 2 anuncia o modo hibrido — so `/parear`
  // e o bot PERGUNTA o codigo. Substring ASCII-only (`pede o c` de "o bot pede
  // o código"), porque o esbuild foge os acentos.
  assert.ok(codigo.includes('pede o c'), 'o bundle deve anunciar que o bot pede o código (modo híbrido)')

  // Passo 3 — comandos essenciais + Avançado + privacidade + Uso recente.
  assert.ok(codigo.includes('Comandos essenciais'), 'o bundle deve conter os comandos essenciais do Passo 3')
  assert.ok(codigo.includes('/emergencia'), 'o bundle deve conter o comando essencial /emergencia')
  assert.ok(codigo.includes('E minha conversa'), 'o bundle deve conter o <details> "E minha conversa?"')
  assert.ok(codigo.includes('Uso recente'), 'o bundle deve conter o bloco "Uso recente"')

  // Os rótulos ANTIGOS desapareceram da trilha.
  assert.ok(!codigo.includes('Parear pelo Telegram'), 'o botão/cartão antigo "Parear pelo Telegram" deve ter saído')
  assert.ok(!codigo.includes('Validar e configurar'), 'o CTA antigo "Validar e configurar" deve ter saído')
  assert.ok(!codigo.includes('Envie na conversa com'), 'a instrução antiga "Envie na conversa com" deve ter saído')

  // NUNCA deve existir um console.log do código nem do token no bundle.
  assert.ok(!/console\.log\(\s*codigo\s*\)/u.test(codigo), 'não pode haver console.log(codigo) no bundle')
  assert.ok(!/console\.log\(\s*par\b/u.test(codigo), 'não pode haver console.log do estado de pareamento no bundle')
})

test('bundle: formatarContagem exporta o countdown m:ss (expiração + formato)', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const fmt = modulo.formatarContagem as (expiraEm: number, agoraMs: number) => string

  assert.equal(fmt(1_000_000_000, 1_000_000_000 - 60_000 - 5_000), '1:05')
  assert.equal(fmt(1_000_000_000, 1_000_000_000 - 245_000), '4:05')
  assert.equal(fmt(1_000_000_000, 1_000_000_000), '0:00', 'no prazo, 0:00')
  assert.equal(fmt(1_000_000_000, 1_000_000_000 + 10_000), '0:00', 'já expirou, 0:00')
  void chamadas
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