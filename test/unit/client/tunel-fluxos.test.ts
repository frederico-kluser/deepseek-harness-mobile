/**
 * Testes de FLUXO HTTP do painel do túnel (sub-tarefa 1.2 — aba "Remote
 * Access"), exercitados pela superficie EXPORTADA do bundle (`apiPost` /
 * `buscarTokenCsrf`) contra um fetch stub — a mesma fidelidade do
 * index.test.ts, aqui focada nos GAPS da onda:
 *
 *  1. A recusa CSRF ({status:0, csrfIndisponivel:true} SEM o POST sair) vale
 *     para TODAS as rotas de escrita do túnel/bot/agentes — não só /token.
 *  2. O token é buscado FRESCO a CADA POST (a fonte GET /api/csrf não é
 *     cacheada no client — dois POSTs = duas GET /csrf).
 *  3. O nonce do LIGAR/REPOR viaja no CORPO JSON do confirm (nunca no header,
 *     nunca na URL) e o DESLIGAR sai com corpo {} (sem nonce — CTL-024).
 *  4. O teto curto da GET /csrf (2500 ms) aborta a fonte e o POST recusa
 *     honestamente (não fica pendurado, não sai sem token).
 *  5. O pedido da fonte única vai com `credentials: 'same-origin'` e
 *     `accept: application/json` (e NUNCA leva o header x-dsh-csrf — o GET
 *     pede o token, não o envia).
 *
 * EXECUCAO: precisa de `pnpm run build:client` antes (o `pnpm test` corre o
 * gate); sem o bundle a suite salta (skip), como no index.test.ts.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BUNDLE_AUSENTE,
  carregarBundle,
  capturarFetch,
  documentoComMeta,
  fakeResposta,
  type ChamadaFetch,
} from './apoio.ts'

/** As NOVE rotas de escrita da superfície (túnel + bot + agentes + parear). */
const ROTAS_DE_ESCRITA: ReadonlyArray<{ caminho: string; corpo: Record<string, unknown> }> = [
  { caminho: '/start', corpo: {} },
  { caminho: '/start/confirm', corpo: { nonce: 'N-1' } },
  { caminho: '/stop', corpo: {} },
  { caminho: '/reset', corpo: {} },
  { caminho: '/reset/confirm', corpo: { nonce: 'N-2' } },
  { caminho: '/telegram/click', corpo: {} },
  { caminho: '/token', corpo: { token: '123:ABC' } },
  { caminho: '/pair', corpo: {} },
  { caminho: '/agents/a1b2c3d4/cancel', corpo: {} },
]

test('tunel: a recusa CSRF vale para TODAS as rotas de escrita — nenhum POST sai sem token', { skip: BUNDLE_AUSENTE }, async () => {
  for (const rota of ROTAS_DE_ESCRITA) {
    // A fonte ÚNICA (GET /csrf) falha (404) → token '' → o POST NEM SAI,
    // para CADA rota — mesmo com um meta antigo presente no documento.
    const { chamadas, fetchStub } = capturarFetch([])
    const modulo = carregarBundle(fetchStub)
    const post = modulo.apiPost as (
      caminho: string,
      corpo: Record<string, unknown>,
      doc: { querySelector: (s: string) => unknown | null },
    ) => Promise<{ status: number; dados: Record<string, unknown>; csrfIndisponivel: boolean }>

    const r = await post(rota.caminho, rota.corpo, documentoComMeta('DO-META-ANTIGO'))
    assert.equal(r.status, 0, `${rota.caminho}: recusa → status 0`)
    assert.equal(r.csrfIndisponivel, true, `${rota.caminho}: recusa marcada csrfIndisponivel`)
    assert.deepEqual(r.dados, {}, `${rota.caminho}: sem dados inventados`)
    const postsSairam = chamadas.filter((c) => c.init?.method === 'POST')
    assert.equal(postsSairam.length, 0, `${rota.caminho}: nenhum POST pode sair sem CSRF`)
    assert.ok(
      chamadas.some((c) => c.url === '/__guard-ui/api/csrf'),
      `${rota.caminho}: a recusa vem DEPOIS de tentar a fonte única /csrf`,
    )
  }
})

