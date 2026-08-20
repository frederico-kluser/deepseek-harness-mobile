#!/usr/bin/env node
/**
 * Duble do `cloudflared`. PREP-OWNED: leitura livre, escrita proibida (PREP 2).
 *
 * PORQUE UM DUBLE E NAO O BINARIO REAL (`09-DECISOES-CANONICAS.md` D10):
 * `cloudflared --url http://localhost:PORTA` PUBLICA NA INTERNET, sem
 * perguntar, o que estiver naquela porta. Durante a pesquisa que originou este
 * plano isso expos o DSH real do utilizador por ~40 segundos. Um tunel real
 * dentro do gate de PR repetiria o incidente a cada commit. O tunel REAL so e
 * exercitado por `test/live/**` (opt-in, `workflow_dispatch`) e pelo roteiro
 * manual M2.
 *
 * O QUE ESTE DUBLE REPRODUZ, medido em campo na Onda 0 (T0.2):
 *   - a URL sai por DOIS caminhos complementares, nao primario/reserva:
 *       (a) `GET /quicktunnel` no metrics server -> {"hostname":"..."} SEM
 *           esquema (o consumidor tem de prefixar `https://`);
 *       (b) regex sobre STDERR. Medido: stdout fica com 0 bytes em 6 execucoes,
 *           e num run o stderr chegou ANTES do endpoint (7826 ms vs 8031 ms).
 *   - `--metrics 127.0.0.1:PORT` e obrigatorio: o default NAO e aleatorio,
 *     pega 20241 e so cai em porta efemera quando a faixa esta ocupada — a
 *     porta e DISPUTADA, e um segundo cloudflared desloca-a em silencio.
 *   - `/ready` -> {"status":...,"readyConnections":N,...} (503 enquanto N=0);
 *     `/healthcheck` -> OK; `/` -> 404.
 *   - SIGTERM: encerra em ~13 ms, exit 0, sem ESRCH.
 *
 * O QUE ESTE DUBLE NAO SIMULA, de proposito: a JANELA DNS. Medido: o
 * `/quicktunnel` devolve o hostname ANTES de o registo DNS existir, e uma
 * consulta cedo demais ENVENENA o cache negativo do resolvedor LOCAL (piso
 * observado de 7 min, teto de 30 min pelo SOA da zona). Por isso
 * `STARTING -> READY` NAO pode ser "o /quicktunnel respondeu". Isso e logica do
 * consumidor (T3.2), nao do duble.
 */
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const metricsArg = args[args.indexOf('--metrics') + 1] ?? '127.0.0.1:0'
const [metricsHost, metricsPortRaw] = metricsArg.split(':')
const hostname = process.env.FAKE_CF_HOSTNAME ?? 'exemplo-duble-do-tunel.trycloudflare.com'
const urlDelayMs = Number(process.env.FAKE_CF_URL_DELAY_MS ?? '0')
const readyAfterMs = Number(process.env.FAKE_CF_READY_AFTER_MS ?? '0')

let readyConnections = 0
setTimeout(() => { readyConnections = 4 }, readyAfterMs)

const metrics = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/quicktunnel') {
    // O endpoint real devolve o hostname SEM esquema. Prefixar e do consumidor.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hostname }))
    return
  }
  if (path === '/ready') {
    const code = readyConnections > 0 ? 200 : 503
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: code, readyConnections, connectorId: 'duble-0000' }))
    return
  }
  if (path === '/healthcheck') { res.writeHead(200); res.end('OK'); return }
  res.writeHead(404); res.end('404 page not found')
})

metrics.listen(Number(metricsPortRaw), metricsHost, () => {
  const porta = metrics.address().port
  // STDERR, nunca stdout: medido, o cloudflared real deixa stdout com 0 bytes.
  process.stderr.write(`INF Version 2026.7.3 (Checksum duble)\n`)
  process.stderr.write(`INF Metrics server listening on ${metricsHost}:${porta}\n`)
  setTimeout(() => {
    process.stderr.write(`INF +--------------------------------------------+\n`)
    process.stderr.write(`INF |  https://${hostname}  |\n`)
    process.stderr.write(`INF +--------------------------------------------+\n`)
  }, urlDelayMs)
})

const encerrar = () => { metrics.close(() => process.exit(0)) }
process.on('SIGTERM', encerrar)
process.on('SIGINT', encerrar)
