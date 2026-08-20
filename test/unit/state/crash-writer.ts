/**
 * O processo que morre A MEIO da escrita. NAO e um teste: o nome nao casa com
 * o glob canonico (`test/unit/**\/*.test.ts`), logo o runner nao lhe pega — quem
 * o lanca e `crash.test.ts`.
 *
 * PORQUE UM PROCESSO DE VERDADE: a pergunta falsificavel 1 de `03-ONDAS.md` 7
 * exige matar o processo no meio da escrita e ler o ficheiro DEPOIS. Um `throw`
 * simulado prova o caminho de erro, nao a morte: com SIGKILL nao corre `finally`
 * nenhum, nem handler de sinal, nem disposer. E exatamente por isso que a
 * propriedade tem de estar na ORDEM das chamadas ao sistema, e nao na limpeza.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { statePathsAt } from '../../../src/state/paths.ts'
import { createStateStore } from '../../../src/state/store.ts'

const dir = process.argv[2]
if (dir === undefined) throw new Error('uso: crash-writer.ts <diretorio-de-estado>')

const handle = createStateStore({
  paths: statePathsAt(dir),
  beforeRename: (): void => {
    // Sinal SINCRONO para o pai — um `stdout` de pipe nao e sincrono em todas
    // as plataformas, um `writeFileSync` e.
    writeFileSync(join(dir, 'PARADO-NO-RENAME'), 'sim')
    // Bloqueia a thread principal para sempre. Deste ponto em diante o unico
    // fim possivel deste processo e o sinal que o pai lhe manda.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  },
})

handle.store.update((estado) => ({
  ...estado,
  desiredState: 'READY',
  secretDigest: 'c'.repeat(64),
}))
