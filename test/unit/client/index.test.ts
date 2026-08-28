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

/** Um fetch stub que REJEITA (queda de rede) nas URLs que casam o predicado. */
function capturarFetchComFalha(
  falhaEm: (url: string, init?: RequestInit) => boolean,
): {
  chamadas: ChamadaFetch[]
  fetchStub: typeof fetch
} {
  const chamadas: ChamadaFetch[] = []
  const fetchStub = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    chamadas.push({ url, init })
    if (falhaEm(url, init)) throw new TypeError('falha de rede simulada (fetch rejeitou)')
    return fakeResposta(404, {})
  }) as typeof fetch
  return { chamadas, fetchStub }
}

/** Uma resposta fake cujo `json()` rejeita (corpo ilegível). */
function fakeRespostaSemJson(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError('corpo ilegível (json() rejeitou)')
    },
  } as unknown as Response
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

  // Passo 3 — comandos essenciais + Avançado + privacidade (Uso recente REMOVIDO).
  assert.ok(codigo.includes('Comandos essenciais'), 'o bundle deve conter os comandos essenciais do Passo 3')
  assert.ok(codigo.includes('/emergencia'), 'o bundle deve conter o comando essencial /emergencia')
  assert.ok(codigo.includes('E minha conversa'), 'o bundle deve conter o <details> "E minha conversa?"')
  // O bloco "Uso recente" (métricas) foi REMOVIDO do Passo 3 — os valores de
  // acesso não devem mais aparecer na tela. A string "Uso recente" em si ainda
  // consta no bundle SÓ por um comentário do CSS embutido (guard-panel.css,
  // que não muda nesta tarefa), por isso a ausência é verificada numa substring
  // ASCII que existia APENAS no bloco removido: o rodapé "Atualizado
  // automaticamente a cada ~15 s..." e o botão "Atualizar" (ambos verificados
  // como 0 no bundle e no CSS). NÃO usar rótulos acentuados como marcador: o
  // esbuild foge não-ASCII (`Conex\xF5es ativas`) e a asserção viraria
  // tautológica, passando mesmo com o bloco presente.
  assert.ok(!codigo.includes('Atualizado automaticamente'), 'o rodapé do bloco removido deve ter saído do bundle')
  assert.ok(!codigo.includes('Atualizar'), 'o botão "Atualizar" do bloco removido deve ter saído do bundle')

  // O chip do cabeçalho reflete o estado AO VIVO do bot (Online/Offline).
  assert.ok(codigo.includes('Online'), 'o bundle deve conter o rótulo do chip "Online"')
  assert.ok(codigo.includes('Offline'), 'o bundle deve conter o rótulo do chip "Offline"')

  // Os rótulos ANTIGOS desapareceram da trilha.
  assert.ok(!codigo.includes('Parear pelo Telegram'), 'o botão/cartão antigo "Parear pelo Telegram" deve ter saído')
  assert.ok(!codigo.includes('Validar e configurar'), 'o CTA antigo "Validar e configurar" deve ter saído')
  assert.ok(!codigo.includes('Envie na conversa com'), 'a instrução antiga "Envie na conversa com" deve ter saído')

  // NUNCA deve existir um console.log do código nem do token no bundle.
  assert.ok(!/console\.log\(\s*codigo\s*\)/u.test(codigo), 'não pode haver console.log(codigo) no bundle')
  assert.ok(!/console\.log\(\s*par\b/u.test(codigo), 'não pode haver console.log do estado de pareamento no bundle')
})

/**
 * Onda 1 — smoke de REGRESSÃO do painel "Remote Access" (contrato do usuário):
 * (1) o remove control "Desfazer parear" está no Avançado; (2) o refresh
 * automático caiu de 15 s para 5 s — o intervalo literal `5000` está no bundle
 * e o antigo `15000` saiu; (3) o bloco "Uso recente" (KPIs/sessões/rodapé) foi
 * REMOVIDO do Passo 3 — os marcadores ASCII que só existiam lá estão ausentes.
 * O `Conex` é o prefixo ASCII de "Conexões ativas": o esbuild foge o não-ASCII
 * (`\xF5`) mas PRESERVA o prefixo, então a ausência prova a remoção sem
 * asserção tautológica (o rótulo acentuado completo jamais casaria no bundle).
 */
