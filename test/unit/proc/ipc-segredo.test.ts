/**
 * =============================================================================
 * S3 -- NENHUM SEGREDO NO PAYLOAD. NEM UM.
 * =============================================================================
 *
 * O contrato e explicito sobre o CRITERIO DE ACEITE, e sobre o que ele NAO e:
 *
 *   > "O criterio de aceite nao e o `git grep` -- e o teste comportamental que
 *   > PROVISIONA UM SEGREDO CONHECIDO, exercita TODOS os caminhos que produzem
 *   > payload, serializa cada um, e assere que a string do segredo NAO APARECE
 *   > EM NENHUM, EM CODIFICACAO NENHUMA."
 *
 * Um `git grep 'token'` prova que ninguem ESCREVEU o token num payload. Nao
 * prova nada sobre o que a composicao produz: um `JSON.stringify` de um objeto
 * de configuracao inteiro, um `error.message` de uma biblioteca HTTP que traz o
 * URL com o token dentro, ou um caminho absoluto num texto de erro passam todos
 * incolumes por um grep e chegam na mesma a infraestrutura do Telegram.
 *
 * Por isso este ficheiro:
 *   1. provisiona segredos com forma REALISTA (token de bot, senha, digest,
 *      `ott`, `mk`, caminho absoluto do `$HOME`);
 *   2. monta a composicao REAL (`createWorkerSupervisor` com o token na
 *      configuracao) e enumera o vocabulario FECHADO do contrato por completo;
 *   3. verifica cada payload em OITO codificacoes;
 *   4. e prova, no fim, que o proprio detetor apanha um segredo plantado -- sem
 *      isso, um teste verde poderia significar apenas que o detetor esta cego.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type {
  IpcErrorCode,
  IpcIntentMessage,
  IpcIntentName,
  IpcMessageToWorker,
  IpcStateMessage,
} from '../../../src/contracts/ipc.ts'
import { createWorkerSupervisor } from '../../../src/proc/supervisor.ts'
import { serializeIpcMessage } from '../../../src/ipc/channel.ts'
import { serializeWorkerIpcMessage } from '../../../worker/ipc.ts'
import { FakeScheduler, makeSupervisorDeps } from '../../support/child-double.ts'
import { makeConfig } from '../../support/fixtures.ts'
import { makeContextoComStdio } from './ipc-seat.ts'

/* ========================================================================== */
/* Os segredos provisionados                                                  */
/* ========================================================================== */

/**
 * Forma realista de cada um, porque a forma importa: um segredo de teste como
 * `'x'` casaria com meio ficheiro e o teste passaria a medir ruido.
 */
const SEGREDOS: Readonly<Record<string, string>> = {
  token: '7712345678:AAH9zQvJ4Kx7pLmN3rTyUiOpAsDfGhJkLzX',
  senha: 'zk4m-7q2w-9f6t-3b8v-5n1r',
  digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  ott: '01JQZ8Y7W6V5T4S3R2Q1P0N9M8',
  mk: 'mk_9aF3kQ7zR1tY5uI8oP2sD6gH4jK0lZ',
  caminhoAbsoluto: '/home/dono-da-maquina/.dsh/state.json',
}

/**
 * OITO codificacoes. Nao e paranoia decorativa: cada uma e uma forma em que um
 * segredo ja escapou de sistemas reais -- base64 num cabecalho `Authorization`,
 * hex num digest, percent-encoding num URL de callback, `\u00XX` numa string
 * JSON produzida por um serializador que escapa nao-ASCII.
 */
function codificacoes(valor: string): ReadonlyArray<readonly [string, string]> {
  const bytes = Buffer.from(valor, 'utf8')
  return [
    ['literal', valor],
    ['minusculas', valor.toLowerCase()],
    ['maiusculas', valor.toUpperCase()],
    ['base64', bytes.toString('base64')],
    ['base64url', bytes.toString('base64url')],
    ['hex', bytes.toString('hex')],
    ['percent', encodeURIComponent(valor)],
    [
      'json-unicode',
      [...valor].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
    ],
  ]
}

