// Sondagem HTTP com diagnostico util: `fetch` engole a causa real dentro de
// `TypeError: fetch failed`, e um relatorio de spike que so diz "fetch failed"
// nao mede nada. Aqui a cadeia de `cause` e desenrolada e o DNS e consultado
// separadamente, porque a falha mais comum de um quick tunnel recem-criado e
// resolucao de nome, nao HTTP.
import dnsPromises from 'node:dns/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Desenrola err.cause ate o fim e devolve algo legivel. */
export function describeErr(err) {
  const chain = []
  let cur = err
  let guard = 0
  while (cur && guard < 6) {
    chain.push({ name: cur.name ?? null, message: cur.message ?? String(cur), code: cur.code ?? null, errno: cur.errno ?? null })
    cur = cur.cause
    guard += 1
  }
  return chain
}

/** Resolve o hostname sem cache do processo, reportando o erro exato. */
export async function resolveHost(hostname) {
  const result = { hostname, lookup: null, resolve4: null, resolve6: null }
  try {
    result.lookup = await dnsPromises.lookup(hostname, { all: true })
  } catch (err) {
    result.lookup = { error: err.code ?? err.message }
  }
  try {
    result.resolve4 = await dnsPromises.resolve4(hostname)
  } catch (err) {
    result.resolve4 = { error: err.code ?? err.message }
  }
  try {
    result.resolve6 = await dnsPromises.resolve6(hostname)
  } catch (err) {
    result.resolve6 = { error: err.code ?? err.message }
  }
  return result
}

/** GET com fetch, sem lancar, com a causa desenrolada. */
export async function getWithDiagnostics(url, { headers = {}, timeoutMs = 20000 } = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    const body = await res.text()
    return {
      ok: true,
      url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      bodyBytes: body.length,
      body,
    }
  } catch (err) {
    return { ok: false, url, errorChain: describeErr(err) }
  }
}

/**
 * Cruzamento com `curl` (ferramenta de sistema, nao dependencia npm). Serve de
 * segunda testemunha: se `fetch` e `curl` divergirem, o problema esta no cliente.
 */
export async function curlProbe(url, headerPairs = [], timeoutSec = 20) {
  const args = ['-sS', '-i', '-m', String(timeoutSec)]
  for (const [k, v] of headerPairs) args.push('-H', `${k}: ${v}`)
  args.push(url)
  try {
    const { stdout, stderr } = await execFileAsync('curl', args, { maxBuffer: 4 * 1024 * 1024 })
    return { ok: true, command: `curl ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`, stdout, stderr }
  } catch (err) {
    return {
      ok: false,
      command: `curl ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`,
      code: err.code ?? null,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message,
    }
  }
}

/**
 * Resolucao por DNS-over-HTTPS no resolvedor publico da Cloudflare. Existe para
 * separar duas hipoteses que um ENOTFOUND local nao separa: "o resolvedor desta
 * maquina nao ve o registo" e "o registo nao existe em lado nenhum".
 * Formato de resposta documentado em https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/
 */
export async function resolveViaDoh(hostname, type = 'A') {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`
  try {
    const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) })
    const json = await res.json()
    return { ok: true, httpStatus: res.status, rcode: json.Status, answer: json.Answer ?? null, authority: json.Authority ?? null }
  } catch (err) {
    return { ok: false, errorChain: describeErr(err) }
  }
}
