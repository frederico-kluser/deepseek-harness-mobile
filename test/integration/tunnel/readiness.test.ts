/**
 * =============================================================================
 * `src/tunnel/readiness.ts` contra SOCKETS de verdade — TUN-012.
 * =============================================================================
 *
 * A pergunta desta suite e uma so, e ela ja custou caro:
 *
 *     "porta aberta"  !=  "aplicacao pronta"
 *
 * Um socket aceite pela borda nao prova nada sobre a aplicacao do outro lado. A
 * unica forma honesta de o demonstrar e ter aqui um `node:net` que ACEITA a
 * ligacao e nunca escreve um byte — coisa que nenhum duble de HTTP consegue
 * imitar, porque um duble de HTTP responde sempre alguma coisa.
 *
 * E a segunda pergunta, a que fecha a fronteira com T3.1:
 *
 *     "a aplicacao responde"  !=  "a aplicacao responde 401 a quem nao tem
 *                                  credencial"
 *
 * O readiness corre DEPOIS de o tunel subir. Quando ele ve um `200` anonimo, a
 * exposicao ja aconteceu. Quem recusa o `200` anonimo e o probe fail-closed de
 * T3.1, ANTES do arranque. Este ficheiro nao o duplica.
 *
 * Nenhum teste espera tempo real: o prazo corre no `FakeClock` congelado.
 * Portas sempre por `listen(0)`.
 */

import assert from 'node:assert/strict'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { setTimeout as dormirDeVerdade } from 'node:timers/promises'
import { after, describe, it } from 'node:test'

import { probeHttp } from '../../../src/tunnel/discover.ts'
import {
  createTunnelReadiness,
  defaultReadinessDeps,
  type ReadinessDeps,
} from '../../../src/tunnel/readiness.ts'
import { denyUnauthorized } from '../../../src/http/responses.ts'
import { FakeClock } from '../../support/clock.ts'

/* ========================================================================== */
/* Apoio                                                                      */
/* ========================================================================== */

const PRAZO = 30_000
const INTERVALO = 500

const servidores: Array<Server | NetServer> = []

