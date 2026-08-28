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
import { TOKEN_ENV_VAR as TOKEN_ENV_VAR_DISCORD } from '../../../worker/providers/discord/token.ts'
import { runTelegramWorker } from '../../../worker/telegram-bot.ts'
import {
  aguardar as aguardarDiscord,
  startFakeDiscord as startFakeDiscordApoio,
  TOKEN_DE_TESTE as TOKEN_DE_TESTE_DISCORD,
  type FakeDiscord,
} from './providers/discord/apoio.ts'
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
const abertosDiscord: FakeDiscord[] = []
after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
  await Promise.all(abertosDiscord.map((srv) => srv.close()))
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

/**
 * Provedor cujo `create` CAPTURA as deps que o boot passa — para provar que a
 * raiz da API e a do PROVEDOR (`apiRootVar`), nunca a de outro canal.
 */
function provedorQueCapturaDeps(): {
  readonly provider: ProvedorDescrito
  readonly depsRecebidas: Array<{ readonly apiRoot?: string }>
} {
  const depsRecebidas: Array<{ readonly apiRoot?: string }> = []
  const provider: ProvedorDescrito = {
    id: 'discord',
    apiRootVar: 'DISCORD_API_ROOT',
    create: (deps) => {
      depsRecebidas.push(deps.apiRoot === undefined ? {} : { apiRoot: deps.apiRoot })
      return {
        id: 'discord',
        limits: { maxTextLength: 2000, maxActionRows: 5, maxActionPerRow: 5, maxActionDataBytes: 100, supportsEditing: true },
        start: async () => undefined,
        stop: async () => undefined,
        publishCommands: async () => undefined,
        sender: () => ({
          send: async () => '',
          edit: async () => 'unchanged',
          answer: async () => true,
        }),
        descartados: () => 0,
      }
    },
    lerToken: () => TOKEN_DE_TESTE,
    assertTokenNaoEmArgv: () => undefined,
  }
  return { provider, depsRecebidas }
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

    // O adaptador REAL ja classificou o 409 do grammY e rejeita o `start()`
    // com o erro do CONTRATO COMUM (`ProviderError` code 11) — o mesmo erro
    // que o `runPolling` do telegram produz num getUpdates conflituoso.
    const erro = new ProviderError(
      WORKER_EXIT.CONFLICT,
      'POLLING_CONFLICT',
      'CONFLITO 409: outro getUpdates esta a correr com este mesmo token.',
    )
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro),
    })

    assert.equal(code, WORKER_EXIT.CONFLICT)
    assert.notEqual(code, WORKER_EXIT.OK)
    assert.match(log.all(), /409/u)
  })

  it('TG-044: 401 na arrancada -> o boot termina com NAO AUTORIZADO (12)', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()

    const erro = new ProviderError(
      WORKER_EXIT.UNAUTHORIZED,
      'POLLING_UNAUTHORIZED',
      'NAO AUTORIZADO 401: o token do bot foi recusado.',
    )
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro),
    })

    assert.equal(code, WORKER_EXIT.UNAUTHORIZED)
    assert.notEqual(code, WORKER_EXIT.OK)
    assert.match(log.all(), /401/u)
  })

  it('contrato comum: erro com code 12 sai 12 INDEPENDENTE do provedor (fake discord, nao telegram)', async () => {
    // O debito da Onda 3: o boot classificava por `instanceof` da classe do
    // telegram e um fatal do discord caia em 13. Com o contrato comum, o boot
    // le o `code` numerico de QUALQUER erro — o provedor nem importa.
    const log = captureLog()
    const { ipc } = ipcFalso()
    const erro = new ProviderError(
      WORKER_EXIT.UNAUTHORIZED,
      'GATEWAY_UNAUTHORIZED',
      'o token foi recusado pelo GET /gateway/bot (HTTP 401).',
    )

    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR_DISCORD]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro),
    })

    assert.equal(code, WORKER_EXIT.UNAUTHORIZED)
    assert.equal(code, 12)
    assert.notEqual(code, WORKER_EXIT.POLLING, 'o fatal do discord NAO pode cair em 13')
    assert.match(log.all(), /GATEWAY_UNAUTHORIZED/u)
  })

  it('erro SEM code do contrato (ex.: GrammyError cru) -> POLLING (13), o default', async () => {
    // O boot generico NAO conhece o grammY: um GrammyError cru rejeitado pelo
    // `start()` cai no default 13. (O adaptador telegram REAL nunca deixa um
    // GrammyError escapar — o `runPolling` classifica e embrulha em
    // ProviderError com o code 11/12/13 antes de rejeitar.)
    const log = captureLog()
    const { ipc } = ipcFalso()

    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro409DeGetUpdates()),
    })

    assert.equal(code, WORKER_EXIT.POLLING)
    assert.match(log.all(), /polling falhou/u)
  })

  it('BOOT_TIMEOUT no start -> o boot preserva o codigo e sai com 14 (NAO 13)', async () => {
    // O `adapter.start` rejeita com o ProviderError BOOT_TIMEOUT (o mesmo que o
    // `runPolling` produz ao estourar o prazo de 45 s). O boot tem de preservar
    // `exitCodeFor(BOOT_TIMEOUT)` = 14 ANTES do `classifyPollingError`, que o
    // reduziria a POLLING_FAILED (13).
    const log = captureLog()
    const { ipc } = ipcFalso()
    const erro = new ProviderError(
      WORKER_EXIT.BOOT_TIMEOUT,
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

  it('apiRootVar: o boot passa a raiz da env DO PROVEDOR, nunca a do telegram', async () => {
    // O vazamento da Onda 3: com TELEGRAM_API_ROOT setado, o adaptador discord
    // recebia a raiz do telegram. O boot le `env[prov.apiRootVar]` — o discord
    // tem a SUA env e so ela entra.
    const log = captureLog()
    const { ipc } = ipcFalso()
    const { provider, depsRecebidas } = provedorQueCapturaDeps()

    const code = await runTelegramWorker({
      env: {
        [TOKEN_ENV_VAR_DISCORD]: TOKEN_DE_TESTE,
        TELEGRAM_API_ROOT: 'https://api.telegram.org',
        DISCORD_API_ROOT: 'https://discord.example.test/api/v10',
      },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider,
    })

    assert.equal(code, WORKER_EXIT.OK)
    assert.equal(depsRecebidas.length, 1, 'o create correu uma vez')
    assert.equal(depsRecebidas[0]?.apiRoot, 'https://discord.example.test/api/v10')
    assert.notEqual(depsRecebidas[0]?.apiRoot, 'https://api.telegram.org', 'a raiz do telegram NAO vaza')
  })

  it('apiRootVar: env ausente ou vazia do provedor -> o boot NAO passa apiRoot', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const { provider, depsRecebidas } = provedorQueCapturaDeps()

    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR_DISCORD]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider,
    })

    assert.equal(code, WORKER_EXIT.OK)
    assert.equal(depsRecebidas.length, 1)
    assert.equal(depsRecebidas[0]?.apiRoot, undefined, 'sem env da raiz, o create nao recebe apiRoot')
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
describe('worker/telegram-bot — o boot classifica pelo CODE do contrato (bordas)', () => {
  it('start rejeita com code 10 (CONFIG) -> o processo sai 10, distinto de instabilidade', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const erro = new ProviderError(WORKER_EXIT.CONFIG, 'TOKEN_MISSING', 'configuracao recusada.')
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro),
    })
    assert.equal(code, WORKER_EXIT.CONFIG)
    assert.equal(code, 10)
    assert.notEqual(code, WORKER_EXIT.POLLING)
    assert.match(log.all(), /TOKEN_MISSING/u)
  })

  it('start rejeita com code 13 (POLLING) -> sai 13 (o default so se usa SEM code)', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const erro = new ProviderError(WORKER_EXIT.POLLING, 'GATEWAY_FAILED', 'o loop do gateway morreu.')
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider: provedorComStartQueRejeita(erro),
    })
    assert.equal(code, WORKER_EXIT.POLLING)
    assert.match(log.all(), /GATEWAY_FAILED/u)
  })

  it('create rebenta com ProviderError 11 -> sai 11 (o catch do arranque le o code)', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const provider: ProvedorDescrito = {
      id: 'telegram',
      create: () => {
        throw new ProviderError(WORKER_EXIT.CONFLICT, 'POLLING_CONFLICT', '409: outro getUpdates vivo.')
      },
      lerToken: () => TOKEN_DE_TESTE,
      assertTokenNaoEmArgv: () => undefined,
    }
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider,
    })
    assert.equal(code, WORKER_EXIT.CONFLICT)
    assert.match(log.all(), /POLLING_CONFLICT/u)
  })

  it('erro com code FORA do union (9, 15, string, decimal) -> POLLING 13 (nao e do contrato)', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    for (const code of [9, 15, '12', 12.5]) {
      const erro = Object.assign(new Error('code estranho'), { code })
      const saida = await runTelegramWorker({
        env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE },
        argv: ARGV_LIMPO,
        log: log.logger,
        time: new FakeTime(),
        ipc,
        provider: provedorComStartQueRejeita(erro),
      })
      assert.equal(saida, WORKER_EXIT.POLLING, `code ${String(code)} nao e do contrato: cai no default 13`)
    }
  })

  it('o boot chama a assertTokenNaoEmArgv DO PROVEDOR (com o argv e o token)', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const recebidos: Array<{ argv: readonly string[]; token: string | undefined }> = []
    const provider: ProvedorDescrito = {
      id: 'discord',
      create: () => {
        throw new Error('nao chega aqui')
      },
      lerToken: () => TOKEN_DE_TESTE,
      assertTokenNaoEmArgv: (argv, token) => {
        recebidos.push({ argv, token })
        throw new ProviderError(WORKER_EXIT.CONFIG, 'TOKEN_IN_ARGV', 'token na linha de comando.')
      },
    }
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR_DISCORD]: TOKEN_DE_TESTE },
      argv: [...ARGV_LIMPO, '--token', TOKEN_DE_TESTE],
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider,
    })
    assert.equal(code, WORKER_EXIT.CONFIG)
    assert.equal(recebidos.length, 1, 'a assert do provedor correu uma vez')
    assert.equal(recebidos[0]?.token, TOKEN_DE_TESTE, 'recebe o token lido do ambiente')
    assert.deepEqual(recebidos[0]?.argv, [...ARGV_LIMPO, '--token', TOKEN_DE_TESTE])
    assert.match(log.all(), /TOKEN_IN_ARGV/u)
  })
})

