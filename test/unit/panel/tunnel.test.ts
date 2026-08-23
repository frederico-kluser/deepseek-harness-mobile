/**
 * As rotas de liga/desliga do painel -- `03-ONDAS.md` T5.3, `04-TESTES.md`
 * 5.6 (CTL-016/017/019/021/022/023/024, CTL-040) e as perguntas falsificaveis.
 *
 * O QUE ESTA SUITE FALSIFICA:
 *
 *  - "o painel usa cookie de sessao? entao TODA mutacao precisa de token
 *    anti-CSRF" -- os POSTs de start, stop e de emissao de nonce sao 403 sem
 *    o token, e um token de OUTRA sessao nao destranca (NIST SP 800-63B-4
 *    5.1.1);
 *  - "o botao de desligar tem confirmacao, ou e um clique so?" -- a confirmacao
 *    de interface vive no HTML (html.test.ts); aqui fica o que a rota exige:
 *    `stop` NAO pede nonce (CTL-024) e o painel nao tem caminho de despacho
 *    sem CSRF;
 *  - "sessao expirada com o painel aberto" -- o POST falha com o MESMO 401 do
 *    gate, byte a byte, e nada e despachado;
 *  - "o painel revela a URL antes do login?" -- nem a pagina nem os POSTs
 *    anonimos a contem;
 *  - o painel e SUPERFICIE: o que ele entrega ao controlador e o
 *    `ControlIntent` do contrato congelado, com origem `panel:<id-hash>`,
 *    `requestId` ULID e `at` do relogio injetado. O nonce atravessa OPACO --
 *    reenviado, e o controlador (T5.1) quem o RECUSA (CTL-021); esta
 *    superficie nao guarda memoria de nonces.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { CSRF_HEADER_NAME } from '../../../src/panel/csrf.ts'
import {
  PANEL_PATH_STATE,
  PANEL_PATH_TUNNEL_START,
  PANEL_PATH_TUNNEL_START_NONCE,
  PANEL_PATH_TUNNEL_STOP,
  PANEL_PATH_ROOT,
  panelPublicRouteKeys,
  policyForRoute,
} from '../../../src/panel/routes.ts'
import { SESSION_ABSOLUTE_TIMEOUT_MS } from '../../../src/session/store.ts'
import {
  criarBancada,
  pedir,
  SNAPSHOT_ONLINE,
  URL_DO_TUNEL,
  type Bancada,
} from './harness.ts'

const FORMA_ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u

/** Cria uma sessao e devolve o id apresentado e o token CSRF VINCULADO a ela. */
function autenticar(bancada: Bancada): { id: string; token: string; idHash: string } {
  const id = bancada.sessions.create()
  const sessao = bancada.sessions.validate(id)
  assert.ok(sessao !== null, 'a sessao recem-criada tem de validar')
  return { id, token: bancada.csrf.issue(sessao.idHash), idHash: sessao.idHash }
}

describe('as rotas de liga/desliga na tabela de politica', () => {
  it('as tres rotas novas exigem sessao -- nenhuma nasce publica', () => {
    for (const chave of [
      `POST ${PANEL_PATH_TUNNEL_START}`,
      `POST ${PANEL_PATH_TUNNEL_STOP}`,
      `POST ${PANEL_PATH_TUNNEL_START_NONCE}`,
    ]) {
      assert.equal(policyForRoute('POST', chave.slice(5)), 'exige-sessao')
      assert.equal(panelPublicRouteKeys().includes(chave), false)
    }
  })
})

