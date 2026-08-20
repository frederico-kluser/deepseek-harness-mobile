/**
 * `src/state/store.ts` — a metade da ESCRITA: atomicidade observada de dentro,
 * falhas do sistema de ficheiros, disposer sincrono (Q-2) e reentrancia.
 *
 * A metade da LEITURA (modo frouxo, corrompido) esta em `store.test.ts`; a
 * prova de que a atomicidade sobrevive a morte do processo esta em
 * `crash.test.ts`, porque so se prova com um processo de verdade a morrer.
 */

import assert from 'node:assert/strict'
import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { PersistedState } from '../../../src/contracts/state.ts'
import { STATE_DIR_MODE, STATE_FILE_MODE, statePathsAt } from '../../../src/state/paths.ts'
import { createStateStore, syncDirectory } from '../../../src/state/store.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'
import { DIGEST, capturar, comStore, esperaCodigo, modeOf, temporarios } from './apoio.ts'

describe('escrita atomica — o que se observa de dentro do processo', () => {
  it('cria o diretorio 0700 e o ficheiro 0600 mesmo com umask 000', () => {
    const temp = makeTempStateDir()
    const anterior = process.umask(0o000)
    try {
      const paths = statePathsAt(join(temp.path, 'guarded-bot'))
      const store = createStateStore({ paths })
      store.store.update((s) => ({ ...s, secretDigest: DIGEST }))
      store.dispose()
      // Com umask 000, um `writeFileSync` sem modo teria deixado 0666 — e o
      // proprio `read()` seguinte recusaria carregar.
      assert.equal(modeOf(paths.file), STATE_FILE_MODE)
      assert.equal(modeOf(paths.dir), STATE_DIR_MODE)
    } finally {
      process.umask(anterior)
      temp.cleanup()
    }
  })

  it('o temporario nasce NO MESMO diretorio, e o destino so muda no rename', () => {
    const temp = makeTempStateDir()
    try {
      const paths = statePathsAt(temp.path)
      const inicial = createStateStore({ paths })
      inicial.store.update((s) => ({ ...s, desiredState: 'STOPPED', secretDigest: DIGEST }))
      inicial.dispose()
      const antes = readFileSync(paths.file, 'utf8')

      // Tudo o que interessa e observado NO INSTANTE entre o fsync e o rename.
      let observado: { tmps: string[]; destino: string; conteudoTmp: string } | undefined
      const store = createStateStore({
        paths,
        beforeRename: (): void => {
          const tmps = temporarios(temp.path)
          observado = {
            tmps,
            destino: readFileSync(paths.file, 'utf8'),
            conteudoTmp: readFileSync(join(temp.path, tmps[0] as string), 'utf8'),
          }
        },
      })
      store.store.update((s) => ({ ...s, desiredState: 'READY' }))
      store.dispose()

      assert.ok(observado !== undefined, 'o gancho tinha de correr entre o fsync e o rename')
      // `rename(2)` so e atomico DENTRO do mesmo sistema de ficheiros: e por
      // isto que o temporario nao pode viver em os.tmpdir().
      assert.equal(observado.tmps.length, 1, 'exatamente um temporario, e no diretorio do destino')
      assert.equal(observado.destino, antes, 'no instante anterior ao rename o destino e o VELHO, inteiro')
      // O temporario ja esta COMPLETO (e ja passou pelo fsync) nesse instante.
      assert.match(observado.conteudoTmp, /"desiredState": "READY"/u)
      assert.equal(observado.conteudoTmp.endsWith('}\n'), true)

      assert.equal(temporarios(temp.path).length, 0, 'o rename consome o temporario')
      assert.equal(readFileSync(paths.file, 'utf8'), observado.conteudoTmp)
    } finally {
      temp.cleanup()
    }
  })

  it('se a escrita falha a meio, o destino fica intacto e nao sobra temporario', () => {
    const temp = makeTempStateDir()
    let rebentar = false
    const store = createStateStore({
      paths: statePathsAt(temp.path),
      beforeRename: (): void => {
        // A primeira escrita passa (cria o ficheiro); a segunda rebenta
        // exatamente onde doi: com o temporario ja completo no disco.
        if (rebentar) throw new Error('falha injectada mesmo antes do rename')
      },
    })
    try {
      store.store.update((s) => ({ ...s, secretDigest: DIGEST }))
      const antes = readFileSync(temp.statePath, 'utf8')
      rebentar = true
      assert.throws(
        () => store.store.update((s) => ({ ...s, desiredState: 'READY' })),
        /falha injectada/u,
      )
      assert.equal(readFileSync(temp.statePath, 'utf8'), antes)
      assert.equal(temporarios(temp.path).length, 0, 'o temporario da tentativa falhada e apagado')
    } finally {
      store.dispose()
      temp.cleanup()
    }
  })
})

