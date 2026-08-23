/**
 * `src/proc/env.ts` -- ambiente do worker por allowlist (achado B-HIGH).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildWorkerEnv,
  DEFAULT_PROVIDER,
  PROVIDER_ENV,
  WORKER_IPC_ENV_MARK,
  WORKER_PROVIDER_ENV_VAR,
} from '../../../src/proc/env.ts'

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
