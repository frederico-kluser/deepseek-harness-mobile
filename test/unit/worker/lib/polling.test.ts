/**
 * `worker/lib/polling.ts` — TG-044, TG-045, TG-046, TG-047.
 *
 * Contra o duble CONGELADO `test/support/telegram-server.mjs`, apontado pelo
 * `apiRoot`. NENHUM destes testes fala com `api.telegram.org`: nao ha token, nao
 * ha rede externa, e a porta e efemera.
 *
 * O caso mais importante e TG-045, e a razao e que o facto medido CONTRARIA o
 * que circulava: `drop_pending_updates` **nao e parametro de `getUpdates`**. O
 * teste assere a chamada onde ela EXISTE (`deleteWebhook`) e FALHA se alguem a
 * puser no `getUpdates`.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import type { PollingOptions } from 'grammy'

import { createBot } from '../../../../worker/lib/client.ts'
import { WORKER_EXIT } from '../../../../worker/lib/errors.ts'
import {
  ALLOWED_UPDATES,
  assertPollingOptions,
  buildPollingOptions,
  classifyPollingError,
  DEFAULT_BOOT_TIMEOUT_MS,
  LONG_POLL_MAX_TIMEOUT,
  runPolling,
} from '../../../../worker/lib/polling.ts'
import {
  aguardar,
  canonicalErrors,
  captureLog,
  chamadasDe,
  startFakeBotApi,
  TOKEN_DE_TESTE,
  type FakeBotApi,
} from './apoio.ts'

/** Servidores abertos por este ficheiro, fechados no fim, aconteca o que acontecer. */
const abertos: FakeBotApi[] = []

after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
})

async function bancada(): Promise<{
  srv: FakeBotApi
  log: ReturnType<typeof captureLog>
  bot: ReturnType<typeof createBot>
}> {
  const srv = await startFakeBotApi()
  abertos.push(srv)
  const log = captureLog()
  const bot = createBot({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })
  return { srv, log, bot }
}

describe('worker/lib/polling — opcoes', () => {
  it('TG-047: o timeout e 50, que e o tecto do servidor (LONG_POLL_MAX_TIMEOUT)', () => {
    const options: PollingOptions = buildPollingOptions()
    const timeout: number = options.timeout ?? Number.POSITIVE_INFINITY
    assert.equal(timeout, 50)
    assert.equal(LONG_POLL_MAX_TIMEOUT, 50)
    // `Math.min` e nao `<=`: com literais, o comparador e verdade em tempo de
    // compilacao e o lint diz — com razao — que a condicao e desnecessaria. O
    // que se quer afirmar e o INVARIANTE, e este escreve-o sem o tautologizar.
    assert.equal(Math.min(timeout, LONG_POLL_MAX_TIMEOUT), timeout, 'timeout <= 50')
  })

  it('TG-046: allowed_updates e explicito e fechado nos dois tipos que o bot trata', () => {
    const options = buildPollingOptions()
    assert.deepEqual([...(options.allowed_updates ?? [])], ['message', 'callback_query'])
    assert.deepEqual([...ALLOWED_UPDATES], ['message', 'callback_query'])
  })

  it('TG-045: drop_pending_updates vem ligado no boot', () => {
    assert.equal(buildPollingOptions().drop_pending_updates, true)
  })

  it('a guarda recusa cada uma das tres degradacoes, em vez de as corrigir em silencio', () => {
    assert.doesNotThrow(() => {
      assertPollingOptions(buildPollingOptions())
    })
    // Sem a chave, e nao com a chave a `undefined`: `exactOptionalPropertyTypes`
    // trata os dois casos como coisas diferentes, e o que se quer medir e a
    // OMISSAO — que e a forma como o defeito aparece na vida real.
    const semAllowed: PollingOptions = { timeout: 50, drop_pending_updates: true, limit: 100 }
    assert.throws(
      () => {
        assertPollingOptions(semAllowed)
      },
      /allowed_updates omitido/u,
      'omitir allowed_updates MANTEM a configuracao anterior no servidor: estado invisivel',
    )
    assert.throws(() => {
      assertPollingOptions({ ...buildPollingOptions(), timeout: 120 })
    }, /timeout/u)
    assert.throws(() => {
      assertPollingOptions({ ...buildPollingOptions(), drop_pending_updates: false })
    }, /drop_pending_updates/u)
    // A LISTA VAZIA e um caso PROPRIO, e nao um sinonimo da omissao: na Bot API
    // ela e o reset para o conjunto por omissao. Ver `assertPollingOptions`.
    assert.throws(
      () => {
        assertPollingOptions({ ...buildPollingOptions(), allowed_updates: [] })
      },
      /allowed_updates vazio/u,
      'lista vazia ABRE a superficie; nao pode ser confundida com "nenhum"',
    )
  })
})

