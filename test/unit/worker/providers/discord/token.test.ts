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

describe('provider/discord/token — DISCORD_TOKEN_SHAPE (forma conservadora)', () => {
  it('>= 50 chars do alfabeto base64url + separadores comuns e a forma', () => {
    assert.ok(DISCORD_TOKEN_SHAPE.test('A'.repeat(50)), '50 chars: o piso exato')
    assert.ok(DISCORD_TOKEN_SHAPE.test(`abcDEF-_.${'x'.repeat(45)}`), 'alfabeto + separadores ._-')
    assert.ok(DISCORD_TOKEN_SHAPE.test('a'.repeat(80)), 'muito acima do piso')
  })

  it('abaixo de 50 chars ou com caracteres fora do alfabeto nao e a forma', () => {
    assert.equal(DISCORD_TOKEN_SHAPE.test('A'.repeat(49)), false, '49 chars: abaixo do piso')
    assert.equal(DISCORD_TOKEN_SHAPE.test(''), false)
    assert.equal(DISCORD_TOKEN_SHAPE.test(`a${'x'.repeat(60)}=`), false, '= (padding base64) nao e a forma')
    assert.equal(DISCORD_TOKEN_SHAPE.test(`a${'x'.repeat(60)}:`), false, ': (separador g1) nao e a forma')
    assert.equal(DISCORD_TOKEN_SHAPE.test(`a${'x'.repeat(60)} `), false, 'espaco nao e a forma')
  })
})

describe('provider/discord/token — assertTokenNotInArgv (bordas)', () => {
  it('token curto (< 8 chars) nao dispara a literal — a FORMA continua a valer', () => {
    // A literal so vale a partir de 8 chars (senao o proprio argv cheio de
    // palavras curtas recusaria tudo); a forma apanha o resto.
    assert.doesNotThrow(() => assertTokenNotInArgv([...ARGV_LIMPO, '--token', 'abc123'], 'abc123'))
  })

  it('sem o token (undefined) so a forma recusa — um token de OUTRO bot', () => {
    const outroToken = 'MzQ0NTAzMDA4MzYyODU0NzE2OTk1Njk3OTIzNDU2Nzg5MDEyMzQ1Ng'
    assert.throws(
      () => assertTokenNotInArgv([...ARGV_LIMPO, outroToken]),
      (error: unknown) => {
        assert.ok(error instanceof ProviderError)
        assert.equal(error.code, WORKER_EXIT.CONFIG)
        assert.equal(error.reason, 'TOKEN_IN_ARGV')
        assert.match(error.message, /argv\[2\]/u, 'a mensagem cita o INDICE do argumento')
        assert.equal(error.message.includes(outroToken), false, 'nao cita o valor recusado')
        return true
      },
    )
  })
})
