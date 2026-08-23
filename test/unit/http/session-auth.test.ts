/**
 * `src/http/session-auth.ts` -- o MECANISMO de sessao e de credencial do portao.
 *
 * A rota `POST /__guard/api/login` NAO e testada aqui: ela e de T3.4. O que se
 * prova e o mecanismo que ela vai usar -- ler o cookie, valida-lo, e deixar
 * passar -- mais as duas pendencias herdadas (auditoria fail-closed e o
 * `StateError` de `verify()`) e o consumo do intent de modo restrito.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { AuditWriteError } from '../../../src/audit/log.ts'
import type { AuditEvent } from '../../../src/contracts/auth.ts'
import type { ExposureConfig } from '../../../src/contracts/tunnel.ts'
import { createGuardedHandler } from '../../../src/http/gate.ts'
import {
  createRequestOriginResolver,
  createTunnelOriginRegistry,
  presentsCredential,
  presentedSecret,
  readPresentedSession,
  recordAudit,
  resolveRequestIdentity,
  rewriteAuthenticatedTunnelRequest,
  verifyPresentedCredential,
  EDGE_CLIENT_IP_HEADER,
  EDGE_FORWARDED_PROTO_HEADER,
  TRUSTED_EDGE_HEADERS,
} from '../../../src/http/session-auth.ts'
import { createGuardLogger } from '../../../src/logging/logger.ts'
import { StateError } from '../../../src/state/schema.ts'
import { FakeResponse, FakeContext } from '../../support/ctx-double.ts'
import { makeConfig } from '../../support/fixtures.ts'
import { bancada, basic, pedido, OWNER_SECRET, type Bancada } from './bancada.ts'

let aberta: Bancada | undefined
function abrir(...args: Parameters<typeof bancada>): Bancada {
  aberta = bancada(...args)
  return aberta
}
afterEach(() => {
  aberta?.cleanup()
  aberta = undefined
})

const log = createGuardLogger(new FakeContext().asContext())

const TUNEL: ExposureConfig = { mode: 'tunnel', autoStart: false, trustEdgeHeaders: true }
const LOOPBACK: ExposureConfig = { mode: 'loopback', autoStart: false, trustEdgeHeaders: false }

describe('registo da origem publica do tunel', () => {
  it('entra em READY e SAI quando o tunel cai -- sem entradas mortas', () => {
    const registo = createTunnelOriginRegistry()
    assert.equal(registo.current(), undefined)
    registo.publish('https://abc.trycloudflare.com')
    assert.equal(registo.current(), 'https://abc.trycloudflare.com')
    registo.publish(undefined)
    assert.equal(registo.current(), undefined)
  })
})

describe('o que conta como credencial APRESENTADA', () => {
  it('um pedido anonimo nao apresenta nada (e nao e uma tentativa)', () => {
    assert.equal(presentsCredential(pedido()), false)
    assert.equal(presentsCredential(pedido({ headers: { cookie: 'outra=coisa' } })), false)
  })

  it('Authorization ou um cookie de sessao bem formado contam', () => {
    assert.equal(presentsCredential(pedido({ headers: { authorization: basic('x') } })), true)
    assert.equal(
      presentsCredential(pedido({ headers: { cookie: `__Host-dsh_sid=${'a'.repeat(43)}` } })),
      true,
    )
  })

  it('extrai apenas a SENHA do Basic (o utilizador `dsh` nao e segredo)', () => {
    assert.equal(presentedSecret(basic('K7QF-2M9X')), 'K7QF-2M9X')
    assert.equal(presentedSecret('Basic ' + Buffer.from('dsh:a:b:c').toString('base64')), 'a:b:c')
    assert.equal(presentedSecret(undefined), '')
    assert.equal(presentedSecret('Bearer xyz'), '')
    assert.equal(presentedSecret('Basic sem-dois-pontos'), '')
  })
})

describe('sessao apresentada', () => {
  it('valida o cookie canonico e recusa o duplicado (cookie shadowing)', () => {
    const b = abrir()
    const id = b.stack.sessions.create()

    assert.notEqual(readPresentedSession(pedido({ headers: { cookie: `__Host-dsh_sid=${id}` } }), b.stack.sessions), null)
    assert.equal(
      readPresentedSession(
        pedido({ headers: { cookie: `__Host-dsh_sid=${id}; __Host-dsh_sid=${id}` } }),
        b.stack.sessions,
      ),
      null,
      'duas ocorrencias significam que alguem injetou uma: fecha-se',
    )
  })

  it('depois do dispose a leitura e FECHADA e silenciosa', () => {
    const b = abrir()
    const cookie = `__Host-dsh_sid=${b.stack.sessions.create()}`
    b.stack.sessions.dispose()

    assert.equal(readPresentedSession(pedido({ headers: { cookie } }), b.stack.sessions), null)
  })
})

describe('identidade: UM cabecalho de borda, e so um', () => {
  it('le CF-Connecting-IP quando (e so quando) ha borda provada a frente', () => {
    const req = pedido({ headers: { [EDGE_CLIENT_IP_HEADER]: '203.0.113.9' } })

    assert.equal(
      resolveRequestIdentity(req, { exposure: TUNEL, viaTunnel: true, session: null }).ip,
      '203.0.113.9',
    )
    assert.equal(
      resolveRequestIdentity(req, { exposure: TUNEL, viaTunnel: false, session: null }).ip,
      undefined,
      'um processo local ligado direto NAO passou pela borda que recusa a forja',
    )
    assert.equal(
      resolveRequestIdentity(req, { exposure: LOOPBACK, viaTunnel: true, session: null }).ip,
      undefined,
      'sem borda nenhuma o cabecalho so pode ter sido escrito localmente',
    )
  })

  it('NUNCA le X-Forwarded-For nem X-Real-IP -- eles sao ACRESCENTADOS, logo forjaveis', () => {
    const req = pedido({
      headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9', 'x-real-ip': '1.2.3.4' },
    })
    assert.equal(
      resolveRequestIdentity(req, { exposure: TUNEL, viaTunnel: true, session: null }).ip,
      undefined,
    )
  })

  it('recusa um CF-Connecting-IP com lista (alguem esta a somar valores)', () => {
    const req = pedido({ headers: { [EDGE_CLIENT_IP_HEADER]: '1.2.3.4, 203.0.113.9' } })
    assert.equal(
      resolveRequestIdentity(req, { exposure: TUNEL, viaTunnel: true, session: null }).ip,
      undefined,
    )
  })
})

describe('pendencia (a): auditoria indisponivel NEGA, e nao lanca', () => {
  it('mapeia AuditWriteError para `false` e nunca deixa a excecao subir', () => {
    const sink = {
      append(_event: AuditEvent): void {
        throw new AuditWriteError('disco cheio', 3, '/nao/apresentavel/audit.log')
      },
    }
    let resultado = true
    assert.doesNotThrow(() => {
      resultado = recordAudit({ audit: sink }, log, { evento: 'x', resultado: 'negado' })
    })
    assert.equal(resultado, false, 'nao registou => o portao TEM de negar')
  })

  it('devolve `true` no caminho feliz', () => {
    const b = abrir()
    assert.equal(recordAudit(b.stack.auth, log, { evento: 'x', resultado: 'permitido' }), true)
  })
})

describe('pendencia (b): `verify()` propaga StateError', () => {
  it('um StateError vira `false` (nega), fica auditado, e NAO vira 500', () => {
    const b = abrir()
    const registado: AuditEvent[] = []

    const resultado = verifyPresentedCredential({
      req: pedido({ headers: { authorization: basic(OWNER_SECRET) } }),
      config: makeConfig(),
      auth: {
        secrets: {
          verify(): boolean {
            throw new StateError('STATE_READ_FAILED', 'state.json ilegivel')
          },
        },
        audit: {
          append(event: AuditEvent): void {
            registado.push(event)
          },
        },
      },
      log,
      staticCredentialMatches: () => false,
    })

    assert.equal(resultado, false, 'um catch que devolvesse `true` era o anti-padrao proibido')
    assert.deepEqual(registado, [{ evento: 'auth_segredo_indisponivel', resultado: 'negado' }])
    void b
  })

  it('os DOIS lados correm sempre -- sem curto-circuito que vire canal temporal', () => {
    let estaticoCorreu = false
    let segredoCorreu = false

    verifyPresentedCredential({
      req: pedido({ headers: { authorization: basic('x') } }),
      config: makeConfig(),
      auth: {
        secrets: {
          verify(): boolean {
            segredoCorreu = true
            return false
          },
        },
        audit: { append(): void {} },
      },
      log,
      staticCredentialMatches: () => {
        estaticoCorreu = true
        return true // acerta no PRIMEIRO lado
      },
    })

    assert.equal(estaticoCorreu, true)
    assert.equal(segredoCorreu, true, 'o segundo lado tem de correr mesmo quando o primeiro acerta')
  })
})

describe('reescrita de cabecalhos do tunel', () => {
  it('poe o Host no loopback e apaga a cerca de borda do nucleo', () => {
    const req = pedido({
      headers: {
        host: 'abc.trycloudflare.com',
        origin: 'https://abc.trycloudflare.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'sec-fetch-user': '?1',
        authorization: basic('x'),
      },
    })

    rewriteAuthenticatedTunnelRequest(req, '127.0.0.1:3080')

    assert.equal(req.headers.host, '127.0.0.1:3080')
    for (const apagado of ['origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) {
      assert.equal(req.headers[apagado], undefined, apagado)
    }
    assert.equal(req.headers.authorization, basic('x'), 'a credencial nao se toca')
  })
})

describe('modo restrito: o intent derruba a exposicao (Onda 2 decide, o portao age)', () => {
  it('ao teto NIST: a origem do tunel SAI da allowlist e as sessoes sao revogadas', async () => {
    const b = abrir({ comSegredo: true, tunnelReady: true })
    b.stack.sessions.create()

    const handler = createGuardedHandler(b.gate, (): void => {}, 'dispatch:request')

    // 100 tentativas com o segredo errado, todas pelo TUNEL (o acesso local
    // abre direto na onda 1 e nunca percorre o caminho de credencial). O
    // atraso interno esta injetado a zero (`04-TESTES.md` 5.1.3: nao se
    // cronometra em CI).
    for (let i = 0; i < 100; i += 1) {
      await handler(
        pedido({
          headers: {
            host: 'marks-organization-moved-coupons.trycloudflare.com',
            authorization: basic(`errada-${String(i)}`),
          },
        }),
        new FakeResponse().asServerResponse(),
      )
    }

    assert.equal(b.stack.restricted.isActive(), true, 'o teto NIST tem de acender o modo restrito')
    assert.equal(b.tunnelOrigin.current(), undefined, 'a origem do tunel tem de SAIR da allowlist')
    assert.equal(b.stack.sessions.live, 0, 'todas as sessoes emitidas sao invalidadas')
    // PERSISTE: reiniciar o DSH nao e o bypass.
    assert.equal(b.stack.state.read().restricted?.reason, 'brute-force-ceiling')
  })
})

describe('esquema do pedido: a condicao e o MODO, nao o HOST', () => {
  const TUNNEL_HOST = 'abc-def.trycloudflare.com'

  function resolutor(mode: ExposureConfig['mode'], comTunel: boolean) {
    const tunnelOrigin = createTunnelOriginRegistry()
    if (comTunel) tunnelOrigin.publish(`https://${TUNNEL_HOST}`)
    const config = makeConfig({
      exposure: { mode, autoStart: false, trustEdgeHeaders: false },
      ...(mode === 'tunnel' ? { tunnel: { mode: 'quick' as const, ttlMinutes: 60 } } : {}),
    })
    return createRequestOriginResolver({ config, tunnelOrigin })
  }

  it('a lista de cabecalhos de borda acreditados tem EXATAMENTE dois elementos', () => {
    assert.deepEqual([...TRUSTED_EDGE_HEADERS], ['cf-connecting-ip', 'x-forwarded-proto'])
  })

  it('confia no X-Forwarded-Proto quando o pedido chegou PELA BORDA (medicao R10)', () => {
    const resolve = resolutor('tunnel', true)
    assert.deepEqual(
      resolve(pedido({ headers: { host: TUNNEL_HOST, [EDGE_FORWARDED_PROTO_HEADER]: 'https' } })),
      { scheme: 'https', host: TUNNEL_HOST },
    )
  })

  it('>>> uma instalacao em LAN e nao-loopback e NAO tem borda: o header e ignorado <<<', () => {
    // "host nao e loopback" NAO e "estamos atras da borda da Cloudflare". Aqui o
    // cabecalho e escrito por qualquer maquina do segmento.
    for (const mode of ['loopback', 'tunnel'] as const) {
      const resolve = resolutor(mode, mode === 'tunnel')
      assert.deepEqual(
        resolve(
          pedido({ headers: { host: '192.168.1.5:3080', [EDGE_FORWARDED_PROTO_HEADER]: 'https' } }),
        ),
        { scheme: 'http', host: '192.168.1.5:3080' },
        `mode=${mode}: um host de LAN nao compra confianca no cabecalho`,
      )
    }
  })

  it('em modo loopback o cabecalho NUNCA e consultado, venha de onde vier', () => {
    const resolve = resolutor('loopback', false)
    assert.equal(
      resolve(pedido({ headers: { host: TUNNEL_HOST, [EDGE_FORWARDED_PROTO_HEADER]: 'https' } })).scheme,
      'http',
    )
  })

  it('um valor invalido (ou uma lista) cai para o socket em vez de adivinhar', () => {
    const resolve = resolutor('tunnel', true)
    for (const valor of ['gopher', 'https, http', '']) {
      assert.equal(
        resolve(pedido({ headers: { host: TUNNEL_HOST, [EDGE_FORWARDED_PROTO_HEADER]: valor } })).scheme,
        'http',
        valor,
      )
    }
  })
})