describe('POST /__guard/api/tunnel/start/nonce -- o passo 1 do liga', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada()
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  beforeEach(() => {
    // Cada caso comeca com o caderno limpo: o que o despacho falso recebeu
    // e o que ESTE caso lhe entregou, nada do anterior.
    bancada.intentos.length = 0
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false }
  })

  it('sem sessao: 401 do gate, e o nonce NAO sai', async () => {
    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START_NONCE, { method: 'POST', body: '' })

    assert.equal(resposta.status, 401)
    assert.equal(resposta.headers['www-authenticate'], undefined, 'sem desafio (texto puro, modelo expose-port)')
    assert.equal(resposta.body.includes('nonce'), false)
    assert.equal(bancada.intentos.length, 0)
  })

  it('com sessao mas sem token anti-CSRF: 403, e nada e emitido', async () => {
    const { id } = autenticar(bancada)
    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START_NONCE, {
      method: 'POST',
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(resposta.status, 403)
  })

  it('a recusa de CSRF NAO consome um nonce -- o primeiro valido e o numero 1', async () => {
    const { id, token } = autenticar(bancada)
    await pedir(port, PANEL_PATH_TUNNEL_START_NONCE, {
      method: 'POST',
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })
    const valido = await pedir(port, PANEL_PATH_TUNNEL_START_NONCE, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(valido.status, 200)
    assert.equal((JSON.parse(valido.body) as Record<string, unknown>)['nonce'], 'nonce-teste-1')
  })

  it('com sessao e token: 200 com o nonce OPACO e a expiracao; NAO despacha', async () => {
    const { id, token } = autenticar(bancada)
    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START_NONCE, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(resposta.status, 200)
    const payload = JSON.parse(resposta.body) as Record<string, unknown>
    assert.equal(typeof payload['nonce'], 'string')
    assert.ok(String(payload['nonce']).length > 0)
    assert.equal(payload['expiresAt'], bancada.clock.now() + 60_000)
    // Emitir nao e mutar: o despacho fica intocado ate ao POST final.
    assert.equal(bancada.intentos.length, 0)
  })

  it('o nonce emitido NAO traz a sessao -- ele viaja opaco e so no corpo do start', async () => {
    const { id, token } = autenticar(bancada)
    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START_NONCE, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(resposta.body.includes(id), false)
  })
})

describe('POST /__guard/api/tunnel/start -- o passo 2 do liga', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada()
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  beforeEach(() => {
    // Cada caso comeca com o caderno limpo: o que o despacho falso recebeu
    // e o que ESTE caso lhe entregou, nada do anterior.
    bancada.intentos.length = 0
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false }
  })

  it('sem sessao: o MESMO 401 do gate, byte a byte, e nada e despachado', async () => {
    const anonimo = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      body: 'nonce=qualquer',
    })
    const estado = await pedir(port, PANEL_PATH_STATE)

    assert.equal(anonimo.status, estado.status)
    assert.equal(anonimo.body, estado.body)
    assert.equal(anonimo.headers['www-authenticate'], estado.headers['www-authenticate'])
    assert.equal(bancada.intentos.length, 0)
  })

  it('com sessao mas sem token anti-CSRF: 403 ANTES do despacho', async () => {
    const { id } = autenticar(bancada)
    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=qualquer',
    })

    assert.equal(resposta.status, 403)
    assert.equal(bancada.intentos.length, 0)
  })

  it('o token anti-CSRF de OUTRA sessao nao destranca: 403, nada despachado', async () => {
    const a = autenticar(bancada)
    const b = autenticar(bancada)
    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: a.token },
      cookie: `__Host-dsh_sid=${b.id}`,
      body: 'nonce=qualquer',
    })

    assert.equal(resposta.status, 403)
    assert.equal(bancada.intentos.length, 0)
  })

  it('despacha UM ControlIntent completo: action, origem, requestId ULID, at do relogio', async () => {
    const { id, token, idHash } = autenticar(bancada)
    bancada.resultadoControl = { estado: 'STARTING', idempotente: false }

    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=nonce-teste-77',
    })

    assert.equal(resposta.status, 200)
    assert.deepEqual(JSON.parse(resposta.body), { ok: true, estado: 'STARTING' })
    assert.equal(bancada.intentos.length, 1)
    const intent = bancada.intentos[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.action, 'start')
    assert.equal(intent.requestedBy, `panel:${idHash}`)
    assert.match(intent.requestId, FORMA_ULID)
    assert.equal(intent.nonce, 'nonce-teste-77')
    assert.equal(intent.at, bancada.clock.now())
  })

  it('sem campo nonce, o intent chega SEM nonce -- NONCE_AUSENTE e decisao do controlador', async () => {
    const { id, token } = autenticar(bancada)

    await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(bancada.intentos.at(-1)?.nonce, undefined)
  })

  it('cada POST gera um requestId NOVO -- a chave de idempotencia nao colide', async () => {
    const { id, token } = autenticar(bancada)

    await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=n-1',
    })
    await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=n-2',
    })

    const [primeiro, segundo] = bancada.intentos
    assert.ok(primeiro !== undefined && segundo !== undefined)
    assert.notEqual(primeiro.requestId, segundo.requestId)
  })

  it('o MESMO nonce reenviado e RE-expedido: o painel nao guarda memoria -- o host recusa (CTL-021)', async () => {
    const { id, token } = autenticar(bancada)

    for (let i = 0; i < 2; i += 1) {
      await pedir(port, PANEL_PATH_TUNNEL_START, {
        method: 'POST',
        headers: { [CSRF_HEADER_NAME]: token },
        cookie: `__Host-dsh_sid=${id}`,
        body: 'nonce=mesmo-nonce-repetido',
      })
    }

    assert.equal(bancada.intentos.length, 2)
    assert.equal(bancada.intentos[0]?.nonce, 'mesmo-nonce-repetido')
    assert.equal(bancada.intentos[1]?.nonce, 'mesmo-nonce-repetido')
  })

  it('recusa MODO_RESTRITO: 409 com o CODIGO no corpo, e o rotulo legivel vive no HTML', async () => {
    const { id, token } = autenticar(bancada)
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false, recusa: 'MODO_RESTRITO' }

    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=nonce-teste-9',
    })

    assert.equal(resposta.status, 409)
    assert.deepEqual(JSON.parse(resposta.body), {
      ok: false,
      recusa: 'MODO_RESTRITO',
      estado: 'STOPPED',
    })
  })

  it('recusa NONCE_EXPIRADO: 409 com o codigo, sem mudanca de estado', async () => {
    const { id, token } = autenticar(bancada)
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false, recusa: 'NONCE_EXPIRADO' }

    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=velho',
    })

    assert.equal(resposta.status, 409)
    assert.equal((JSON.parse(resposta.body) as Record<string, unknown>)['recusa'], 'NONCE_EXPIRADO')
  })

  it('recusa SHUTDOWN_IN_PROGRESS (D29/CTL-007): 409, e a resposta nao e um 500 mudo', async () => {
    const { id, token } = autenticar(bancada)
    bancada.resultadoControl = {
      estado: 'STOPPING',
      idempotente: false,
      recusa: 'SHUTDOWN_IN_PROGRESS',
    }

    const resposta = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=x',
    })

    assert.equal(resposta.status, 409)
    assert.equal((JSON.parse(resposta.body) as Record<string, unknown>)['recusa'], 'SHUTDOWN_IN_PROGRESS')
  })
})

