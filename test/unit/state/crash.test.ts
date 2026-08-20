/**
 * PERGUNTA FALSIFICAVEL 1 — "a escrita e atomica DE VERDADE?"
 *
 * O metodo: um processo filho e levado ate ao instante entre o `fsync` e o
 * `rename` e morto com SIGKILL — que nao corre `finally`, nem handler de sinal,
 * nem disposer. Depois le-se o ficheiro. Se a escrita fosse "abrir o destino e
 * escrever por cima", o que sobrava aqui era um `state.json` truncado e o
 * `secretDigest` do dono perdido.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { statePathsAt } from '../../../src/state/paths.ts'
import { createStateStore } from '../../../src/state/store.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'

const ESCRITOR = fileURLToPath(new URL('./crash-writer.ts', import.meta.url))
const DIGEST_ANTIGO = 'a'.repeat(64)
const DIGEST_NOVO = 'c'.repeat(64)

async function esperaFicheiro(caminho: string, limiteMs: number): Promise<void> {
  const fim = Date.now() + limiteMs
  while (Date.now() < fim) {
    if (existsSync(caminho)) return
    await sleep(10)
  }
  throw new Error(`o filho nao chegou ao ponto de rename em ${limiteMs} ms`)
}

describe('SIGKILL entre o fsync e o rename', () => {
  it('deixa o state.json ANTIGO intacto, byte a byte, e o novo completo no temporario', async () => {
    const temp = makeTempStateDir()
    try {
      // Estado inicial, escrito pelo caminho normal.
      const inicial = createStateStore({ paths: statePathsAt(temp.path) })
      inicial.store.update((s) => ({ ...s, desiredState: 'STOPPED', secretDigest: DIGEST_ANTIGO }))
      inicial.dispose()
      const antes = readFileSync(temp.statePath)

      const filho = spawn(process.execPath, [ESCRITOR, temp.path], { stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      filho.stderr.setEncoding('utf8')
      filho.stderr.on('data', (parte: string) => {
        stderr += parte
      })

      try {
        await esperaFicheiro(join(temp.path, 'PARADO-NO-RENAME'), 20_000)
      } catch (error) {
        filho.kill('SIGKILL')
        throw new Error(`${(error as Error).message}\nstderr do filho:\n${stderr}`, { cause: error })
      }

      filho.kill('SIGKILL')
      const [, sinal] = (await once(filho, 'close')) as [number | null, string | null]
      assert.equal(sinal, 'SIGKILL', 'o filho tinha de morrer pelo sinal, nao sair sozinho')

      // 1. O DESTINO NAO FOI TOCADO. Byte a byte.
      assert.deepEqual(readFileSync(temp.statePath), antes)

      // 2. O temporario ficou — NO MESMO DIRETORIO do destino — e ja estava
      //    completo e sincronizado quando o processo morreu.
      const tmps = readdirSync(temp.path).filter((n) => n.startsWith('.state.json.tmp-'))
      assert.equal(tmps.length, 1)
      const conteudoTmp = readFileSync(join(temp.path, tmps[0] as string), 'utf8')
      assert.equal(conteudoTmp.endsWith('}\n'), true, 'o temporario nao esta truncado')
      const novo = JSON.parse(conteudoTmp) as { desiredState: string; secretDigest: string }
      assert.equal(novo.desiredState, 'READY')
      assert.equal(novo.secretDigest, DIGEST_NOVO)

      // 3. O plugin volta a arrancar e ainda ve o estado ANTIGO, inteiro. E
      //    isto que separa "atomico" de "quase": nao ha estado meio escrito.
      const depois = createStateStore({ paths: statePathsAt(temp.path) })
      const lido = depois.store.read()
      depois.dispose()
      assert.equal(lido.desiredState, 'STOPPED')
      assert.equal(lido.secretDigest, DIGEST_ANTIGO)
    } finally {
      temp.cleanup()
    }
  })

  it('e o mesmo vale quando NAO havia ficheiro nenhum: nao nasce um state.json parcial', async () => {
    const temp = makeTempStateDir()
    try {
      assert.equal(existsSync(temp.statePath), false)

      const filho = spawn(process.execPath, [ESCRITOR, temp.path], { stdio: ['ignore', 'ignore', 'ignore'] })
      await esperaFicheiro(join(temp.path, 'PARADO-NO-RENAME'), 20_000)
      filho.kill('SIGKILL')
      await once(filho, 'close')

      // O destino nunca existiu — a escrita nao "comeca" no destino.
      assert.equal(existsSync(temp.statePath), false)

      // E o arranque seguinte e um primeiro arranque legitimo, nao um erro.
      const depois = createStateStore({ paths: statePathsAt(temp.path) })
      assert.deepEqual(depois.store.read(), { version: 1, desiredState: 'STOPPED' })
      depois.dispose()
    } finally {
      temp.cleanup()
    }
  })

  it('um temporario abandonado por um processo morto nao contamina a leitura seguinte', () => {
    const temp = makeTempStateDir()
    try {
      const store = createStateStore({ paths: statePathsAt(temp.path) })
      store.store.update((s) => ({ ...s, desiredState: 'READY' }))
      // Lixo com o prefixo dos temporarios, deixado por um crash anterior.
      writeFileSync(join(temp.path, '.state.json.tmp-morto-000000000000'), '{corrompido', { mode: 0o600 })
      assert.equal(store.store.read().desiredState, 'READY')
      store.store.update((s) => ({ ...s, desiredState: 'STOPPED' }))
      assert.equal(store.store.read().desiredState, 'STOPPED')
      store.dispose()
    } finally {
      temp.cleanup()
    }
  })
})
