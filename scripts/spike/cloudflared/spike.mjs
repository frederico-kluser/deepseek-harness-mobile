#!/usr/bin/env node
// T0.2 — medicao em campo do cloudflared quick tunnel.
//
// SEGURANCA: este script SO tuneliza a origem que ele mesmo abre, numa porta alta
// atribuida pelo SO. A porta 3080 (DeepSeek Harness real do usuario) esta em
// blocklist dura em lib/guard.mjs; qualquer tentativa de aponta-la aborta o run.
//
// Uso: node scripts/spike/cloudflared/spike.mjs [--bin PATH] [--origin-port N]
//                                               [--warmup-ms N] [--skip-s2s3]
//
// Cobre: (a) GET /quicktunnel com --metrics fixado; (b) stdout vs stderr;
// (c) S2 headers de identidade do cliente; (d) S3 WebSocket bidirecional;
// (e) SIGTERM e residuo; (f) checksum do binario.
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startOrigin } from './origin.mjs'
import { ExposureGuardError, isPortFree, reserveFreePort, targetPortOfOwnServer } from './lib/guard.mjs'
import { killGroup, pollQuickTunnel, probeMetrics, spawnQuickTunnel, waitClose } from './lib/tunnel.mjs'
import { runBidirectionalWs } from './lib/s3-websocket.mjs'
import { curlProbe, getWithDiagnostics, resolveHost, resolveViaDoh } from './lib/http-probe.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : fallback
}
const BIN = flag('--bin', path.join(os.homedir(), '.local/bin/cloudflared'))
const FORCED_ORIGIN_PORT = flag('--origin-port', null)
const WARMUP_MS = Number(flag('--warmup-ms', '120000'))

const say = (line = '') => console.log(line)
/** Servidor real, deliberadamente sem `listen()`, para o auto-teste da guarda. */
const createUnlistenedServer = () => net.createServer()
const section = (title) => {
  say('')
  say(`===== ${title} =====`)
}
const dump = (label, value) => say(`${label}: ${JSON.stringify(value, null, 2)}`)

