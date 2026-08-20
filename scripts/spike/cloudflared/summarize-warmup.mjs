#!/usr/bin/env node
// Rende as tabelas compactas de warmup a partir de um log de `spike.mjs`.
//
// Existe porque o `spike.mjs` despeja o warmup como JSON indentado — legivel por
// maquina, ilegivel num relatorio de 85 tentativas. Este script e a UNICA fonte
// do formato tabular citado em `docs/spikes/cloudflared.md`: sem ele, aquele
// bloco seria o unico do relatorio sem script de origem no repositorio.
//
// Uso: node scripts/spike/cloudflared/summarize-warmup.mjs <log-do-spike.txt>
//
// Aceita os dois formatos de log: o antigo, com um unico rotulo `warmup:` (que
// consultava o resolvedor do SO desde o instante zero), e o atual, com as duas
// fases separadas.
import { readFileSync } from 'node:fs'

const path = process.argv[2]
if (path === undefined) {
  console.error('uso: summarize-warmup.mjs <log-do-spike.txt>')
  process.exit(2)
}
const text = readFileSync(path, 'utf8')

/** Extrai o objeto JSON que começa logo depois de `label`. */
function jsonAfter(label) {
  const at = text.indexOf(label)
  if (at < 0) return null
  const start = text.indexOf('{', at)
  if (start < 0) return null
  let depth = 0
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
  }
  return null
}

const outcome = (v) => (Array.isArray(v) ? 'OK' : (v?.error ?? 'n/a'))

const fase1 = jsonAfter('FASE 1 — publicacao do registo DNS')
if (fase1 !== null) {
  console.log('== FASE 1 — publicacao do registo DNS (so DoH; o resolvedor do SO nao foi consultado)')
  console.log(`   publicado=${fase1.publicado} atMs=${fase1.atMs ?? 'n/a'} ttl=${fase1.ttl ?? 'n/a'} ips=${JSON.stringify(fase1.ips ?? null)}`)
  for (const t of fase1.tries) console.log(`   ${String(t.atMs).padStart(7)} ms  doh_rcode=${t.rcode}  answer=${t.answer === null ? 'null' : t.answer.length}`)
}

for (const label of ['FASE 2 — warmup HTTP', 'warmup: ']) {
  const w = jsonAfter(label)
  if (w === null) continue
  console.log(`== ${label.trim().replace(/:$/, '')}`)
  console.log(`   pronto=${w.pronto} atMs=${w.atMs ?? 'n/a'} tentativas=${w.tries.length}`)
  for (const t of w.tries) {
    const cols = [
      `${String(t.atMs).padStart(7)} ms`,
      `lookup=${String(outcome(t.dnsLookup)).padEnd(9)}`,
      `resolve4=${String(outcome(t.dnsResolve4)).padEnd(9)}`,
      t.dohRcode === undefined ? null : `doh_rcode=${t.dohRcode}`,
      `http_status=${t.status ?? 'null'}`,
      `erro=${t.erro?.code ?? 'null'}`,
    ].filter((c) => c !== null)
    console.log(`   ${cols.join('  ')}`)
  }
  break
}
