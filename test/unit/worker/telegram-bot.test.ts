/**
 * `worker/telegram-bot.ts` — o BOOT GENERICO por provedor (onda 4).
 *
 * PORQUE ESTE FICHEIRO NAO ESTA EM `test/unit/worker/providers/`: a convencao
 * de `05-QUALIDADE-CODIGO.md` 5.4 e `test/unit/<mesmo caminho da fonte>`, e a
 * fonte e `worker/telegram-bot.ts`.
 *
 * O boot monta o NUCLEO neutro sobre o ADAPTADOR telegram (o unico provedor
 * hoje) contra o duble `telegram-server.mjs` via `apiRoot`. O canal IPC e
 * INJETADO (`runtime.ipc`) para o teste nao tocar no `process`: o que se mede
 * e a ORQUESTRACAO — token->adaptador->nucleo->polling e os codigos de saida.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import { GrammyError } from 'grammy'

import type { IpcMessageFromWorker } from '../../../src/contracts/ipc.ts'
import { WORKER_EXIT } from '../../../worker/lib/errors.ts'
import type { WorkerIpc } from '../../../worker/ipc.ts'
import type { ProvedorDescrito } from '../../../worker/providers/registry.ts'
import { ProviderError } from '../../../worker/providers/telegram/interno.ts'
import { TOKEN_ENV_VAR } from '../../../worker/providers/telegram/token.ts'
import { runTelegramWorker } from '../../../worker/telegram-bot.ts'
import {
  aguardar,
  captureLog,
  chamadasDe,
  FakeTime,
  startFakeBotApi,
  TOKEN_DE_TESTE,
  type FakeBotApi,
} from './bot-apoio.ts'

const abertos: FakeBotApi[] = []
after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
})

const ARGV_LIMPO = ['/usr/bin/node', '/pacote/dist/worker/telegram-bot.js']

/** Canal IPC falso: o `send` regista, o host nunca envia mensagens. */
function ipcFalso(): { ipc: WorkerIpc; sends: IpcMessageFromWorker[] } {
  const sends: IpcMessageFromWorker[] = []
  return {
    ipc: {
      send: (message: Parameters<WorkerIpc['send']>[0]): boolean => {
        sends.push(message)
        return true
      },
      log: () => undefined,
      dispose: () => undefined,
    },
    sends,
  }
}

/** O provedor telegram completo, so para os testes que o usam por injecao. */
function provedorQueEstouraNoCreate(): ProvedorDescrito {
  return {
    id: 'telegram',
    create: () => {
      throw new Error('a montagem do adaptador falhou')
    },
    lerToken: () => TOKEN_DE_TESTE,
    assertTokenNaoEmArgv: () => undefined,
  }
}

/** Ao proveedor cujo `start()` rejeita TERMINALMENTE (409/401) na arrancada. */
function provedorComStartQueRejeita(erro: unknown): ProvedorDescrito {
  return {
    id: 'telegram',
    create: () => ({
      id: 'telegram',
      limits: { maxTextLength: 4096, maxActionRows: 1, maxActionPerRow: 1, maxActionDataBytes: 64, supportsEditing: true },
      start: async () => {
        throw erro
      },
      stop: async () => undefined,
      publishCommands: async () => undefined,
      sender: () => ({
        send: async () => '',
        edit: async () => 'unchanged',
        answer: async () => true,
      }),
      descartados: () => 0,
    }),
    lerToken: () => TOKEN_DE_TESTE,
    assertTokenNaoEmArgv: () => undefined,
  }
}

/** Um `GrammyError` 409 como o grammY o produz (o boot classifica-o -> 11). */
function erro409DeGetUpdates(): GrammyError {
  return new GrammyError(
    'Call to getUpdates failed',
    {
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    },
    'getUpdates',
    {},
  )
}

/** Um `GrammyError` 401 como o grammY o produz (o boot classifica-o -> 12). */
function erro401DeGetUpdates(): GrammyError {
  return new GrammyError(
    'Call to getUpdates failed',
    {
      ok: false,
      error_code: 401,
      description: 'Unauthorized',
    },
    'getUpdates',
    {},
  )
}

describe('worker/telegram-bot — configuracao recusada no arranque', () => {
  it('sem token: sai com o codigo de CONFIG, nao com o de instabilidade', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const code = await runTelegramWorker({ env: {}, argv: ARGV_LIMPO, log: log.logger, ipc })

    assert.equal(code, WORKER_EXIT.CONFIG)
    assert.notEqual(code, WORKER_EXIT.POLLING)
    assert.match(log.all(), /TOKEN_MISSING/u)
    assert.match(log.all(), /TELEGRAM_BOT_TOKEN/u)
  })

  it('TG-069: token em argv recusa o arranque (fail-closed), mesmo estando tambem no ambiente', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: [...ARGV_LIMPO, '--token', TOKEN_DE_TESTE],
      log: log.logger,
      ipc,
    })

    assert.equal(code, WORKER_EXIT.CONFIG)
    assert.match(log.all(), /TOKEN_IN_ARGV/u)
    assert.equal(log.all().includes(TOKEN_DE_TESTE), false, 'a recusa nao vaza o que recusa')
  })
})

