/**
 * `src/config/schema.ts` -- resolucao do `worker/` empacotado.
 *
 * O `worker/` esta FORA da arvore de fonte (`<repo>/worker/`) e DENTRO da arvore
 * emitida (`<pkg>/dist/worker/`). Uma so expressao relativa NAO serve os dois, e
 * foi exatamente essa suposicao que partiu toda a instalacao por npm assim que o
 * `worker.cwd` absoluto saiu do manifesto.
 */

import assert from 'node:assert/strict'
import { existsSync, statSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PACKAGED_WORKER_DIR,
  PACKAGED_WORKER_ENTRYPOINT,
  resolvePackagedWorkerDir,
  resolveWorkerCwd,
  resolveWorkerEntrypoint,
} from '../../../src/config/schema.ts'
import { makeConfig } from '../../support/fixtures.ts'

describe('resolvePackagedWorkerDir', () => {
  it('LAYOUT DE FONTE (dev): sobe DOIS niveis, para o irmao da arvore de fonte', () => {
    assert.equal(
      resolvePackagedWorkerDir('file:///repo/src/config/schema.ts'),
      fileURLToPath('file:///repo/worker/'),
    )
  })

  it('LAYOUT EMITIDO (tarball): sobe UM nivel, para dentro de dist/', () => {
    // `<pkg>/dist/config/schema.js` -> `<pkg>/dist/worker/`. Com a expressao
    // antiga (`../../worker/`) dava `<pkg>/worker/`, que nao existe no tarball.
    assert.equal(
      resolvePackagedWorkerDir('file:///pkg/dist/config/schema.js'),
      fileURLToPath('file:///pkg/dist/worker/'),
    )
  })

  it('as duas expressoes sao DIFERENTES -- nenhuma serve os dois layouts', () => {
    // Anti-regressao do erro original: o comentario afirmava que "os dois
    // caminhos sobem exatamente dois niveis, logo a mesma expressao serve os
    // dois". Se alguem voltar a usar uma expressao unica, um destes dois testes
    // falha -- e este diz porque.
    const fonte = resolvePackagedWorkerDir('file:///x/src/config/schema.ts')
    const emitido = resolvePackagedWorkerDir('file:///x/dist/config/schema.js')

    assert.notEqual(fonte, emitido)
    assert.equal(emitido.includes(`${'dist'}`), true, 'o layout emitido vive DENTRO de dist/')
    assert.equal(fonte.includes(`${'src'}`), false, 'o layout de fonte vive FORA de src/')
  })

  it('reconhece as tres extensoes de modulo emitido', () => {
    for (const ficheiro of ['schema.js', 'schema.mjs', 'schema.cjs']) {
      assert.equal(
        resolvePackagedWorkerDir(`file:///pkg/dist/config/${ficheiro}`),
        fileURLToPath('file:///pkg/dist/worker/'),
        `'${ficheiro}' e arvore emitida`,
      )
    }
  })

  it('NAO sonda o sistema de ficheiros: decide pela extensao, nao pelo que existe', () => {
    // Um caminho que nao existe em lado nenhum continua a resolver de forma
    // deterministica. Escolher "o que existir" esconderia um layout errado em
    // vez de o expor no arranque (Q-3).
    const inventado = resolvePackagedWorkerDir('file:///nao/existe/dist/config/schema.js')
    assert.equal(inventado, fileURLToPath('file:///nao/existe/dist/worker/'))
    assert.equal(existsSync(inventado), false)
  })
})

describe('PACKAGED_WORKER_DIR desta instalacao', () => {
  it('aponta para um diretorio que EXISTE (e o que assertValidConfig exige)', () => {
    assert.equal(existsSync(PACKAGED_WORKER_DIR), true, PACKAGED_WORKER_DIR)
    assert.equal(statSync(PACKAGED_WORKER_DIR).isDirectory(), true)
  })

  it('e o default de worker.cwd quando o manifesto nao o declara', () => {
    const semCwd = makeConfig()
    delete semCwd.worker.cwd

    assert.equal(resolveWorkerCwd(semCwd), PACKAGED_WORKER_DIR)
  })

  it('nunca vem do process.cwd() -- o cwd do host e o workspace do utilizador', () => {
    assert.notEqual(PACKAGED_WORKER_DIR, process.cwd())
    assert.equal(PACKAGED_WORKER_DIR.startsWith(process.cwd()), true, 'mas esta dentro do pacote')
  })
})

describe('resolveWorkerEntrypoint', () => {
  it('LAYOUT DE FONTE (dev): worker/telegram-bot.ts, irmao da arvore de fonte', () => {
    assert.equal(
      resolveWorkerEntrypoint('file:///repo/src/config/schema.ts'),
      fileURLToPath('file:///repo/worker/telegram-bot.ts'),
    )
  })

  it('LAYOUT EMITIDO (tarball): dist/worker/telegram-bot.js, dentro de dist/', () => {
    // E a frase literal das tres decisoes canonicas: "o argv do spawn resolve
    // dist/worker/telegram-bot.js relativo a import.meta.url, nunca por cwd".
    assert.equal(
      resolveWorkerEntrypoint('file:///pkg/dist/config/schema.js'),
      fileURLToPath('file:///pkg/dist/worker/telegram-bot.js'),
    )
  })

  it('a EXTENSAO acompanha o layout, tal como a profundidade do diretorio', () => {
    assert.equal(resolveWorkerEntrypoint('file:///x/src/config/schema.ts').endsWith('.ts'), true)
    assert.equal(resolveWorkerEntrypoint('file:///x/dist/config/schema.js').endsWith('.js'), true)
  })

  it('vive sempre DENTRO do diretorio que resolvePackagedWorkerDir devolve', () => {
    for (const url of ['file:///x/src/config/schema.ts', 'file:///x/dist/config/schema.js']) {
      assert.equal(
        resolveWorkerEntrypoint(url).startsWith(resolvePackagedWorkerDir(url)),
        true,
        url,
      )
    }
  })

  it('o entrypoint desta instalacao EXISTE e e ficheiro', () => {
    assert.equal(existsSync(PACKAGED_WORKER_ENTRYPOINT), true, PACKAGED_WORKER_ENTRYPOINT)
    assert.equal(statSync(PACKAGED_WORKER_ENTRYPOINT).isFile(), true)
  })

  it('e absoluto e nao vem do process.cwd()', () => {
    assert.equal(PACKAGED_WORKER_ENTRYPOINT.startsWith(PACKAGED_WORKER_DIR), true)
    assert.notEqual(PACKAGED_WORKER_ENTRYPOINT, process.cwd())
  })
})
