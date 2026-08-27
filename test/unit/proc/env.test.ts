/**
 * `src/proc/env.ts` -- ambiente do worker por allowlist (achado B-HIGH).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildWorkerEnv,
  DEFAULT_PROVIDER,
  PROVIDER_ENV,
  resolverProvedorDoAmbiente,
  WORKER_IPC_ENV_MARK,
  WORKER_PROVIDER_ENV_VAR,
} from '../../../src/proc/env.ts'
// O registry do worker e o ESPELHO do lado do processo filho: os provedores
// registados la tem de existir aqui, com o `tokenVar` que o worker espera.
import { PROVIDERS } from '../../../worker/providers/registry.ts'

describe('ambiente do worker por allowlist (achado B-HIGH)', () => {
  it('nao propaga ADMIN_USER/ADMIN_PASS nem qualquer outro segredo do plano de controlo', () => {
    const env = buildWorkerEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/dsh',
        LANG: 'pt_PT.UTF-8',
        LC_ALL: 'pt_PT.UTF-8',
        TZ: 'Europe/Lisbon',
        PYTHONUNBUFFERED: '1',
        ADMIN_USER: 'admin',
        ADMIN_PASS: 's3cr3t-do-plano-de-controlo',
        AWS_SECRET_ACCESS_KEY: 'nao-devia-estar-aqui',
        SSH_AUTH_SOCK: '/tmp/agent',
      },
      'token-do-bot',
    )

    assert.equal(env['ADMIN_PASS'], undefined, 'ADMIN_PASS NAO pode chegar ao worker')
    assert.equal(env['ADMIN_USER'], undefined, 'ADMIN_USER NAO pode chegar ao worker')
    assert.equal(env['AWS_SECRET_ACCESS_KEY'], undefined)
    assert.equal(env['SSH_AUTH_SOCK'], undefined)

    assert.equal(env['TELEGRAM_BOT_TOKEN'], 'token-do-bot')
    assert.equal(env[WORKER_PROVIDER_ENV_VAR], 'telegram')
    assert.equal(env['PATH'], '/usr/bin')
    assert.equal(env['HOME'], '/home/dsh')
    assert.equal(env['LANG'], 'pt_PT.UTF-8')
    assert.equal(env['LC_ALL'], 'pt_PT.UTF-8')
    assert.equal(env['TZ'], 'Europe/Lisbon')
    assert.equal(env['PYTHONUNBUFFERED'], '1')
  })

  it('poe a marca DSH_GUARD_IPC, e ela NAO e um controlo', () => {
    const env = buildWorkerEnv({ PATH: '/usr/bin' }, 'token-do-bot')
    assert.equal(env[WORKER_IPC_ENV_MARK], '1')
  })

  it('a marca herdada do pai NAO passa: so a que este modulo poe', () => {
    // O assento remove todos os `DSH_*` HERDADOS (`scrubbedParentEnv`) e a
    // allowlist tambem nao os deixa passar. Quem a poe e so `buildWorkerEnv`, e
    // por isso ela nao pode ser usada como prova de nada -- o dead-mans switch
    // depende do EOF, nunca dela.
    const env = buildWorkerEnv({ PATH: '/usr/bin', [WORKER_IPC_ENV_MARK]: 'valor-do-pai' }, 't')
    assert.equal(env[WORKER_IPC_ENV_MARK], '1', 'o valor e sempre reescrito por nos')
  })
})

describe('provedor ativo (D1) -- default fechado e tabela PROVIDER_ENV', () => {
  it('chamar sem provider injeta o default `telegram` em DSH_GUARD_PROVIDER', () => {
    const env = buildWorkerEnv({ PATH: '/usr/bin' }, 'token-do-bot')
    assert.equal(DEFAULT_PROVIDER, 'telegram')
    assert.equal(env[WORKER_PROVIDER_ENV_VAR], 'telegram')
    assert.equal(PROVIDER_ENV['telegram'].tokenVar, 'TELEGRAM_BOT_TOKEN')
    // O default e o MESMO alvo que antes: o token do provedor ativo vai para o
    // tokenVar do telegram, e a variavel continua a existir.
    assert.equal(env['TELEGRAM_BOT_TOKEN'], 'token-do-bot')
  })

  it('explicito telegram e identico ao default -- nada do comportamento muda', () => {
    const explicito = buildWorkerEnv({ PATH: '/usr/bin' }, 'token-do-bot', 'telegram')
    const omisso = buildWorkerEnv({ PATH: '/usr/bin' }, 'token-do-bot')
    assert.deepEqual(explicito, omisso)
    assert.equal(explicito[WORKER_PROVIDER_ENV_VAR], 'telegram')
    assert.equal(explicito[PROVIDER_ENV['telegram'].tokenVar], 'token-do-bot')
  })
})

describe('discord REGISTRADO (Onda 2 do host) -- PROVIDER_ENV, buildWorkerEnv e o ambiente', () => {
  it('(a) PROVIDER_ENV resolve o tokenVar certo por provider: telegram e discord', () => {
    assert.equal(PROVIDER_ENV['telegram'].tokenVar, 'TELEGRAM_BOT_TOKEN')
    assert.equal(PROVIDER_ENV['discord'].tokenVar, 'DISCORD_BOT_TOKEN')
  })

  it('(a) paridade com o registry do worker: todo provedor registado LA existe AQUI', () => {
    // O registry (worker/providers/registry.ts) e o espelho do worker: quando
    // a Onda 3 registar o adaptador discord LA, este teste obriga o host a ja
    // ter a linha em PROVIDER_ENV — e, ate la, garante que o host nao apaga a
    // do telegram. A direcao e worker -> host: o host PODE ter entradas que o
    // worker ainda nao implementa (o filho falha-closed por provedor
    // desconhecido ate o adaptador existir), nunca o contrario.
    for (const id of Object.keys(PROVIDERS)) {
      assert.ok(
        id in PROVIDER_ENV,
        `o provedor '${id}' esta registado no worker mas falta a linha em PROVIDER_ENV`,
      )
    }
    // E o tokenVar do provedor REGISTADO no worker tem de ser o que o worker
    // le: `TOKEN_ENV_VAR` de worker/providers/telegram/token.ts.
    assert.equal(PROVIDER_ENV['telegram'].tokenVar, 'TELEGRAM_BOT_TOKEN')
  })

  it('(d) buildWorkerEnv com provider=discord injeta DISCORD_BOT_TOKEN e NAO deixa TELEGRAM_BOT_TOKEN', () => {
    const env = buildWorkerEnv({ PATH: '/usr/bin' }, 'token-do-bot-discord', 'discord')
    assert.equal(env['DISCORD_BOT_TOKEN'], 'token-do-bot-discord')
    assert.equal(env['TELEGRAM_BOT_TOKEN'], undefined, 'o token do discord NAO pode ir para a chave do telegram')
    assert.equal(env[WORKER_PROVIDER_ENV_VAR], 'discord')
    assert.equal(env[WORKER_IPC_ENV_MARK], '1')
  })

  it('o default fechado nao muda: sem provider, o alvo continua TELEGRAM_BOT_TOKEN', () => {
    const env = buildWorkerEnv({ PATH: '/usr/bin' }, 'token-do-bot')
    assert.equal(env['TELEGRAM_BOT_TOKEN'], 'token-do-bot')
    assert.equal(env['DISCORD_BOT_TOKEN'], undefined)
  })

  it('resolverProvedorDoAmbiente: ausente/vazio = telegram; discord explicito = discord', () => {
    assert.equal(resolverProvedorDoAmbiente({}), DEFAULT_PROVIDER)
    assert.equal(resolverProvedorDoAmbiente({ [WORKER_PROVIDER_ENV_VAR]: '   ' }), 'telegram')
    assert.equal(resolverProvedorDoAmbiente({ [WORKER_PROVIDER_ENV_VAR]: 'discord' }), 'discord')
    assert.equal(resolverProvedorDoAmbiente({ [WORKER_PROVIDER_ENV_VAR]: 'telegram' }), 'telegram')
  })

  it('resolverProvedorDoAmbiente: valor desconhecido e ERRO (fail-closed, nunca o token errado)', () => {
    // Degradar em silencio para o telegram leria a CHAVE ERRADA do
    // secrets.env — a mesma razao do resolverProvedor do registry do worker.
    assert.throws(
      () => resolverProvedorDoAmbiente({ [WORKER_PROVIDER_ENV_VAR]: 'whatsapp' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /whatsapp/u)
        assert.match(error.message, /telegram \| discord/u, 'nomeia os antecipados')
        return true
      },
    )
  })
})
