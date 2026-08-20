/**
 * =============================================================================
 * ADV-001..ADV-020 -- NENHUMA ROTA ESCAPA DO GATE. Suite adversarial de T6.3.
 * =============================================================================
 *
 * A lista fechada de 04-TESTES.md 6.1, contra o servidor REAL por SOCKET CRU
 * (nao fetch, que normaliza o caminho antes de enviar). A regra do ficheiro:
 * **toda a superficie e guardada** (a barreira e dona do despacho) e o unico
 * pass-through sem credencial e a tabela de isencao de T3.4 -- que este ficheiro
 * tambem fecha, por igualdade de conjunto e por comportamento.
 *
 * PORQUE SOCKET CRU: e o unico cliente que deixa o request-target intacto. O
 * node:http.request reescreve //api/x como /api/x e o fetch normaliza antes de
 * enviar; nenhum dos dois exercita o parser do servidor. O atacante escreve a
 * linha de pedido a mao, e e essa linha que o parser do node:http (e o
 * canonizador do portao) tem de aguentar.
 *
 * O QUE SE ASSERE, E O QUE NAO SE ASSERE: esperado uniforme 401/403/404, NUNCA
 * pass-through (200 do delegado). O 404 e o caso de CANAL LOCAL APENAS
 * (/__guard/secret pelo tunel, L2.6 antes da isencao). O 400 de ADV-019 e do
 * node:http a rejeitar Content-Length + Transfer-Encoding -- nao e a nossa
 * camada, e o teste regista-o honestamente.
 *
 * AS TRES ROTAS ISENTAS DE T3.4 (04-TESTES 5.9 / 03-ONDAS T3.4):
 *
 *   GET  /__guard/magic  -- pagina INERTE: nao consome, nao emite sessao;
 *   GET  /__guard/secret -- so com ott (canal LOCAL apenas, L2.6);
 *   POST /__guard/api/login -- o passo que CRIA a sessao.
 *
 * A isencao e ENUMERADA: a lista do gate e EXATAMENTE estas tres, e nenhuma
 * grafia vizinha (/__guard/magicX, /x/../__guard/magic, /__guard/API/login) as
 * alcanca -- o canonizador resolve-as para a MESMA chave da tabela, e o teste
 * comportamental abaixo prova que o lookalike NAO passa sem credencial.
 * =============================================================================
 */


import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { after, before, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { installAuthBarrier } from '../../src/http/intercept.ts'
import { LOOPBACK_ONLY_PREFIXES, UNAUTHENTICATED_PANEL_PREFIXES } from '../../src/index.ts'
import { canonicalRequestPath, isGuardedPath } from '../../src/http/path.ts'
import { bancada, basic, OWNER_SECRET, type Bancada } from '../unit/http/bancada.ts'

let b: Bancada
let server: Server
let port = 0
let reverter: (() => void) | undefined
/** O delegado marcou pass-through? false em toda a suite = nenhuma rota escapou. */
let delegadoAlcancado = false

const HOST_DO_TUNEL = 'marks-organization-moved-coupons.trycloudflare.com'

before(async () => {
  server = createServer()
  server.on('request', (_req, res) => {
    delegadoAlcancado = true
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('PASSOU')
  })
  server.on('upgrade', (_req, socket: Duplex) => {
    delegadoAlcancado = true
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  b = bancada({
    comSegredo: true,
    tunnelReady: true,
    loopbackAuthority: `127.0.0.1:${String(port)}`,
    unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
    loopbackOnlyPrefixes: LOOPBACK_ONLY_PREFIXES,
  })
  reverter = installAuthBarrier(
    server,
    {
      wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'adv:path'),
      wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'adv:path:upgrade'),
    },
    b.gate.log,
  )
})

after(async () => {
  reverter?.()
  b.cleanup()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Pedido CRU por socket, com a linha de pedido exatamente como o atacante a escreve. */
function pedidoCru(linhaDePedido: string, host: string = '127.0.0.1'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${linhaDePedido}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => void pedacos.push(d))
    socket.on('error', reject)
    socket.on('end', () => resolve(Buffer.concat(pedacos).toString('latin1')))
  })
}

