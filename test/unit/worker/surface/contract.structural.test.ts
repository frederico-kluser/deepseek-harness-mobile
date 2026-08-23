/**
 * Invariantes ESTRUTURAIS do contrato neutro da superficie (`worker/surface/`).
 *
 * Estes testes NAO importam o contrato -- LEEM o fonte com `fs` e assertam sobre
 * os especificadores de import, exactamente como a suite de `worker/auth/` prova
 * «nenhuma linha de CODIGO le username» perguntando `04-TESTES.md` 5.5. A regra
 * aqui e a fronteira D4 de `worker/surface/contract.ts` §«A FRONTEIRA»:
 *
 *   - o contrato e NEUTRO: nenhum tipo do grammY, nenhum `worker/lib/*`;
 *   - o worker e processo separado: so pode importar de `src/contracts/ipc.ts`
 *     (tipos puros) -- qualquer outro caminho de `src/` e rejeicao de PR
 *     (`05-QUALIDADE-CODIGO.md` 5.5);
 *   - o que mais pode importar e `node:*` ou a propria `worker/surface/`.
 *
 * Um import falso no fonte (que o typecheck nao ve, por ser so comentario)
 * derruba ESTE teste antes de chegar a producao.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { it } from 'node:test'

const SURFACE_DIR = new URL('../../../../worker/surface/', import.meta.url)
const SRCS = readdirSync(SURFACE_DIR)
  .filter((name) => name.endsWith('.ts'))
  .toSorted()

/** Remove comentarios -- o JSDoc FALA de grammY/worker/lib; o codigo nao pode USAR. */
function codeOnly(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/(^|\s)\/\/.*$/gmu, '$1')
}

/** Extrai o especificador de CADA import/export-from declarado. */
function importSpecifiers(source: string): string[] {
  const out: string[] = []
  const re = /^\s*(?:import[\s\S]*?\sfrom\s+|export\s+(?:type\s+)?[\s\S]*?\sfrom\s+)'([^']+)'/gmu
  for (const match of source.matchAll(re)) out.push(match[1] ?? '')
  return out
}

/** O cone de import que a fronteira D4 + 05-QUALIDADE-CODIGO.md 5.5 autoriza. */
function conePermitido(spec: string): boolean {
  return (
    spec.startsWith('./') || // a propria worker/surface/ (contract.ts, ids.ts)
    spec.startsWith('node:') || // builtin do runtime
    spec === '../../src/contracts/ipc.ts' // unica janela para o host (tipos puros)
  )
}

// ---------------------------------------------------------------------------

it('worker/surface/: ha ficheiros fonte para inspecionar', () => {
  assert.ok(SRCS.length > 0, 'tem de haver ficheiros fonte em worker/surface/')
})

it('worker/surface/: nenhum import de grammy nem de worker/lib', () => {
  for (const file of SRCS) {
    const code = codeOnly(readFileSync(new URL(file, SURFACE_DIR), 'utf8'))
    for (const spec of importSpecifiers(code)) {
      assert.equal(/\bgrammy\b/u.test(spec), false, `${file} importa 'grammy' -- contrato neutro nao conhece o grammY`)
      assert.equal(/\bworker\/lib\b/u.test(spec), false, `${file} importa '${spec}' -- nada de worker/lib no contrato`)
    }
  }
})

it('worker/surface/: o cone de import e node: | ./ | src/contracts/ipc.ts', () => {
  for (const file of SRCS) {
    const code = codeOnly(readFileSync(new URL(file, SURFACE_DIR), 'utf8'))
    for (const spec of importSpecifiers(code)) {
      assert.ok(
        conePermitido(spec),
        `${file} importa '${spec}' -- fora do cone do contrato (grammY/worker/lib/outros src/ proibidos)`,
      )
    }
  }
})

it('worker/surface/: a UNICA janela para src/ e contracts/ipc.ts', () => {
  for (const file of SRCS) {
    const code = codeOnly(readFileSync(new URL(file, SURFACE_DIR), 'utf8'))
    const foradosCone = importSpecifiers(code).filter((spec) => !spec.startsWith('./') && !spec.startsWith('node:'))
    for (const spec of foradosCone) {
      assert.equal(
        spec,
        '../../src/contracts/ipc.ts',
        `${file} importa '${spec}' de src/ -- o worker so pode tocar contracts/ipc.ts (05-QUALIDADE-CODIGO.md 5.5)`,
      )
    }
  }
})