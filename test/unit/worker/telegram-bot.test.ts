/**
 * `worker/telegram-bot.ts` — o entrypoint, do arranque ao codigo de saida.
 *
 * PORQUE ESTE FICHEIRO NAO ESTA EM `test/unit/worker/lib/`: a convencao de
 * `05-QUALIDADE-CODIGO.md` 5.4 e `test/unit/<mesmo caminho da fonte>`, e a
 * fonte e `worker/telegram-bot.ts`. O dono do teste e o dono da fonte, e esta
 * fonte e exclusiva de T4.2.
 *
 * `runTelegramWorker` DEVOLVE o codigo de saida em vez de chamar `process.exit`:
 * e essa separacao que torna todos estes caminhos — incluindo o do 409 — mediveis
 * sem subprocesso nenhum.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'

import { WORKER_EXIT } from '../../../worker/lib/errors.ts'
import { createWorkerLogger } from '../../../worker/lib/log.ts'
import { runTelegramWorker, WORKER_LOG_LEVEL } from '../../../worker/telegram-bot.ts'
import {
  aguardar,
  canonicalErrors,
  captureLog,
  chamadasDe,
  FakeTime,
  startFakeBotApi,
  TOKEN_DE_TESTE,
  type FakeBotApi,
} from './lib/apoio.ts'

const abertos: FakeBotApi[] = []
after(async () => {
  await Promise.all(abertos.map((srv) => srv.close()))
})

const ARGV_LIMPO = ['/usr/bin/node', '/pacote/dist/worker/telegram-bot.js']

describe('worker/telegram-bot — configuracao recusada no arranque', () => {
  it('sem TELEGRAM_BOT_TOKEN: sai com o codigo de CONFIG, nao com o de instabilidade', async () => {
    const log = captureLog()
    const code = await runTelegramWorker({ env: {}, argv: ARGV_LIMPO, log: log.logger })

    assert.equal(code, WORKER_EXIT.CONFIG)
    assert.notEqual(code, WORKER_EXIT.POLLING, 'config nao e o mesmo que polling instavel')
    assert.match(log.all(), /TOKEN_MISSING/u)
    assert.match(log.all(), /TELEGRAM_BOT_TOKEN/u)
  })

  it('TG-069: token em argv recusa o arranque (fail-closed), mesmo estando tambem no ambiente', async () => {
    const log = captureLog()
    const code = await runTelegramWorker({
      env: { TELEGRAM_BOT_TOKEN: TOKEN_DE_TESTE },
      argv: [...ARGV_LIMPO, '--token', TOKEN_DE_TESTE],
      log: log.logger,
    })

    assert.equal(code, WORKER_EXIT.CONFIG)
    assert.match(log.all(), /TOKEN_IN_ARGV/u)
    assert.equal(log.all().includes(TOKEN_DE_TESTE), false, 'a recusa nao vaza o que recusa')
  })
})

describe('worker/telegram-bot — ciclo completo contra o servidor falso', () => {
  it('arranca, deixa a costura registar-se ANTES do polling, e sai limpo', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()
    const marcos: string[] = []
    let bot: { stop(): Promise<void> } | undefined

    const corrida = runTelegramWorker({
      env: { TELEGRAM_BOT_TOKEN: TOKEN_DE_TESTE, TELEGRAM_API_ROOT: srv.apiRoot },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      configure: (b) => {
        // A costura de T4.3 (IPC), T4.4 (allowlist) e T5.2 (comandos) entra
        // aqui. O que se mede e a ORDEM: registar depois de o polling arrancar
        // seria perder os primeiros updates.
        marcos.push(`configure@${chamadasDe(srv, 'getUpdates').length}`)
        bot = b
      },
    })

    await aguardar(() => bot !== undefined, 'configure chamado')
    await aguardar(() => chamadasDe(srv, 'getUpdates').length >= 1, 'primeiro getUpdates')
    await bot?.stop()
    const code = await corrida

    assert.equal(code, WORKER_EXIT.OK)
    assert.deepEqual(marcos, ['configure@0'], 'configure corre ANTES do primeiro getUpdates')
    assert.equal(srv.calls[0]?.token, TOKEN_DE_TESTE, 'o token viaja na URL…')
    assert.equal(log.all().includes(TOKEN_DE_TESTE), false, '…e mesmo assim nao aparece no log')
  })

  it('TG-044: 409 -> o processo termina com o codigo de CONFLITO, distinto de tudo o resto', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const errors = await canonicalErrors()
    const conflito = errors['conflictOtherGetUpdates']
    assert.ok(conflito !== undefined)
    srv.queueError('getUpdates', conflito)
    const log = captureLog()

    const code = await runTelegramWorker({
      env: { TELEGRAM_BOT_TOKEN: TOKEN_DE_TESTE, TELEGRAM_API_ROOT: srv.apiRoot },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
    })

    assert.equal(code, WORKER_EXIT.CONFLICT)
    assert.notEqual(code, WORKER_EXIT.OK, 'sair com 0 faria o host achar que foi paragem pedida')
    assert.equal(chamadasDe(srv, 'getUpdates').length, 1, 'sem ciclo de reconexao')
    assert.match(log.all(), /409/u)
  })

  it('um `configure` que rebenta nao deixa o processo pendurado: sai com codigo', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const log = captureLog()

    const code = await runTelegramWorker({
      env: { TELEGRAM_BOT_TOKEN: TOKEN_DE_TESTE, TELEGRAM_API_ROOT: srv.apiRoot },
      argv: ARGV_LIMPO,
      log: log.logger,
      time: new FakeTime(),
      configure: () => {
        throw new Error('a costura falhou a registar-se')
      },
    })

    assert.equal(code, WORKER_EXIT.POLLING)
    assert.match(log.all(), /a costura falhou a registar-se/u)
    assert.equal(chamadasDe(srv, 'getUpdates').length, 0, 'nem chegou a fazer polling')
  })
})

describe('worker/telegram-bot — ACHADO 7: nenhum controlo a fingir', () => {
  it('o nivel do processo deixa passar `debug`: nenhuma chamada log.debug e codigo morto', () => {
    const linhas: string[] = []
    const logger = createWorkerLogger({ sink: (l) => linhas.push(l), level: WORKER_LOG_LEVEL })

    logger.debug('sonda')

    assert.equal(
      linhas.length,
      1,
      'com o nivel preso em `info` — que era o efeito real — esta linha desaparecia',
    )
  })

  it('`WORKER_LOG_LEVEL` NAO e lida do ambiente: a allowlist do host nao a deixa passar', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('../../../worker/telegram-bot.ts', import.meta.url)),
      'utf8',
    )
    const semComentarios = fonte
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '')

    assert.equal(
      /env\s*\[\s*['"`]WORKER_LOG_LEVEL/u.test(semComentarios),
      false,
      'ler uma variavel que WORKER_ENV_ALLOWLIST nao deixa passar e um botao desligado do fio',
    )
  })

  it('por a variavel no ambiente nao muda nada — e nao muda em silencio, muda por desenho', async () => {
    const comVariavel = captureLog()
    const code = await runTelegramWorker({
      env: { WORKER_LOG_LEVEL: 'error' },
      argv: ARGV_LIMPO,
      log: comVariavel.logger,
    })
    // Falta o token, logo sai por CONFIG — o que importa e que a linha de erro
    // SAIU apesar de `WORKER_LOG_LEVEL=error` sugerir o contrario para `info`.
    assert.equal(code, WORKER_EXIT.CONFIG)
    assert.match(comVariavel.all(), /TOKEN_MISSING/u)
  })
})
