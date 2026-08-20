/**
 * `src/ratelimit/restricted.ts` -- o modo restrito DECIDE e PERSISTE.
 *
 * Cobre RL-008 (a metade que esta onda pode provar), RL-014, RL-015 e RL-016 de
 * `04-TESTES.md`, e o item 8 do aceite da Onda 2: aos 100 o modo ativa, e
 * persistido no `state.json` e CONTINUA ATIVO APOS REINICIAR.
 *
 * O `StateStore` real e de T2.5 e ainda nao existe nesta worktree (a Onda 2 e
 * paralela por construcao: as duas acoplam-se pelo contrato congelado em
 * `src/contracts/state.ts`, nao pelo ficheiro uma da outra). O duble abaixo
 * implementa esse contrato sobre um `state.json` DE VERDADE, num diretorio
 * descartavel de `test/support/state-dir.ts` -- ficheiro real, `JSON.parse` real,
 * recusa real de modo mais frouxo que 0600. Sem ficheiro real, "persiste entre
 * reinicios" seria uma afirmacao sobre um `Map`.
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { FakeClock } from '../../support/clock.ts'
import { makeTempStateDir, type TempStateDir } from '../../support/state-dir.ts'
import type { PersistedState, StateStore } from '../../../src/contracts/state.ts'
import { DEFAULT_RATE_LIMIT_POLICY } from '../../../src/ratelimit/policy.ts'
import { createRestrictedMode, RESTRICTED_REASON } from '../../../src/ratelimit/restricted.ts'

const policy = DEFAULT_RATE_LIMIT_POLICY
const EMPTY: PersistedState = { version: 1, desiredState: 'STOPPED' }

/** Duble do `StateStore` de T2.5, fiel ao contrato congelado. */
function createFileStateStore(statePath: string): StateStore {
  const read = (): PersistedState => {
    if (!existsSync(statePath)) return { ...EMPTY }
    // "RECUSA carregar se o modo do ficheiro for mais frouxo que 0600."
    const mode = statSync(statePath).mode & 0o777
    if (mode > 0o600) {
      throw new Error(`STATE_MODE_TOO_OPEN: ${statePath} esta ${mode.toString(8)}; corrija com chmod 600`)
    }
    // `JSON.parse` lanca em ficheiro corrompido -- e isso e o comportamento
    // desejado: recomecar do zero apagaria o `secretDigest` do dono.
    return JSON.parse(readFileSync(statePath, 'utf8')) as PersistedState
  }

  return {
    read,
    update(fn: (s: PersistedState) => PersistedState): void {
      const next = fn(read())
      const tmp = `${statePath}.tmp` // no MESMO diretorio: rename entre FS nao e atomico
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
      renameSync(tmp, statePath)
    },
  }
}

const dirs: TempStateDir[] = []
function freshStateDir(): TempStateDir {
  const dir = makeTempStateDir()
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) dir.cleanup()
})

function readRaw(statePath: string): PersistedState {
  return JSON.parse(readFileSync(statePath, 'utf8')) as PersistedState
}