/** Devolve a primeira fuga encontrada, ou `undefined`. */
function procurarFuga(payload: string): string | undefined {
  const alvo = payload.toLowerCase()
  for (const [nome, segredo] of Object.entries(SEGREDOS)) {
    for (const [forma, texto] of codificacoes(segredo)) {
      // Comparacao insensivel a caixa dos dois lados: um segredo que viajasse
      // com a caixa trocada continua a ser o segredo.
      if (texto.length >= 8 && alvo.includes(texto.toLowerCase())) {
        return `${nome} em ${forma}`
      }
    }
  }
  return undefined
}

function assertSemSegredo(payloads: readonly string[], contexto: string): void {
  for (const payload of payloads) {
    const fuga = procurarFuga(payload)
    assert.equal(fuga, undefined, `${contexto}: fuga de ${String(fuga)} em ${payload}`)
  }
}

/* ========================================================================== */
/* O vocabulario FECHADO, por inteiro                                         */
/* ========================================================================== */

const ESTADOS: readonly IpcStateMessage['state'][] = [
  'STOPPED',
  'STARTING',
  'READY',
  'DEGRADED',
  'STOPPING',
  'FAILED',
]
const CODIGOS: readonly IpcErrorCode[] = [
  'SHUTDOWN_IN_PROGRESS',
  'EXPOSURE_DISABLED',
  'RESTRICTED_MODE',
  'PROBE_FAILED',
  'TUNNEL_FAILED',
  'NOT_PAIRED',
  'NONCE_INVALID',
  'RATE_LIMITED',
  'INTERNAL',
]
const INTENCOES: readonly IpcIntentName[] = [
  'tunnel.up',
  'tunnel.down',
  'tunnel.status',
  'session.issue',
  'secret.rotate',
  'emergency',
]

/** A URL do tunel PODE viajar: nao e segredo (`02-SEGURANCA.md` 2.2). */
const URL_DO_TUNEL = 'https://exemplo-de-tunel-publico.trycloudflare.com'

function todasHostParaWorker(): readonly IpcMessageToWorker[] {
  const todas: IpcMessageToWorker[] = []

  for (const state of ESTADOS) {
    todas.push(
      state === 'READY'
        ? { v: 1, type: 'state', state, seq: 1, url: URL_DO_TUNEL, expiresAt: 1_800_000 }
        : { v: 1, type: 'state', state, seq: 1 },
    )
    for (const result of ['accepted', 'noop'] as const) {
      todas.push({ v: 1, type: 'ack', requestId: '01J0000000000000000000000A', result, state })
    }
    for (const code of CODIGOS) {
      todas.push({ v: 1, type: 'ack', requestId: 'r', result: 'rejected', state, code })
    }
  }
  for (const code of CODIGOS) {
    todas.push({ v: 1, type: 'error', code, message: `Falhou: ${code}.` })
    todas.push({ v: 1, type: 'error', requestId: 'r', code, message: `Falhou: ${code}.` })
  }
  return todas
}

function todasWorkerParaHost(): readonly IpcIntentMessage[] {
  const todas: IpcIntentMessage[] = []
  for (const intent of INTENCOES) {
    todas.push({ v: 1, type: 'intent', intent, requestId: 'r', from: 123, chat: 456 })
    todas.push({ v: 1, type: 'intent', intent, requestId: 'r', from: 123, chat: 456, nonce: 'op4co' })
  }
  return todas
}

/* ========================================================================== */
/* Os testes                                                                  */
/* ========================================================================== */

describe('S3: o detetor tem de funcionar antes de o resto valer alguma coisa', () => {
  it('apanha um segredo plantado, em cada uma das OITO codificacoes', () => {
    for (const [forma, texto] of codificacoes(SEGREDOS['token'] ?? '')) {
      const fuga = procurarFuga(`{"v":1,"type":"error","message":"${texto}"}`)
      assert.notEqual(fuga, undefined, `o detetor esta cego para ${forma}`)
    }
  })

  it('nao acusa um payload limpo (senao mediria ruido)', () => {
    assert.equal(procurarFuga(serializeIpcMessage({ v: 1, type: 'state', state: 'STOPPED', seq: 1 }, 'to-worker')), undefined)
  })
})