test('bundle: Onda 1 — Desfazer parear presente, refresh 5 s e bloco Uso recente removido', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = readFileSync(BUNDLE_PATH, 'utf8')

  // Remove control: o botão "Desfazer parear" (e o texto da confirmação).
  assert.ok(codigo.includes('Desfazer parear'), 'o bundle deve conter o botão "Desfazer parear" do Avançado')
  assert.ok(codigo.includes('Desfazer o parear'), 'o bundle deve conter o texto da confirmação "Desfazer o parear"')

  // Refresh automático: 5 s (novo) presente; 15 s (antigo) ausente. O esbuild
  // imprime o literal numérico na forma mais curta (5000 → `5e3`), por isso o
  // marcador é a forma EMITIDA do intervalo do refresh (`}, 5e3);` — única no
  // bundle; o poll de pareamento é `3e3` e o ticker é `1e3`).
  assert.ok(codigo.includes('}, 5e3)'), 'o bundle deve conter o refresh de 5 s (esbuild imprime 5000 como 5e3)')
  assert.ok(!codigo.includes('15e3'), 'o antigo refresh de 15 s (15000 → 15e3) deve ter saído do bundle')

  // Bloco "Uso recente" removido: os marcadores ASCII do rodapé/botão/KPI saíram.
  assert.ok(!codigo.includes('Atualizado automaticamente'), 'o rodapé "Atualizado automaticamente…" deve ter saído')
  assert.ok(!codigo.includes('Atualizar'), 'o botão "Atualizar" do bloco removido deve ter saído')
  assert.ok(!codigo.includes('Conex'), 'o KPI "Conexões ativas" (prefixo ASCII "Conex") deve ter saído')
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

/**
 * Bordas da contagem regressiva `m:ss` — a expiração EXATA e os limiares de
 * arredondamento (`Math.floor` da diferença em segundos): 0:00 no prazo/passado
 * (nunca 0:60); `0:01` só com ≥ 1000 ms restantes; `1:00` no minuto exato
 * (60_000 ms); `59:59` no teto antes da virada de hora.
 */
test('bundle: formatarContagem — bordas de expiração exata e limiares m:ss', { skip: BUNDLE_AUSENTE }, () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const fmt = modulo.formatarContagem as (expiraEm: number, agoraMs: number) => string
  const BASE = 1_000_000_000

  // Expiração exata: prazo == agora → 0:00 (e não 0:60).
  assert.equal(fmt(BASE, BASE), '0:00', 'expiração exata → 0:00')
  assert.equal(fmt(0, 0), '0:00', 'ambos zerados → 0:00')
  // Passado: qualquer diferença negativa → 0:00.
  assert.equal(fmt(0, 5_000), '0:00', 'prazo 0 com agora > 0 → 0:00')

  // Limiar de arredondamento: < 1 s inteiro zera; ≥ 1000 ms vira 0:01.
  assert.equal(fmt(BASE, BASE - 999), '0:00', '999 ms restantes → 0:00 (floor)')
  assert.equal(fmt(BASE, BASE - 1_000), '0:01', '1000 ms restantes → 0:01')

  // Minuto exato: 60_000 ms → 1:00 (nunca 0:60); 59_999 ms → 0:59.
  assert.equal(fmt(BASE, BASE - 60_000), '1:00', '60 s restantes → 1:00')
  assert.equal(fmt(BASE, BASE - 59_999), '0:59', '59.999 s restantes → 0:59')

  // Teto antes da hora: 59:59.
  assert.equal(fmt(BASE, BASE - 3_599_000), '59:59', '3599 s restantes → 59:59')
  void chamadas
})

