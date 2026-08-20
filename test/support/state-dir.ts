/**
 * Diretorio de estado descartavel. PREP-OWNED (PREP 2).
 *
 * T2.5 precisa provar coisas que so se provam com um diretorio REAL: que a
 * escrita e atomica (tmp no MESMO dir + fsync + rename), que o boot RECUSA um
 * `state.json` com modo 0644, e que um ficheiro corrompido para o arranque com
 * mensagem acionavel em vez de "comecar do zero" — que apagaria o
 * `secretDigest` e trocaria a senha do dono sem ninguem pedir.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TempStateDir {
  readonly path: string
  readonly statePath: string
  cleanup(): void
}

export function makeTempStateDir(): TempStateDir {
  const path = mkdtempSync(join(tmpdir(), 'dsh-guard-state-'))
  return {
    path,
    statePath: join(path, 'state.json'),
    cleanup: (): void => {
      rmSync(path, { recursive: true, force: true })
    },
  }
}