describe('POST /__guard/api/tunnel/stop -- o desliga', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada()
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  beforeEach(() => {
    // Cada caso comeca com o caderno limpo: o que o despacho falso recebeu
    // e o que ESTE caso lhe entregou, nada do anterior.
    bancada.intentos.length = 0
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false }
  })

  it('com sessao e CSRF: despacha action stop SEM nonce (CTL-024: reduzir exposicao funciona de primeira)', async () => {
    const { id, token, idHash } = autenticar(bancada)
    bancada.resultadoControl = { estado: 'STOPPING', idempotente: false }

    const resposta = await pedir(port, PANEL_PATH_TUNNEL_STOP, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(resposta.status, 200)
    assert.deepEqual(JSON.parse(resposta.body), { ok: true, estado: 'STOPPING' })
    assert.equal(bancada.intentos.length, 1)
    const intent = bancada.intentos[0]
    assert.ok(intent !== undefined)
    assert.equal(intent.action, 'stop')
    assert.equal(intent.requestedBy, `panel:${idHash}`)
    assert.equal(intent.nonce, undefined)
    assert.equal(intent.at, bancada.clock.now())
  })

  it('sem token anti-CSRF: 403, e o desliga NAO acontece', async () => {
    const { id } = autenticar(bancada)
    const resposta = await pedir(port, PANEL_PATH_TUNNEL_STOP, {
      method: 'POST',
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(resposta.status, 403)
    assert.equal(bancada.intentos.length, 0)
  })

  it('recusa do controlador: 409 com o codigo no corpo', async () => {
    const { id, token } = autenticar(bancada)
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false, recusa: 'TERMINAL_SEM_RESET' }

    const resposta = await pedir(port, PANEL_PATH_TUNNEL_STOP, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(resposta.status, 409)
    assert.equal((JSON.parse(resposta.body) as Record<string, unknown>)['recusa'], 'TERMINAL_SEM_RESET')
  })
})

describe('sessao expirada com o painel aberto', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada()
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  beforeEach(() => {
    // Cada caso comeca com o caderno limpo: o que o despacho falso recebeu
    // e o que ESTE caso lhe entregou, nada do anterior.
    bancada.intentos.length = 0
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false }
  })

  it('o POST do botao falha com o 401 do gate, indistinguivel de nunca ter havido sessao', async () => {
    const { id, token } = autenticar(bancada)
    const antes = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=qualquer',
    })
    assert.equal(antes.status, 200)

    bancada.clock.advance(SESSION_ABSOLUTE_TIMEOUT_MS + 60_000)

    const expirada = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookie: `__Host-dsh_sid=${id}`,
      body: 'nonce=qualquer',
    })
    const anonima = await pedir(port, PANEL_PATH_TUNNEL_START, {
      method: 'POST',
      body: 'nonce=qualquer',
    })

    assert.equal(expirada.status, 401)
    assert.equal(expirada.body, anonima.body)
    assert.equal(expirada.headers['www-authenticate'], anonima.headers['www-authenticate'])
    // E o despacho ficou intocado: 401 antes do tratador, sempre.
    assert.equal(bancada.intentos.length, 1)
  })

  it('o mesmo vale para o desliga e para a emissao do nonce', async () => {
    const { id } = autenticar(bancada)
    bancada.clock.advance(SESSION_ABSOLUTE_TIMEOUT_MS + 60_000)

    const desliga = await pedir(port, PANEL_PATH_TUNNEL_STOP, {
      method: 'POST',
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })
    const nonce = await pedir(port, PANEL_PATH_TUNNEL_START_NONCE, {
      method: 'POST',
      cookie: `__Host-dsh_sid=${id}`,
      body: '',
    })

    assert.equal(desliga.status, 401)
    assert.equal(nonce.status, 401)
  })
})

