/**
 * `worker/providers/telegram/token.ts` — de onde o token vem e por onde NAO
 * pode vir (TG-069). Port fiel de `worker/lib/token.ts`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  API_ROOT_ENV_VAR,
  TOKEN_ENV_VAR,
  assertTokenNotInArgv,
  lerTokenDoAmbiente,
} from '../../../../../worker/providers/telegram/token.ts'
import { TOKEN_DE_TESTE } from './apoio.ts'

function envCom(valor: string | undefined): NodeJS.ProcessEnv {
  return { [TOKEN_ENV_VAR]: valor }
}

describe('provider/telegram/token — leitura do ambiente', () => {
  it('le o token por `TELEGRAM_BOT_TOKEN` e faz trim', () => {
    assert.equal(lerTokenDoAmbiente(envCom(`  ${TOKEN_DE_TESTE}  `)), TOKEN_DE_TESTE)
  })

  it('variavel ausente recusa com TOKEN_MISSING (fail-closed)', () => {
    assert.throws(() => lerTokenDoAmbiente({}), /TOKEN_MISSING/u)
  })

  it('variavel so com espacos recusa — o valor nao e citado na message (nao vazaria)', () => {
    assert.throws(() => lerTokenDoAmbiente(envCom('   ')), /TOKEN_MISSING/u)
  })

  it('nomes de variavel estaveis: contrato com o host (buildWorkerEnv)', () => {
    assert.equal(TOKEN_ENV_VAR, 'TELEGRAM_BOT_TOKEN')
    assert.equal(API_ROOT_ENV_VAR, 'TELEGRAM_API_ROOT')
  })
})

describe('provider/telegram/token — TG-069: token NUNCA em argv', () => {
  it('recusa arranque quando o argv contem o nosso token literal', () => {
    assert.throws(() => assertTokenNotInArgv(['--token', TOKEN_DE_TESTE], TOKEN_DE_TESTE), /TOKEN_IN_ARGV/u)
  })

  it('recusa TAMBEM um token com a FORMA (outro bot) passado por engano', () => {
    const outro = '987654321:CCCoutro-token-de-outro-bot_abcdefghij'
    assert.throws(() => assertTokenNotInArgv(['--token', outro]), /TOKEN_IN_ARGV/u)
  })

  it('sem token em argv, nao lanca', () => {
    assert.doesNotThrow(() => assertTokenNotInArgv(['node', 'worker.js']))
  })
})