describe('S3: o vocabulario FECHADO inteiro, serializado, nao leva segredo', () => {
  it(`as ${String(todasHostParaWorker().length)} mensagens host -> worker`, () => {
    const linhas = todasHostParaWorker().map((m) => serializeIpcMessage(m, 'to-worker'))
    assertSemSegredo(linhas, 'host -> worker')
  })

  it(`as ${String(todasWorkerParaHost().length)} mensagens worker -> host, pelos DOIS serializadores`, () => {
    const linhas = todasWorkerParaHost().flatMap((m) => [
      serializeIpcMessage(m, 'to-host'),
      serializeWorkerIpcMessage(m, 'to-host'),
    ])
    assertSemSegredo(linhas, 'worker -> host')
  })

  it('a URL do tunel PODE viajar -- ela nao e segredo, e o produto depende disso', () => {
    const linha = serializeIpcMessage(
      { v: 1, type: 'state', state: 'READY', seq: 1, url: URL_DO_TUNEL, expiresAt: 1 },
      'to-worker',
    )
    assert.equal(linha.includes(URL_DO_TUNEL), true, 'sem URL nao ha como o dono chegar ao painel')
    assert.equal(procurarFuga(linha), undefined)
  })
})

describe('S3: a COMPOSICAO real -- o token esta na configuracao e nao sai por lado nenhum', () => {
  /**
   * Aqui o token nao e uma constante do teste: e `config.worker.token`, o mesmo
   * campo que `buildWorkerEnv` poe no ambiente do filho. Se algum caminho do
   * canal serializasse configuracao, este teste apanhava-o.
   */
  function montarComSegredo(): ReturnType<typeof makeContextoComStdio> & {
    supervisor: ReturnType<typeof createWorkerSupervisor>
  } {
    const config = makeConfig()
    config.worker.token = SEGREDOS['token'] ?? ''
    config.encodedAuthString = Buffer.from(`admin:${SEGREDOS['senha'] ?? ''}`).toString('base64')

    const ctx = makeContextoComStdio()
    const { deps } = makeSupervisorDeps(new FakeScheduler())
    const supervisor = createWorkerSupervisor(ctx.ctx, config, deps)
    return { ...ctx, supervisor }
  }

  it('o caminho SEM controlador (resposta INTERNAL) nao vaza nada', () => {
    const h = montarComSegredo()
    h.supervisor.start()
    const child = h.subprocess.lastChild()

    for (const intent of INTENCOES) {
      child.diz(
        serializeWorkerIpcMessage(
          { v: 1, type: 'intent', intent, requestId: 'r', from: 1, chat: 1 },
          'to-host',
        ),
      )
    }

    assertSemSegredo([child.recebido()], 'resposta sem controlador')
    h.supervisor.dispose()
  })

  it('um controlador que LANCA com o segredo na mensagem tambem nao o deixa sair', () => {
    const config = makeConfig()
    config.worker.token = SEGREDOS['token'] ?? ''
    const ctx = makeContextoComStdio()
    const { deps } = makeSupervisorDeps(new FakeScheduler())
    const supervisor = createWorkerSupervisor(ctx.ctx, config, deps, {
      onIntent: (): never => {
        // O caso realista: uma excecao de biblioteca com o URL do Telegram
        // dentro, que e onde a API poe o token.
        throw new Error(`ECONNRESET em https://api.telegram.org/bot${SEGREDOS['token'] ?? ''}/getUpdates`)
      },
    })

    supervisor.start()
    const child = ctx.subprocess.lastChild()
    child.diz(
      serializeWorkerIpcMessage(
        { v: 1, type: 'intent', intent: 'tunnel.up', requestId: 'r', from: 1, chat: 1 },
        'to-host',
      ),
    )

    const resposta = child.recebido()
    assert.match(resposta, /"code":"INTERNAL"/u, 'o ack e SEMPRE emitido')
    assertSemSegredo([resposta], 'resposta a um controlador que lancou')

    /**
     * >>> A ASSERCAO QUE FALTAVA, E QUE CUSTOU UM ACHADO DE SEGURANCA. <<<
     *
     * Este cenario ja aqui estava e so verificava o PAYLOAD. O caminho irmao --
     * linha malformada, no teste a seguir -- ja verificava o LOG. A assimetria
     * dentro do proprio ficheiro escondeu que `src/ipc/channel.ts` registava
     * `error.message` CRU: um `ECONNRESET em .../bot<token>/getUpdates` entrava
     * em claro no log do plano de controlo, enquanto o MESMO token impresso pelo
     * FILHO ja saia mascarado por `attachStreamLogging`.
     *
     * O custo real: o dono cola o log num relatorio de bug e entrega o bot.
     */
    const registos = ctx.logger.entries.map((e) => e.message)
    assert.ok(registos.some((m) => m.includes('lancou')), 'o defeito TEM de ser visivel no log')
    assertSemSegredo(registos, 'log do controlador que lancou')
    assert.ok(
      registos.some((m) => m.includes('[REDACTED]')),
      'e tem de ser visivelmente cortado, nao apenas ausente',
    )

    supervisor.dispose()
  })

  it('uma linha malformada com segredo dentro nao e ecoada para o log', () => {
    const h = montarComSegredo()
    h.supervisor.start()
    const child = h.subprocess.lastChild()

    // O pior caso: o outro lado escreveu lixo com o segredo la dentro. Registar
    // a LINHA seria por o segredo no log do plano de controlo -- so a RAZAO e
    // registada.
    child.diz(`{lixo com ${SEGREDOS['mk'] ?? ''} e ${SEGREDOS['caminhoAbsoluto'] ?? ''}\n`)

    const registos = h.logger.entries.map((e) => e.message)
    assert.ok(registos.some((m) => m.includes('descartada')), 'o descarte tem de ser visivel')
    assertSemSegredo(registos, 'log do descarte')
    h.supervisor.dispose()
  })

  it('o `stderr` do filho continua a ir para o log, e passa por redact()', () => {
    const h = montarComSegredo()
    h.supervisor.start()
    const child = h.subprocess.lastChild()

    child.stderr.write(
      Buffer.from(`erro de rede em https://api.telegram.org/bot${SEGREDOS['token'] ?? ''}/getUpdates\n`),
    )

    const registos = h.logger.entries.map((e) => e.message)
    assert.ok(registos.some((m) => m.includes('erro de rede')), 'a linha humana chega ao log')
    assertSemSegredo(registos, 'stderr encaminhado')
    h.supervisor.dispose()
  })

  it('e o `stdout` NAO vai para o log: ele e protocolo, nao diagnostico (S2)', () => {
    const h = montarComSegredo()
    h.supervisor.start()
    const child = h.subprocess.lastChild()

    child.diz('{"v":1,"type":"intent","intent":"tunnel.status","requestId":"r","from":1,"chat":1}\n')

    const registos = h.logger.entries.map((e) => e.message)
    // O NOME da intencao entra no log (e diagnostico legitimo e nao e segredo);
    // o que nao pode acontecer e a LINHA do protocolo ser copiada para la pelo
    // encaminhamento de `stdout`, que era o habito ate a Onda 4.
    assert.equal(
      registos.some((m) => m.includes('[worker STDOUT]')),
      false,
      'o stdout do worker nao pode voltar ao log: ele e protocolo (S2)',
    )
    assert.equal(
      registos.some((m) => m.includes('"type":"intent"')),
      false,
      'nenhuma linha JSONL do canal aparece no log',
    )
    h.supervisor.dispose()
  })
})
