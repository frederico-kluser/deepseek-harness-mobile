import { test } from 'node:test'
import assert from 'node:assert/strict'

// COMMIT PREP 1 -- placeholder verde de `test/live`.
// `node --test` com um glob que nao casa com nenhum ficheiro sai com codigo 1
// (09-DECISOES-CANONICAS.md D4). Sem este ficheiro o gate ficaria vermelho por
// AUSENCIA de teste, nao por defeito. A primeira sub-tarefa real deste
// directorio apaga-o.
test('placeholder do directorio test/live', () => {
  assert.equal(true, true)
})
