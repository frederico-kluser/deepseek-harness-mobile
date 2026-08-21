#!/usr/bin/env node
/**
 * gen-compat-table.mjs -- GERA docs/COMPATIBILITY.md a partir de dsh-compat.yml.
 * Fonte de verdade: dsh-compat.yml (raiz). Saida: docs/COMPATIBILITY.md.
 * NUNCA edite docs/COMPATIBILITY.md a mao: edite dsh-compat.yml e corra:
 *   node scripts/gen-compat-table.mjs
 * Subconjunto YAML rigido e sem dependencia externa; fora dele, exit 1.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const INPUT = resolve(REPO_ROOT, 'dsh-compat.yml')
const OUTPUT = resolve(REPO_ROOT, 'docs', 'COMPATIBILITY.md')
const ACCEPTED_STATUS = new Set(['supported', 'deprecated', 'eol'])

function parseCompatYaml(text) {
  const split = text.split(/\r?\n/)
  const top = {}
  const rows = []
  let current = { isRow: false, obj: top, block: null }
  const assign = (owner, key, value) => { owner[key] = value }
  const flushBlock = () => {
    if (current.block) { assign(current.block.owner, current.block.key, current.block.lines.join('\n')); current.block = null }
  }
  const unquote = (v, idx) => {
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) return v.slice(1, -1)
    if ((v.startsWith('"') || v.endsWith('"')) && v.includes('"')) throw new Error('linha ' + idx + ': aspas desequilibradas')
    return v
  }
  const assignInline = (rest, owner, idx) => {
    const c = rest.indexOf(':')
    const k = rest.slice(0, c).trim()
    let v = rest.slice(c + 1).trim()
    if (v.includes(' #')) v = v.slice(0, v.indexOf(' #')).trim()
    owner[k] = unquote(v, idx)
  }
  for (let idx = 0; idx < split.length; idx++) {
    const raw = split[idx]
    const indent = raw.length - raw.trimStart().length
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (current.block) { if (/^\s{4,}/.test(raw)) { current.block.lines.push(raw.replace(/^\s{4}/, '')); continue } flushBlock() }
    if (/^-\s/.test(trimmed)) {
      if (indent !== 2) throw new Error('linha ' + (idx + 1) + ': item de lista exige 2 espacos')
      const item = {}
      rows.push(item)
      current = { isRow: true, obj: item, block: null }
      const rest = trimmed.replace(/^-\s+/, '')
      if (rest) assignInline(rest, item, idx)
      continue
    }
    const col = raw.indexOf(':')
    if (col === -1) throw new Error('linha ' + (idx + 1) + ': esperava chave: valor')
    const key = raw.slice(0, col).trim()
    const value = raw.slice(col + 1).trim()
    const owner = indent === 0 ? top : current.isRow ? current.obj : null
    if (owner === null) throw new Error('linha ' + (idx + 1) + ': sub-chave sem dono (' + key + ')')
    if (value === '|') { current.block = { owner, key, lines: [] }; continue }
    assignInline(raw, owner, idx)
  }
  flushBlock()
  return { top, rows }
}

function validate(data) {
  const { top, rows } = data
  for (const req of ['package', 'plugin', 'supported-range', 'policy']) {
    if (typeof top[req] !== 'string' || top[req] === '') throw new Error('dsh-compat.yml: falta a chave obrigatoria: ' + req)
  }
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('dsh-compat.yml: falta a lista rows (ou esta vazia)')
  let sawSupported = false
  const labels = new Set()
  for (const row of rows) {
    if (!row.version || !row.label || !row.status) throw new Error('linha de compatibilidade sem version/label/status')
    if (!ACCEPTED_STATUS.has(row.status)) throw new Error('status invalido: ' + row.status)
    if (row.status === 'supported') sawSupported = true
    if (labels.has(row.label)) throw new Error('rotulo duplicado: ' + row.label)
    labels.add(row.label)
  }
  if (!sawSupported) throw new Error('dsh-compat.yml: precisa de pelo menos uma linha supported')
}

function renderLines(top) {
  const out = []
  const add = (s) => out.push(s)
  const bt = String.fromCharCode(96)
  add('# COMPATIBILITY.md -- compatibilidade com o upstream ' + top.package)
  add('')
  add('> **Gerado por** ' + bt + 'scripts/gen-compat-table.mjs' + bt + ' a partir de ' + bt + 'dsh-compat.yml' + bt + '.')
  add('> **NUNCA edite este ficheiro a mao.** Para mudar a faixa suportada, edite')
  add('> ' + bt + 'dsh-compat.yml' + bt + ' na raiz do repositorio e re-corra o gerador:')
  add('>')
  add('> ' + bt + bt + bt + 'bash')
  add('> node scripts/gen-compat-table.mjs')
  add('> ' + bt + bt + bt)
  add('')
  add('O upstream ' + bt + top.package + bt + ' esta em developer preview (0.x.rc). A politica de suporte e')
  add('**' + top.policy + '**: a linha de release corrente do upstream mais a linha anterior. Mais')
  add('que duas linhas de rc vira matriz insustentavel para um projeto de um mantenedor.')
  add('')
  add('**Faixa global suportada:** ' + bt + top['supported-range'] + bt + '.')
  add('')
  add('A verificacao em runtime e por FORMA do servico (' + bt + 'src/dsh/adapter.ts' + bt + ' confere,')
  add('por exemplo, ' + bt + 'typeof ctx.webServer?.registerFallback === "function"' + bt + '), nao por')
  add('string de versao: o upstream renomeia servico sem bumpar major (esta em 0.x). Se faltar um')
  add('simbolo, o plugin falha no carregamento com mensagem que nomeia o simbolo ausente e a faixa')
  add('testada. Os tipos ' + bt + 'types/' + bt + ' sao regenerados byte-exact dos tarballs npm pinnedos e o')
  add('contrato roda em ' + bt + 'test:contract' + bt + '.')
  add('')
  return out
}

function renderTable(rows) {
  const out = []
  out.push('| Versao do plugin | Faixa de rc do DSH | Status | Rotulo |')
  out.push('| --- | --- | --- | --- |')
  for (const row of rows) {
    const color = row.status === 'supported' ? ':white_check_mark:' : row.status === 'deprecated' ? ':warning:' : ':no_entry_sign:'
    out.push('| ' + (row.plugin || '--') + ' | ' + row.version + ' | ' + color + ' ' + row.status + ' | ' + row.label + ' |')
  }
  out.push('')
  out.push('### Notas por linha')
  out.push('')
  for (const row of rows) {
    const note = row.note ? row.note.replace(/\n/g, ' ') : ''
    out.push('- **' + row.label + '** (' + row.version + ') - ' + row.status + '. ' + note)
  }
  return out
}

function main() {
  let text
  try { text = readFileSync(INPUT, 'utf8') } catch (e) { console.error('gen-compat-table: nao consegui ler ' + INPUT + ': ' + e.message); process.exit(1) }
  let data
  try { data = parseCompatYaml(text); validate(data) }
  catch (err) { console.error('gen-compat-table: dsh-compat.yml invalido: ' + err.message); process.exit(1) }
  const out = renderLines(data.top).concat(renderTable(data.rows))
  out.push('')
  out.push('---')
  out.push('')
  out.push('_Gerado por scripts/gen-compat-table.mjs. Nao editar a mao._')
  out.push('')
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, out.join('\n'))
  console.log('docs/COMPATIBILITY.md regenerado (' + data.rows.length + ' linhas de compatibilidade).')
}

main()