test('tunel: o token é buscado FRESCO a cada POST — 2 POSTs → 2 GET /csrf (sem cache)', { skip: BUNDLE_AUSENTE }, async () => {
  // Tokens DIFERENTES por pedido: o 2.º POST tem de levar o 2.º token — um
  // token cacheado (T1) no 2.º POST seria o bug (o valor envelhece no TTL).
  let ordem = 0
  const chamadas: ChamadaFetch[] = []
  const fetchStub = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    chamadas.push({ url, init })
    if (url.includes('/__guard-ui/api/csrf')) {
      ordem += 1
      return fakeResposta(200, { token: `T-${ordem}` })
    }
    return fakeResposta(200, { ok: true })
  }) as typeof fetch
  const modulo = carregarBundle(fetchStub)
  const post = modulo.apiPost as (c: string, b: Record<string, unknown>, d: unknown) => Promise<{ status: number }>

  await post('/start', {}, documentoComMeta(null))
  await post('/stop', {}, documentoComMeta(null))

  const getsCsrf = chamadas.filter((c) => c.url.includes('/__guard-ui/api/csrf'))
  assert.equal(getsCsrf.length, 2, 'cada POST busca um token FRESCO (2 POSTs = 2 GET /csrf)')
  const posts = chamadas.filter((c) => c.init?.method === 'POST')
  assert.equal(posts.length, 2, 'os dois POSTs saíram (com token nenhum faltando)')
  const headerDoPrimeiro = ((posts[0]?.init?.headers ?? {}) as Record<string, string>)['x-dsh-csrf']
  const headerDoSegundo = ((posts[1]?.init?.headers ?? {}) as Record<string, string>)['x-dsh-csrf']
  assert.equal(headerDoPrimeiro, 'T-1', 'o 1.º POST leva o token da SUA busca')
  assert.equal(headerDoSegundo, 'T-2', 'o 2.º POST leva o token FRESCO (T-2) — nunca um cacheado T-1')
})

test('tunel: o nonce viaja no CORPO JSON do /start/confirm e do /reset/confirm', { skip: BUNDLE_AUSENTE }, async () => {
  for (const [caminho, nonce] of [['/start/confirm', 'N-START-777'], ['/reset/confirm', 'N-RESET-42']] as const) {
    const { chamadas, fetchStub } = capturarFetch([
      { urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, { token: 'TOKEN-OK' }) },
      { urlContem: `/__guard-ui/api${caminho}`, metodo: 'POST', resposta: fakeResposta(200, { ok: true }) },
    ])
    const modulo = carregarBundle(fetchStub)
    const post = modulo.apiPost as (
      caminho: string,
      corpo: Record<string, unknown>,
      doc: unknown,
    ) => Promise<{ status: number; dados: Record<string, unknown>; csrfIndisponivel: boolean }>

    const r = await post(caminho, { nonce }, documentoComMeta(null))
    assert.equal(r.status, 200)
    const chamada = chamadas.find((c) => c.init?.method === 'POST' && c.url.endsWith(caminho))
    assert.ok(chamada !== undefined, `${caminho}: o POST confirm deve ter saído`)
    assert.equal(chamada.url, `/__guard-ui/api${caminho}`, `${caminho}: o caminho é API_BASE + rota`)
    assert.deepEqual(JSON.parse(String(chamada.init?.body)), { nonce }, `${caminho}: o corpo é EXATAMENTE {nonce}`)
    const cabecalhos = (chamada.init?.headers ?? {}) as Record<string, string>
    assert.equal(cabecalhos['x-dsh-csrf'], 'TOKEN-OK', `${caminho}: o token vai no header x-dsh-csrf`)
    assert.equal(cabecalhos['content-type'], 'application/json', `${caminho}: corpo JSON`)
  }
})

test('tunel: o DESLIGAR sai SEM nonce — POST /stop com corpo vazio', { skip: BUNDLE_AUSENTE }, async () => {
  // CTL-024: o desligar é uma ação de 1 etapa pós-confirmação, SEM nonce —
  // o corpo do POST /stop é {} (nunca carrega um nonce velho).
  const { chamadas, fetchStub } = capturarFetch([
    { urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, { token: 'TOKEN-OK' }) },
    { urlContem: '/__guard-ui/api/stop', metodo: 'POST', resposta: fakeResposta(200, { ok: true }) },
  ])
  const modulo = carregarBundle(fetchStub)
  const post = modulo.apiPost as (c: string, b: Record<string, unknown>, d: unknown) => Promise<{ status: number }>

  const r = await post('/stop', {}, documentoComMeta(null))
  assert.equal(r.status, 200)
  const chamada = chamadas.find((c) => c.init?.method === 'POST' && c.url.endsWith('/stop'))
  assert.ok(chamada !== undefined, 'o POST /stop deve ter saído')
  const corpo = JSON.parse(String(chamada.init?.body)) as Record<string, unknown>
  assert.deepEqual(corpo, {}, 'o corpo de /stop é {} — sem nonce nenhum')
  assert.ok(!('nonce' in corpo), '/stop NUNCA leva nonce')
})