async function main() {
  section('0. AMBIENTE E GUARDA DE EXPOSICAO')
  say(`node: ${process.version}`)
  say(`cloudflared bin: ${BIN}`)
  say(`cloudflared --version: ${execFileSync(BIN, ['--version'], { encoding: 'utf8' }).trim()}`)
  say(`sha256(binario local): ${createHash('sha256').update(readFileSync(BIN)).digest('hex')}`)
  say(`porta 3080 (DSH real) ocupada neste instante? ${!(await isPortFree(3080))}`)
  // Auto-teste da allowlist: o alvo de um tunel so pode ser nomeado por um
  // net.Server em escuta deste processo. Numero de porta nao e caminho valido.
  for (const [rotulo, valor] of [
    ['numero de porta cru (3080)', 3080],
    ['numero de porta cru (qualquer)', 8080],
    ['objeto que finge ser servidor', { address: () => ({ port: 3080 }), listening: true }],
    ['servidor real ainda sem listen()', createUnlistenedServer()],
  ]) {
    try {
      targetPortOfOwnServer(valor)
      say(`FALHA DA GUARDA: "${rotulo}" foi aceito como alvo. Abortando.`)
      process.exitCode = 1
      return
    } catch (err) {
      if (!(err instanceof ExposureGuardError)) throw err
      say(`guarda OK — recusou ${rotulo}`)
      say(`  motivo: ${err.message}`)
    }
  }

  section('1. ORIGEM PROPRIA')
  const origin = await startOrigin({ port: FORCED_ORIGIN_PORT ? Number(FORCED_ORIGIN_PORT) : undefined })
  say(`origem propria escutando em http://127.0.0.1:${origin.port}`)
  say(`targetPortOfOwnServer(origin.server) = ${targetPortOfOwnServer(origin.server)} — a porta sai do servidor, nao de um argumento`)
  const metricsPort = await reserveFreePort()
  say(`porta de metricas reservada (FIXADA com --metrics 127.0.0.1:PORT): ${metricsPort}`)

  section('2. SPAWN DO CLOUDFLARED')
  const { child, state, args } = spawnQuickTunnel({ bin: BIN, originServer: origin.server, metricsPort })
  say(`argv: ${JSON.stringify([BIN, ...args])}`)
  say(`pid: ${child.pid}`)

  let publicUrl = null
  let hostname = null
  try {
    section('3. (a) GET /quicktunnel NO METRICS SERVER FIXADO')
    const quick = await pollQuickTunnel({ metricsPort, state, timeoutMs: 45000 })
    dump('polling', {
      ok: quick.ok,
      elapsedMs: quick.elapsedMs ?? null,
      status: quick.status ?? null,
      reason: quick.reason ?? null,
      tentativas: quick.attempts.length,
      primeiras3: quick.attempts.slice(0, 3),
      ultima: quick.attempts.at(-1),
    })
    if (quick.ok) {
      say(`corpo CRU de GET http://127.0.0.1:${metricsPort}/quicktunnel:`)
      say(quick.body)
      const parsed = JSON.parse(quick.body)
      say(`chaves do JSON: ${JSON.stringify(Object.keys(parsed))}`)
      say(`hostname devolvido: ${JSON.stringify(parsed.hostname)}`)
      say(`tem esquema (://)? ${String(parsed.hostname).includes('://')}`)
      hostname = parsed.hostname
      publicUrl = `https://${hostname}`
      say(`URL publica apos prefixar https://: ${publicUrl}`)
    }

    section('3b. ENDPOINTS AUXILIARES DO MESMO METRICS SERVER')
    for (const p of ['/ready', '/healthcheck', '/', '/metrics']) {
      const r = await probeMetrics(metricsPort, p)
      const body = r.ok ? (p === '/metrics' ? `${r.body.length} bytes` : r.body.trim().slice(0, 400)) : r.error
      say(`GET ${p} -> status=${r.status ?? 'n/a'} body=${JSON.stringify(body)}`)
    }

    section('4. (b) STDOUT vs STDERR')
    say(`bytes em stdout: ${state.stdout.bytes}`)
    say(`bytes em stderr: ${state.stderr.bytes}`)
    say('stdout capturado (cru, entre marcadores):')
    say('<<<STDOUT')
    say(state.stdout.text)
    say('STDOUT>>>')
    say(`URL achada por regex em stderr: ${JSON.stringify(state.stderrUrl)}`)
    say(`tempo ate a URL aparecer em stderr: ${state.stderrUrlMs === null ? 'n/a' : `${Math.round(state.stderrUrlMs)} ms`}`)
    say('stderr capturado ate aqui (cru, entre marcadores):')
    say('<<<STDERR')
    say(state.stderr.text)
    say('STDERR>>>')

    if (publicUrl === null) {
      say('SEM URL PUBLICA — S2 e S3 nao podem ser medidos neste run.')
      return
    }

    section('5. WARMUP DA BORDA (DNS + primeiro 200)')
    let myIp = null
    try {
      const trace = await fetch('https://cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(10000) })
      myIp = /(^|\n)ip=([^\n]+)/.exec(await trace.text())?.[2] ?? null
    } catch (err) {
      say(`nao consegui obter o IP publico desta maquina: ${err.message}`)
    }
    say(`IP publico desta maquina (https://cloudflare.com/cdn-cgi/trace): ${myIp}`)
    // FASE 1 — publicacao do registo DNS, medida SO por DNS-over-HTTPS.
    // O resolvedor do SO nao pode ser consultado antes disto: /quicktunnel devolve
    // o hostname ANTES de o registo existir, e uma consulta precoce faz o
    // resolvedor local cachear o NXDOMAIN pelo TTL negativo da zona — medido:
    // 7 minutos de ENOTFOUND local com o registo ja vivo no autoritativo.
    const pub = await waitForDnsPublication(hostname, 120000)
    dump('FASE 1 — publicacao do registo DNS (so DoH, o SO nao foi consultado)', pub)
    if (!pub.publicado) {
      say('O REGISTO DNS NAO FOI PUBLICADO NO ORCAMENTO — S2/S3 nao medidos neste run.')
      return
    }
    // FASE 2 — so agora o resolvedor do SO e usado.
    const warm = await warmup(publicUrl, hostname, WARMUP_MS)
    dump('FASE 2 — warmup HTTP (resolvedor do SO ja pode ser usado)', warm)
    if (!warm.pronto) {
      say('BORDA NAO FICOU ALCANCAVEL NESTE RUN — ver cadeia de erro acima.')
    }

    section('6. (c) S2 — QUE IDENTIDADE DE CLIENTE CHEGA A ORIGEM')
    // Cada caso isola UM header. Testar varios de uma vez so diz "algo foi
    // recusado"; nao diz qual, e a decisao de T2.3 depende exatamente disso.
    const cases = [
      { nome: 'R1-controle-sem-forja', headers: {} },
      { nome: 'R2-so-X-Forwarded-For', headers: { 'X-Forwarded-For': '1.2.3.4' } },
      { nome: 'R3-so-CF-Connecting-IP', headers: { 'CF-Connecting-IP': '1.2.3.4' } },
      { nome: 'R4-so-True-Client-IP', headers: { 'True-Client-IP': '1.2.3.4' } },
      { nome: 'R5-so-X-Real-IP', headers: { 'X-Real-IP': '1.2.3.4' } },
      { nome: 'R6-XFF-cadeia-multipla', headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' } },
      { nome: 'R7-so-CF-IPCountry', headers: { 'CF-IPCountry': 'XX' } },
      { nome: 'R8-so-CDN-Loop', headers: { 'CDN-Loop': 'forjado; loops=99' } },
      { nome: 'R9-so-CF-Ray', headers: { 'CF-Ray': '0000000000000000-XXX' } },
      { nome: 'R10-so-X-Forwarded-Proto', headers: { 'X-Forwarded-Proto': 'http' } },
      {
        nome: 'R11-tudo-junto',
        headers: {
          'X-Forwarded-For': '203.0.113.9, 198.51.100.7',
          'CF-Connecting-IP': '203.0.113.9',
          'True-Client-IP': '203.0.113.9',
          'X-Real-IP': '203.0.113.9',
        },
      },
    ]
    for (const c of cases) {
      say('')
      say(`--- caso ${c.nome} ---`)
      say(`headers enviados de FORA: ${JSON.stringify(c.headers)}`)
      const before = origin.events.length
      const res = await getWithDiagnostics(`${publicUrl}/s2`, { headers: c.headers })
      say(`resposta na ponta do cliente: ${JSON.stringify({ ok: res.ok, status: res.status ?? null, errorChain: res.errorChain ?? null })}`)
      const seen = origin.events.slice(before).filter((e) => e.kind === 'http')
      if (seen.length === 0) say('NENHUM evento chegou a origem para este caso (a borda barrou antes).')
      for (const e of seen) {
        say('LOG CRU DA ORIGEM (rawHeaders preserva ordem e duplicatas):')
        say(JSON.stringify(e.rawHeaders))
        const pares = []
        for (let i = 0; i < e.rawHeaders.length; i += 2) {
          if (/^(x-forwarded-for|cf-connecting-ip|true-client-ip|x-real-ip|cf-ipcountry|cdn-loop|cf-ray|x-forwarded-proto)$/i.test(e.rawHeaders[i])) {
            pares.push(`${e.rawHeaders[i]}: ${e.rawHeaders[i + 1]}`)
          }
        }
        say(`headers de identidade que chegaram: ${JSON.stringify(pares)}`)
      }
    }

    say('')
    say('--- cruzamento com curl (segunda testemunha, mesma forja) ---')
    const before = origin.events.length
    const cp = await curlProbe(`${publicUrl}/s2-curl`, [
      ['X-Forwarded-For', '1.2.3.4'],
      ['CF-Connecting-IP', '1.2.3.4'],
    ])
    say(`comando: ${cp.command}`)
    say(`stdout do curl:\n${cp.stdout}`)
    if (cp.stderr) say(`stderr do curl:\n${cp.stderr}`)
    for (const e of origin.events.slice(before).filter((e) => e.kind === 'http')) {
      say('LOG CRU DA ORIGEM (caso curl):')
      say(JSON.stringify(e, null, 2))
    }

    section('7. (d) S3 — WEBSOCKET ATRAVES DO TUNEL, NOS DOIS SENTIDOS')
    const wsUrl = `${publicUrl.replace(/^https:/, 'wss:')}/ws`
    say(`conectando em ${wsUrl}`)
    const s3 = await runBidirectionalWs(wsUrl)
    dump('resultado S3 (lado cliente)', s3)
    say('eventos WebSocket registrados pela ORIGEM:')
    for (const e of origin.events.filter((x) => String(x.kind).startsWith('ws') || x.kind === 'upgrade')) {
      say(JSON.stringify(e))
    }
  } finally {
    section('8. (e) SIGTERM, ENCERRAMENTO E RESIDUO')
    const kill = killGroup(child, state, 'SIGTERM')
    dump('process.kill(-pid, SIGTERM)', kill)
    const closed = await waitClose(child, state, 40000)
    dump("evento 'close' do filho", closed)
    dump("evento 'exit' do filho", state.exited)
    dump("evento 'error' do filho", state.spawnError)
    say(`bytes em stdout no total: ${state.stdout.bytes}`)
    dump('GET /quicktunnel DEPOIS do SIGTERM', await probeMetrics(metricsPort, '/quicktunnel', 3000))

    if (publicUrl !== null) {
      await new Promise((r) => setTimeout(r, 3000))
      for (let i = 1; i <= 3; i += 1) {
        const r = await getWithDiagnostics(`${publicUrl}/depois-do-sigterm`, { timeoutMs: 15000 })
        say(
          `tentativa ${i} na URL publica apos SIGTERM: ${JSON.stringify({
            ok: r.ok,
            status: r.status ?? null,
            cfRay: r.headers?.['cf-ray'] ?? null,
            trecho: r.body?.slice(0, 160) ?? null,
            errorChain: r.errorChain ?? null,
          })}`,
        )
        await new Promise((r2) => setTimeout(r2, 2000))
      }
    }

    try {
      say(`pgrep -af cloudflared:\n${execFileSync('pgrep', ['-af', 'cloudflared'], { encoding: 'utf8' })}`)
    } catch {
      say('pgrep -af cloudflared: (vazio, exit 1)')
    }
    const cfDir = path.join(os.homedir(), '.cloudflared')
    say(`~/.cloudflared existe? ${existsSync(cfDir)}`)
    if (existsSync(cfDir)) say(`conteudo: ${JSON.stringify(readdirSync(cfDir))}`)
    await origin.close()
    say('origem propria encerrada.')
  }
}

/**
 * Espera o registo DNS do hostname aparecer no resolvedor AUTORITATIVO, medido
 * por DNS-over-HTTPS. Nao toca no resolvedor do SO de proposito: uma consulta
 * antes da publicacao envenena o cache negativo local por todo o TTL negativo
 * da zona, e o tunel fica inalcancavel desta maquina mesmo estando vivo.
 */
async function waitForDnsPublication(hostname, budgetMs) {
  const t0 = performance.now()
  const tries = []
  for (;;) {
    const doh = await resolveViaDoh(hostname)
    const atMs = Math.round(performance.now() - t0)
    tries.push({ atMs, rcode: doh.rcode ?? null, answer: doh.answer ?? null })
    if (doh.ok && doh.rcode === 0 && Array.isArray(doh.answer) && doh.answer.length > 0) {
      return { publicado: true, atMs, ips: doh.answer.map((a) => a.data), ttl: doh.answer[0].TTL, tries }
    }
    if (performance.now() - t0 > budgetMs) return { publicado: false, tries }
    await new Promise((res) => setTimeout(res, 2000))
  }
}

async function warmup(publicUrl, hostname, budgetMs) {
  const t0 = performance.now()
  const tries = []
  for (;;) {
    const dns = await resolveHost(hostname)
    const doh = await resolveViaDoh(hostname)
    const r = await getWithDiagnostics(`${publicUrl}/warmup`, { timeoutMs: 15000 })
    tries.push({
      atMs: Math.round(performance.now() - t0),
      dnsLookup: dns.lookup,
      dnsResolve4: dns.resolve4,
      dohRcode: doh.rcode ?? null,
      dohAnswer: doh.answer ?? null,
      status: r.status ?? null,
      erro: r.errorChain?.at(-1) ?? null,
    })
    if (r.ok && r.status !== 530 && r.status !== 502) return { pronto: true, atMs: Math.round(performance.now() - t0), tries }
    if (performance.now() - t0 > budgetMs) return { pronto: false, tries }
    await new Promise((res) => setTimeout(res, 5000))
  }
}

await main()