/**
 * O chip do cabeçalho (chipDoBot) reflete o estado AO VIVO do bot — a função
 * pura exportada, exercitada nos TRÊS estados pedidos + os de carregamento:
 *  - token configurado + /telegram online  → verde "Online" (@handle ou fonte);
 *  - token configurado + /telegram offline → aviso "Offline" (motivo quando há);
 *  - token NÃO configurado                 → comportamento atual do chipDoEstado;
 *  - estado ainda a carregar (null)        → neutro "verificando…".
 */
test('bundle: chipDoBot reflete o estado do bot (Online/Offline/verificando)', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const chip = modulo.chipDoBot as (
    token: unknown,
    telegrama: unknown,
  ) => { tom: string; rotulo: string; detalhe?: string }

  // Online com @handle: detalhe = @handle.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets', handle: 'meu_bot' }, { online: true, handle: 'meu_bot' }),
    { tom: 'ok', rotulo: 'Online', detalhe: '@meu_bot' },
  )
  // Online sem handle: detalhe = a fonte do token.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets' }, { online: true }),
    { tom: 'ok', rotulo: 'Online', detalhe: 'secrets' },
  )
  // Offline com motivo: aviso + o motivo da rota /telegram.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets' }, { online: false, motivo: 'sem-pareamento' }),
    { tom: 'aviso', rotulo: 'Offline', detalhe: 'sem-pareamento' },
  )
  // Offline sem motivo: aviso "Offline" sem detalhe.
  assert.equal(chip({ configurado: true, fonte: 'secrets' }, { online: false }).detalhe, undefined)
  // Token NÃO configurado: mantém o chipDoEstado (não chega a olhar o bot).
  assert.deepEqual(
    chip({ configurado: false, fonte: 'nenhum' }, null),
    { tom: 'neutro', rotulo: 'Não configurado' },
  )
  // Estado ainda a carregar (token/telegram null): neutro "verificando…".
  assert.deepEqual(chip(null, null), { tom: 'neutro', rotulo: 'verificando…' })
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets' }, null),
    { tom: 'neutro', rotulo: 'verificando…' },
  )
  void chamadas
})

/**
 * Bordas do chip do cabeçalho (chipDoBot) — os casos que o smoke principal não
 * toca: handle vazio '', fontes 'env'/'nenhum', motivo vazio '' e o SEGUNDO
 * motivo da rota /telegram ('sem-chave'). O `chipDoEstado` interno não é
 * exportado e é exercitado AQUI através do `chipDoBot` no caminho
 * `!configurado` (a única porta de entrada pública dele).
 */
test('bundle: chipDoBot — bordas (handle vazio, fontes env/nenhum, motivo vazio)', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const chip = modulo.chipDoBot as (
    token: unknown,
    telegrama: unknown,
  ) => { tom: string; rotulo: string; detalhe?: string }

  // Online com handle VAZIO '' → conta como "sem handle": detalhe = fonte.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets', handle: '' }, { online: true, handle: '' }),
    { tom: 'ok', rotulo: 'Online', detalhe: 'secrets' },
    'handle vazio não vira @ — o detalhe é a fonte do token',
  )
  // Online sem handle, fonte 'env' → detalhe 'env' (a fonte, não o token).
  assert.deepEqual(
    chip({ configurado: true, fonte: 'env' }, { online: true }),
    { tom: 'ok', rotulo: 'Online', detalhe: 'env' },
  )
  // Online sem handle, fonte 'nenhum' (configurado por outra via) → detalhe 'nenhum'.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'nenhum' }, { online: true }),
    { tom: 'ok', rotulo: 'Online', detalhe: 'nenhum' },
  )

  // Offline com motivo vazio '' → o motivo é repassado TAL QUAL (detalhe:'' —
  // comportamento OBSERVADO do código; o contrato só promete "sem detalhe"
  // quando o motivo está AUSENTE/undefined).
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets' }, { online: false, motivo: '' }),
    { tom: 'aviso', rotulo: 'Offline', detalhe: '' },
  )
  // Offline com o SEGUNDO motivo da rota → detalhe = motivo.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets' }, { online: false, motivo: 'sem-chave' }),
    { tom: 'aviso', rotulo: 'Offline', detalhe: 'sem-chave' },
  )

  // Token NÃO configurado + fonte 'env' → chipDoEstado: "Env manda" (o env
  // prevalece sobre o bot — o estado do bot é irrelevante sem token).
  assert.deepEqual(
    chip({ configurado: false, fonte: 'env' }, { online: true }),
    { tom: 'aviso', rotulo: 'Env manda', detalhe: 'sem token até remover a variável' },
  )
  // Token NÃO configurado + fonte 'secrets' → chipDoEstado: "Não configurado".
  assert.deepEqual(
    chip({ configurado: false, fonte: 'secrets' }, null),
    { tom: 'neutro', rotulo: 'Não configurado' },
  )
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