test('tunel: o clique das instruções do bot é POST /telegram/click COM CSRF', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetch([
    { urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, { token: 'TOKEN-OK' }) },
    {
      urlContem: '/__guard-ui/api/telegram/click',
      metodo: 'POST',
      resposta: fakeResposta(200, { passos: [{ titulo: 'Abrir o Telegram', texto: 'Toque no bot.' }] }),
    },
  ])
  const modulo = carregarBundle(fetchStub)
  const post = modulo.apiPost as (c: string, b: Record<string, unknown>, d: unknown) => Promise<{ status: number; dados: Record<string, unknown>; csrfIndisponivel: boolean }>

  const r = await post('/telegram/click', {}, documentoComMeta(null))
  assert.equal(r.status, 200, 'o clique devolve 200 com os passos')
  assert.deepEqual(r.dados.passos, [{ titulo: 'Abrir o Telegram', texto: 'Toque no bot.' }])
  assert.equal(r.csrfIndisponivel, false)
  const chamada = chamadas.find((c) => c.init?.method === 'POST' && c.url.endsWith('/telegram/click'))
  assert.ok(chamada !== undefined, 'o POST /telegram/click deve ter saído')
  const cabecalhos = (chamada.init?.headers ?? {}) as Record<string, string>
  assert.equal(cabecalhos['x-dsh-csrf'], 'TOKEN-OK', 'o clique é uma ESCRITA — viaja com CSRF')
})

test('tunel: o teto curto da GET /csrf (2500 ms) aborta → token \'\' → o POST recusa SEM sair', { skip: BUNDLE_AUSENTE, timeout: 8000 }, async (t) => {
  // Se o client perdesse o teto curto (o abort nunca chegasse), este teste
  // HANGARIA em vez de falhar — a opção `timeout` converte o pendurar em FALHA.
  // A fonte única PENDURA (o servidor não responde): o AbortController do
  // client tem de matar o pedido no teto curto (2500 ms) — o POST recusa com
  // mensagem clara em vez de ficar pendurado para sempre.
  t.mock.timers.enable({ apis: ["setTimeout"] })

  const chamadas: ChamadaFetch[] = []
  const fetchStub = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    chamadas.push({ url, init })
    if (url.includes('/__guard-ui/api/csrf')) {
      // Pendura até o SINAL de abort chegar (o teto curto do client).
      return new Promise<Response>((_resolve, rejeita) => {
        init?.signal?.addEventListener('abort', () => rejeita(new Error('The operation was aborted')))
      })
    }
    return fakeResposta(200, { ok: true })
  }) as typeof fetch

  const modulo = carregarBundle(fetchStub)
  const buscar = modulo.buscarTokenCsrf as (doc: unknown) => Promise<string>
  const post = modulo.apiPost as (c: string, b: Record<string, unknown>, d: unknown) => Promise<{ status: number; dados: Record<string, unknown>; csrfIndisponivel: boolean }>

  // Antes do teto: o pedido está em voo (só a GET saiu).
  const pendente = buscar(documentoComMeta(null))
  t.mock.timers.tick(2499)
  assert.equal(chamadas.filter((c) => c.init?.method === 'POST').length, 0)

  // No teto (2500 ms): o abort dispara → token ''.
  t.mock.timers.tick(1)
  assert.equal(await pendente, '', 'o teto curto aborta a fonte única → token vazio')

  // E o POST daí resultante RECUSA sem sair (csrfIndisponivel): a nova GET
  // /csrf pendura de novo — o mesmo teto curto a mata no tick seguinte.
  const rPendente = post('/start', {}, documentoComMeta(null))
  t.mock.timers.tick(2500)
  const r = await rPendente
  assert.equal(r.status, 0)
  assert.equal(r.csrfIndisponivel, true)
  assert.equal(chamadas.filter((c) => c.init?.method === 'POST').length, 0, 'nenhum POST sai com o token abortado')
})

test('tunel: o pedido da fonte única /csrf vai com credentials same-origin e accept json (e nunca leva x-dsh-csrf)', { skip: BUNDLE_AUSENTE }, async () => {
  const { chamadas, fetchStub } = capturarFetch([
    { urlContem: '/__guard-ui/api/csrf', resposta: fakeResposta(200, { token: 'T' }) },
  ])
  const modulo = carregarBundle(fetchStub)
  const buscar = modulo.buscarTokenCsrf as (doc: unknown) => Promise<string>
  await buscar(documentoComMeta(null))

  assert.ok(chamadas.length > 0, 'a GET da fonte única deve ter sido tentada')
  const get = chamadas[0] as ChamadaFetch
  const init = get.init as RequestInit
  assert.equal(get.url, '/__guard-ui/api/csrf', 'a fonte única é EXATAMENTE /__guard-ui/api/csrf')
  assert.equal(init.credentials, 'same-origin', 'o GET vai com a sessão (same-origin)')
  const cabecalhos = (init.headers ?? {}) as Record<string, string>
  assert.equal(cabecalhos['accept'], 'application/json')
  assert.equal(cabecalhos['x-dsh-csrf'], undefined, 'a GET pede o token — nunca o envia')
})
