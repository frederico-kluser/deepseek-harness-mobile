/**
 * FABRICAS de configuracao e de instalacao do plugin.
 *
 * CASA TEMPORARIA -- ver `ctx-double.ts`. Ficheiro sem sufixo `.test.ts`.
 */

import { tmpdir } from 'node:os'

import type { Config } from '../../src/config/schema.ts'
import { apply } from '../../src/index.ts'
import { FakeContext } from './ctx-double.ts'

/**
 * `assertValidConfig` exige que o `worker.cwd` efetivo EXISTA (uma falha de
 * spawn nao produz saida normal, rejeita `done`). Usa-se o diretorio temporario
 * do sistema, que existe sempre e nao precisa de limpeza.
 */
export const WORKER_CWD = tmpdir()

export const VALID_CREDENTIAL = Buffer.from('admin:s3cr3t').toString('base64')
export const WRONG_CREDENTIAL = Buffer.from('admin:errada').toString('base64')

/**
 * Drena microtasks e a fila de imediatos.
 *
 * As decisoes do portao sao assincronas (`ctx.waterfall`) e a terminacao do
 * worker chega por `SubprocessHandle.done`, que e uma Promise. Um `setImmediate`
 * corre depois de toda a fila de microtasks pendente, que e o que se quer
 * observar.
 */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    encodedAuthString: VALID_CREDENTIAL,
    realm: 'Secure DSH Interface',
    allowedHosts: ['127.0.0.1', '::1'],
    trustedRemotes: ['127.0.0.1'],
    guardedPrefixes: ['/api'],
    deniedPermissions: ['danger-full-access'],
    worker: {
      // Espelha o manifesto de Camada 1 real (T1.3): `process.execPath` e o
      // MESMO Node que ja corre o host, e `args` esta vazio de proposito -- o
      // entrypoint NAO pode vir do manifesto, e anteposto pelo supervisor.
      command: process.execPath,
      args: [],
      cwd: WORKER_CWD,
      token: 'token-de-teste',
      graceMs: 3000,
      backoff: {
        initialDelayMs: 500,
        maxDelayMs: 10000,
        maxAttempts: 10,
        resetAfterMs: 60000,
      },
    },
  }

  return Object.assign(base, overrides)
}

export interface Installation {
  ctx: FakeContext
  config: Config
}

export function install(
  overrides: Partial<Config> = {},
  options: { withUpgrade?: boolean } = {},
): Installation {
  const ctx = new FakeContext(options)
  const config = makeConfig(overrides)
  apply(ctx.asContext(), config)
  return { ctx, config }
}

/**
 * Indices dos efeitos registados por `apply()`, na ordem de instalacao.
 *
 * A ordem e contrato: os disposers correm em LIFO, logo o worker morre antes,
 * depois o controlador (que derruba o tunel), e so depois a barreira e
 * levantada. O `controlador` entrou na Onda 5 (T5.1, `src/index.ts`).
 */
export const EFFECT = { veto: 0, authCheck: 1, barreira: 2, controlador: 3, worker: 4 } as const
