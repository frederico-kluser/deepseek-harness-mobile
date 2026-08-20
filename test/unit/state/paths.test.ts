/**
 * `src/state/paths.ts` — ONDE o estado vive e com que modos nasce.
 *
 * A pergunta falsificavel 5 de `03-ONDAS.md` 7 esta aqui inteira: `$DSH_HOME`
 * respeitado, qual e o fallback, e o que acontece a `$XDG_STATE_HOME` — que
 * NAO entra na cadeia, por decisao escrita no cabecalho de `paths.ts` a partir
 * do veredito S9 da Onda 0.
 */

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  DSH_HOME_DIR_NAME,
  assertOwnedByUs,
  STATE_DIR_MODE,
  STATE_DIR_SEGMENT,
  STATE_FILE_NAME,
  ensureStateDir,
  expandHomePath,
  resolveDshHome,
  resolveStatePaths,
  statePathsAt,
} from '../../../src/state/paths.ts'
import { StateError } from '../../../src/state/schema.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'
import { esperaCodigo, modeOf } from './apoio.ts'

describe('precedencia do diretorio de estado (replica de resolveDshHome, spike S9)', () => {
  it('respeita $DSH_HOME quando definido', () => {
    const temp = makeTempStateDir()
    try {
      const paths = resolveStatePaths({ env: { HOME: '/home/nao-usado', DSH_HOME: temp.path } })
      assert.equal(paths.dir, join(temp.path, STATE_DIR_SEGMENT))
      assert.equal(paths.file, join(temp.path, STATE_DIR_SEGMENT, STATE_FILE_NAME))
    } finally {
      temp.cleanup()
    }
  })

  it('o fallback e ~/.dsh/guarded-bot — a casa do harness, NAO $XDG_STATE_HOME', () => {
    const temp = makeTempStateDir()
    try {
      const paths = resolveStatePaths({ env: { HOME: temp.path } })
      assert.equal(paths.dir, join(temp.path, DSH_HOME_DIR_NAME, STATE_DIR_SEGMENT))
    } finally {
      temp.cleanup()
    }
  })

  it('$XDG_STATE_HOME sozinho NAO desvia o estado (divergencia deliberada do texto do plano)', () => {
    const temp = makeTempStateDir()
    const xdg = makeTempStateDir()
    try {
      const paths = resolveStatePaths({ env: { HOME: temp.path, XDG_STATE_HOME: xdg.path } })
      assert.equal(paths.dir, join(temp.path, DSH_HOME_DIR_NAME, STATE_DIR_SEGMENT))
      assert.ok(!paths.dir.startsWith(xdg.path), 'o estado nao pode cair fora da casa do harness')
    } finally {
      xdg.cleanup()
      temp.cleanup()
    }
  })

  it('um caminho configurado ganha a $DSH_HOME', () => {
    const configured = makeTempStateDir()
    const fromEnv = makeTempStateDir()
    try {
      const paths = resolveStatePaths({
        configuredHome: configured.path,
        env: { HOME: '/home/nao-usado', DSH_HOME: fromEnv.path },
      })
      assert.equal(paths.dir, join(configured.path, STATE_DIR_SEGMENT))
    } finally {
      fromEnv.cleanup()
      configured.cleanup()
    }
  })

  it('$DSH_HOME vazio ou so espacos conta como AUSENTE (nunca resolve para o cwd)', () => {
    const temp = makeTempStateDir()
    try {
      const esperado = join(temp.path, DSH_HOME_DIR_NAME, STATE_DIR_SEGMENT)
      assert.equal(resolveStatePaths({ env: { HOME: temp.path, DSH_HOME: '' } }).dir, esperado)
      assert.equal(resolveStatePaths({ env: { HOME: temp.path, DSH_HOME: '   ' } }).dir, esperado)
    } finally {
      temp.cleanup()
    }
  })

  it('RECUSA um $DSH_HOME relativo em vez de o resolver contra o cwd (Q-3)', () => {
    assert.throws(
      () => resolveDshHome({ env: { HOME: '/home/x', DSH_HOME: 'dsh' } }),
      esperaCodigo('STATE_PATH_INVALID'),
    )
    assert.throws(
      () => resolveDshHome({ configuredHome: './estado' }),
      esperaCodigo('STATE_PATH_INVALID'),
    )
  })

  it('expande o prefixo ~ contra o HOME injetado', () => {
    assert.equal(expandHomePath('~', '/home/ana'), '/home/ana')
    assert.equal(expandHomePath('~/dados', '/home/ana'), '/home/ana/dados')
    assert.equal(resolveDshHome({ env: { HOME: '/home/ana', DSH_HOME: '~/casa' } }), '/home/ana/casa')
    // Sem prefixo, o caminho passa intacto — e em POSIX `~\x` e um nome de
    // ficheiro legitimo, nao um til (divergencia deliberada face ao host).
    assert.equal(expandHomePath('/abs/oluto', '/home/ana'), '/abs/oluto')
    assert.equal(expandHomePath('~x', '/home/ana'), '~x')
  })

  it('sem env injetado le process.env (o caminho real do plugin)', () => {
    const anterior = process.env['DSH_HOME']
    const temp = makeTempStateDir()
    try {
      process.env['DSH_HOME'] = temp.path
      assert.equal(resolveStatePaths().dir, join(temp.path, STATE_DIR_SEGMENT))
      delete process.env['DSH_HOME']
      assert.equal(resolveStatePaths().dir, join(homedir(), DSH_HOME_DIR_NAME, STATE_DIR_SEGMENT))
    } finally {
      if (anterior === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = anterior
      temp.cleanup()
    }
  })
})

describe('ensureStateDir — 0700 de facto, nao 0700 pedido', () => {
  it('cria 0700 mesmo com o umask permissivo tipico, e nao toca no modo do antecessor', () => {
    const temp = makeTempStateDir()
    // Com `umask 0022`, um `mkdir` sem modo explicito daria 0755 ao diretorio
    // que guarda o `secretDigest`. E este o caso que discrimina.
    const anterior = process.umask(0o022)
    try {
      const casa = join(temp.path, DSH_HOME_DIR_NAME)
      const paths = statePathsAt(join(casa, STATE_DIR_SEGMENT))
      ensureStateDir(paths)
      assert.equal(modeOf(paths.dir), STATE_DIR_MODE)
      // O antecessor e a casa do HARNESS: fica com o modo do sistema.
      assert.equal(modeOf(casa), 0o755)
    } finally {
      process.umask(anterior)
      temp.cleanup()
    }
  })

  it('APERTA o modo de um diretorio que ja existia frouxo (mkdir -p nao o faria)', () => {
    const temp = makeTempStateDir()
    try {
      const paths = statePathsAt(join(temp.path, STATE_DIR_SEGMENT))
      mkdirSync(paths.dir, { recursive: true, mode: 0o755 })
      assert.equal(modeOf(paths.dir), 0o755)
      ensureStateDir(paths)
      assert.equal(modeOf(paths.dir), STATE_DIR_MODE)
    } finally {
      temp.cleanup()
    }
  })

  it('e idempotente', () => {
    const temp = makeTempStateDir()
    try {
      const paths = statePathsAt(join(temp.path, STATE_DIR_SEGMENT))
      ensureStateDir(paths)
      ensureStateDir(paths)
      assert.equal(modeOf(paths.dir), STATE_DIR_MODE)
    } finally {
      temp.cleanup()
    }
  })

  it('RECUSA um link simbolico no lugar do diretorio de estado', () => {
    const temp = makeTempStateDir()
    const alvo = makeTempStateDir()
    try {
      const link = join(temp.path, STATE_DIR_SEGMENT)
      symlinkSync(alvo.path, link)
      assert.throws(() => ensureStateDir(statePathsAt(link)), esperaCodigo('STATE_DIR_UNSAFE'))
    } finally {
      alvo.cleanup()
      temp.cleanup()
    }
  })

  it('RECUSA um ficheiro regular no lugar do diretorio de estado, com mensagem propria', () => {
    const temp = makeTempStateDir()
    try {
      const ocupado = join(temp.path, STATE_DIR_SEGMENT)
      writeFileSync(ocupado, 'nao sou um diretorio')
      // Nao e o `EEXIST` cru do `mkdir`: e o codigo do plugin, que diz o que
      // esta errado. Por isso a inspeccao vem ANTES da criacao.
      assert.throws(() => ensureStateDir(statePathsAt(ocupado)), esperaCodigo('STATE_DIR_UNSAFE'))
    } finally {
      temp.cleanup()
    }
  })
})

describe('assertOwnedByUs — estado de outra conta nao se le', () => {
  it('LANCA quando o dono do caminho nao e este processo', () => {
    const nosso = process.getuid?.()
    assert.ok(nosso !== undefined, 'este pacote so declara linux e darwin')
    assert.throws(() => assertOwnedByUs(nosso + 1, '/tmp/de-outro/state.json'), esperaCodigo('STATE_NOT_OWNED'))
    assert.doesNotThrow(() => assertOwnedByUs(nosso, '/tmp/nosso/state.json'))
  })

  it('a mensagem nomeia os dois uids — o do ficheiro e o do processo', () => {
    const nosso = process.getuid?.() ?? 0
    try {
      assertOwnedByUs(nosso + 7, '/tmp/de-outro/state.json')
      assert.fail('tinha de lancar')
    } catch (error) {
      assert.ok(error instanceof StateError)
      assert.match(error.message, new RegExp(`uid ${nosso + 7}`, 'u'))
      assert.match(error.message, new RegExp(`uid ${nosso}`, 'u'))
    }
  })
})
