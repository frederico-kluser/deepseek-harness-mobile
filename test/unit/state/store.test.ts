/**
 * `src/state/store.ts` — a metade da LEITURA do unico writer do `state.json`.
 *
 * Cobre as perguntas falsificaveis 2 e 3 de `03-ONDAS.md` 7: o modo 0644 e
 * RECUSADO (nao avisado) e um ficheiro corrompido PARA com mensagem acionavel
 * em vez de "comecar do zero". A escrita esta em `store-escrita.test.ts`.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { statePathsAt } from '../../../src/state/paths.ts'
import { createStateStore } from '../../../src/state/store.ts'
import { FakeClock } from '../../support/clock.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'
import { DIGEST, capturar, comStore, esperaCodigo, temporarios } from './apoio.ts'

const clock = new FakeClock(1_700_000_000_000)

describe('leitura', () => {
  it('AUSENCIA do ficheiro e primeiro arranque legitimo (e a UNICA excepcao)', () => {
    comStore(({ store }) => {
      assert.deepEqual(store.store.read(), { version: 1, desiredState: 'STOPPED' })
    })
  })

  it('o que foi escrito e o que se le depois de "reiniciar o plugin"', () => {
    const temp = makeTempStateDir()
    const paths = statePathsAt(temp.path)
    try {
      const primeiro = createStateStore({ paths })
      primeiro.store.update((s) => ({ ...s, desiredState: 'READY', secretDigest: DIGEST }))
      primeiro.dispose()

      // Store NOVO, como no arranque seguinte do processo.
      const segundo = createStateStore({ paths })
      const lido = segundo.store.read()
      segundo.dispose()

      assert.equal(lido.desiredState, 'READY')
      assert.equal(lido.secretDigest, DIGEST)
    } finally {
      temp.cleanup()
    }
  })
})

describe('modo frouxo: RECUSA carregar (02-SEGURANCA.md 8.2 item 7)', () => {
  it('0644 faz `read()` FALHAR — nao e aviso, e paragem', () => {
    comStore(({ temp, store }) => {
      store.store.update((s) => ({ ...s, secretDigest: DIGEST }))
      chmodSync(temp.statePath, 0o644)

      const erro = capturar(() => store.store.read())
      assert.equal(erro.code, 'STATE_MODE_TOO_OPEN')
      assert.match(erro.message, /0644/u)
      assert.match(erro.message, /chmod 600/u)
      // A instrucao completa: o chmod fecha a porta, nao desfaz a leitura que
      // ja possa ter acontecido — por isso manda rodar o segredo.
      assert.match(erro.message, /rode o segredo/u)
      assert.equal(erro.message.includes(DIGEST), false)
    })
  })

  it('QUALQUER bit de grupo ou de outros e suficiente para recusar', () => {
    comStore(({ temp, store }) => {
      store.store.update((s) => ({ ...s, desiredState: 'READY' }))
      for (const modo of [0o640, 0o604, 0o660, 0o606, 0o666, 0o610]) {
        chmodSync(temp.statePath, modo)
        assert.throws(() => store.store.read(), esperaCodigo('STATE_MODE_TOO_OPEN'), `modo 0${modo.toString(8)}`)
      }
    })
  })

  it('0600 e 0400 (mais restrito) passam — a regra e exposicao, nao igualdade', () => {
    comStore(({ temp, store }) => {
      store.store.update((s) => ({ ...s, desiredState: 'READY' }))
      for (const modo of [0o600, 0o400]) {
        chmodSync(temp.statePath, modo)
        assert.equal(store.store.read().desiredState, 'READY', `modo 0${modo.toString(8)}`)
      }
    })
  })

  it('`update()` tambem recusa: ninguem contorna o modo escrevendo por cima', () => {
    comStore(({ temp, store }) => {
      store.store.update((s) => ({ ...s, secretDigest: DIGEST }))
      chmodSync(temp.statePath, 0o644)
      assert.throws(
        () => store.store.update((s) => ({ ...s, desiredState: 'READY' })),
        esperaCodigo('STATE_MODE_TOO_OPEN'),
      )
      // E o ficheiro exposto continua intacto: nem se apaga o vestigio.
      assert.match(readFileSync(temp.statePath, 'utf8'), /b{64}/u)
    })
  })

  it('recusa um `state.json` que seja link simbolico ou que nao seja ficheiro regular', () => {
    const temp = makeTempStateDir()
    const alvo = makeTempStateDir()
    try {
      writeFileSync(alvo.statePath, '{"version":1,"desiredState":"READY"}\n', { mode: 0o600 })
      symlinkSync(alvo.statePath, temp.statePath)
      const porLink = createStateStore({ paths: statePathsAt(temp.path) })
      assert.throws(() => porLink.store.read(), esperaCodigo('STATE_DIR_UNSAFE'))
      porLink.dispose()
    } finally {
      alvo.cleanup()
      temp.cleanup()
    }

    const outro = makeTempStateDir()
    try {
      mkdirSync(outro.statePath)
      const porDiretorio = createStateStore({ paths: statePathsAt(outro.path) })
      assert.throws(() => porDiretorio.store.read(), esperaCodigo('STATE_DIR_UNSAFE'))
      porDiretorio.dispose()
    } finally {
      outro.cleanup()
    }
  })
})

describe('corrompido PARA — nunca "comeca do zero"', () => {
  it('o arranque falha e o `secretDigest` continua no disco, por tocar', () => {
    comStore(({ temp, store }) => {
      store.store.update((s) => ({ ...s, secretDigest: DIGEST, desiredState: 'READY' }))
      const antes = readFileSync(temp.statePath)

      // Truncagem a meio — a forma classica de um estado corrompido.
      writeFileSync(temp.statePath, antes.subarray(0, 20), { mode: 0o600 })
      assert.throws(() => store.store.read(), esperaCodigo('STATE_CORRUPT'))

      // E `update()` tambem: se ele "comecasse do zero", o `secretDigest`
      // desaparecia e a senha do dono mudava sem ninguem pedir.
      assert.throws(
        () => store.store.update((s) => ({ ...s, desiredState: 'STOPPED' })),
        esperaCodigo('STATE_CORRUPT'),
      )
      assert.equal(temporarios(temp.path).length, 0, 'uma leitura falhada nao deixa temporarios')
    })
  })

  it('um ficheiro de ZERO bytes e corrupcao, nao ficheiro novo', () => {
    comStore(({ temp, store }) => {
      writeFileSync(temp.statePath, '', { mode: 0o600 })
      assert.throws(() => store.store.read(), esperaCodigo('STATE_CORRUPT'))
    })
  })
})

describe('os campos que as outras sub-tarefas vao persistir', () => {
  it('sobrevivem a uma volta completa pelo disco', () => {
    comStore(({ store }) => {
      store.store.update((s) => ({
        ...s,
        secretDigest: DIGEST,
        desiredState: 'READY',
        restricted: { since: clock.now(), reason: 'brute-force-ceiling' },
        tunnel: { pid: 31_337, startedAt: clock.advance(5_000), mode: 'quick' },
        pairing: { ownerUserId: '42', ownerChatId: '-1001999', pairedAt: clock.advance(5_000) },
      }))

      const lido = store.store.read()
      assert.equal(lido.secretDigest, DIGEST)
      assert.deepEqual(lido.restricted, { since: 1_700_000_000_000, reason: 'brute-force-ceiling' })
      assert.deepEqual(lido.tunnel, { pid: 31_337, startedAt: 1_700_000_005_000, mode: 'quick' })
      assert.deepEqual(lido.pairing, {
        ownerUserId: '42',
        ownerChatId: '-1001999',
        pairedAt: 1_700_000_010_000,
      })
    })
  })

  it('MIGRACAO: um state.json LEGADO (ids numericos) le normalizado e grava string na proxima escrita', () => {
    comStore(({ temp, store }) => {
      // Um ficheiro da era V1, com os ids do dono NUMERICOS.
      writeFileSync(
        temp.statePath,
        '{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":42,"ownerChatId":-1001234567890,"pairedAt":2000}}\n',
        { mode: 0o600 },
      )

      // A leitura normaliza para string em memoria (EMENDA ONDA-1-IPC-ENVELOPE-STRING).
      const lido = store.store.read()
      assert.deepEqual(lido.pairing, { ownerUserId: '42', ownerChatId: '-1001234567890', pairedAt: 2000 })

      // A proxima escrita grava STRING — o disco migra sozinho, sem passo manual.
      store.store.update((s) => ({ ...s, desiredState: 'READY' }))
      const noDisco = readFileSync(temp.statePath, 'utf8')
      assert.equal(noDisco.includes('"ownerUserId": "42"'), true)
      assert.equal(noDisco.includes('"ownerUserId": 42'), false, 'o numero legado nao volta ao disco')

      // E um store NOVO (o arranque seguinte) le a forma canonica.
      const segundo = createStateStore({ paths: statePathsAt(temp.path) })
      try {
        assert.deepEqual(segundo.store.read().pairing, { ownerUserId: '42', ownerChatId: '-1001234567890', pairedAt: 2000 })
      } finally {
        segundo.dispose()
      }
    })
  })

  it('apagar um campo opcional apaga-o do ficheiro (o modo restrito sai quando sai)', () => {
    comStore(({ temp, store }) => {
      store.store.update((s) => ({ ...s, restricted: { since: 1, reason: 'brute-force-ceiling' } }))
      assert.match(readFileSync(temp.statePath, 'utf8'), /brute-force-ceiling/u)
      store.store.update((s) => ({ ...s, restricted: undefined }))
      assert.equal(readFileSync(temp.statePath, 'utf8').includes('brute-force-ceiling'), false)
      assert.equal(store.store.read().restricted, undefined)
    })
  })
})
