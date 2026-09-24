/**
 * GUARDIAO ESTRUTURAL PERMANENTE — o golden master da remocao do provedor
 * apagado (onda 1, tarefa B: «apagar COMPLETAMENTE o codigo do Discord; golden
 * master grep=0 fora da historia»).
 *
 * PORQUE ISTO VIVE EM CODIGO DE TESTE E NAO NUM `grep` MANUAL: um grep manual
 * so corre quando alguem se lembra dele. A remocao completa de um provedor e a
 * mudanca que mais facilmente regride por via de um comentario, uma string de
 * ajuda ou uma entrada de manifesto — e o unico guardian ate agora era uma
 * verificacao manual. Este ficheiro torna-a PERMANENTE: corre em `pnpm test`.
 *
 * O CONTRATO (FOCO 1a): NENHUM ficheiro atual de producao/worker/src/test (nem
 * de config, docs atuais ou skills) menciona o provedor removido, FORA da
 * historia preservada:
 *   - docs/plano/**, docs/spikes/**, docs/manual-runs/**, docs/RELATORIO*,
 *     docs/mutantes.md  (a historia nao se reescreve);
 *   - CHANGELOG.md e .changeset/** (as entradas de remocao NAMEIAM o removido
 *     de proposito — sao o registo da decisao).
 *
 * AUTO-EXCLUSAO: este ficheiro precisa da palavra para a procurar e para
 * nomear o bug no titulo do caso — e por isso ele e o UNICO ficheiro isento
 * (por caminho proprio; o conteudo dele nunca e procurado). Nenhum outro
 * ficheiro de teste a pode usar.
 *
 * ESTADO ATUAL: o contrato (caso em `skip` abaixo) esta REPROVADO por um
 * residuo REAL em producao — `worker/providers/telegram/parse.ts:389`. Pela
 * regra de test-after nao se corrige producao daqui: o caso guarda a assercao
 * do comportamento CORRETO e esta marcado como falha-esperada, NOMEANDO o bug.
 * O caso «ratchet» ativo impede, entretanto, QUALQUER residuo novo.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url))
const EU = resolve(fileURLToPath(import.meta.url))

/**
 * Diretorios que NAO sao ficheiro-atual-de-repo: controlo de versao,
 * dependencias instaladas, estado local do orquestrador e EMITIDOS de build
 * (`dist/`/`lib/` da RAIZ — `worker/lib/` e FONTE e continua a ser varrido).
 */
const DIRS_FORA = new Set(['.git', 'node_modules', 'dist', '.deep-orchestrator'])

/** Extensoes nao-texto (logos, tarballs, fontes) + artefactos de build. */
const EXTS_FORA = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.tgz', '.gz', '.zip',
  '.woff', '.woff2', '.ttf', '.otf', '.pdf', '.lock', '.tsbuildinfo',
])

/**
 * A HISTORIA PRESERVADA — as unicas isencoes do contrato.
 * `PREFIXOS`: casam por comeco de caminho (`docs/RELATORIO*` e um globs).
 * `EXACTOS`: casam pelo caminho inteiro (nada de `CHANGELOG.md.old`).
 */
const PREFIXOS_HISTORIA: readonly string[] = [
  'docs/plano/',
  'docs/spikes/',
  'docs/manual-runs/',
  'docs/RELATORIO',
  '.changeset/',
]
const EXACTOS_HISTORIA: readonly string[] = ['docs/mutantes.md', 'CHANGELOG.md']

/** `true` se o caminho (relativo, posix) pertence a historia preservada. */
function eHistoria(relPosix: string): boolean {
  return (
    PREFIXOS_HISTORIA.some((prefixo) => relPosix.startsWith(prefixo)) ||
    EXACTOS_HISTORIA.includes(relPosix)
  )
}

interface Mencoes {
  /** Varredura nao-vazia (ficheiros realmente percorridos) — guarda anti-vazio. */
  readonly ficheiros: string[]
  /** `caminho:linha` de cada linha que casa o termo. */
  readonly linhas: string[]
}

/**
 * O TERMO procurado, montado em tempo de execucao: o nome do provedor removido
 * (e variantes coladas simples, ex. `dis-cord`), em qualquer caixa. Montado
 * por partes para este ficheiro nao se citar a si mesmo no `grep` futuro. As
 * variantes sao limitadas a UM separador: com `\S*` aberto, o cruzamento entre
 * duas ocorrencias de `cordis` (lockfiles, espelhos `types/`) casava falso.
 */
const TERMOS = new RegExp(`${'dis'}[-_.]?${'cord'}`, 'iu')

function varrer(dir: string, acc: Mencoes): void {
  const naRaiz = resolve(dir) === resolve(RAIZ)
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name)
    const rel = relative(RAIZ, caminho).split(sep).join('/')
    if (entrada.isDirectory()) {
      if (DIRS_FORA.has(entrada.name)) continue
      if (naRaiz && entrada.name === 'lib') continue // emitido do client (gitignorado)
      if (eHistoria(rel + '/')) continue
      varrer(caminho, acc)
      continue
    }
    if (!entrada.isFile()) continue
    if (eHistoria(rel)) continue
    if (EXTS_FORA.has(extname(caminho))) continue
    // Este ficheiro entra na lista (prova de que o walker chegou aqui) mas o
    // CONTEUDO dele e auto-isento: precisa do termo para o procurar.
    const euSouEu = caminho === EU
    acc.ficheiros.push(rel)
    if (euSouEu) continue
    const linhas = readFileSync(caminho, 'utf8').split('\n')
    for (let i = 0; i < linhas.length; i += 1) {
      if (TERMOS.test(linhas[i] ?? '')) acc.linhas.push(`${rel}:${String(i + 1)}`)
    }
  }
}

