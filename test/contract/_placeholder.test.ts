import { test } from 'node:test'
import assert from 'node:assert/strict'

// COMMIT PREP 0 — placeholder verde.
// Existe por uma razao mecanica: `node --test` com um glob que nao casa com
// nenhum ficheiro sai com codigo 1 (09-DECISOES-CANONICAS.md D4). Sem este
// ficheiro, `pnpm test:contract` ficaria vermelho por AUSENCIA de teste, nao
// por defeito. E apagado pela primeira sub-tarefa real deste directorio (T0.1,
// que escreve CONTRACT-001..009 em test/contract/dsh-types.test.ts).
test('placeholder do directorio test/contract', () => {
  assert.equal(true, true)
})
