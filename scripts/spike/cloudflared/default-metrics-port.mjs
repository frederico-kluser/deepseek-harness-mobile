#!/usr/bin/env node
// Mede a porta de metricas quando --metrics NAO e passado.
//
// O plano afirma que o default e porta aleatoria e que a faixa 20241-20245 da
// documentacao nao e confiavel. Este script sobe o cloudflared duas vezes SEM
// --metrics, contra a origem propria do spike, e le a porta escolhida no stderr.
// Guarda de exposicao: a origem e sempre criada por este processo.
import { startOrigin } from './origin.mjs'
import { targetPortOfOwnServer } from './lib/guard.mjs'
import { killGroup, waitClose } from './lib/tunnel.mjs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const BIN = path.join(os.homedir(), '.local/bin/cloudflared')
const RE = /Starting metrics server on ([0-9.]+:\d+)\/metrics/
// --occupy: ocupa 20241-20245 antes de subir, para observar o fallback do default.
const OCCUPY = process.argv.includes('--occupy')
const squatters = []
if (OCCUPY) {
  for (const p of [20241, 20242, 20243, 20244, 20245]) {
    const srv = net.createServer()
    await new Promise((resolve) => {
      srv.once('error', (err) => {
        console.log(`nao consegui ocupar ${p}: ${err.code}`)
        resolve()
      })
      srv.listen(p, '127.0.0.1', () => {
        squatters.push(srv)
        resolve()
      })
    })
  }
  console.log(`portas ocupadas por este processo: ${JSON.stringify(squatters.map((s) => s.address().port))}`)
}

for (let run = 1; run <= 2; run += 1) {
  const origin = await startOrigin({})
  const originPort = targetPortOfOwnServer(origin.server)
  const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${originPort}`]
  const child = spawn(BIN, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const state = { startedAt: performance.now(), closed: null, stdout: { bytes: 0 } }
  let stderr = ''
  let stdoutBytes = 0
  child.stdout.on('data', (c) => {
    stdoutBytes += c.length
  })
  child.stderr.on('data', (c) => {
    stderr += c.toString('utf8')
  })
  child.on('error', (err) => console.log(`run ${run}: erro de spawn ${err.code}: ${err.message}`))
  child.on('close', () => {
    state.closed = true
  })

  const t0 = performance.now()
  while (!RE.test(stderr) && performance.now() - t0 < 30000 && state.closed === null) {
    await new Promise((r) => setTimeout(r, 200))
  }
  const hit = RE.exec(stderr)
  console.log(`run ${run}: argv=${JSON.stringify([BIN, ...args])}`)
  console.log(`run ${run}: linha bruta = ${JSON.stringify(stderr.split('\n').find((l) => RE.test(l)) ?? null)}`)
  console.log(`run ${run}: endereco de metricas escolhido = ${hit ? hit[1] : 'NAO OBSERVADO'}`)
  console.log(`run ${run}: porta na faixa 20241-20245? ${hit ? Number(hit[1].split(':')[1]) >= 20241 && Number(hit[1].split(':')[1]) <= 20245 : 'n/a'}`)
  console.log(`run ${run}: bytes em stdout = ${stdoutBytes}`)
  killGroup(child, state, 'SIGTERM')
  await waitClose(child, state, 20000)
  await origin.close()
}
for (const s of squatters) s.close()
