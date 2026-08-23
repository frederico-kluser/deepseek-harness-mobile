/**
 * `worker/lib/log.ts` — INVARIANTE S2.
 *
 * «O worker escreve EXCLUSIVAMENTE JSONL em `stdout`. TODO log humano vai para
 * `stderr`.» (`src/contracts/ipc.ts` S2). Violada, o parser do pai passa a ver
 * ruido e o modo de falha e SILENCIOSO: o canal parece vivo e as mensagens
 * somem. E por isso que ha um teste que le o CODIGO-FONTE de `worker/` a
 * procura de escritas em `stdout` — a unica forma de apanhar a violacao no
 * ficheiro que ainda nao existe.
 *
 * ONDA 5a: este ficheiro testa o LOGGER NEUTRO que permanece
 * (`worker/lib/log.ts` nao e legado). Vivia em `test/unit/worker/lib/` (diretoria
 * de testes orfaos apagada); foi RE-HOMED para `test/unit/worker/lib-infra/`.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import { createWorkerLogger, LOG_LEVELS } from '../../../../worker/lib/log.ts'
import { FakeTime, TOKEN_DE_TESTE } from '../bot-apoio.ts'

function bancada(level?: 'debug' | 'info' | 'warn' | 'error') {
  const linhas: string[] = []
  const time = new FakeTime(1_800_000_000_000)
  const logger = createWorkerLogger({
    sink: (line) => linhas.push(line),
    clock: time,
    secrets: () => [TOKEN_DE_TESTE],
    ...(level === undefined ? {} : { level }),
  })
  return { linhas, logger, time }
}

describe('worker/lib/log', () => {
  it('uma linha por chamada, sempre terminada em \\n', () => {
    const b = bancada()
    b.logger.info('primeira')
    b.logger.warn('segunda')
    assert.equal(b.linhas.length, 2)
    for (const linha of b.linhas) {
      assert.ok(linha.endsWith('\n'), 'sem \\n duas escritas colam-se e inventam uma linha')
      assert.equal(linha.slice(0, -1).includes('\n'), false, 'e uma so linha por chamada')
    }
  })

  it('carimba a hora do relogio INJETADO, e o nivel em maiusculas', () => {
    const b = bancada()
    b.logger.error('rebentou')
    assert.match(b.linhas[0] ?? '', /^2027-01-15T\d\d:\d\d:\d\d\.\d\d\dZ ERROR /u)
  })

  it('mascara o segredo na mensagem E nos campos', () => {
    const b = bancada()
    b.logger.error(`falhou com ${TOKEN_DE_TESTE}`, { url: `https://x/bot${TOKEN_DE_TESTE}/getMe` })
    const tudo = b.linhas.join('')
    assert.equal(tudo.includes(TOKEN_DE_TESTE), false)
    assert.match(tudo, /REDACTED/u)
  })

  it('o nivel filtra: `warn` nao deixa passar `info` nem `debug`', () => {
    const b = bancada('warn')
    b.logger.debug('x')
    b.logger.info('y')
    b.logger.warn('z')
    assert.equal(b.linhas.length, 1)
    assert.match(b.linhas[0] ?? '', /WARN \[.+\] z/u)
  })

  it('campos `undefined` nao viram ruido', () => {
    const b = bancada()
    b.logger.info('m', { a: 1, b: undefined })
    assert.match(b.linhas[0] ?? '', / a=1\n$/u)
  })

  it('os niveis estao ordenados do mais barulhento ao mais grave', () => {
    assert.deepEqual([...LOG_LEVELS], ['debug', 'info', 'warn', 'error'])
  })
})

/** Todos os `.ts` de `worker/`, recursivamente. */
function fontes(dir: string): string[] {
  const saida: string[] = []
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada)
    if (statSync(caminho).isDirectory()) saida.push(...fontes(caminho))
    else if (entrada.endsWith('.ts') && !entrada.endsWith('.d.ts')) saida.push(caminho)
  }
  return saida
}

describe('S2 — nada em worker/ escreve no stdout', () => {
  it('nem `process.stdout`, nem `console.log`, nem `console.info`', () => {
    const raiz = fileURLToPath(new URL('../../../../worker', import.meta.url))
    const proibido = /process\s*\.\s*stdout|console\s*\.\s*(?:log|info|dir|table)\s*\(/u
    const infratores: string[] = []

    for (const ficheiro of fontes(raiz)) {
      const conteudo = readFileSync(ficheiro, 'utf8')
      // Comentarios contam a historia da regra e citam os nomes; tira-se o que
      // e comentario antes de procurar, senao o proprio aviso reprova o teste.
      const semComentarios = conteudo
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '')
      if (proibido.test(semComentarios)) infratores.push(ficheiro)
    }

    assert.deepEqual(
      infratores,
      [],
      'stdout do worker e EXCLUSIVAMENTE JSONL (S2); log humano vai para stderr',
    )
  })

  it('o sink por omissao e o stderr — verificado sem escrever nada', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('../../../../worker/lib/log.ts', import.meta.url)),
      'utf8',
    )
    assert.match(fonte, /process\.stderr\.write/u)
  })
})