describe('worker/telegram-bot — apiRootVar (bordas)', () => {
  it('provedor SEM apiRootVar: o env da raiz do telegram NAO entra no create', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const depsRecebidas: Array<{ readonly apiRoot?: string }> = []
    const provider: ProvedorDescrito = {
      id: 'telegram',
      // Sem apiRootVar: este provedor nao tem raiz via env.
      create: (deps) => {
        depsRecebidas.push(deps.apiRoot === undefined ? {} : { apiRoot: deps.apiRoot })
        return {
          id: 'telegram',
          limits: { maxTextLength: 4096, maxActionRows: 1, maxActionPerRow: 1, maxActionDataBytes: 64, supportsEditing: true },
          start: async () => undefined,
          stop: async () => undefined,
          publishCommands: async () => undefined,
          sender: () => ({
            send: async () => '',
            edit: async () => 'unchanged',
            answer: async () => true,
          }),
          descartados: () => 0,
        }
      },
      lerToken: () => TOKEN_DE_TESTE,
      assertTokenNaoEmArgv: () => undefined,
    }
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR]: TOKEN_DE_TESTE, TELEGRAM_API_ROOT: 'https://api.telegram.org' },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider,
    })
    assert.equal(code, WORKER_EXIT.OK)
    assert.equal(depsRecebidas[0]?.apiRoot, undefined, 'sem apiRootVar o boot NAO le env nenhuma')
  })

  it('apiRootVar com env vazia: o boot NAO passa apiRoot (vazio = sem raiz)', async () => {
    const log = captureLog()
    const { ipc } = ipcFalso()
    const { provider, depsRecebidas } = provedorQueCapturaDeps()
    const code = await runTelegramWorker({
      env: { [TOKEN_ENV_VAR_DISCORD]: TOKEN_DE_TESTE, DISCORD_API_ROOT: '' },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      provider,
    })
    assert.equal(code, WORKER_EXIT.OK)
    assert.equal(depsRecebidas[0]?.apiRoot, undefined)
  })
})

