/**
 * `worker/providers/telegram/polling.ts` — as guardas anti-degradacao das
 * opcoes, a classificacao terminal de 409/401 e o prazo de arranque. Port fiel
 * de `worker/lib/polling.ts` (o loop em si e exercitado pelo teste do adapter).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { GrammyError } from 'grammy'

import {
  ALLOWED_UPDATES,
  assertPollingOptions,
  classifyPollingError,
  CONFLICT_OTHER_GET_UPDATES,
  DEFAULT_BOOT_TIMEOUT_MS,
  LONG_POLL_MAX_TIMEOUT,
  runPolling,
  UNAUTHORIZED,
} from '../../../../../worker/providers/telegram/polling.ts'
import { WORKER_EXIT } from '../../../../../worker/providers/telegram/interno.ts'
import { createTelegramBot } from '../../../../../worker/providers/telegram/cliente.ts'
import { captureLog, startFakeBotApi, TOKEN_DE_TESTE } from './apoio.ts'

function construirGrammyError(code: number, description: string): Error {
  return new GrammyError(`Call to 'x' failed!`, { ok: false, error_code: code, description }, 'x', {})
}

describe('provider/telegram/polling — constantes de teto', () => {
  it('o timeout e o tecto do servidor (50), nao opiniao nossa', () => {
    assert.equal(LONG_POLL_MAX_TIMEOUT, 50)
  })
  it('a superficie fechada e so message/callback_query', () => {
    assert.deepEqual(ALLOWED_UPDATES, ['message', 'callback_query'])
  })
  it('prazo de arranque de 45 s', () => {
    assert.equal(DEFAULT_BOOT_TIMEOUT_MS, 45_000)
  })
})

describe('provider/telegram/polling — guardas anti-degradacao', () => {
  function opcoes(override: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      timeout: 50,
      allowed_updates: ALLOWED_UPDATES,
      drop_pending_updates: true,
      limit: 100,
      ...override,
    }
  }

  it('a lista de updates NAO pode estar vazia (reset para o default do grammY)', () => {
    assert.throws(() => assertPollingOptions(opcoes({ allowed_updates: [] }) as never), /vazio/u)
  })

  it('drop_pending_updates tem de ser true (ate 24 h de comandos represados)', () => {
    assert.throws(() => assertPollingOptions(opcoes({ drop_pending_updates: false }) as never), /true/u)
  })

  it('timeout acima do tecto e recusado (o servidor clampa a 50 de qualquer forma)', () => {
    assert.throws(() => assertPollingOptions(opcoes({ timeout: 120 }) as never), /timeout/u)
  })

  it('opcoes correctas nao lancam', () => {
    assert.doesNotThrow(() => assertPollingOptions(opcoes() as never))
  })
})

describe('provider/telegram/polling — classificacao terminal', () => {
  it('409 -> POLLING_CONFLICT (ha um segundo getUpdates vivo)', () => {
    const verdict = classifyPollingError(construirGrammyError(409, 'Conflict: terminated by other getUpdates'))
    assert.equal(verdict.code, 'POLLING_CONFLICT')
  })

  it('401 -> POLLING_UNAUTHORIZED (token revogado/errado)', () => {
    const verdict = classifyPollingError(construirGrammyError(401, 'Unauthorized: invalid token specified'))
    assert.equal(verdict.code, 'POLLING_UNAUTHORIZED')
  })

  it('qualquer outro -> POLLING_FAILED', () => {
    const verdict = classifyPollingError(construirGrammyError(500, 'Internal'))
    assert.equal(verdict.code, 'POLLING_FAILED')
  })

  it('409/401 sao terminais e DISTINGUIVEIS (zero reconexoes)', () => {
    assert.notEqual(CONFLICT_OTHER_GET_UPDATES, UNAUTHORIZED)
    const a = classifyPollingError(construirGrammyError(409, 'x')).code
    const b = classifyPollingError(construirGrammyError(401, 'x')).code
    assert.notEqual(a, b)
    const c = classifyPollingError(new Error('foo')).code
    assert.notEqual(a, c)
  })
})

describe('provider/telegram/polling — prazo de arranque (boot 45 s -> exit 14)', () => {
  it('arranque ENCRAVADO: fatal BOOT_TIMEOUT com exitCode 14 e o bot e parado com cuidado', async () => {
    const log = captureLog()
    let parou = false
    // `start()` que nunca resolve: o caso medido do bug de unidades do
    // `withRetries` do getMe (100 s de sono) — o processo nao pode ficar VIVO,
    // CALADO e SEM SAIR.
    const bot = {
      start: () => new Promise<void>(() => undefined),
      stop: async (): Promise<void> => {
        parou = true
      },
    }
    const outcome = await runPolling({ bot: bot as never, log: log.logger, bootTimeoutMs: 20 })
    assert.equal(outcome.kind, 'fatal')
    if (outcome.kind === 'fatal') {
      assert.equal(outcome.code, 'BOOT_TIMEOUT')
      assert.equal(outcome.exitCode, WORKER_EXIT.BOOT_TIMEOUT, 'o code do contrato e 14')
      assert.equal(outcome.exitCode, 14)
    }
    assert.equal(parou, true, 'pararComCuidado chamou bot.stop()')
    assert.match(log.all(), /ARRANQUE ENCRAVADO/u)
  })

  it('arranque que COMECA antes do prazo nao dispara o boot-timeout', async () => {
    const log = captureLog()
    const bot = {
      start: async (options?: { onStart?: (info: { username: string | undefined }) => Promise<void> }): Promise<void> => {
        // O onStart do grammY dispara quando o polling comeca a receber.
        await options?.onStart?.({ username: 'dsh_spike_bot' })
      },
      stop: async (): Promise<void> => undefined,
    }
    const outcome = await runPolling({ bot: bot as never, log: log.logger, bootTimeoutMs: 20 })
    assert.equal(outcome.kind, 'stopped')
    if (outcome.kind === 'stopped') assert.equal(outcome.exitCode, WORKER_EXIT.OK)
  })
})

describe('provider/telegram/polling — o bot real contra o doble (smoke)', () => {
  it('getMe do grammY casa com o protocolo do boot', async () => {
    const srv = await startFakeBotApi()
    try {
      const log = captureLog()
      const bot = createTelegramBot({ token: TOKEN_DE_TESTE, apiRoot: srv.apiRoot, log: log.logger })
      await bot.api.getMe()
      assert.equal(srv.calls.length, 1)
      assert.equal(srv.calls[0]?.method, 'getme')
    } finally {
      await srv.close()
    }
  })
})