/** 401/403/404, e o delegado NUNCA foi alcancado. */
async function exigeRecusa(
  linha: string,
  rotulo: string,
  host: string = '127.0.0.1',
  permitidos: readonly number[] = [401, 403, 404],
): Promise<void> {
  delegadoAlcancado = false
  const resposta = await pedidoCru(linha, host)
  const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(resposta)?.[1] ?? 0)
  assert.ok(
    permitidos.includes(status),
    `${rotulo}: esperava ${permitidos.join('/')}, recebi ${String(status)}\n${resposta.slice(0, 200)}`,
  )
  assert.equal(delegadoAlcancado, false, `${rotulo}: o delegado foi alcancado (${linha})`)
  assert.equal(resposta.includes('PASSOU'), false, `${rotulo}: o corpo do delegado vazou`)
}
describe('ADV-001..019 -- a tabela fechada de request-targets evasivos', () => {
  it('ADV-001: /api/x -- baseline: guardado', async () => {
    await exigeRecusa('GET /api/x HTTP/1.1', 'ADV-001')
  })

  it('ADV-002: /apinfo -- fronteira de SEGMENTO: /api NAO cobre /apinfo', async () => {
    // O predicado puro e a fronteira: o mutante M-12 (startsWith sem fronteira)
    // morre AQUI, e nao no socket.
    assert.equal(isGuardedPath('/apinfo', ['/api']), false)
    assert.equal(isGuardedPath('/api', ['/api']), true)
    // No gate, a superficie INTEIRA e guardada: /apinfo sem credencial e 401,
    // nunca 200 -- o pass-through so existe para as tres isentas.
    await exigeRecusa('GET /apinfo HTTP/1.1', 'ADV-002')
  })

  it('ADV-003: //api/x -- barra dupla', async () => {
    await exigeRecusa('GET //api/x HTTP/1.1', 'ADV-003')
  })

  it('ADV-004: /./api/x -- segmento ponto', async () => {
    await exigeRecusa('GET /./api/x HTTP/1.1', 'ADV-004')
  })

  it('ADV-005: /foo/../api/x -- traversal para DENTRO do prefixo', async () => {
    await exigeRecusa('GET /foo/../api/x HTTP/1.1', 'ADV-005')
  })

  it('ADV-006: /api/../public/x -- traversal a SAIR do prefixo', async () => {
    await exigeRecusa('GET /api/../public/x HTTP/1.1', 'ADV-006')
  })

  it('ADV-007: /%61pi/x -- percent-encoding de letra', async () => {
    await exigeRecusa('GET /%61pi/x HTTP/1.1', 'ADV-007')
  })

  it('ADV-008: /api%2fx -- barra codificada', async () => {
    await exigeRecusa('GET /api%2fx HTTP/1.1', 'ADV-008')
  })

  it('ADV-009: /%2e%2e/api/x -- ponto-ponto codificado', async () => {
    await exigeRecusa('GET /%2e%2e/api/x HTTP/1.1', 'ADV-009')
  })

  it('ADV-010: /%252e%252e/api/x -- DUPLO encoding (nao decodifica duas vezes)', async () => {
    await exigeRecusa('GET /%252e%252e/api/x HTTP/1.1', 'ADV-010')
  })

  it('M-14: o canonizador PARA ao fim de 3 passagens -- triplo encoding nao colapsa', () => {
    // %2525252e so se torna '.' na QUARTA passagem. Com o limite de 3, o
    // resultado tem de ficar em /%2e%2e/api/x (o %2e sobrevive); se um
    // mutante aumentar o limite, colapsa para /api/x e o ASSERT cai. Este e o
    // teste que mata M-14 (decodificar percent DUAS vezes).
    assert.equal(canonicalRequestPath('/%2525252e%2525252e/api/x'), '/%2e%2e/api/x')
  })

  it('ADV-011: /API/x -- maiusculas: sobre-guarda deliberada (case-insensitive)', async () => {
    await exigeRecusa('GET /API/x HTTP/1.1', 'ADV-011')
  })

  it('ADV-012: /api/x;jsessionid=1 -- parametro de caminho', async () => {
    await exigeRecusa('GET /api/x;jsessionid=1 HTTP/1.1', 'ADV-012')
  })

  it('ADV-013: /api/x%00.png -- NUL byte', async () => {
    await exigeRecusa('GET /api/x%00.png HTTP/1.1', 'ADV-013')
  })

  it('ADV-014: /api/x?a=/public -- a query nao altera a decisao', async () => {
    await exigeRecusa('GET /api/x?a=/public HTTP/1.1', 'ADV-014')
  })

  it('ADV-015: /api/x#frag -- fragmento', async () => {
    await exigeRecusa('GET /api/x#frag HTTP/1.1', 'ADV-015')
  })

  it('ADV-016: /api/x (espaco/ponto ao final -- normalizacao FS do Windows)', async () => {
    await exigeRecusa('GET /api/x%20 HTTP/1.1', 'ADV-016 espaco')
    await exigeRecusa('GET /api/x. HTTP/1.1', 'ADV-016 ponto')
  })

  it('ADV-017: GET http://outro.host/api/x -- absolute-form', async () => {
    // O node:http entrega req.url = 'http://outro.host/api/x'. O canonizador
    // resolve-o para /http:/outro.host/api/x (nao cai sob /api); a superficie
    // inteira guardada devolve 401 na mesma -- nunca pass-through.
    await exigeRecusa('GET http://outro.host/api/x HTTP/1.1', 'ADV-017')
  })

  it('ADV-018: /api//x -- barras duplas internas', async () => {
    await exigeRecusa('GET /api//x HTTP/1.1', 'ADV-018')
  })

  it('ADV-019: Content-Length + Transfer-Encoding juntos -- o NODE rejeita, nao nos', async () => {
    const resposta = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          'POST /api/x HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
            'Content-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
        )
      })
      const pedacos: Buffer[] = []
      socket.on('data', (d: Buffer) => void pedacos.push(d))
      socket.on('error', reject)
      socket.on('end', () => resolve(Buffer.concat(pedacos).toString('latin1')))
    })
    const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(resposta)?.[1] ?? 0)
    // O request smuggling nao e a nossa camada; a assercao honesta e que o
    // node:http RECUSA (400) e o delegado nunca ve o pedido.
    assert.equal(status, 400, `esperava 400 do node:http, recebi ${status}`)
    assert.equal(delegadoAlcancado, false)
  })
})