test('CSRF HIGH-2: rede falhou na GET /csrf -> fallback ao meta (catch do fetch)', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetchComFalha((url) => url.includes('/csrf'))
  const modulo = carregarBundle(fetchStub)
  const buscar = modulo.buscarTokenCsrf as (doc: { querySelector: (s: string) => unknown | null }) => Promise<string>

  const token = await buscar(documentoComMeta('DO-META'))
  assert.equal(token, 'DO-META', 'a GET /csrf REJEITOU (não é só 404) e o meta do chrome antigo valeu')
  assert.ok(chamadas[0]?.url.includes('/csrf'), 'a GET /csrf deve ter sido tentada')
})

test('CSRF HIGH-2: GET /csrf ok mas SEM token utilizável -> fallback ao meta', { skip: BUNDLE_AUSENTE }, async () => {
  // `{}` (sem a chave token), `{token:''}` (vazio) e `{token: 123}` (tipo
  // errado) têm de cair no meta — só string não-vazia vale como token.
  for (const corpo of [{}, { token: '' }, { token: 123 }]) {
    const { fetchStub } = capturarFetch([{ urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, corpo) }])
    const modulo = carregarBundle(fetchStub)
    const buscar = modulo.buscarTokenCsrf as (doc: { querySelector: (s: string) => unknown | null }) => Promise<string>
    assert.equal(await buscar(documentoComMeta('DO-META')), 'DO-META', `corpo ${JSON.stringify(corpo)} → fallback ao meta`)
  }
})

test('CSRF HIGH-2: GET /csrf 500 e meta com conteúdo vazio -> token indisponível', { skip: BUNDLE_AUSENTE }, async () => {
  // 500 da GET /csrf: não-ok → cai no meta (válido).
  const { fetchStub } = capturarFetch([{ urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(500, {}) }])
  const modulo = carregarBundle(fetchStub)
  const buscar = modulo.buscarTokenCsrf as (doc: { querySelector: (s: string) => unknown | null }) => Promise<string>
  assert.equal(await buscar(documentoComMeta('DO-META')), 'DO-META', 'GET /csrf 500 → meta')

  // Meta com conteúdo só-espaço (trim → '') → '' = CSRF indisponível.
  assert.equal(await buscar(documentoComMeta('   ')), '', 'meta só-espaço → \'\' (trim)')
})

test('apiPost: rede falhou no POST -> {status:0} sem csrfIndisponivel', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetchComFalha((_url, init) => init?.method === 'POST')
  const modulo = carregarBundle(fetchStub)
  const post = modulo.apiPost as (
    caminho: string,
    corpo: Record<string, unknown>,
    doc: { querySelector: (s: string) => unknown | null },
  ) => Promise<{ status: number; dados: Record<string, unknown>; csrfIndisponivel: boolean }>

  // A GET /csrf responde 404 (cai no meta 'META'), o POST /token REJEITA por rede.
  const r = await post('/token', { token: '123:ABC' }, documentoComMeta('META'))
  assert.equal(r.status, 0, 'rede falhou no POST → status 0 (NUNCA rejeição não tratada)')
  assert.equal(r.csrfIndisponivel, false, 'o CSRF ESTAVA disponível — a falha foi só de rede')
  assert.deepEqual(r.dados, {})
  const postChamada = chamadas.find((c) => c.url.includes('/api/token') && c.init?.method === 'POST')
  assert.ok(postChamada !== undefined, 'o POST /token deve ter SAÍDO (e falhado por rede)')
})

