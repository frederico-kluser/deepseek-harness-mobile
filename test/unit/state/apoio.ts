/**
 * Apoio COMUM aos testes de `src/state/**`.
 *
 * Nao e um teste (o nome nao casa com o glob canonico `test/unit/**\/*.test.ts`)
 * e nao e um dublê: os dublês desta onda sao os prep-owned de `test/support/**`,
 * e sao esses que se usam. Aqui esta so o que os quatro ficheiros de teste do
 * modulo repetiriam palavra por palavra — e repetir a asercao de codigo de erro
 * em quatro sitios e ter quatro versoes dela.
 */

import assert from 'node:assert/strict'
import { readdirSync, statSync } from 'node:fs'

import { statePathsAt } from '../../../src/state/paths.ts'
import { StateError } from '../../../src/state/schema.ts'
import { createStateStore, type StateStoreOptions } from '../../../src/state/store.ts'
import { makeTempStateDir, type TempStateDir } from '../../support/state-dir.ts'

/** Um `sha256` em hex valido — o formato que `src/brand.ts` exige. */
export const DIGEST = 'b'.repeat(64)

export function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

/** Os temporarios da escrita atomica que estao no diretorio (deviam ser zero). */
export function temporarios(dir: string): string[] {
  return readdirSync(dir).filter((nome) => nome.startsWith('.state.json.tmp-'))
}

/** Validador para `assert.throws`: exige `StateError` COM o codigo esperado. */
export function esperaCodigo(code: string): (error: unknown) => true {
  return (error: unknown): true => {
    assert.ok(error instanceof StateError, `esperava StateError, veio ${String(error)}`)
    assert.equal(error.code, code)
    return true
  }
}

/** `assert.throws` nao devolve o erro; para inspeccionar a MENSAGEM, apanha-se. */
export function capturar(fn: () => unknown): StateError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof StateError, `esperava StateError, veio ${String(error)}`)
    return error
  }
  throw new assert.AssertionError({ message: 'esperava que lancasse, e nao lancou' })
}

export interface Cenario {
  readonly temp: TempStateDir
  readonly store: ReturnType<typeof createStateStore>
}

/**
 * Um diretorio de estado descartavel + um store apontado para ele, com o
 * disposer e a limpeza garantidos por `finally`.
 *
 * O diretorio vem de `makeTempStateDir()` (prep-owned): um diretorio REAL, que
 * e a unica forma de provar modos de ficheiro, `rename` e `fsync`.
 */
export function comStore(
  corpo: (cenario: Cenario) => void,
  opcoes: Omit<StateStoreOptions, 'paths'> = {},
): void {
  const temp = makeTempStateDir()
  const store = createStateStore({ ...opcoes, paths: statePathsAt(temp.path) })
  try {
    corpo({ temp, store })
  } finally {
    store.dispose()
    temp.cleanup()
  }
}
