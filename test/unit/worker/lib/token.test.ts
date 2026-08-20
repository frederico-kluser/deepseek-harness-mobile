/**
 * `worker/lib/token.ts` — TG-069-equivalente: o token NUNCA em `argv`.
 *
 * `/proc/<pid>/cmdline` e legivel por qualquer processo local do mesmo
 * utilizador, e um `ps` casual entrega o token a quem estiver a olhar. O token
 * chega por AMBIENTE, e o ambiente do worker e construido por allowlist no host
 * (`buildWorkerEnv`) — nao herda `process.env` inteiro, e `NODE_OPTIONS` fica
 * deliberadamente de fora porque aceita `--require`, ou seja carga de codigo
 * arbitrario no filho.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  API_ROOT_ENV_VAR,
  assertTokenNotInArgv,
  BOT_TOKEN_SHAPE,
  readBotToken,
  TOKEN_ENV_VAR,
} from '../../../../worker/lib/token.ts'
import { TOKEN_DE_TESTE } from './apoio.ts'

describe('worker/lib/token — leitura do ambiente', () => {
  it('o nome da variavel e o que `buildWorkerEnv` escreve', () => {
    assert.equal(TOKEN_ENV_VAR, 'TELEGRAM_BOT_TOKEN')
    assert.equal(API_ROOT_ENV_VAR, 'TELEGRAM_API_ROOT')
  })

  it('le o token e apara espacos das pontas', () => {
    assert.equal(readBotToken({ TELEGRAM_BOT_TOKEN: ` ${TOKEN_DE_TESTE} ` }), TOKEN_DE_TESTE)
  })

  it('ausente ou vazio: erro com codigo, e SEM citar o valor lido', () => {
    for (const env of [{}, { TELEGRAM_BOT_TOKEN: '' }, { TELEGRAM_BOT_TOKEN: '   ' }]) {
      assert.throws(() => readBotToken(env), /TOKEN_MISSING/u)
    }
    try {
      readBotToken({ TELEGRAM_BOT_TOKEN: '   ' })
      assert.fail('devia ter lancado')
    } catch (error) {
      assert.ok(error instanceof Error)
      assert.match(error.message, /TELEGRAM_BOT_TOKEN/u, 'nomeia a variavel')
      assert.equal(error.message.includes("'   '"), false, 'e nao cita o valor')
    }
  })
})

describe('worker/lib/token — TG-069: o token nunca em argv', () => {
  it('o arranque normal passa: o token esta no ambiente, nao na linha de comando', () => {
    assert.doesNotThrow(() => {
      assertTokenNotInArgv(['/usr/bin/node', '/pacote/dist/worker/telegram-bot.js'], TOKEN_DE_TESTE)
    })
  })

  it('FAIL-CLOSED: o NOSSO token em argv recusa o arranque', () => {
    assert.throws(
      () => {
        assertTokenNotInArgv(['node', 'bot.js', '--token', TOKEN_DE_TESTE], TOKEN_DE_TESTE)
      },
      /TOKEN_IN_ARGV/u,
    )
  })

  it('recusa mesmo colado a uma flag (`--token=...`)', () => {
    assert.throws(() => {
      assertTokenNotInArgv(['node', 'bot.js', `--token=${TOKEN_DE_TESTE}`], TOKEN_DE_TESTE)
    }, /TOKEN_IN_ARGV/u)
  })

  it('recusa o token de OUTRO bot, que e o caso em que ninguem repara', () => {
    assert.throws(
      () => {
        assertTokenNotInArgv(['node', 'bot.js', '987654321:BBBum-token-de-outra-pessoa'], undefined)
      },
      /TOKEN_IN_ARGV/u,
    )
  })

  it('a mensagem diz PORQUE, e nao repete o token', () => {
    try {
      assertTokenNotInArgv(['node', 'bot.js', TOKEN_DE_TESTE], TOKEN_DE_TESTE)
      assert.fail('devia ter lancado')
    } catch (error) {
      assert.ok(error instanceof Error)
      assert.match(error.message, /cmdline/u)
      assert.match(error.message, /TELEGRAM_BOT_TOKEN/u)
      assert.equal(error.message.includes(TOKEN_DE_TESTE), false, 'a recusa nao pode vazar o que recusa')
    }
  })

  it('a forma reconhece um token e nao reconhece uma porta nem uma hora', () => {
    assert.ok(BOT_TOKEN_SHAPE.test(TOKEN_DE_TESTE))
    assert.equal(BOT_TOKEN_SHAPE.test('127.0.0.1:8080'), false)
    assert.equal(BOT_TOKEN_SHAPE.test('12:30'), false)
    assert.equal(BOT_TOKEN_SHAPE.test('--verbose'), false)
  })
})