test('apiPost: corpo ilegível usa o status; erro 500 do servidor propaga status', { skip: BUNDLE_AUSENTE }, async () => {
  // 200 com corpo não-JSON: json() rejeita → dados {} mas o status preservado.
  const { chamadas, fetchStub } = capturarFetch([
    { urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, { token: 'T-OK' }) },
    { urlContem: '/__guard-ui/api/token', metodo: 'POST', resposta: fakeRespostaSemJson(200) },
  ])
  const modulo = carregarBundle(fetchStub)
  const post = modulo.apiPost as (
    caminho: string,
    corpo: Record<string, unknown>,
    doc: { querySelector: (s: string) => unknown | null },
  ) => Promise<{ status: number; dados: Record<string, unknown>; csrfIndisponivel: boolean }>

  const r1 = await post('/token', { token: '123:ABC' }, documentoComMeta('ANTIGO'))
  assert.equal(r1.status, 200)
  assert.deepEqual(r1.dados, {}, 'corpo ilegível → dados {} (o status vale)')
  assert.equal(r1.csrfIndisponivel, false)

  // 500 com JSON válido: status 500 + dados do erro propagados.
  const { chamadas: chamadas2, fetchStub: fetchStub2 } = capturarFetch([
    { urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, { token: 'T-OK' }) },
    { urlContem: '/__guard-ui/api/token', metodo: 'POST', resposta: fakeResposta(500, { erro: 'worker-indisponivel' }) },
  ])
  const modulo2 = carregarBundle(fetchStub2)
  const post2 = modulo2.apiPost as typeof post
  const r2 = await post2('/token', { token: '123:ABC' }, documentoComMeta('ANTIGO'))
  assert.equal(r2.status, 500)
  assert.deepEqual(r2.dados, { erro: 'worker-indisponivel' })
  assert.equal(r2.csrfIndisponivel, false)
  void chamadas
  void chamadas2
})


/**
 * Onda 2 — provider-aware: o mapa local de rótulos escolhe por provedor e cai
 * no telegram quando o valor está ausente/desconhecido (o host ainda não emite
 * o campo `provider` — o fallback é o contrato desta onda).
 */
test('bundle: rotulosDoProvider — labels por provider e fallback telegram', { skip: BUNDLE_AUSENTE }, () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const rotulos = modulo.rotulosDoProvider as (p?: unknown) => Record<string, unknown>

  // Telegram (o default): os literais atuais.
  const tel = rotulos('telegram')
  assert.equal(tel['botFather'], '@BotFather')
  assert.equal(tel['tokenVar'], 'TELEGRAM_BOT_TOKEN')
  assert.equal(tel['rotuloCampoToken'], 'Token do bot (@BotFather)')
  const criacaoTel = tel['criacao'] as string[]
  assert.ok(
    Array.isArray(criacaoTel) && criacaoTel.some((passo) => passo.includes('/newbot')),
    'os passos de criação do telegram devem incluir /newbot',
  )

  // Discord: rótulos próprios (genéricos, apontam para a doc oficial).
  const dis = rotulos('discord')
  assert.equal(dis['tokenVar'], 'DISCORD_BOT_TOKEN')
  assert.equal(dis['naConversa'], 'No Discord, envia:')
  assert.equal(dis['rotuloCampoToken'], 'Token do bot (Developer Portal)')
  const criacaoDis = dis['criacao'] as string[]
  assert.ok(criacaoDis.some((s) => s.includes('Developer Portal')), 'os passos de criação do discord devem apontar para o Developer Portal')

  // Fallback: ausente (undefined/null) e desconhecido → telegram.
  assert.equal(rotulos(undefined)['tokenVar'], 'TELEGRAM_BOT_TOKEN', 'sem provider → telegram')
  assert.equal(rotulos(null)['tokenVar'], 'TELEGRAM_BOT_TOKEN', 'provider null → telegram')
  assert.equal(rotulos('signal')['tokenVar'], 'TELEGRAM_BOT_TOKEN', 'provider desconhecido → telegram')
  void chamadas
})