describe('falhas do sistema de ficheiros: alto e com codigo, nunca em silencio', () => {
  it('um `state.json` ilegivel (diretorio sem permissao) da STATE_READ_FAILED', () => {
    const temp = makeTempStateDir()
    const paths = statePathsAt(temp.path)
    const store = createStateStore({ paths })
    try {
      store.store.update((s) => ({ ...s, desiredState: 'READY' }))
      if (process.getuid?.() === 0) return // root ignora as permissoes; nada a provar
      chmodSync(temp.path, 0o000)
      const erro = capturar(() => store.store.read())
      assert.equal(erro.code, 'STATE_READ_FAILED')
      assert.match(erro.message, /state\.json/u)
    } finally {
      chmodSync(temp.path, 0o700)
      store.dispose()
      temp.cleanup()
    }
  })

  it('se o temporario desaparecer antes do rename, falha com STATE_WRITE_FAILED e nao mente', () => {
    const temp = makeTempStateDir()
    const paths = statePathsAt(temp.path)
    let sabotar = false
    const store = createStateStore({
      paths,
      beforeRename: (): void => {
        if (!sabotar) return
        // Alguem (um "limpador de temporarios") apagou o ficheiro debaixo dos pes.
        for (const nome of temporarios(temp.path)) unlinkSync(join(temp.path, nome))
      },
    })
    try {
      store.store.update((s) => ({ ...s, secretDigest: DIGEST }))
      const antes = readFileSync(paths.file, 'utf8')
      sabotar = true
      const erro = capturar(() => store.store.update((s) => ({ ...s, desiredState: 'READY' })))
      assert.equal(erro.code, 'STATE_WRITE_FAILED')
      assert.match(erro.message, /NAO foi alterado/u)
      assert.equal(readFileSync(paths.file, 'utf8'), antes)
    } finally {
      store.dispose()
      temp.cleanup()
    }
  })

  it('um diretorio de estado que e afinal um FICHEIRO da primeiro arranque, nao estoiro (ENOTDIR)', () => {
    const temp = makeTempStateDir()
    try {
      writeFileSync(join(temp.path, 'ficheiro'), 'sou um ficheiro')
      const store = createStateStore({ paths: statePathsAt(join(temp.path, 'ficheiro')) })
      // Ler de um caminho cujo antecessor nao e diretorio e AUSENCIA, nao
      // corrupcao: nunca existiu estado nenhum ali.
      assert.deepEqual(store.store.read(), { version: 1, desiredState: 'STOPPED' })
      // Mas ESCREVER ali falha alto — e nao em silencio.
      assert.throws(() => store.store.update((s) => ({ ...s, desiredState: 'READY' })))
      store.dispose()
    } finally {
      temp.cleanup()
    }
  })

  it('`syncDirectory` engole — e SO ela — a falha de fsync num descritor que nao a suporta', () => {
    // Os dois caminhos engolidos, exercidos: o diretorio que nao abre e o
    // descritor em que `fsync` devolve EINVAL. Uma excepcao que ninguem
    // consegue provocar num teste e uma excepcao que ninguem sabe se esta
    // escrita ao contrario.
    assert.doesNotThrow(() => syncDirectory('/este/caminho/nao/existe/de/certeza'))
    assert.doesNotThrow(() => syncDirectory('/dev/null'))
  })
})

describe('contrato de uso: disposer sincrono (Q-2) e reentrancia', () => {
  it('depois de `dispose()`, ler ou escrever LANCA', () => {
    const temp = makeTempStateDir()
    try {
      const store = createStateStore({ paths: statePathsAt(temp.path) })
      store.store.update((s) => ({ ...s, desiredState: 'READY' }))
      store.dispose()
      store.dispose() // idempotente
      assert.throws(() => store.store.read(), esperaCodigo('STATE_STORE_DISPOSED'))
      assert.throws(() => store.store.update((s) => s), esperaCodigo('STATE_STORE_DISPOSED'))
    } finally {
      temp.cleanup()
    }
  })

  it('`dispose()` limpa os temporarios que a instancia deixou para tras', () => {
    const temp = makeTempStateDir()
    try {
      const store = createStateStore({
        paths: statePathsAt(temp.path),
        beforeRename: (): void => {
          throw new Error('interrompido')
        },
      })
      assert.throws(() => store.store.update((s) => ({ ...s, desiredState: 'READY' })), /interrompido/u)
      store.dispose()
      assert.equal(temporarios(temp.path).length, 0)
    } finally {
      temp.cleanup()
    }
  })

  it('`update()` dentro de `update()` LANCA (a escrita de fora comeria a de dentro)', () => {
    comStore(({ store }) => {
      assert.throws(
        () =>
          store.store.update((s): PersistedState => {
            store.store.update((interno) => ({ ...interno, desiredState: 'READY' }))
            return s
          }),
        esperaCodigo('STATE_REENTRANT_UPDATE'),
      )
      // E o store continua utilizavel depois: a guarda nao o deixa preso.
      store.store.update((s) => ({ ...s, desiredState: 'READY' }))
      assert.equal(store.store.read().desiredState, 'READY')
    })
  })

  it('um callback que nao devolve estado e erro, nao "escreve vazio"', () => {
    comStore(({ store }) => {
      assert.throws(
        () => store.store.update((() => undefined) as unknown as (s: PersistedState) => PersistedState),
        esperaCodigo('STATE_CORRUPT'),
      )
      assert.throws(
        () => store.store.update(((s: PersistedState) => ({ ...s, desiredState: 'LIGADO' })) as unknown as (s: PersistedState) => PersistedState),
        esperaCodigo('STATE_CORRUPT'),
      )
    })
  })
})
