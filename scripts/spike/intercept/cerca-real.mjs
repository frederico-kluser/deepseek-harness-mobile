/**
 * S12 — carrega a cerca de confiança REAL, extraída em runtime do pacote
 * publicado `@deepseek-ai/dsh-client-connection@0.1.0-rc.8`.
 *
 * Não vendorizamos o código de terceiros: recortamos a região das funções da
 * cerca do `lib/index.js` instalado, escrevemos num ficheiro temporário fora do
 * repositório e importamos. O recorte é impresso pelo chamador, com sha256, para
 * a medição ser auto-verificável.
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ORIGEM = fileURLToPath(new URL(
  './node_modules/@deepseek-ai/dsh-client-connection/lib/index.js', import.meta.url))

/** Recorta a região da cerca e importa-a. Devolve `{ fence, meta }`. */
export async function carregarCercaReal() {
  const linhas = readFileSync(ORIGEM, 'utf8').split('\n')
  const inicio = linhas.findIndex((l) => l.startsWith('function isLoopbackHostname('))
  if (inicio === -1) throw new Error('cerca-real: `isLoopbackHostname` nao encontrada no pacote publicado')
  const fimRel = linhas.slice(inicio).findIndex((l, i) => i > 0 && l.startsWith('//#endregion')
    && linhas.slice(inicio, inicio + i).some((x) => x.startsWith('function isTrustedApiRequest(')))
  if (fimRel === -1) throw new Error('cerca-real: fim da regiao da cerca nao encontrado')
  const recorte = linhas.slice(inicio, inicio + fimRel).join('\n')
  const fonte = `${recorte}\nexport { isTrustedApiRequest }\n`
  const dir = mkdtempSync(join(tmpdir(), 'dsh-spike-cerca-'))
  const alvo = join(dir, 'cerca.mjs')
  writeFileSync(alvo, fonte)
  const mod = await import(alvo)
  return {
    isTrustedApiRequest: mod.isTrustedApiRequest,
    meta: {
      origem: ORIGEM,
      linhas: `${inicio + 1}..${inicio + fimRel}`,
      sha256Recorte: createHash('sha256').update(fonte).digest('hex').slice(0, 16),
      corpoDaFuncao: recorte.slice(recorte.indexOf('function isTrustedApiRequest(')),
    },
  }
}