/**
 * Onda 2 — o consumo do campo `provider` do GET /telegram é OPCIONAL e
 * defensivo: `normalizarProvider` é a função que o painel usa para ler o campo
 * quando o host o emitir — só 'telegram'/'discord' passam; qualquer outro
 * valor (incl. ausente) cai no 'telegram'.
 */
test('bundle: normalizarProvider — campo provider opcional com default telegram', { skip: BUNDLE_AUSENTE }, () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const normalizar = modulo.normalizarProvider as (v: unknown) => string

  assert.equal(normalizar('telegram'), 'telegram')
  assert.equal(normalizar('discord'), 'discord')
  // Ausente / tipo errado / valor desconhecido → default telegram.
  assert.equal(normalizar(undefined), 'telegram')
  assert.equal(normalizar(null), 'telegram')
  assert.equal(normalizar('signal'), 'telegram')
  assert.equal(normalizar(42), 'telegram')
  void chamadas
})

/**
 * Onda 2 — o chip do cabeçalho aceita o provider (3.º argumento, opcional,
 * default 'telegram') e os estados ALCANÇÁVEIS não mudam com ele: o estado do
 * bot (Online/Offline) é provider-agnóstico por construção, e o rótulo de env
 * alcançável ('Env manda') é estático. O rótulo da variável de ambiente por
 * provider (tokenVar) é verificado no teste do mapa (`rotulosDoProvider`).
 */
test('bundle: chipDoBot aceita o provider sem mudar os estados alcançáveis', { skip: BUNDLE_AUSENTE }, () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const chip = modulo.chipDoBot as (
    token: unknown,
    telegrama: unknown,
    provider?: unknown,
  ) => { tom: string; rotulo: string; detalhe?: string }

  // Env a mandar + token não configurado → 'Env manda', igual p/ qualquer provider.
  assert.deepEqual(
    chip({ configurado: false, fonte: 'env' }, null, 'discord'),
    { tom: 'aviso', rotulo: 'Env manda', detalhe: 'sem token até remover a variável' },
    'provider discord não muda o rótulo alcançável de env',
  )
  assert.deepEqual(
    chip({ configurado: false, fonte: 'env' }, null),
    { tom: 'aviso', rotulo: 'Env manda', detalhe: 'sem token até remover a variável' },
    'sem provider → mesmo rótulo (regressão zero)',
  )
  // Online/Offline NÃO mudam com o provider (o estado do bot é agnóstico).
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets' }, { online: true }, 'discord'),
    { tom: 'ok', rotulo: 'Online', detalhe: 'secrets' },
  )
  assert.deepEqual(
    chip({ configurado: true, fonte: 'secrets' }, { online: false, motivo: 'sem-pareamento' }, 'discord'),
    { tom: 'aviso', rotulo: 'Offline', detalhe: 'sem-pareamento' },
  )
  void chamadas
})

/**
 * Onda 2 — os rótulos do discord viajam no bundle (o mapa local é
 * provider-aware): a variável de ambiente, o canal de criação e a instrução de
 * pareamento do discord constam ao lado dos literais do telegram (o fallback).
 */
test('bundle: os rótulos do discord estão no bundle (mapa provider-aware)', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = readFileSync(BUNDLE_PATH, 'utf8')

  assert.ok(codigo.includes('DISCORD_BOT_TOKEN'), 'o bundle deve conter a variável de ambiente do discord')
  assert.ok(codigo.includes('Developer Portal'), 'o bundle deve conter o canal de criação do discord')
  assert.ok(codigo.includes('No Discord, envia'), 'o bundle deve conter a instrução de pareamento do discord')

  // Os literais do telegram (o fallback) continuam intactos.
  assert.ok(codigo.includes('TELEGRAM_BOT_TOKEN'), 'o bundle deve continuar a conter a variável do telegram')
  assert.ok(codigo.includes('@BotFather'), 'o bundle deve continuar a conter o @BotFather')
  assert.ok(codigo.includes('No Telegram, envia'), 'o bundle deve continuar a conter a instrução do telegram')
})

