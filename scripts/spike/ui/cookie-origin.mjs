/**
 * T0.4 / S10 — origem HTTP de teste (porta dedicada, NUNCA a do harness real).
 *
 * Emite quatro cookies numa unica resposta e mede, na requisicao SEGUINTE,
 * quais deles o navegador REENVIA no header `Cookie`. Como `HttpOnly` torna
 * `document.cookie` cego por construcao, o reenvio do header e a unica medida
 * que interessa — e e exactamente a que o painel depende.
 *
 * As quatro celulas separam as duas perguntas que costumam ser confundidas:
 *   host_secure   `__Host-dsh_sid`  Secure  -> a celula sob teste (D5 / T2.2)
 *   secure_only   `dsh_secure`      Secure  -> isola "Secure sobre http"
 *   host_nosecure `__Host-dsh_bad`  sem Secure -> deve ser RECUSADO (o prefixo
 *                                    `__Host-` exige Secure); se voltar, o
 *                                    navegador nao esta a aplicar o prefixo e
 *                                    a medida das outras celulas nao vale
 *   plain         `dsh_plain`       sem nada -> controlo de "ha cookies de todo"
 *
 * Uso: node scripts/spike/ui/cookie-origin.mjs [--host 127.0.0.1] [--port 0]
 *      [--out resultado.json]
 * Imprime `LISTENING <origem>` no arranque e o JSON do resultado no fim.
 */
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const host = flag('host', '127.0.0.1')
const port = Number(flag('port', '0'))
const outFile = flag('out', undefined)

/** As quatro celulas do desenho, na ordem em que sao emitidas. */
const CELLS = [
  { id: 'host_secure', header: '__Host-dsh_sid=S10-host-secure; Secure; HttpOnly; Path=/; SameSite=Strict' },
  { id: 'secure_only', header: 'dsh_secure=S10-secure-only; Secure; HttpOnly; Path=/; SameSite=Strict' },
  { id: 'host_nosecure', header: '__Host-dsh_bad=S10-host-nosecure; HttpOnly; Path=/; SameSite=Strict' },
  { id: 'plain', header: 'dsh_plain=S10-plain; HttpOnly; Path=/; SameSite=Strict' },
]
const NAMES = { host_secure: '__Host-dsh_sid', secure_only: 'dsh_secure', host_nosecure: '__Host-dsh_bad', plain: 'dsh_plain' }

/** Quais celulas voltaram no header `Cookie` desta requisicao. */
function observe(cookieHeader) {
  const jar = (cookieHeader ?? '').split(';').map((part) => part.trim().split('=')[0])
  return Object.fromEntries(CELLS.map((cell) => [cell.id, jar.includes(NAMES[cell.id])]))
}

const observations = []
let resolveDone
const done = new Promise((resolve) => { resolveDone = resolve })

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`)
  if (url.pathname === '/step1') {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'set-cookie': CELLS.map((cell) => cell.header),
    })
    // Navegacao sem depender de JS, mais uma sub-requisicao same-site.
    res.end('<!doctype html><meta http-equiv="refresh" content="0; url=/step2">'
      + '<img src="/step-subresource" alt="">'
      + '<script>location.replace("/step2")</script>')
    return
  }
  if (url.pathname === '/step2' || url.pathname === '/step-subresource') {
    observations.push({
      kind: url.pathname === '/step2' ? 'navegacao' : 'sub-recurso',
      rawCookieHeader: req.headers.cookie ?? null,
      resent: observe(req.headers.cookie),
    })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end('<!doctype html><title>S10 done</title>medido')
    if (observations.some((o) => o.kind === 'navegacao')) setTimeout(() => { resolveDone() }, 700)
    return
  }
  res.writeHead(404)
  res.end()
})

await new Promise((resolve) => { server.listen(port, host, resolve) })
const origin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`
console.log(`LISTENING ${origin}`)

const timeoutMs = Number(flag('timeout', '30000'))
const timer = setTimeout(() => { resolveDone() }, timeoutMs)
await done
clearTimeout(timer)

const result = {
  origin,
  setCookieEmitido: CELLS.map((cell) => `Set-Cookie: ${cell.header}`),
  observacoes: observations,
  veredito: observations.length === 0
    ? 'SEM MEDICAO: o navegador nao voltou a esta origem'
    : {
        host_secure_reenviado: observations.some((o) => o.resent.host_secure),
        secure_only_reenviado: observations.some((o) => o.resent.secure_only),
        host_nosecure_reenviado: observations.some((o) => o.resent.host_nosecure),
        plain_reenviado: observations.some((o) => o.resent.plain),
      },
}
console.log(JSON.stringify(result, null, 2))
if (outFile !== undefined) await writeFile(outFile, JSON.stringify(result, null, 2))
server.close()
process.exit(0)
