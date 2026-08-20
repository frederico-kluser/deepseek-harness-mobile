/**
 * Duble de `StateStore` sobre um diretorio REAL.
 *
 * PORQUE UM DUBLE DE FICHEIRO E NAO UM OBJETO EM MEMORIA: a pergunta
 * falsificavel 2 de T2.1 ("o ficheiro de hash tem mesmo 0600? confira com
 * `stat`") so tem resposta se houver ficheiro. Este duble imita o contrato de
 * T2.5 -- escrita atomica com temporario NO MESMO diretorio, `fsync` antes do
 * `rename`, ficheiro 0600, e recusa de ler um estado mais frouxo que isso.
 *
 * NAO E a implementacao de T2.5 nem pretende ser: vive em `test/unit/secret/`
 * porque e material de teste DESTA sub-tarefa. A implementacao real e
 * `src/state/store.ts`, que entra pela fronteira do contrato congelado.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { PersistedState, StateStore } from '../../../src/contracts/state.ts'

const EMPTY: PersistedState = { version: 1, desiredState: 'STOPPED' }

export function createFileStateStore(statePath: string): StateStore {
  const read = (): PersistedState => {
    if (!existsSync(statePath)) return { ...EMPTY }
    const mode = statSync(statePath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      throw new Error(`state.json com modo 0${mode.toString(8)}: mais frouxo que 0600`)
    }
    return JSON.parse(readFileSync(statePath, 'utf8')) as PersistedState
  }
  return {
    read,
    update: (fn: (s: PersistedState) => PersistedState): void => {
      const next = fn(read())
      const temporary = join(dirname(statePath), '.state.json.tmp')
      const fd = openSync(temporary, 'w', 0o600)
      try {
        writeSync(fd, JSON.stringify(next))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, statePath)
    },
  }
}

/** Escreve um estado a mao, para montar cenarios que o `update` nao produz. */
export function writeRawState(statePath: string, raw: string): void {
  const fd = openSync(statePath, 'w', 0o600)
  try {
    writeSync(fd, raw)
  } finally {
    closeSync(fd)
  }
}