describe('o painel nao revela a URL do tunel antes do login', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada({ estado: SNAPSHOT_ONLINE })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  beforeEach(() => {
    // Cada caso comeca com o caderno limpo: o que o despacho falso recebeu
    // e o que ESTE caso lhe entregou, nada do anterior.
    bancada.intentos.length = 0
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false }
  })

  it('a pagina autenticada NAO embute a URL -- ela so entra pelo /api/state', async () => {
    const { id } = autenticar(bancada)
    const pagina = await pedir(port, PANEL_PATH_ROOT, { cookie: `__Host-dsh_sid=${id}` })

    assert.equal(pagina.status, 200)
    assert.equal(pagina.body.includes(URL_DO_TUNEL), false)
    assert.equal(pagina.body.includes('trycloudflare'), false)
  })

  it('nenhum POST anonimo a revela', async () => {
    for (const caminho of [PANEL_PATH_TUNNEL_START, PANEL_PATH_TUNNEL_STOP, PANEL_PATH_TUNNEL_START_NONCE]) {
      const resposta = await pedir(port, caminho, { method: 'POST', body: '' })
      assert.equal(resposta.status, 401)
      assert.equal(resposta.body.includes(URL_DO_TUNEL), false)
      assert.equal(resposta.body.includes('trycloudflare'), false)
    }
  })
})

describe('o seq do controlador no estado -- a projecao do painel', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada()
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  beforeEach(() => {
    // Cada caso comeca com o caderno limpo: o que o despacho falso recebeu
    // e o que ESTE caso lhe entregou, nada do anterior.
    bancada.intentos.length = 0
    bancada.resultadoControl = { estado: 'STOPPED', idempotente: false }
  })

  it('GET /__guard/api/state com sessao traz o seq corrente', async () => {
    const { id } = autenticar(bancada)
    bancada.seqValor = 41

    const resposta = await pedir(port, PANEL_PATH_STATE, { cookie: `__Host-dsh_sid=${id}` })

    assert.equal(resposta.status, 200)
    assert.equal((JSON.parse(resposta.body) as Record<string, unknown>)['seq'], 41)
  })

  it('o seq avanca quando o controlador avanca -- o painel e projecao, nao cache', async () => {
    const { id } = autenticar(bancada)
    bancada.seqValor = 7
    const primeiro = await pedir(port, PANEL_PATH_STATE, { cookie: `__Host-dsh_sid=${id}` })
    bancada.seqValor = 8
    const segundo = await pedir(port, PANEL_PATH_STATE, { cookie: `__Host-dsh_sid=${id}` })

    assert.equal((JSON.parse(primeiro.body) as Record<string, unknown>)['seq'], 7)
    assert.equal((JSON.parse(segundo.body) as Record<string, unknown>)['seq'], 8)
  })
})