describe('worker/lib/polling — contra o servidor Bot API falso', () => {
  it('TG-045/046/047: a sequencia de boot e getMe -> deleteWebhook{drop_pending_updates} -> getUpdates', async () => {
    const { srv, log, bot } = await bancada()

    const corrida = runPolling({ bot, log: log.logger })
    await aguardar(() => chamadasDe(srv, 'getUpdates').length >= 1, 'primeiro getUpdates')
    await bot.stop()
    const outcome = await corrida

    assert.equal(outcome.kind, 'stopped')
    assert.equal(outcome.exitCode, WORKER_EXIT.OK)

    const ordem = srv.calls.map((c) => c.method)
    assert.deepEqual(ordem.slice(0, 3), ['getme', 'deletewebhook', 'getupdates'], 'a ordem do boot')

    // ---- TG-045: A ASSERCAO NO SITIO CERTO -------------------------------
    const deleteWebhook = chamadasDe(srv, 'deleteWebhook')
    assert.equal(deleteWebhook.length, 1, 'exatamente um deleteWebhook, no boot')
    assert.equal(
      deleteWebhook[0]?.payload['drop_pending_updates'],
      true,
      'drop_pending_updates viaja em deleteWebhook — e o UNICO sitio onde a Bot API o aceita',
    )

    // ---- TG-045: E A ASSERCAO QUE FALHA SE ALGUEM O PUSER NO SITIO ERRADO -
    for (const call of chamadasDe(srv, 'getUpdates')) {
      assert.equal(
        Object.hasOwn(call.payload, 'drop_pending_updates'),
        false,
        'drop_pending_updates NAO e parametro de getUpdates; se aparecer aqui, alguem copiou a doc errada',
      )
    }

    // ---- TG-046 ----------------------------------------------------------
    const primeiro = chamadasDe(srv, 'getUpdates')[0]
    assert.ok(primeiro !== undefined)
    assert.deepEqual(
      primeiro.payload['allowed_updates'],
      ['message', 'callback_query'],
      'allowed_updates ENVIADO. Omitido, o servidor manteria a configuracao anterior.',
    )

    // ---- TG-047 ----------------------------------------------------------
    const timeout = primeiro.payload['timeout']
    assert.equal(typeof timeout, 'number')
    assert.ok((timeout as number) <= LONG_POLL_MAX_TIMEOUT, 'timeout <= 50')
    assert.equal(timeout, 50)

    // O token viaja no CAMINHO da URL, e o duble regista-o. E o que torna a
    // regra "mascarar em log" concreta em vez de teorica.
    assert.equal(srv.calls[0]?.token, TOKEN_DE_TESTE)
    assert.equal(log.all().includes(TOKEN_DE_TESTE), false, 'e mesmo assim nao aparece no log')
  })

  it('ACHADO 2: a guarda corre EM PRODUCAO — opcoes degradadas nao chegam ao fio', async () => {
    const { srv, log, bot } = await bancada()

    // Exatamente as degradacoes que a revisao mediu a passar: `timeout: 120`,
    // `allowed_updates: []` (o "reset to default" do grammY, que ABRE a
    // superficie fechada em silencio) e `drop_pending_updates: false`.
    const degradadas: PollingOptions = {
      timeout: 120,
      allowed_updates: [],
      drop_pending_updates: false,
      limit: 100,
    }

    await assert.rejects(
      () => runPolling({ bot, log: log.logger, options: degradadas }),
      /allowed_updates vazio/u,
      'recusa, e nomeia primeiro a degradacao que ABRE a superficie',
    )

    assert.deepEqual(srv.calls, [], 'lanca ANTES de qualquer I/O: nem getMe chegou a sair')
  })

  it('ACHADO 2: cada degradacao sozinha e recusada em producao, uma a uma', async () => {
    const { srv, log, bot } = await bancada()
    const base = buildPollingOptions()

    const casos: ReadonlyArray<readonly [string, PollingOptions]> = [
      ['allowed_updates vazio', { ...base, allowed_updates: [] }],
      ['timeout acima do tecto', { ...base, timeout: 120 }],
      ['sem descarte da fila', { ...base, drop_pending_updates: false }],
    ]
    for (const [nome, options] of casos) {
      await assert.rejects(() => runPolling({ bot, log: log.logger, options }), `recusa: ${nome}`)
    }
    assert.deepEqual(srv.calls, [], 'nenhuma delas tocou na rede')
  })

  it('TG-044: 409 de polling duplicado -> erro claro, veredito terminal, ZERO reconexoes', async () => {
    const { srv, log, bot } = await bancada()
    const errors = await canonicalErrors()
    const conflito = errors['conflictOtherGetUpdates']
    assert.ok(conflito !== undefined)
    srv.queueError('getUpdates', conflito)

    const outcome = await runPolling({ bot, log: log.logger })

    assert.ok(outcome.kind === 'fatal')
    assert.equal(outcome.code, 'POLLING_CONFLICT')
    assert.equal(outcome.exitCode, WORKER_EXIT.CONFLICT)

    // O NUCLEO DE TG-044: uma tentativa e mais nenhuma. Um ciclo de reconexao
    // agressiva aqui seria flapping infinito — medido: o 409 mata a instancia
    // que JA estava pendurada, nunca a que chega, portanto quem reinicia
    // continua a matar-se a si proprio.
    assert.equal(chamadasDe(srv, 'getUpdates').length, 1, 'nao ha segunda tentativa')

    const texto = log.all()
    assert.match(texto, /409/u)
    assert.match(texto, /outro getUpdates/u)
    assert.match(texto, /flapping/u, 'a mensagem explica PORQUE o processo sai em vez de reiniciar')
    assert.equal(texto.includes(TOKEN_DE_TESTE), false, 'nem no caminho de erro o token sai')
  })

  it('TG-044 (irmao): 401 e igualmente terminal, e distinguivel do 409', async () => {
    const { srv, log, bot } = await bancada()
    const errors = await canonicalErrors()
    const naoAutorizado = errors['unauthorized']
    assert.ok(naoAutorizado !== undefined)
    srv.queueError('getUpdates', naoAutorizado)

    const outcome = await runPolling({ bot, log: log.logger })

    assert.ok(outcome.kind === 'fatal')
    assert.equal(outcome.code, 'POLLING_UNAUTHORIZED')
    assert.equal(outcome.exitCode, WORKER_EXIT.UNAUTHORIZED)
    assert.notEqual(outcome.exitCode, WORKER_EXIT.CONFLICT, 'codigos distintos: causas distintas')
    assert.equal(chamadasDe(srv, 'getUpdates').length, 1)
    assert.equal(log.all().includes(TOKEN_DE_TESTE), false)
  })

  it('runPolling nunca engole o erro: ele volta dentro do veredito', async () => {
    const { srv, log, bot } = await bancada()
    const errors = await canonicalErrors()
    const conflito = errors['conflictOtherGetUpdates']
    assert.ok(conflito !== undefined)
    srv.queueError('getUpdates', conflito)

    const outcome = await runPolling({ bot, log: log.logger })
    assert.ok(outcome.kind === 'fatal')
    assert.ok(outcome.error instanceof Error, 'o erro original volta intacto no veredito')
  })
})