describe('worker/telegram-bot — o boot generico com o provedor discord REAL (registry)', () => {
  it('DSH_GUARD_PROVIDER=discord: identifica, READY, para limpo (OK); o token nunca vai ao log', async () => {
    const srv = await startFakeDiscordApoio()
    abertosDiscord.push(srv)
    const log = captureLog()
    const { ipc } = ipcFalso()
    let parar: (() => Promise<void>) | undefined

    const corrida = runTelegramWorker({
      env: {
        DSH_GUARD_PROVIDER: 'discord',
        [TOKEN_ENV_VAR_DISCORD]: TOKEN_DE_TESTE_DISCORD,
        DISCORD_API_ROOT: srv.apiRoot,
      },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
      onBooted: (boot) => {
        parar = boot.parar
      },
    })

    await aguardarDiscord(() => srv.gatewayState.sessions >= 1, 'READY do discord no boot')
    assert.ok(parar !== undefined, 'o handle de paragem existe')
    await parar?.()
    const code = await corrida

    assert.equal(code, WORKER_EXIT.OK)
    assert.equal(log.all().includes(TOKEN_DE_TESTE_DISCORD), false, 'o token do discord nao sai no log')
    assert.equal(srv.gatewayState.identify[0]?.['token'], TOKEN_DE_TESTE_DISCORD, 'o identify levou o token')
  })

  it('DSH_GUARD_PROVIDER=discord: close 4004 no gateway -> o PROCESSO sai 12 (por codigo, nao por classe)', async () => {
    const srv = await startFakeDiscordApoio()
    abertosDiscord.push(srv)
    const log = captureLog()
    const { ipc } = ipcFalso()

    const corrida = runTelegramWorker({
      env: {
        DSH_GUARD_PROVIDER: 'discord',
        [TOKEN_ENV_VAR_DISCORD]: TOKEN_DE_TESTE_DISCORD,
        DISCORD_API_ROOT: srv.apiRoot,
      },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      ipc,
    })

    await aguardarDiscord(() => srv.gatewayState.sessions >= 1, 'READY antes do 4004')
    srv.fecharGateway(4004, 'token recusado')
    const code = await Promise.race([
      corrida,
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 5000)),
    ])
    assert.equal(code, WORKER_EXIT.UNAUTHORIZED, 'o fatal do discord sai com o codigo CERTO (12)')
    assert.equal(code, 12)
    assert.notEqual(code, WORKER_EXIT.POLLING, 'NAO pode cair em 13 (o debito da Onda 3)')
    assert.match(log.all(), /GATEWAY_UNAUTHORIZED/u)
    assert.equal(log.all().includes(TOKEN_DE_TESTE_DISCORD), false)
  })
})
