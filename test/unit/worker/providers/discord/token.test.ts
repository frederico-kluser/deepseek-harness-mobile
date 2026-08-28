/**
 * `worker/providers/discord/token.ts` — o token do bot e a raiz da API.
 *
 * Cobre: `DISCORD_BOT_TOKEN`/`DISCORD_API_ROOT` (os NOMES que o host injeta —
 * a paridade e `test/unit/proc/env.test.ts`), `TOKEN_MISSING` sem citar o
 * valor, a raiz da API com default publico, e TG-069 (token NUNCA em `argv` —
 * pela literal e pela forma).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  API_ROOT_ENV_VAR,
  assertTokenNotInArgv,
  DEFAULT_DISCORD_API_ROOT,
  DISCORD_TOKEN_SHAPE,
  lerApiRootDoAmbiente,
  lerTokenDoAmbiente,
  TOKEN_ENV_VAR,
} from '../../../../../worker/providers/discord/token.ts'
import { ProviderError } from '../../../../../worker/providers/discord/interno.ts'
import { WORKER_EXIT } from '../../../../../worker/lib/errors.ts'
import { TOKEN_DE_TESTE } from './apoio.ts'

const ARGV_LIMPO = ['/usr/bin/node', '/pacote/dist/worker/telegram-bot.js']

describe('provider/discord/token — as variaveis (contrato com o host)', () => {
  it('o TOKEN_ENV_VAR e o que o host escreve: DISCORD_BOT_TOKEN', () => {
    assert.equal(TOKEN_ENV_VAR, 'DISCORD_BOT_TOKEN')
    assert.equal(API_ROOT_ENV_VAR, 'DISCORD_API_ROOT')
  })

  it('lerTokenDoAmbiente le e faz trim; ausente/vazio -> TOKEN_MISSING sem citar o valor', () => {
    assert.equal(lerTokenDoAmbiente({ [TOKEN_ENV_VAR]: '  token-x  ' }), 'token-x')
    assert.throws(
      () => lerTokenDoAmbiente({}),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        // O contrato comum (Onda 3-fix): o `code` e o NUMERICO 10 (CONFIG) e a
        // causa legivel vive no `reason`/mensagem.
        assert.equal(error.code, WORKER_EXIT.CONFIG)
        assert.equal(error.reason, 'TOKEN_MISSING')
        assert.match(error.message, /DISCORD_BOT_TOKEN/u)
        assert.equal(error.message.includes('token-x'), false, 'nao cita valores')
        return true
      },
    )
    assert.throws(() => lerTokenDoAmbiente({ [TOKEN_ENV_VAR]: '   ' }), /TOKEN_MISSING/u)
  })

  it('lerApiRootDoAmbiente: default publico; DISCORD_API_ROOT tem precedencia; barra final normalizada', () => {
    assert.equal(lerApiRootDoAmbiente({}), DEFAULT_DISCORD_API_ROOT)
    assert.equal(DEFAULT_DISCORD_API_ROOT, 'https://discord.com/api/v10')
    assert.equal(lerApiRootDoAmbiente({ [API_ROOT_ENV_VAR]: 'http://127.0.0.1:9999/' }), 'http://127.0.0.1:9999')
    assert.equal(lerApiRootDoAmbiente({ [API_ROOT_ENV_VAR]: '   ' }), DEFAULT_DISCORD_API_ROOT)
  })
})

describe('provider/discord/token — TG-069 (token NUNCA em argv)', () => {
  it('a LITERAL do nosso token em argv recusa (mesmo que o formato mude)', () => {
    assert.throws(
      () => assertTokenNotInArgv([...ARGV_LIMPO, '--token', TOKEN_DE_TESTE], TOKEN_DE_TESTE),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.code, WORKER_EXIT.CONFIG)
        assert.equal(error.reason, 'TOKEN_IN_ARGV')
        assert.match(error.message, /DISCORD_BOT_TOKEN/u)
        return true
      },
    )
  })

  it('a FORMA de um token de OUTRO bot tambem recusa (o caso em que ninguem repara)', () => {
    const outroToken = 'MzQ0NTAzMDA4MzYyODU0NzE2OTk1Njk3OTIzNDU2Nzg5MDEyMzQ1Ng'
    assert.ok(DISCORD_TOKEN_SHAPE.test(outroToken), 'o shape deteta tokens do discord')
    assert.throws(() => assertTokenNotInArgv([...ARGV_LIMPO, outroToken]))
  })

  it('argv limpo nao recusa nada', () => {
    assert.doesNotThrow(() => assertTokenNotInArgv(ARGV_LIMPO, TOKEN_DE_TESTE))
    assert.doesNotThrow(() => assertTokenNotInArgv(['--config', 'caminho/curto'], TOKEN_DE_TESTE))
  })
})