after(async () => {
  for (const servidor of servidores) {
    servidor.close()
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
})

/**
 * `pollIntervalMs` maior encurta o teste sem lhe tirar nada: ele so decide
 * quantas voltas cabem no prazo VIRTUAL de 30 s. Os cenarios que so terminam por
 * esgotamento usam um passo largo — caso contrario o unico tempo de parede da
 * suite (o tecto por tentativa) era pago sessenta vezes.
 */
function depsReais(
  clock: FakeClock,
  pollIntervalMs = INTERVALO,
  // Curto por omissao: o socket mudo tem de ser declarado inalcancavel por
  // TEMPO, e nao por o teste ficar preso nele. Mas o tecto por tentativa
  // TAMBEM fecha o socket quando dispara — e um tecto curto mascarava a
  // ausencia do `res.destroy()`, deixando esse mutante vivo. O teste de
  // higiene de sockets usa por isso o valor de PRODUCAO.
  attemptTimeoutMs = 50,
): ReadinessDeps {
  return {
    ...defaultReadinessDeps,
    now: () => clock.now(),
    sleep: async (ms: number, signal: AbortSignal): Promise<void> => {
      clock.advance(ms)
      await dormirDeVerdade(2, undefined, { signal })
    },
    pollIntervalMs,
    attemptTimeoutMs,
  }
}

/** O tecto por tentativa que `defaultReadinessDeps` usa a serio. */
const TECTO_DE_PRODUCAO = 5000

/** Passo largo: seis voltas cobrem o prazo virtual inteiro. */
const PASSO_LARGO = 5000

async function escutar(servidor: Server | NetServer): Promise<string> {
  servidores.push(servidor)
  await new Promise<void>((resolve) => {
    servidor.listen(0, '127.0.0.1', resolve)
  })
  const { port } = servidor.address() as AddressInfo
  return `http://127.0.0.1:${String(port)}/`
}

/* ========================================================================== */
/* TUN-012 — porta aberta nao e aplicacao pronta                              */
/* ========================================================================== */

describe('TUN-012 — porta aberta NAO e aplicacao pronta', () => {
  it('um socket TCP que aceita e nunca responde da `usable: false` e `status: null`', async () => {
    // O caso que nenhum duble de HTTP consegue produzir: ligacao estabelecida,
    // handshake completo, zero bytes de resposta. Uma implementacao que
    // considerasse "consegui ligar" como pronto passava aqui a dizer que sim —
    // e o dono recebia um link que fica a girar para sempre.
    const mudo = createNetServer(() => {
      // Sem `socket.end()`: o silencio E o cenario.
    })
    const url = await escutar(mudo)
    const clock = new FakeClock(0)

    const resultado = await createTunnelReadiness(depsReais(clock, PASSO_LARGO)).waitUntilUsable({
      url,
      signal: new AbortController().signal,
      timeoutMs: PRAZO,
    })

    assert.deepEqual(resultado, { usable: false, status: null })
    assert.equal(clock.now() >= PRAZO, true)
  })

  it('nada a escutar (ECONNREFUSED) tambem da `status: null`', async () => {
    const provisorio = createNetServer()
    const url = await escutar(provisorio)
    await new Promise<void>((resolve) => {
      provisorio.close(() => {
        resolve()
      })
    })
    const clock = new FakeClock(0)

    const resultado = await createTunnelReadiness(depsReais(clock, PASSO_LARGO)).waitUntilUsable({
      url,
      signal: new AbortController().signal,
      timeoutMs: PRAZO,
    })

    assert.deepEqual(resultado, { usable: false, status: null })
  })

  it('503 da borda, 503 de novo, e so o 401 da aplicacao declara pronto', async () => {
    // A sequencia MEDIDA de um arranque: a borda ja atende antes de o conector
    // registar (`/ready` do cloudflared devolve 503 enquanto
    // `readyConnections` for 0) e so depois a aplicacao entra no caminho.
    let pedidos = 0
    const servidor = createHttpServer((_req, res) => {
      pedidos += 1
      if (pedidos <= 2) {
        res.writeHead(503)
        res.end()
        return
      }
      // O 401 REAL do modelo novo: texto puro, SEM `WWW-Authenticate` (o
      // desafio Basic foi removido a pedido do dono).
      denyUnauthorized(res)
    })
    const url = await escutar(servidor)
    const clock = new FakeClock(0)

    const resultado = await createTunnelReadiness(depsReais(clock)).waitUntilUsable({
      url,
      signal: new AbortController().signal,
      timeoutMs: PRAZO,
    })

    assert.deepEqual(resultado, { usable: true, status: 401 })
    assert.equal(pedidos, 3)
    assert.equal(clock.now(), 2 * INTERVALO)
  })

  it('preso em 530 ate ao fim do prazo: `usable: false`, mas com o codigo a vista', async () => {
    // 530 e o classico "Argo Tunnel error 1033": o hostname existe na borda e
    // nao ha tunel do outro lado. Devolver `status: 530` em vez de `null` e o
    // que permite ao dono distinguir "ninguem atendeu" de "a Cloudflare atendeu
    // e nao encontrou o meu conector".
    const servidor = createHttpServer((_req, res) => {
      res.writeHead(530)
      res.end()
    })
    const url = await escutar(servidor)
    const clock = new FakeClock(0)

    const resultado = await createTunnelReadiness(depsReais(clock, PASSO_LARGO)).waitUntilUsable({
      url,
      signal: new AbortController().signal,
      timeoutMs: PRAZO,
    })

    assert.deepEqual(resultado, { usable: false, status: 530 })
  })
})

/* ========================================================================== */
/* A fronteira com o probe de seguranca de T3.1                               */
/* ========================================================================== */

describe('readiness nao e o probe de seguranca', () => {
  it('sonda de forma ANONIMA: nenhuma credencial viaja para a borda', async () => {
    const cabecalhos: Array<Record<string, string | string[] | undefined>> = []
    const servidor = createHttpServer((req, res) => {
      cabecalhos.push({ ...req.headers })
      res.writeHead(401)
      res.end()
    })
    const url = await escutar(servidor)

    const resultado = await createTunnelReadiness(depsReais(new FakeClock(0))).waitUntilUsable({
      url,
      signal: new AbortController().signal,
      timeoutMs: PRAZO,
    })

    assert.equal(resultado.usable, true)
    assert.equal(cabecalhos.length, 1)
    const [primeiro] = cabecalhos
    assert.ok(primeiro !== undefined)
    // Mandar a senha do dono a cada volta do ciclo era espalhar o segredo por um
    // caminho que nao precisa dele.
    assert.equal(primeiro['authorization'], undefined)
    assert.equal(primeiro['cookie'], undefined)
  })

  it('endereco com credencial embutida e RECUSADO antes de sair pedido nenhum', async () => {
    // DEFEITO DE PRODUCAO apanhado pela revisao adversarial: `http.request`
    // copia `username`/`password` de um `URL` para `options.auth` e monta um
    // `Authorization: Basic`. Alcancavel em `tunnel.mode: 'named'`, onde a URL
    // vem do dominio do utilizador por configuracao e NAO passa por
    // `discover()`.
    const cabecalhos: Array<string | undefined> = []
    const servidor = createHttpServer((req, res) => {
      cabecalhos.push(req.headers.authorization)
      res.writeHead(401)
      res.end()
    })
    const url = await escutar(servidor)
    const comCredencial = url.replace('http://', 'http://dono:senha-do-dono@')

    await assert.rejects(
      createTunnelReadiness(depsReais(new FakeClock(0))).waitUntilUsable({
        url: comCredencial,
        signal: new AbortController().signal,
        timeoutMs: PRAZO,
      }),
      (erro: unknown) => {
        assert.equal((erro as { code: string }).code, 'INVALID_CONFIG')
        return true
      },
    )

    assert.deepEqual(cabecalhos, [], 'nem um pedido chegou ao servidor')
  })

  it('o SEGUNDO fecho: mesmo chamando `probeHttp` a mao, a credencial nao viaja', async () => {
    // O primeiro fecho e a recusa acima. Este e o de baixo, para o dia em que
    // aparecer um chamador que nao passe por `parseUsableUrl`. Medido: SEM o
    // `auth: null`, o servidor recebe `Basic ZG9ubzpzZW5oYS1kby1kb25v`.
    const cabecalhos: Array<string | undefined> = []
    const servidor = createHttpServer((req, res) => {
      cabecalhos.push(req.headers.authorization)
      res.writeHead(401)
      res.end()
    })
    const url = await escutar(servidor)

    const probe = await probeHttp({
      target: new URL(url.replace('http://', 'http://dono:senha-do-dono@')),
      signal: new AbortController().signal,
      timeoutMs: 1000,
      maxBodyBytes: 0,
    })

    assert.equal(probe.kind, 'response')
    assert.deepEqual(cabecalhos, [undefined], 'o pedido saiu, e saiu ANONIMO')
  })

  it('um 200 ANONIMO e declarado pronto — e isto e deliberado', async () => {
    // Contra-intuitivo, e o teste existe exactamente para impedir que alguem o
    // "corrija". Um `200` anonimo E uma falha grave de seguranca; so que, no
    // momento em que este modulo o observa, o tunel JA esta no ar. Quem tem de
    // o recusar e o probe fail-closed de T3.1, ANTES do arranque
    // (TUN-020..TUN-025). Exigir `401` aqui daria a ilusao de rede dupla e
    // mudava a verificacao para DEPOIS da exposicao — o defeito que ja expos o
    // DSH real do utilizador durante cerca de 40 s.
    const servidor = createHttpServer((_req, res) => {
      res.writeHead(200)
      res.end('<html>SPA</html>')
    })
    const url = await escutar(servidor)

    const resultado = await createTunnelReadiness(depsReais(new FakeClock(0))).waitUntilUsable({
      url,
      signal: new AbortController().signal,
      timeoutMs: PRAZO,
    })

    assert.deepEqual(resultado, { usable: true, status: 200 })
  })
})

/* ========================================================================== */
/* Aborto e recursos                                                          */
/* ========================================================================== */

describe('aborto e recursos', () => {
  it('aborta de imediato quando o processo morre, sem consumir o prazo', async () => {
    const controlador = new AbortController()
    let pedidos = 0
    const servidor = createHttpServer((_req, res) => {
      pedidos += 1
      if (pedidos === 2) controlador.abort()
      res.writeHead(502)
      res.end()
    })
    const url = await escutar(servidor)
    const clock = new FakeClock(0)

    const resultado = await createTunnelReadiness(depsReais(clock)).waitUntilUsable({
      url,
      signal: controlador.signal,
      timeoutMs: PRAZO,
    })

    assert.equal(resultado.usable, false)
    assert.equal(resultado.status, 502, 'o ultimo codigo observado sobrevive ao aborto')
    assert.equal(clock.now() < PRAZO, true, `clock=${String(clock.now())}`)
  })

  it('nao deixa ligacao viva: a pagina de erro da borda e descartada, nao lida', async () => {
    // MATA o `res.destroy()` do caminho `maxBodyBytes === 0`. A versao anterior
    // deste teste era DECORATIVA — sobrevivia a remocao de `agent: false`, de
    // `connection: close` E do `res.destroy()`, porque as tres eram redundantes
    // entre si. A revisao adversarial mostrou-o; o `connection: close` saiu do
    // `src` e o corpo da resposta passou a ser GRANDE, que e o que torna o
    // `destroy` observavel.
    //
    // E o caso real: a borda da Cloudflare responde com uma pagina HTML de erro
    // e o portao responde `401` com corpo. O readiness so quer o codigo; sem
    // `destroy`, cada volta do ciclo prende um socket com um corpo por ler.
    // 4 MB: o menor tamanho MEDIDO nesta maquina que excede os buffers de
    // socket e de stream. Abaixo disso o corpo cabe nos buffers, a resposta
    // completa-se sozinha e o `destroy` deixa de ser observavel — foi assim que
    // a primeira versao deste teste sobreviveu ao mutante. E nao e tamanho
    // inventado: o que esta por tras do tunel nao e nosso, e o corpo que ele
    // devolve nao tem tecto que nos pertenca.
    // 4 MB e QUATRO voltas. As duas coisas foram medidas e as duas sao
    // precisas: abaixo de 4 MB o corpo cabe nos buffers de socket e de stream,
    // a resposta completa-se sozinha e o `destroy` deixa de ser observavel; com
    // UMA volta so, um corpo unico tambem acaba por ser absorvido. O que a
    // matriz medida mostrou a acumular sockets foi a REPETICAO — que e
    // exactamente o modo de falha real: o readiness sonda em ciclo, e sem
    // `destroy` cada volta prende um socket com um corpo por ler.
    const corpo = Buffer.alloc(4 * 1024 * 1024, 'a')
    let voltas = 0
    const servidor = createHttpServer((_req, res) => {
      voltas += 1
      // As tres primeiras sao a borda ainda a registar; a quarta e o portao.
      res.writeHead(voltas <= 3 ? 503 : 401, { 'content-type': 'text/html' })
      res.end(corpo)
    })
    const url = await escutar(servidor)

    const resultado = await createTunnelReadiness(
      depsReais(new FakeClock(0), INTERVALO, TECTO_DE_PRODUCAO),
    ).waitUntilUsable({
      url,
      signal: new AbortController().signal,
      timeoutMs: PRAZO,
    })
    assert.equal(resultado.usable, true)
    assert.equal(voltas, 4, 'foram mesmo quatro sondagens, quatro sockets')

    // Uma volta de relogio de parede para o fecho do socket ser contabilizado —
    // e MUITO menos do que o tecto por tentativa, senao seria ele a limpar o
    // socket e o teste voltava a nao provar nada.
    await dormirDeVerdade(100)
    const abertas = await new Promise<number>((resolve, reject) => {
      servidor.getConnections((erro, quantas) => {
        if (erro !== null) reject(erro)
        else resolve(quantas)
      })
    })

    assert.equal(abertas, 0, 'ficou uma ligacao viva a borda depois de o readiness acabar')

    await new Promise<void>((resolve, reject) => {
      const guarda = setTimeout(() => {
        reject(new Error('o servidor nao fechou: ha socket nosso ainda vivo'))
      }, 2000)
      servidor.close(() => {
        clearTimeout(guarda)
        resolve()
      })
    })
  })
})