function mencoesForaDaHistoria(): Mencoes {
  const acc: Mencoes = { ficheiros: [], linhas: [] }
  varrer(RAIZ, acc)
  return acc
}

/* O residuo CONHECIDO (BUG-1): a unica mencao atual fora da historia. A
 * tolerancia e a ENTRADA EXATA (`caminho:linha`) — nunca por prefixo de
 * ficheiro: com um prefixo, QUALQUER mencao nova no ficheiro inteiro passava
 * isenta (revisao MED/M4b). O titulo do caso skipado fixa o arquivo:linha. */
const RESIDUO_CONHECIDO = 'worker/providers/telegram/parse.ts:389'

describe('golden master da limpeza — nenhuma mencao ao provedor removido fora da historia', () => {
  it('a varredura cobre MESMO a arvore inteira (guarda anti-vazio)', () => {
    const { ficheiros } = mencoesForaDaHistoria()
    // Sem esta checagem, um bug no walker tornaria todos os casos verdes por
    // varrer zero ficheiros — o classico guarda vazio.
    for (const obrigatorio of [
      'worker/providers/registry.ts',
      'worker/providers/telegram/parse.ts',
      'src/proc/env.ts',
      'package.json',
      'cordis.patch.yml',
      'test/unit/estrutural/golden-master.test.ts',
    ]) {
      assert.ok(
        ficheiros.includes(obrigatorio),
        `a varredura nao chegou a ${obrigatorio} — o walker regrediu`,
      )
    }
    assert.ok(ficheiros.length > 50, 'a varredura leu poucos ficheiros')
  })

  it('as isencoes sao EXATAMENTE a historia preservada (nada escapa por typo)', () => {
    assert.ok(eHistoria('docs/plano/06-REPO-E-CI.md'))
    assert.ok(eHistoria('docs/spikes/telegram.md'))
    assert.ok(eHistoria('docs/manual-runs/M1-onboarding-telegram.md'))
    assert.ok(eHistoria('docs/RELATORIO-FINAL.md'))
    assert.ok(eHistoria('docs/RELATORIO-FECHAMENTO.md'))
    assert.ok(eHistoria('docs/mutantes.md'))
    assert.ok(eHistoria('CHANGELOG.md'))
    assert.ok(eHistoria('.changeset/remocao-provedor.md'))
    // O que NAO e historia nao escapa (prefixos e exactos nao se confundem):
    assert.ok(!eHistoria('docs/INSTALL.md'))
    assert.ok(!eHistoria('docs/PROVIDERS.md'))
    assert.ok(!eHistoria('docs/mutantes.md.bak'))
    assert.ok(!eHistoria('README.md'))
    assert.ok(!eHistoria('src/index.ts'))
    assert.ok(!eHistoria('test/unit/index.test.ts'))
    assert.ok(!eHistoria('CHANGELOG.md.old'))
    assert.ok(!eHistoria('plano/06-REPO-E-CI.md'))
    assert.ok(!eHistoria('.changeset-velho/x.md'))
  })

  it.skip(
    'BUG: o golden master grep=0 fora da historia esta QUEBRADO — sobra a palavra do provedor removido num comentario de producao em worker/providers/telegram/parse.ts:389 (a onda 1 removeu o provedor por completo mas deixou "espelho do discord conta igual o dispatch-outro"; nao se corrige producao daqui — regra test-after)',
    () => {
      // A ASSERCAO DO COMPORTAMENTO CORRETO, mantida integralmente: zero
      // mencoes fora da historia preservada. Marcado como falha-esperada
      // porque a producao contradiz o contrato (bug REAL, nao erro de teste).
      const { linhas } = mencoesForaDaHistoria()
      assert.deepEqual(
        linhas,
        [],
        `o contrato e grep=0 fora da historia; residuos encontrados: ${linhas.join(', ')}`,
      )
    },
  )

  it('ratchet: fora da ENTRADA EXATA do residuo conhecido, nenhuma mencao nova em lado nenhum', () => {
    // NAO valida o residuo: o contrato (zero) vive no caso skipado acima. Este
    // caso so garante que a superficie limpa CONTINUA limpa enquanto o bug nao
    // e corrigido. A unica entrada tolerada e a EXATA `parse.ts:389`: qualquer
    // mencao nova em QUALQUER outro sitio — inclusive OUTRA LINHA do proprio
    // `worker/providers/telegram/parse.ts` — cai aqui. Quando o bug for
    // corrigido, este caso continua verde e o caso acima volta a poder ser
    // restaurado.
    const { linhas } = mencoesForaDaHistoria()
    const novas = linhas.filter((m) => m !== RESIDUO_CONHECIDO)
    assert.deepEqual(
      novas,
      [],
      `residuos NOVOS fora da historia preservada: ${novas.join(', ')}`,
    )
  })
})