describe('worker/telegram-bot — ciclo completo contra o servidor falso', () => {
  it('o provedor desconhecido do registry recusa o arranque com erro claro (fail-closed)', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const code = await runTelegramWorker({
      env: { ['DSH_GUARD_PROVIDER']: 'whatsapp' },
      argv: ARGV_LIMPO,
      log: log.logger,
      ipc,
    })

    assert.equal(code, WORKER_EXIT.CONFIG)
    assert.match(log.all(), /provedor desconhecido/u)
    assert.match(log.all(), /whatsapp/u)
  })

  it('arranca com a wiring montada antes do polling, publica a lista, e sai limpo', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    const { ipc, sends } = ipcFalso()
    let parar: (() => Promise<void>) | undefined

    const corrida = runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE, TELEGRAM_API_ROOT: srv.apiRoot },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      onBooted: (boot) => {
        parar = boot.parar
      },
    })

    // A wiring (canal IPC + nucleo) e montada ANTES de o polling arrancar: o
    // `onBooted` so dispara depois de `adapter.start`, mas o `getMe`/`getUpdates`
    // so podem existir depois do boot ter o handler do nucleo ligado.
    await aguardar(() => chamadasDe(srv, 'getUpdates').length >= 1, 'primeiro getUpdates')
    await aguardar(() => parar !== undefined, 'onBooted fornece o handle de paragem', 2000)
    await parar?.()
    const code = await corrida

    assert.equal(code, WORKER_EXIT.OK)
    // A ordem do boot real, tal como o e2e assere.
    const ordem = srv.calls.map((c) => c.method)
    const idxMe = ordem.indexOf('getme')
    const idxGu = ordem.indexOf('getupdates')
    assert.ok(idxMe !== -1 && idxGu !== -1)
    assert.ok(idxMe < idxGu, 'getMe antes do primeiro getUpdates')
    // A publicacao da lista canonica (TG-080) correu — o adaptador tinha o bot.
    assert.ok(ordem.includes('setmycommands'), 'a lista canonica foi publicada')
    // O token viaja na URL... e NAO aparece no log.
    assert.equal(srv.calls[0]?.token, TOKEN_DE_TESTE)
    assert.equal(log.all().includes(TOKEN_DE_TESTE), false)
    // Nenhum intent foi enviado por este caminho (sem host).
    assert.equal(sends.length, 0)
  })

  it('TG-044: 409 na arrancada -> o boot termina com CONFLITO (11), distinto de tudo o resto', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()

    // O regex da classificacao do boot vai para cima do `start()` rejeitado.
    // Um adaptador cujo arranque rejeita com o 409 do grammY (o mesmo erro que
    // o `bot.start()` real produz num getUpdates conflituoso).
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro409DeGetUpdates()),
    })

    assert.equal(code, WORKER_EXIT.CONFLICT)
    assert.notEqual(code, WORKER_EXIT.OK)
    assert.match(log.all(), /409/u)
  })

  it('TG-044: 401 na arrancada -> o boot termina com NAO AUTORIZADO (12)', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()

    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro401DeGetUpdates()),
    })

    assert.equal(code, WORKER_EXIT.UNAUTHORIZED)
    assert.notEqual(code, WORKER_EXIT.OK)
    assert.match(log.all(), /401/u)
  })

  it('BOOT_TIMEOUT no start -> o boot preserva o codigo e sai com 14 (NAO 13)', async () => {
    // O `adapter.start` rejeita com o ProviderError BOOT_TIMEOUT (o mesmo que o
    // `runPolling` produz ao estourar o prazo de 45 s). O boot tem de preservar
    // `exitCodeFor(BOOT_TIMEOUT)` = 14 ANTES do `classifyPollingError`, que o
    // reduziria a POLLING_FAILED (13).
    const log = captureLog()
    const { ipc } = ipcFalso()
    const erro = new ProviderError(
      'BOOT_TIMEOUT',
      'o arranque nao chegou a receber updates em 45000 ms',
    )

    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro),
    })

    assert.equal(code, WORKER_EXIT.BOOT_TIMEOUT)
    assert.equal(code, 14)
    assert.notEqual(code, WORKER_EXIT.POLLING, 'o BOOT_TIMEOUT NAO pode cair em 13')
    assert.match(log.all(), /BOOT_TIMEOUT/u)
  })

  it('o proveedor que rebenta ao montar o adaptador nao pendura: sai com codigo', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    const { ipc } = ipcFalso()

    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE, TELEGRAM_API_ROOT: srv.apiRoot },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorQueEstouraNoCreate(),
    })

    assert.equal(code, WORKER_EXIT.POLLING)
    assert.match(log.all(), /a montagem do adaptador falhou/u)
    assert.equal(chamadasDe(srv, 'getUpdates').length, 0, 'nem chegou a fazer polling')
  })
})