describe('createRestrictedMode -- ativacao aos 100 e persistencia', () => {
  it('arranca INATIVO quando o state.json nao diz nada sobre modo restrito', () => {
    const dir = freshStateDir()
    const mode = createRestrictedMode({ state: createFileStateStore(dir.statePath), now: () => 1, policy })
    assert.equal(mode.isActive(), false)
    assert.deepEqual(mode.status(), { active: false, since: undefined, reason: undefined })
  })

  it('99 falhas nao ativam nada -- o teto e 100, e nao 99', () => {
    const dir = freshStateDir()
    const mode = createRestrictedMode({ state: createFileStateStore(dir.statePath), now: () => 1, policy })
    assert.equal(mode.activateIfCeilingReached(99), undefined)
    assert.equal(mode.isActive(), false)
    assert.equal(existsSync(dir.statePath), false, 'nao ativar nao pode escrever no state.json')
  })

  it('RL-008: aos 100 ativa, devolve o intent e PERSISTE no state.json', () => {
    const dir = freshStateDir()
    const clock = new FakeClock(1_700_000_000_000)
    const mode = createRestrictedMode({
      state: createFileStateStore(dir.statePath),
      now: () => clock.now(),
      policy,
    })

    const intent = mode.activateIfCeilingReached(100)
    assert.notEqual(intent, undefined)
    assert.deepEqual(intent, {
      kind: 'restrict-exposure',
      reason: 'brute-force-ceiling',
      since: 1_700_000_000_000,
      accountFailures: 100,
    })

    assert.equal(mode.isActive(), true)
    assert.deepEqual(readRaw(dir.statePath).restricted, {
      since: 1_700_000_000_000,
      reason: RESTRICTED_REASON,
    })
    assert.equal(statSync(dir.statePath).mode & 0o777, 0o600)
  })

  it('a ativacao e IDEMPOTENTE: o `since` nao pode ser empurrado para a frente', () => {
    const dir = freshStateDir()
    const clock = new FakeClock(1_000)
    const mode = createRestrictedMode({
      state: createFileStateStore(dir.statePath),
      now: () => clock.now(),
      policy,
    })

    assert.notEqual(mode.activateIfCeilingReached(100), undefined)
    clock.advance(500_000)
    assert.equal(mode.activateIfCeilingReached(250), undefined, 'ja ativo: nao ha nova transicao')
    assert.equal(readRaw(dir.statePath).restricted?.since, 1_000)
    assert.equal(mode.status().since, 1_000)
  })

  it('ACEITE 8: reiniciar o plugin NAO e o bypass -- instancia nova le o disco e continua ativa', () => {
    const dir = freshStateDir()
    const clock = new FakeClock(42_000)

    const antes = createRestrictedMode({
      state: createFileStateStore(dir.statePath),
      now: () => clock.now(),
      policy,
    })
    antes.activateIfCeilingReached(100)
    assert.equal(antes.isActive(), true)

    // "Reiniciar" = tudo o que era memoria desaparece. `StateStore` novo,
    // `RestrictedMode` novo, relogio novo -- so o ficheiro sobrevive.
    const depois = createRestrictedMode({
      state: createFileStateStore(dir.statePath),
      now: () => 9_999_999,
      policy,
    })
    assert.equal(depois.isActive(), true)
    assert.deepEqual(depois.status(), { active: true, since: 42_000, reason: RESTRICTED_REASON })
  })
})