/**
 * Onda 2 — fonte `'env'` com token CONFIGURADO: o chip e decidido pelo
 * TELEGRAMA, nunca pelo env (o env so decide quando o token NAO esta
 * configurado — 'Env manda'). O ramo "Configurado via env" de `chipDoEstado`
 * (o unico que cita a variavel do provider, `rotulosDoProvider(provider)
 * .tokenVar`) e INALCANCAVEL pela porta publica: o `chipDoBot` so delega a
 * `chipDoEstado` quando `!token.configurado` (client/index.ts:292). O teste
 * PINANDO o comportamento observado — como o repo ja faz para o motivo vazio:
 * configurado+env em cada estado do telegrama (null/online/offline), com e sem
 * o 3.º argumento.
 */
test('bundle: chipDoBot — env+configurado: o chip e decidido pelo telegrama (ramo "Configurado via env" inalcancavel)', { skip: BUNDLE_AUSENTE }, () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const chip = modulo.chipDoBot as (
    token: unknown,
    telegrama: unknown,
    provider?: unknown,
  ) => { tom: string; rotulo: string; detalhe?: string }

  // configurado+env e o /telegram ainda a carregar -> 'verificando…' (o env NAO
  // decide com o token configurado), com e sem provider.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'env' }, null, 'discord'),
    { tom: 'neutro', rotulo: 'verificando…' },
  )
  assert.deepEqual(
    chip({ configurado: true, fonte: 'env' }, null),
    { tom: 'neutro', rotulo: 'verificando…' },
    '2 args (sem provider): o mesmo estado — regressao zero',
  )

  // configurado+env e ONLINE -> 'Online' com o detalhe = a fonte do token.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'env' }, { online: true }, 'discord'),
    { tom: 'ok', rotulo: 'Online', detalhe: 'env' },
  )

  // configurado+env e OFFLINE -> 'Offline' com o motivo da rota.
  assert.deepEqual(
    chip({ configurado: true, fonte: 'env' }, { online: false, motivo: 'sem-pareamento' }, 'discord'),
    { tom: 'aviso', rotulo: 'Offline', detalhe: 'sem-pareamento' },
  )
  void chamadas
})

/**
 * Onda 2 — o CONSUMO do campo `provider` do GET /telegram esta fiado no bundle
 * (o esbuild do repo roda com `minify:false`, logo os nomes do fonte aparecem
 * verbatim no artefacto): a rota normaliza o campo e alimenta o estado React
 * (`setProvider(normalizarProvider(dados.provider))`), o painel passa o
 * provedor ao chip (`chipDoBot(token, telegrama, provider)`) e aos rotulos
 * (`rotulosDoProvider(provider)`, incluindo o detalhe de env). Falsifica a
 * aceitacao "o campo provider chega do servidor ao estado React" ao nivel do
 * artefacto compilado.
 */
test('bundle: o campo provider do GET /telegram esta fiado ao estado e ao render', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = readFileSync(BUNDLE_PATH, 'utf8')

  assert.ok(
    codigo.includes('setProvider(normalizarProvider(dados.provider))'),
    'a GET /telegram deve normalizar o campo provider e alimentar o estado React',
  )
  assert.ok(codigo.includes('chipDoBot(token, telegrama, provider)'), 'o painel deve passar o provedor ativo ao chip do cabecalho')
  assert.ok(codigo.includes('rotulosDoProvider(provider)'), 'o render deve escolher os rotulos pelo provedor ativo')
  assert.ok(codigo.includes('rotulosDoProvider(provider).tokenVar'), 'o detalhe de env deve citar a variavel do provedor ativo')
})

