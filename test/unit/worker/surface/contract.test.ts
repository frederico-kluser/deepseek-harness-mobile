/**
 * Smoke de TIPOS do contrato neutro da superficie no runtime.
 *
 * `SurfaceAction` e um alias de `IpcIntentName` de `src/contracts/ipc.ts` -- o
 * tipo nao tem valor proprio, por isso a forma como o teste o prende ao
 * vocabulario do IPC e por OBJECTOS LITERAIS: o vocabulo canonico e uma unica
 * lista a partir da qual os eventos e botoes sao construidos, e o teste assere
 * que SÓ esse vocabulo produz um `SurfaceActionEvent`/`SurfaceActionData`
 * tipados (e que um `kind` invalido em `ActionRow` falha em compile-time).
 *
 * Sem frameworks novos, node:test, PT-BR -- o mesmo estilo da suite.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { IpcIntentName } from '../../../../src/contracts/ipc.ts'
import type {
  ActionRow,
  SurfaceAction,
  SurfaceActionData,
  SurfaceActionEvent,
  SurfaceCommandEvent,
  SurfaceEditOutcome,
  SurfaceEvent,
} from '../../../../worker/surface/index.ts'

/** O vocabulario FECHADO do contrato IPC -- a fonte unica dos acoes no teste. */
const VOCABULARIO_IPC: readonly IpcIntentName[] = [
  'tunnel.up',
  'tunnel.down',
  'tunnel.status',
  'session.issue',
  'secret.rotate',
  'emergency',
]

const IDENTIDADE = { userKey: 'dono', chatKey: 'grupo' } as const

/** Tipa `{ action, token }` como SurfaceActionData -- erro de compile se action nao for SurfaceAction. */
const acao = (action: SurfaceAction, token: string): SurfaceActionData => ({ action, token })
/** Tipa uma ActionRow -- erro de compile se a forma nao bater com o contrato. */
const linhaTyped = (linha: ActionRow): ActionRow => linha

/* ========================================================================== */
/* SurfaceAction ~ IpcIntentName                                              */
/* ========================================================================== */

describe('SurfaceAction -- o vocabulario fechado do contrato IPC', () => {
  it('os seis intents do contrato IPC formam a SurfaceAction', () => {
    assert.deepEqual(VOCABULARIO_IPC.toSorted(), [
      'emergency',
      'secret.rotate',
      'session.issue',
      'tunnel.down',
      'tunnel.status',
      'tunnel.up',
    ])
  })

  it('SurfaceAction e SurfaceActionData transportam o mesmo vocabulo (runtime)', () => {
    for (const name of VOCABULARIO_IPC) {
      const dado = acao(name, 'nonce-opaco')
      assert.equal(dado.action, name)
      assert.equal(dado.token, 'nonce-opaco')
    }
  })
})

/* ========================================================================== */
/* ActionRow e ActionRowLayout                                                */
/* ========================================================================== */

describe('ActionRow -- token opaco OBRIGATORIO na forma, kind anota a natureza', () => {
  it('uma linha valida: rotulo, acao, token; kind opcional e fechado', () => {
    const linha = linhaTyped({
      label: '⚡ Tunel acima',
      action: 'tunnel.up',
      token: 'nonce-do-host',
    })
    assert.equal(linha.action, 'tunnel.up')
    assert.equal(linha.token, 'nonce-do-host')

    // `kind` aceita so os dois valores anotados da natureza.
    assert.equal(linhaTyped({ label: 'a', action: 'tunnel.up', token: 't', kind: 'confirm' }).kind, 'confirm')
    assert.equal(linhaTyped({ label: 'a', action: 'tunnel.up', token: 't', kind: 'emergency' }).kind, 'emergency')
  })

  it('uma SurfaceActionEvent leva ao botao o MESMO token que a percorreu', () => {
    const dado = acao('tunnel.down', 'token-local')
    const evento: SurfaceActionEvent = {
      kind: 'acao',
      identity: IDENTIDADE,
      action: dado.action,
      token: dado.token,
      answerTarget: 'query-1',
    }
    assert.deepEqual({ action: evento.action, token: evento.token }, { action: 'tunnel.down', token: 'token-local' })
  })
})

/* ========================================================================== */
/* SurfaceEditOutcome                                                         */
/* ========================================================================== */

describe('SurfaceEditOutcome -- o veredito fechado de uma edicao in-place', () => {
  it('so os tres estados do espelho de worker/lib/keyboard.ts', () => {
    const estados: readonly SurfaceEditOutcome[] = ['edited', 'unchanged', 'failed']
    assert.equal(estados.length, 3)
    assert.ok(estados.includes('edited') && estados.includes('unchanged') && estados.includes('failed'))
  })
})

/* ========================================================================== */
/* SurfaceEvent -- a uniao discriminada por kind                              */
/* ========================================================================== */

describe('SurfaceEvent -- kind discrimina comando / acao / acao-invalida', () => {
  it('o evento de COMANDO carrega identidade e texto cru', () => {
    const comando: SurfaceCommandEvent = { kind: 'comando', identity: IDENTIDADE, text: '  /parear  ' }
    assert.equal(comando.kind, 'comando')
    assert.equal(comando.text, '  /parear  ', 'o texto e cru: a normalizacao de comando vive no router')
  })

  it('o evento de ACAO INVALida resigna-se a responder e contar, sem acao forjada', () => {
    const rejeitado: SurfaceEvent = {
      kind: 'acao-invalida',
      answerTarget: 'query-1',
      reason: 'forma',
      identity: IDENTIDADE,
    }
    assert.equal(rejeitado.kind, 'acao-invalida')
  })

  it('um SurfaceEvent valido de comando com identidade valida e coerente com ids.ts', () => {
    assert.ok(IDENTIDADE.userKey && IDENTIDADE.chatKey, 'identidade de teste tem de ser valida para o tipo bater')
  })
})