describe('recuperacao -- nao e lockout permanente (RL-015)', () => {
  it('o caminho de recuperacao LOCAL e EXECUTADO: limpa o disco e sobrevive ao reinicio', () => {
    const dir = freshStateDir()
    const state = createFileStateStore(dir.statePath)
    const mode = createRestrictedMode({ state, now: () => 7, policy })
    mode.activateIfCeilingReached(100)
    assert.equal(mode.isActive(), true)

    // O UNICO caminho de saida, e ele e local (bin/dsh-guard-setup, T4.1).
    assert.equal(mode.releaseFromLocalMachine(), true)
    assert.equal(mode.isActive(), false)
    assert.equal(readRaw(dir.statePath).restricted, undefined)

    const reiniciado = createRestrictedMode({ state: createFileStateStore(dir.statePath), now: () => 8, policy })
    assert.equal(reiniciado.isActive(), false, 'a saida tambem tem de persistir, senao o dono fica preso')
  })

  it('libertar quando nao ha nada a libertar devolve false e nao escreve', () => {
    const dir = freshStateDir()
    const mode = createRestrictedMode({ state: createFileStateStore(dir.statePath), now: () => 1, policy })
    assert.equal(mode.releaseFromLocalMachine(), false)
    assert.equal(existsSync(dir.statePath), false)
  })

  it('depois de libertar, o teto volta a poder acender (o controlo nao se gasta)', () => {
    const dir = freshStateDir()
    const clock = new FakeClock(100)
    const mode = createRestrictedMode({
      state: createFileStateStore(dir.statePath),
      now: () => clock.now(),
      policy,
    })
    mode.activateIfCeilingReached(100)
    mode.releaseFromLocalMachine()

    clock.advance(1)
    assert.notEqual(mode.activateIfCeilingReached(100), undefined)
    assert.equal(readRaw(dir.statePath).restricted?.since, 101)
  })

  it('`reload()` re-le o disco: o ficheiro e a fonte da verdade, a cache e conveniencia', () => {
    const dir = freshStateDir()
    const state = createFileStateStore(dir.statePath)
    const mode = createRestrictedMode({ state, now: () => 1, policy })
    assert.equal(mode.isActive(), false)

    // Escrita "externa" (o CLI local, noutro processo).
    state.update((previous) => ({ ...previous, restricted: { since: 5, reason: RESTRICTED_REASON } }))
    assert.equal(mode.isActive(), false, 'a cache ainda nao sabe')
    mode.reload()
    assert.equal(mode.isActive(), true)

    state.update((previous) => ({ ...previous, restricted: undefined }))
    mode.reload()
    assert.equal(mode.isActive(), false)
  })
})

describe('FAIL LOUD -- um state.json partido nunca vira "nao restrito" (RL-016)', () => {
  it('state.json corrompido faz o arranque LANCAR, nao assumir o modo desligado', () => {
    const dir = freshStateDir()
    writeFileSync(dir.statePath, '{"version":1,"desiredState":"STOPPED"', { mode: 0o600 })
    assert.throws(() =>
      createRestrictedMode({ state: createFileStateStore(dir.statePath), now: () => 1, policy }),
    )
  })

  it('state.json com modo 0644 faz o arranque LANCAR', () => {
    const dir = freshStateDir()
    const state = createFileStateStore(dir.statePath)
    state.update((previous) => ({ ...previous, restricted: { since: 3, reason: RESTRICTED_REASON } }))
    chmodSync(dir.statePath, 0o644)

    assert.throws(
      () => createRestrictedMode({ state: createFileStateStore(dir.statePath), now: () => 1, policy }),
      /STATE_MODE_TOO_OPEN/u,
    )
    chmodSync(dir.statePath, 0o600)
  })

  it('`restricted.since` invalido LANCA com mensagem acionavel', () => {
    const dir = freshStateDir()
    const broken = join(dir.path, 'quebrado.json')
    writeFileSync(
      broken,
      JSON.stringify({ version: 1, desiredState: 'STOPPED', restricted: { since: null, reason: RESTRICTED_REASON } }),
      { mode: 0o600 },
    )
    assert.throws(
      () => createRestrictedMode({ state: createFileStateStore(broken), now: () => 1, policy }),
      /RESTRICTED_STATE_INVALID/u,
    )
  })
})

describe('fronteira da onda -- decide e persiste, nao executa', () => {
  it('o intent e um DADO: nada aqui derruba tunel, mata processo ou fala com o Telegram', () => {
    const dir = freshStateDir()
    const mode = createRestrictedMode({ state: createFileStateStore(dir.statePath), now: () => 11, policy })
    const intent = mode.activateIfCeilingReached(100)

    // Quem executa e T3.3 (gate) / T3.1 + T5.1 (tunel). Aqui so ha o veredito.
    assert.ok(intent !== undefined)
    assert.equal(intent.kind, 'restrict-exposure')
    assert.deepEqual(Object.keys(intent).toSorted(), ['accountFailures', 'kind', 'reason', 'since'])
    for (const value of Object.values(intent)) {
      assert.notEqual(typeof value, 'function', 'um intent com funcao dentro ja seria fiacao')
    }
  })
})
