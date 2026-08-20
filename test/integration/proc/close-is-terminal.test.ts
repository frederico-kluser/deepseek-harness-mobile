/**
 * SUP-007, SUP-008, SUP-010, SUP-011, SUP-012, SUP-013 — MEDIDOS contra o
 * `node:child_process` real, e nao descritos.
 *
 * PORQUE ESTE FICHEIRO E O MAIS IMPORTANTE DOS TESTES DE PROCESSO: o supervisor
 * inteiro assenta numa afirmacao sobre o Node — *"o unico evento terminal
 * universal e `'close'`; num `ENOENT` a sequencia e `error -> close` e `'exit'`
 * NUNCA dispara"*. Uma afirmacao dessas envelhece: se uma versao futura do Node
 * mudar, o supervisor trava exatamente no modo de falha mais comum e ninguem
 * percebe porque. Estes casos CONGELAM a medicao.
 *
 * Nenhum destes processos e o `cloudflared`. Sao `node -e` de uma linha, criados
 * pelo proprio teste — que e a forma de nao depender de dublê nenhum e de nao
 * publicar coisa nenhuma na Internet.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

const temporarios: string[] = []
after(() => {
  for (const dir of temporarios) rmSync(dir, { recursive: true, force: true })
})

/** Corre um `spawn` ate ao `'close'` e devolve a ORDEM dos eventos observados. */
function observe(
  command: string,
  args: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<{ events: string[]; error: NodeJS.ErrnoException | undefined; code: number | null }> {
  return new Promise((resolve) => {
    const events: string[] = []
    let error: NodeJS.ErrnoException | undefined

    const child = spawn(command, [...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })

    child.on('spawn', () => events.push('spawn'))
    child.on('exit', () => events.push('exit'))
    child.on('error', (err: NodeJS.ErrnoException) => {
      events.push('error')
      error ??= err
    })
    child.on('close', (code) => {
      events.push('close')
      resolve({ events, error, code })
    })
  })
}

describe('SUP-010 / SUP-007: o evento terminal universal e `close`', () => {
  it('SUP-007: ENOENT emite `error` e `close`, e `exit` NUNCA dispara', async () => {
    const inexistente = join(tmpdir(), 'binario-que-nao-existe-dsh-guard')

    const observed = await observe(inexistente, [])

    // >>> A MEDICAO. Um supervisor que espera por `'exit'` fica pendurado AQUI,
    // >>> no modo de falha mais comum de todos (binario ausente / PATH errado).
    assert.deepEqual(observed.events, ['error', 'close'])
    assert.equal(observed.events.includes('exit'), false)
    assert.equal(observed.events.includes('spawn'), false, "`'spawn'` tambem nao dispara")
    assert.equal(observed.error?.code, 'ENOENT')
    // `close` recebe o codigo sintetico -2 (o errno do ENOENT), nao um exit code.
    assert.equal(observed.code, -2)
  })

  it('SUP-008: EACCES (ficheiro existe, sem bit de execucao) segue a MESMA sequencia', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-eacces-'))
    temporarios.push(dir)
    const semExecucao = join(dir, 'sem-x.sh')
    writeFileSync(semExecucao, '#!/bin/sh\necho oi\n')
    chmodSync(semExecucao, 0o600)

    const observed = await observe(semExecucao, [])

    assert.deepEqual(observed.events, ['error', 'close'])
    assert.equal(observed.error?.code, 'EACCES')
  })

  it('sucesso: a sequencia e `spawn -> exit -> close`, e `close` vem SEMPRE por ultimo', async () => {
    const observed = await observe(process.execPath, ['-e', 'process.exit(0)'])

    assert.deepEqual(observed.events, ['spawn', 'exit', 'close'])
    assert.equal(observed.events.at(-1), 'close')
    assert.equal(observed.code, 0)
  })

  it("`'spawn'` NAO e readiness: dispara mesmo quando o programa falha logo a seguir", async () => {
    // A doc do Node e explicita: o evento dispara "regardless of whether an error
    // occurs within the spawned process". Readiness e outra coisa, e por isso o
    // warmup do tunel usa polling do servidor de metricas, nunca o `'spawn'`.
    const observed = await observe(process.execPath, ['-e', 'process.exit(37)'])

    assert.equal(observed.events[0], 'spawn')
    assert.equal(observed.code, 37)
  })
})

describe('SUP-011 / SUP-012 / SUP-013: o que o `AbortSignal` faz, medido', () => {
  it('SUP-011: com o sinal JA abortado, `killed` e `false` no mesmo tick e `true` no seguinte', async () => {
    const controller = new AbortController()
    controller.abort()

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      signal: controller.signal,
    })
    child.on('error', () => {})

    // O Node ADIA o kill para `process.nextTick`. Congelar esta assimetria e o
    // ponto do caso: codigo que leia `killed` logo apos o `spawn` para decidir se
    // ja matou le `false` e conclui o contrario do que e verdade.
    const noMesmoTick = child.killed
    await new Promise<void>((resolve) => process.nextTick(resolve))
    const noTickSeguinte = child.killed

    assert.equal(noMesmoTick, false, 'no MESMO tick ainda nao foi morto')
    assert.equal(noTickSeguinte, true, 'no tick SEGUINTE ja foi')

    await new Promise<void>((resolve) => child.on('close', () => resolve()))
  })

  it('SUP-012: `AbortError` so e emitido se `child.kill()` devolver `true`', async () => {
    const controller = new AbortController()

    // Processo que ja SAIU antes do abort: `kill()` devolve `false` e nao ha
    // `AbortError` nenhum. Codigo que dependa de receber sempre um fica a espera.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      signal: controller.signal,
    })
    const errosDepoisDeSair: string[] = []
    child.on('error', (error: Error) => errosDepoisDeSair.push(error.name))

    await new Promise<void>((resolve) => child.on('close', () => resolve()))
    const killDepoisDeSair = child.kill()
    controller.abort()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))

    assert.equal(killDepoisDeSair, false, 'o processo ja saiu: kill() nao entrega nada')
    assert.deepEqual(errosDepoisDeSair, [], 'e por isso NAO ha AbortError')
  })

  it('SUP-013: `err.cause` do `AbortError` e o `reason` passado a `abort(reason)`', async () => {
    const controller = new AbortController()
    const razao = new Error('o dono mandou desligar');

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      signal: controller.signal,
    })

    const erro = await new Promise<Error>((resolve) => {
      child.on('error', resolve)
      child.on('spawn', () => controller.abort(razao))
    })

    assert.equal(erro.name, 'AbortError')
    // A causa transita: e o que permite ao supervisor distinguir "morreu sozinho"
    // de "nos matamo-lo", e POR QUE razao o matamos.
    assert.equal((erro as Error & { cause?: unknown }).cause, razao)

    await new Promise<void>((resolve) => child.on('close', () => resolve()))
  })
})