describe('worker/lib/polling — classificacao', () => {
  it('um erro desconhecido nao vira 409 nem 401: cai em POLLING_FAILED', () => {
    const verdict = classifyPollingError(new Error('socket hang up'))
    assert.equal(verdict.code, 'POLLING_FAILED')
    assert.equal(verdict.exitCode, WORKER_EXIT.POLLING)
  })
})

describe('worker/lib/polling — o arranque tem prazo', () => {
  it('arranque que nunca termina: relata e SAI, em vez de ficar vivo e calado', async () => {
    /* BOT FALSO, e a razao esta no cabecalho de `DEFAULT_BOOT_TIMEOUT_MS`: o
       sono de 100 s do `getMe` do grammY nao tem sinal de aborto no primeiro
       arranque, portanto um teste in-process contra rede a serio herdava um
       `setTimeout` orfao e pendurava o processo do `node --test` — medido.
       O `start()` que nunca resolve reproduz esse estado exatamente, sem o
       temporizador. O comportamento REAL, com rede em baixo, esta medido contra
       o artefacto compilado (prazo aos 45 s, saida com codigo 14 aos 47 s). */
    const log = captureLog()
    let paragens = 0
    const botFalso = {
      start: (): Promise<void> => new Promise<void>(() => undefined),
      stop: async (): Promise<void> => {
        paragens += 1
        return Promise.resolve()
      },
    }

    const outcome = await runPolling({ bot: botFalso, log: log.logger, bootTimeoutMs: 20 })

    assert.ok(outcome.kind === 'fatal')
    assert.equal(outcome.code, 'BOOT_TIMEOUT')
    assert.equal(outcome.exitCode, WORKER_EXIT.BOOT_TIMEOUT)
    assert.equal(paragens, 1, 'tenta desmontar antes de desistir')
    assert.match(log.all(), /ARRANQUE ENCRAVADO/u)
    assert.match(log.all(), /supervisor/u, 'a linha diz PORQUE sair e nao reiniciar aqui dentro')
  })

  it('um `stop()` que rebenta no fim do prazo nao troca a causa do veredito', async () => {
    const log = captureLog()
    const botFalso = {
      start: (): Promise<void> => new Promise<void>(() => undefined),
      stop: (): Promise<void> => Promise.reject(new Error('stop tambem falhou')),
    }

    const outcome = await runPolling({ bot: botFalso, log: log.logger, bootTimeoutMs: 20 })

    assert.ok(outcome.kind === 'fatal')
    assert.equal(outcome.code, 'BOOT_TIMEOUT', 'a causa que interessa e o arranque, nao a paragem')
    assert.match(log.all(), /stop tambem falhou/u, 'e a falha da paragem tambem nao e engolida')
  })

  it('o prazo NAO dispara quando o arranque corre bem', async () => {
    const { srv, log, bot } = await bancada()

    // Prazo curto de proposito: se ele contasse a partir do arranque e nao fosse
    // cancelado pelo `onStart`, este teste apanhava-o.
    const corrida = runPolling({ bot, log: log.logger, bootTimeoutMs: 1000 })
    await aguardar(() => chamadasDe(srv, 'getUpdates').length >= 1, 'primeiro getUpdates')
    // Passa do prazo DE PROPOSITO: se o `onStart` nao o cancelasse, disparava.
    await new Promise((resolve) => setTimeout(resolve, 1200))
    await bot.stop()
    const outcome = await corrida

    assert.equal(outcome.kind, 'stopped', 'o polling ja arrancou; o prazo nao se aplica')
    assert.match(log.all(), /arranque concluido/u)
  })

  it('o prazo por omissao e generoso face ao sono de 100 s do grammY', () => {
    assert.equal(DEFAULT_BOOT_TIMEOUT_MS, 45_000)
    assert.ok(DEFAULT_BOOT_TIMEOUT_MS < 100_000, 'tem de disparar ANTES do primeiro sono longo')
  })
})
