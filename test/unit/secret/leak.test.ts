/**
 * HIGIENE do modulo `src/secret/**` -- as perguntas 1 e 5 de T2.1, e os
 * criterios de aceite 4 e 7, como TESTE e nao como promessa.
 *
 * Um comentario a dizer "nunca logamos o segredo" envelhece mal: basta um
 * `console.log` de depuracao esquecido num merge. Estas asercoes correm em toda
 * a suite e falham no minuto em que isso acontecer.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { createSecretStore } from '../../../src/secret/store.ts'
import { canonicalizeSecret } from '../../../src/secret/canonical.ts'
import { createOneTimeTokenStore } from '../../../src/secret/ott.ts'
import { FakeClock } from '../../support/clock.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'
import { createFileStateStore } from './state-store-double.ts'

const SECRET_DIR = join(import.meta.dirname, '../../../src/secret')
/** Cada fonte com o texto integral e o CODIGO (sem comentarios) a parte: uma
 *  asercao sobre "o modulo nao faz X" tem de olhar para o que ele executa, nao
 *  para o que ele explica -- os comentarios aqui falam de `node:fs` e do logger
 *  precisamente para dizer que nao os usam. */
const SOURCES = readdirSync(SECRET_DIR)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => {
    const text = readFileSync(join(SECRET_DIR, name), 'utf8')
    const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')
    return { name, text, code }
  })

describe('src/secret/** -- higiene do modulo', () => {
  it('tem exatamente os ficheiros do layout canonico', () => {
    assert.deepEqual(
      SOURCES.map((f) => f.name).toSorted(),
      ['canonical.ts', 'generate.ts', 'ott.ts', 'qr.ts', 'store.ts', 'verify.ts'],
    )
  })

  it('criterio 7: nenhum ficheiro passa das 400 linhas', () => {
    for (const { name, text } of SOURCES) {
      const lines = text.split('\n').length
      assert.ok(lines <= 400, `${name} tem ${lines} linhas`)
    }
  })

  it('criterio 4: so importa contratos, marca e erros de fora do modulo', () => {
    const permitido = /^\.\.\/(contracts\/[a-z-]+\.ts|brand\.ts|errors\.ts)$/u
    for (const { name, text } of SOURCES) {
      for (const match of text.matchAll(/from '(\.\.\/[^']+)'/gu)) {
        assert.match(match[1]!, permitido, `${name} importa ${match[1]}`)
      }
    }
  })

  it('P5: nao ha caminho que escreva o segredo -- nem em `debug`', () => {
    for (const { name, code } of SOURCES) {
      for (const proibido of ['console.', 'process.stdout', 'process.stderr', 'logger', 'debug(']) {
        assert.ok(!code.includes(proibido), `${name} contem ${proibido}`)
      }
    }
  })

  it('nao toca no disco: a persistencia e do StateStore de T2.5', () => {
    for (const { name, code } of SOURCES) {
      assert.ok(!code.includes('node:fs'), `${name} importa node:fs`)
      assert.ok(!code.includes('node:path'), `${name} resolve caminhos`)
      assert.ok(!code.includes('writeFile'), `${name} escreve ficheiro`)
    }
  })

  it('P1: nao ha estado mutavel de modulo onde o segredo pudesse ficar', () => {
    for (const { name, code } of SOURCES) {
      // `let`/`var` na coluna 0 e estado de modulo. Dentro de funcao ou de bloco
      // (indentado) e variavel local, que morre com a chamada.
      assert.equal(/^(let|var) /mu.test(code), false, `${name} tem estado mutavel de modulo`)
    }
  })

  it('a aleatoriedade vem do CSPRNG, nunca de Math.random', () => {
    for (const { name, code } of SOURCES) {
      assert.ok(!code.includes('Math.random'), `${name} usa Math.random`)
    }
    assert.match(
      SOURCES.find((f) => f.name === 'generate.ts')!.code,
      /import \{ randomBytes \} from 'node:crypto'/u,
    )
  })
})

describe('P5 em execucao: provisao, verificacao e rotacao nao imprimem nada', () => {
  it('nem uma letra do segredo chega ao stdout ou ao stderr', () => {
    const dir = makeTempStateDir()
    const captured: string[] = []
    const originalOut = process.stdout.write.bind(process.stdout)
    const originalErr = process.stderr.write.bind(process.stderr)
    let secret = ''
    let token = ''
    try {
      // Intercepta as duas saidas e deixa-as seguir: o que interessa e o que
      // passou por elas, nao suprimir o relatorio do runner.
      process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        captured.push(String(chunk))
        return (originalOut as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
      }) as typeof process.stdout.write
      process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        captured.push(String(chunk))
        return (originalErr as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest)
      }) as typeof process.stderr.write

      const store = createSecretStore({
        state: createFileStateStore(dir.statePath),
        sessions: { revokeAll: (): void => {} },
      })
      secret = canonicalizeSecret(store.provision().display.split('\n')[0]!)
      store.verify(secret)
      store.verify('SEGREDO-ERRADO')
      secret = canonicalizeSecret(store.rotate().display.split('\n')[0]!)
      store.verify(secret)

      const ott = createOneTimeTokenStore({ clock: new FakeClock(0) })
      token = ott.issue().token
      ott.consume(token)
      ott.dispose()
    } finally {
      process.stdout.write = originalOut
      process.stderr.write = originalErr
      dir.cleanup()
    }
    const output = captured.join('')
    assert.ok(!output.includes(secret), 'o segredo apareceu numa saida do processo')
    assert.ok(!output.includes(secret.slice(0, 8)), 'nem um prefixo de 8 caracteres')
    assert.ok(!output.includes(token), 'o ott apareceu numa saida do processo')
  })
})