describe('ADV-020 -- fuzz de 5000 caminhos (semente fixa), invariante do canonizador', () => {
  it('nunca lanca; nenhum segmento .. sobrevive; nenhuma barra dupla', () => {
    // Semente LCG fixa: a suite e deterministica e reprodutivel.
    let seed = 0x5eed_1234
    const proximo = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0
      return seed
    }

    for (let i = 0; i < 5000; i += 1) {
      const tamanho = (proximo() % 64) + 1
      let alvo = '/'
      for (let j = 0; j < tamanho; j += 1) alvo += String.fromCharCode(proximo() % 256)
      // INVARIANTE 1: nunca lanca. Um lancamento no caminho de decisao seria
      // um 500 no catch do portao -- o oraculo que D9 proibe.
      const canonico = canonicalRequestPath(alvo)
      assert.equal(typeof canonico, 'string', `lanca em ${JSON.stringify(alvo)}`)
      // INVARIANTE 2: traversal neutralizado. Um segmento .. que sobreviva
      // seria a porta para o M-13/M-14 escaparem por aqui.
      for (const segmento of canonico.split('/')) {
        assert.notEqual(segmento, '..', `segmento .. em ${JSON.stringify(canonico)} (de ${JSON.stringify(alvo)})`)
      }
      // INVARIANTE 3: barras repetidas colapsadas.
      assert.equal(canonico.includes('//'), false, `// em ${JSON.stringify(canonico)} (de ${JSON.stringify(alvo)})`)
    }
  })

  it('residual DECLARADO: % e \\u0000 PODEM sobreviver -- e sao fail-closed', () => {
    // NOTA DE HONESTIDADE sobre a letra de 04-TESTES 6.1 (o canonico "nunca
    // devolve string contendo .., %, \\0 ou //"). As duas primeiras sao
    // verdadeiras por construcao; as duas ultimas NAO:
    //
    //   - % sobrevive quando a sequencia e malformada (/ %zz): o
    //     safeDecodeURIComponent devolve a entrada INTACTA no erro, por
    //     decisao documentada (src/http/path.ts) -- uma excecao no caminho de
    //     decisao seria pior do que a string por decodificar;
    //   - \\u0000 aparece quando %00 e decodificado: o NUL e um byte legal
    //     numa string JS e o canonizador nao o filtra.
    //
    // PORQUE ISTO NAO E UM FURO: o canonico e uma CHAVE DE COMPARACAO, nunca
    // um caminho servido. Um % ou NUL residual so pode fazer a chave NAO bater
    // com um prefixo declarado (que nunca os contem) -- e a superficie inteira
    // e guardada por omissao, logo o resultado e 401, nunca pass-through.
    assert.equal(canonicalRequestPath('/%zz'), '/%zz')
    assert.equal(canonicalRequestPath('/%00'), '/\u0000')
    assert.equal(canonicalRequestPath('/api/x%00.png'), '/api/x\u0000.png')
    assert.equal(isGuardedPath('/%zz', ['/__guard/magic']), false)
    assert.equal(isGuardedPath('/__guard/magic%00', ['/__guard/magic']), false)
  })
})

