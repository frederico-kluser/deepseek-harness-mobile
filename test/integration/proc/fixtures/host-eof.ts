/**
 * HOST DE MEDICAO do dead-man's switch. Nao e uma suite.
 *
 * Faz o que `src/proc/worker.ts` faz e mais nada: `spawn` do worker com os tres
 * canais em `'pipe'` e `detached: true`. Publica o pid do filho no seu proprio
 * `stdout` e depois fica vivo para sempre — a experiencia e mata-lo com
 * `SIGKILL` e cronometrar o filho.
 *
 * PORQUE `detached: true` NO FILHO: sem isso o filho ficaria no grupo do pai e
 * morreria com ele por caminhos que nada tem a ver com o EOF. Com o proprio
 * grupo, a UNICA coisa que o liga ao pai e o pipe.
 *
 * O `stderr` do filho e ENCAMINHADO para o `stderr` deste processo: e por ai que
 * o teste sabe quando o worker entrou no bloqueio sincrono (modo `bloqueio`).
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(new URL('./worker-eof.ts', import.meta.url))

const child = spawn(process.execPath, [worker], {
  detached: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

child.stderr.on('data', (chunk: Buffer): void => {
  process.stderr.write(chunk)
})
child.stdout.resume()

process.stdout.write(`WORKER=${String(child.pid)}\n`)

setInterval((): void => {}, 3600_000)