/**
 * Onda 2 — os mapas de rotulos sao FROZEN e o fallback e a MESMA identidade do
 * mapa telegram: `rotulosDoProvider(undefined)` devolve o proprio objeto
 * telegram (nunca uma copia), e o discord e um objeto DISTINTO. Protege a
 * aceitacao "fallback telegram para tudo que nao e discord".
 */
test('bundle: rotulosDoProvider — mapas congelados e fallback por identidade', { skip: BUNDLE_AUSENTE }, () => {
  const { chamadas, fetchStub } = capturarFetch([])
  const modulo = carregarBundle(fetchStub)
  const rotulos = modulo.rotulosDoProvider as (p?: unknown) => Record<string, unknown>

  const telegram = rotulos('telegram')
  const discord = rotulos('discord')
  assert.ok(Object.isFrozen(telegram), 'o mapa telegram deve ser congelado (imutavel)')
  assert.ok(Object.isFrozen(discord), 'o mapa discord deve ser congelado (imutavel)')

  assert.equal(rotulos(undefined), telegram, 'fallback (undefined) devolve a MESMA identidade do telegram')
  assert.equal(rotulos(null), telegram, 'fallback (null) devolve a mesma identidade do telegram')
  assert.equal(rotulos('signal'), telegram, 'fallback (desconhecido) devolve a mesma identidade do telegram')
  assert.notEqual(discord, telegram, 'o mapa discord e um objeto DISTINTO do telegram')
  void chamadas
})

/**
 * Onda 2 — o espelho `client/client.d.ts` (copiado para `lib/client.d.ts` pelo
 * `build-client.mjs` — o subpath `./client` do tarball) declara a MESMA
 * superficie provider-aware do fonte `client/index.ts`: cada export NOMEADO do
 * fonte tem a sua declaracao no espelho, e os tres pontos provider
 * (`TipoProvider`, `EstadoTelegrama.provider`, o 3.º argumento do `chipDoBot`)
 * estao tipados. Estrutural e sem build: le os dois ficheiros do repositorio.
 */
test('client.d.ts (espelho) declara a superficie provider-aware do fonte', () => {
  const fonte = readFileSync(resolve(ROOT, 'client/index.ts'), 'utf8')
  const espelho = readFileSync(resolve(ROOT, 'client/client.d.ts'), 'utf8')

  // Cada export NOMEADO do fonte (function/const/type/interface, com ou sem
  // `async`) tem a sua declaracao correspondente no espelho.
  const nomes = [...fonte.matchAll(/^export (?:async )?(?:function|const|type|interface)\s+([A-Za-z0-9_]+)/gmu)].map(
    (m) => m[1],
  )
  assert.ok(nomes.length >= 9, `esperava os exports do fonte, achei: ${nomes.join(', ')}`)
  for (const nome of nomes) {
    assert.ok(
      new RegExp(`export (?:function|const|type|interface)\\s+${nome}\\b`, 'u').test(espelho),
      `o espelho deve declarar o export ${nome} do fonte`,
    )
  }

  // Os pontos provider-aware tipados no espelho.
  assert.match(espelho, /export type TipoProvider = 'telegram' \| 'discord'/u, 'o union do TipoProvider no espelho')
  assert.match(espelho, /readonly provider\?: TipoProvider/u, 'EstadoTelegrama.provider (opcional) no espelho')
  assert.match(
    espelho,
    /chipDoBot\(token: EstadoDoToken \| null, telegrama: EstadoTelegrama \| null, provider\?: TipoProvider\)/u,
    'o 3.º argumento (provider) do chipDoBot no espelho',
  )
  assert.match(
    espelho,
    /export function rotulosDoProvider\(provider\?: TipoProvider \| null\): RotulosDoProvider/u,
    'rotulosDoProvider com fallback tipado no espelho',
  )
  assert.match(espelho, /export function normalizarProvider\(valor: unknown\): TipoProvider/u)
})