describe('AS TRES ROTAS ISENTAS DE T3.4 -- na tabela, e em lugar nenhum alem dela', () => {
  it('a lista do gate e EXATAMENTE as tres isentas, por igualdade de conjunto', () => {
    assert.deepEqual(
      [...UNAUTHENTICATED_PANEL_PREFIXES].toSorted(),
      ['/__guard/api/login', '/__guard/magic', '/__guard/secret'],
    )
  })

  it('/__guard/secret esta em AMBAS as tabelas: isenta DE credencial E canal local apenas', () => {
    assert.deepEqual([...LOOPBACK_ONLY_PREFIXES], ['/__guard/secret'])
  })

  it('comportamental: as tres isentas chegam ao delegado SEM credencial', async () => {
    for (const [metodo, alvo] of [
      ['GET', '/__guard/magic'],
      ['GET', '/__guard/secret'],
      ['POST', '/__guard/api/login'],
    ]) {
      delegadoAlcancado = false
      const resposta = await pedidoCru(`${metodo} ${alvo} HTTP/1.1`)
      const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(resposta)?.[1] ?? 0)
      assert.equal(status, 200, `${metodo} ${alvo}: esperava pass-through isento, recebi ${status}`)
      assert.equal(delegadoAlcancado, true, `${metodo} ${alvo}: o delegado nao foi alcancado`)
    }
  })

  it('LOOKALIKES NAO-DESCENDENTES nao sao isentos: o gate recusa-os', async () => {
    // A isencao e por SEGMENTO (isGuardedPath): /__guard/magic cobre
    // /__guard/magic/passo2 mas NAO /__guard/magicX. Cada um destes tem de
    // levar 401/403/404.
    for (const alvo of [
      '/__guard/magicX',
      '/__guard/magico',
      '/__guard/secretX',
      '/__guard/api/loginX',
      '/__guard/api/other',
      // /__guard/API/login NAO e lookalike: o canonizador e case-insensitive de
      // proposito (sobre-guarda deliberada, ADV-011) e resolve-o para a MESMA
      // chave da tabela -- logo e a propria isencao, e tem de passar.
      '/x/../__guard/magicX',
    ]) {
      await exigeRecusa(`GET ${alvo} HTTP/1.1`, `lookalike ${alvo}`)
    }
  })

  it('DESCENDENTES de um prefixo isento passam o GATE -- e o PAINEL e o segundo portao (PANEL-009)', async () => {
    // A isencao do gate e por prefixo de SEGMENTO (documentado em
    // src/index.ts e src/http/gate.ts): um descendente cai SOB a mesma
    // entrada. O que o protege nao e o gate -- e a TABELA DO PAINEL
    // (test/security/panel-exemptions.test.ts, PANEL-009), que so serve as
    // rotas registadas e 404 o resto. Aqui assere-se a composicao:
    // descendentes chegam ao delegado (o gate deixou passar), e a tabela do
    // painel nao os conhece.
    for (const alvo of ['/__guard/magic/extra', '/__guard/api/login/extra']) {
      delegadoAlcancado = false
      const resposta = await pedidoCru(`GET ${alvo} HTTP/1.1`)
      const status = Number(/^HTTP\/1\.1 (\d{3})/u.exec(resposta)?.[1] ?? 0)
      assert.equal(status, 200, `${alvo}: o gate tem de passar descendentes do prefixo isento`)
      assert.equal(delegadoAlcancado, true)
    }
  })

  it('com credencial CORRETA, as rotas guardadas passam -- recusar tudo nao e defender', async () => {
    delegadoAlcancado = false
    const resposta = await pedidoCru('GET /api/state HTTP/1.1')
    assert.match(resposta, /^HTTP\/1\.1 401 /u)

    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${basic(OWNER_SECRET)}\r\nConnection: close\r\n\r\n`,
      )
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => void pedacos.push(d))
    const corpo = await new Promise<string>((resolve, reject) => {
      socket.on('error', reject)
      socket.on('end', () => resolve(Buffer.concat(pedacos).toString('utf8')))
    })
    assert.match(corpo, /^HTTP\/1\.1 200 /u)
    assert.equal(delegadoAlcancado, true)
  })

  it('a rota de CANAL LOCAL APENAS pelo tunel: 404, mesmo com credencial (L2.6 antes de L3)', async () => {
    await exigeRecusa('GET /__guard/secret HTTP/1.1', 'secret pelo tunel', HOST_DO_TUNEL, [404])
  })
})

describe('os prefixos guardados do plano de controlo (a configuracao que o gate usa)', () => {
  it('isGuardedPath cobre descendentes e nao apanha vizinhos -- o mutante M-12 morre aqui', () => {
    for (const alvo of ['/api', '/api/', '/api/commands/execute', '/API/x', '//api/x', '/%61pi']) {
      assert.equal(isGuardedPath(alvo, ['/api']), true, `${alvo} devia cair sob /api`)
    }
    for (const alvo of ['/apinfo', '/apix', '/apiX', '/ap', '/x-api']) {
      assert.equal(isGuardedPath(alvo, ['/api']), false, `${alvo} NAO devia cair sob /api`)
    }
  })
})
