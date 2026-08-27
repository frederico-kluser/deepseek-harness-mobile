/**
 * `src/state/schema.ts` — a FORMA do estado, a migracao e a mensagem acionavel.
 *
 * O que estes testes protegem nao e "o JSON esta bonito": e que um ficheiro que
 * nao le como estado valido PARE o arranque em vez de virar `emptyState()`.
 * Recomecar do zero apagaria `secretDigest` e `pairing` — trocaria a senha e o
 * dono do bot sem ninguem pedir (pergunta falsificavel 3 de `03-ONDAS.md` 7).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { PersistedState } from '../../../src/contracts/state.ts'
import {
  CURRENT_STATE_VERSION,
  emptyState,
  parsePersistedState,
  parseStateDocument,
  serializeStateDocument,
} from '../../../src/state/schema.ts'
import { FakeClock } from '../../support/clock.ts'
import { capturar, esperaCodigo } from './apoio.ts'

const FONTE = '/nao/existe/state.json'
const DIGEST = 'a'.repeat(64)

/** O relogio injetado (prep-owned) da aos instantes persistidos valores fixos. */
const clock = new FakeClock(1_700_000_000_000)

function recusa(texto: string, code = 'STATE_CORRUPT'): void {
  assert.throws(() => parseStateDocument(texto, FONTE), esperaCodigo(code))
}

describe('emptyState — o primeiro arranque e fail-closed', () => {
  it('nasce em STOPPED, sem segredo e sem emparelhamento', () => {
    assert.deepEqual(emptyState(), { version: 1, desiredState: 'STOPPED' })
    assert.equal(CURRENT_STATE_VERSION, 1)
  })
})

describe('serializacao', () => {
  it('emite ordem de chaves FIXA e termina em newline', () => {
    const estado: PersistedState = {
      version: 1,
      desiredState: 'READY',
      secretDigest: DIGEST,
      restricted: { since: clock.now(), reason: 'brute-force-ceiling' },
      tunnel: { pid: 4242, startedAt: clock.advance(1000), mode: 'quick' },
      pairing: { ownerUserId: '7', ownerChatId: '-1001234', pairedAt: clock.advance(1000) },
    }
    const texto = serializeStateDocument(estado)
    assert.ok(texto.endsWith('\n'))
    assert.deepEqual(Object.keys(JSON.parse(texto) as object), [
      'version',
      'desiredState',
      'secretDigest',
      'restricted',
      'tunnel',
      'pairing',
    ])
    // Byte a byte estavel: dois estados iguais produzem o MESMO ficheiro. E o
    // que permite afirmar "o destino nao foi tocado" por comparacao de bytes.
    assert.equal(texto, serializeStateDocument(structuredClone(estado)))
  })

  it('chave opcional ausente NAO vira null', () => {
    const texto = serializeStateDocument(emptyState())
    assert.equal(texto.includes('null'), false)
    assert.deepEqual(Object.keys(JSON.parse(texto) as object), ['version', 'desiredState'])
  })

  it('sobrevive a uma ida e volta pelo disco (round-trip)', () => {
    const estado: PersistedState = {
      version: 1,
      desiredState: 'READY',
      secretDigest: DIGEST,
      tunnel: { pid: 99, startedAt: clock.now(), mode: 'named' },
    }
    const lido = parseStateDocument(serializeStateDocument(estado), FONTE)
    assert.equal(lido.desiredState, 'READY')
    assert.equal(lido.secretDigest, DIGEST)
    assert.deepEqual(lido.tunnel, { pid: 99, startedAt: clock.now(), mode: 'named' })
    assert.equal(lido.restricted, undefined)
    assert.equal(lido.pairing, undefined)
  })
})

describe('um ficheiro que existe e nao le PARA o arranque', () => {
  it('vazio ou so espacos e CORRUPCAO, nao primeiro arranque', () => {
    recusa('')
    recusa('   \n\t ')
  })

  it('JSON invalido', () => {
    recusa('{"version": 1,')
    recusa('nao sou json')
  })

  it('o documento tem de ser um objeto', () => {
    recusa('[]')
    recusa('null')
    recusa('42')
    recusa('"texto"')
  })

  it('sem `version` nao se sabe que forma o ficheiro tem', () => {
    recusa('{"desiredState":"READY"}')
    recusa('{"version":"1","desiredState":"READY"}')
    recusa('{"version":0,"desiredState":"READY"}')
  })

  it('uma versao FUTURA nao se degrada por adivinhacao', () => {
    recusa('{"version":2,"desiredState":"READY"}', 'STATE_VERSION_UNSUPPORTED')
  })

  it('chave desconhecida no topo e erro (a proxima escrita apaga-la-ia)', () => {
    recusa('{"version":1,"desiredState":"READY","tunnelUrl":"https://x.trycloudflare.com"}')
  })

  it('chave desconhecida DENTRO de um sub-objeto tambem', () => {
    recusa('{"version":1,"desiredState":"READY","tunnel":{"pid":1,"startedAt":0,"mode":"quick","url":"x"}}')
  })

  it('desiredState so pode ser READY ou STOPPED', () => {
    recusa('{"version":1,"desiredState":"FAILED"}')
    recusa('{"version":1}')
  })

  it('secretDigest tem de ser hex minusculo de 64 (reutiliza o validador de src/brand.ts)', () => {
    recusa(`{"version":1,"desiredState":"STOPPED","secretDigest":"${'A'.repeat(64)}"}`)
    recusa(`{"version":1,"desiredState":"STOPPED","secretDigest":"${'a'.repeat(63)}"}`)
    recusa('{"version":1,"desiredState":"STOPPED","secretDigest":123}')
    assert.doesNotThrow(() =>
      parseStateDocument(`{"version":1,"desiredState":"STOPPED","secretDigest":"${DIGEST}"}`, FONTE),
    )
  })

  it('restricted so aceita o motivo do contrato', () => {
    recusa('{"version":1,"desiredState":"STOPPED","restricted":{"since":1,"reason":"porque-sim"}}')
    recusa('{"version":1,"desiredState":"STOPPED","restricted":{"since":-1,"reason":"brute-force-ceiling"}}')
    recusa('{"version":1,"desiredState":"STOPPED","restricted":"sim"}')
  })

  it('tunnel.pid < 1 e recusado: 0 designaria o GRUPO e -1 TODOS os processos', () => {
    recusa('{"version":1,"desiredState":"STOPPED","tunnel":{"pid":0,"startedAt":0,"mode":"quick"}}')
    recusa('{"version":1,"desiredState":"STOPPED","tunnel":{"pid":-1,"startedAt":0,"mode":"quick"}}')
    recusa('{"version":1,"desiredState":"STOPPED","tunnel":{"pid":1.5,"startedAt":0,"mode":"quick"}}')
    recusa('{"version":1,"desiredState":"STOPPED","tunnel":{"pid":1,"startedAt":0,"mode":"lento"}}')
  })

  it('pairing no formato LEGADO (number): chat NEGATIVO e legitimo, ownerUserId <= 0 nao', () => {
    const comGrupo = parseStateDocument(
      '{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":5,"ownerChatId":-1001,"pairedAt":0}}',
      FONTE,
    )
    // MIGRACAO ADITIVA (EMENDA ONDA-1-IPC-ENVELOPE-STRING): o numero legado
    // normaliza para string na memoria — o formato canonico passou a ser string.
    assert.deepEqual(comGrupo.pairing, { ownerUserId: '5', ownerChatId: '-1001', pairedAt: 0 })
    recusa('{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":0,"ownerChatId":1,"pairedAt":0}}')
  })

  it('pairing no formato NOVO (string): qualquer id nao vazio e aceite, vazio nao', () => {
    const lido = parseStateDocument(
      '{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":"1057992969437413409","ownerChatId":"-1001234567890","pairedAt":0}}',
      FONTE,
    )
    assert.deepEqual(lido.pairing, {
      ownerUserId: '1057992969437413409',
      ownerChatId: '-1001234567890',
      pairedAt: 0,
    })
    // A politica minima e trim + nao vazio (espelho do normalizeKey do worker):
    // um id de so espacos nao designa ninguem.
    recusa('{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":"  ","ownerChatId":"1","pairedAt":0}}')
    recusa('{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":"1","ownerChatId":"","pairedAt":0}}')
    // Um valor que nao e nem numero legado nem string nova e corrupcao.
    recusa('{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":true,"ownerChatId":"1","pairedAt":0}}')
  })
})

describe('a mensagem do estado corrompido e ACIONAVEL, e nao vaza conteudo', () => {
  it('nomeia o ficheiro, o risco e o passo seguinte', () => {
    const conteudo = `{"version":1,"desiredState":"STOPPED","secretDigest":"${DIGEST}",`
    const erro = capturar(() => parseStateDocument(conteudo, FONTE))
    assert.equal(erro.code, 'STATE_CORRUPT')
    assert.match(erro.message, /STATE_CORRUPT/u)
    assert.match(erro.message, /\/nao\/existe\/state\.json/u)
    assert.match(erro.message, /secretDigest/u)
    assert.match(erro.message, /pairing/u)
    assert.match(erro.message, /rm \/nao\/existe\/state\.json/u)
    assert.match(erro.message, /onboarding/u)
    // Q-4: o conteudo do ficheiro NUNCA entra na mensagem — ela vai para o log
    // do host, ao lado do de outros plugins.
    assert.equal(erro.message.includes(DIGEST), false)
  })

  it('a versao futura instrui a ACTUALIZAR, nao a apagar', () => {
    const erro = capturar(() => parseStateDocument('{"version":9,"desiredState":"READY"}', FONTE))
    assert.equal(erro.code, 'STATE_VERSION_UNSUPPORTED')
    assert.match(erro.message, /versao mais recente/u)
    assert.match(erro.message, /Actualize o plugin/u)
  })
})

describe('parsePersistedState valida tambem a SAIDA do callback de update()', () => {
  it('recusa um estado montado a mao que nao respeita o contrato', () => {
    assert.throws(
      () => parsePersistedState({ version: 1, desiredState: 'LIGADO' }, FONTE),
      esperaCodigo('STATE_CORRUPT'),
    )
    assert.throws(() => parsePersistedState('nao sou objeto', FONTE), esperaCodigo('STATE_CORRUPT'))
  })

  it('normaliza: o resultado nunca leva chaves a mais', () => {
    const lido = parsePersistedState({ version: 1, desiredState: 'READY' }, FONTE)
    assert.deepEqual(Object.keys(lido).toSorted(), [
      'desiredState',
      'pairing',
      'restricted',
      'secretDigest',
      'tunnel',
      'version',
    ])
    assert.equal(lido.secretDigest, undefined)
  })
})

describe('`provider` persistido (D3) -- aditivo e fechado', () => {
  it('um state v1 sem `provider` continua a ler: ausente = telegram -, nada quebra', () => {
    const lido = parseStateDocument('{"version":1,"desiredState":"READY"}', FONTE)
    assert.equal(lido.provider, undefined)
    assert.deepEqual(Object.keys(lido).toSorted(), [
      'desiredState',
      'pairing',
      'restricted',
      'secretDigest',
      'tunnel',
      'version',
    ])
  })

  it('aceita o unico literal fechado, `telegram`', () => {
    const lido = parseStateDocument('{"version":1,"desiredState":"READY","provider":"telegram"}', FONTE)
    assert.equal(lido.provider, 'telegram')
  })

  it('recusa valor de provedor desconhecido -- nao se degrada por adivinhacao', () => {
    recusa('{"version":1,"desiredState":"READY","provider":"whatsapp"}')
    recusa('{"version":1,"desiredState":"READY","provider":42}')
  })

  it('emptyState nao ganha a chave: o default fechado e a AUSENCIA', () => {
    assert.deepEqual(emptyState(), { version: 1, desiredState: 'STOPPED' })
    assert.equal('provider' in emptyState(), false)
  })

  it('provider NULO e o default (ausencia), nao erro', () => {
    const lido = parseStateDocument('{"version":1,"desiredState":"STOPPED","provider":null}', FONTE)
    assert.equal(lido.provider, undefined)
  })

  it('sobrevive a uma ida e volta pelo disco', () => {
    const estado: PersistedState = { version: 1, desiredState: 'READY', provider: 'telegram' }
    const texto = serializeStateDocument(estado)
    assert.deepEqual(Object.keys(JSON.parse(texto) as object), ['version', 'desiredState', 'provider'])
    assert.equal(parseStateDocument(texto, FONTE).provider, 'telegram')
  })
})

describe('MIGRACAO ADITIVA do pareamento numerico -> string (EMENDA ONDA-1-IPC-ENVELOPE-STRING)', () => {
  it('um state.json v1 LEGADO (ids numericos) le, normaliza para string e grava string', () => {
    // O que um state.json da era V1 tinha no disco.
    const legado =
      '{"version":1,"desiredState":"READY","pairing":{"ownerUserId":42,"ownerChatId":-1001234567890,"pairedAt":2000}}'

    const lido = parseStateDocument(legado, FONTE)
    assert.deepEqual(lido.pairing, { ownerUserId: '42', ownerChatId: '-1001234567890', pairedAt: 2000 })

    // A proxima escrita grava o formato NOVO (string) — o disco migra sozinho
    // na primeira escrita, sem nenhum passo manual.
    const reescrito = serializeStateDocument(lido)
    assert.equal(reescrito.includes('"ownerUserId": "42"'), true)
    assert.equal(reescrito.includes('"ownerChatId": "-1001234567890"'), true)
    assert.equal(reescrito.includes('"ownerUserId": 42'), false, 'o numero legado NAO volta ao disco')
    assert.equal(reescrito.includes('"ownerChatId": -1001234567890'), false)
    // E o documento reescrito le de volta com a MESMA forma canonica.
    assert.deepEqual(parseStateDocument(reescrito, FONTE).pairing, lido.pairing)
  })

  it('parsePersistedState (a saida do callback de update) tambem normaliza numeros', () => {
    // O `update()` do store valida a SAIDA do callback por este caminho: um
    // callback que devolva o formato legado e aceite e canonizado para string.
    const saida = parsePersistedState(
      {
        version: 1,
        desiredState: 'STOPPED',
        pairing: { ownerUserId: 7, ownerChatId: -1_001, pairedAt: 0 },
      },
      FONTE,
    )
    assert.deepEqual(saida.pairing, { ownerUserId: '7', ownerChatId: '-1001', pairedAt: 0 })
  })
})

/* ========================================================================== */
/* EMENDA ONDA-1-IPC-ENVELOPE-STRING: bordas da migracao ADITIVA — o legado   */
/* numerico so migra o que nao perde precisao                                 */
/* ========================================================================== */

describe('a migracao aditiva NUNCA trunca um numero legado', () => {
  it('um inteiro fora de Number.MAX_SAFE_INTEGER no legado e CORRUPCAO, nao truncagem silenciosa', () => {
    // 2^53 nao e um inteiro seguro: `String(9007199254740992)` ainda acertaria,
    // mas 2^53 + 1 ja colapsaria para 9007199254740992 — e a migracao nao pode
    // adivinhar qual dos dois o disco tinha. Recusa-se: o dono inspeciona.
    recusa(
      '{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":9007199254740993,"ownerChatId":1,"pairedAt":0}}',
    )
    recusa(
      '{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":1,"ownerChatId":9007199254740993,"pairedAt":0}}',
    )
  })

  it('um numero NAO-inteiro no legado (1.5) e corrupcao — o piso de inteiro do formato v1 mantem-se', () => {
    recusa('{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":1.5,"ownerChatId":1,"pairedAt":0}}')
    recusa('{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":1,"ownerChatId":-100.5,"pairedAt":0}}')
  })

  it('`pairedAt` fracionado ou negativo no legado e corrupcao (as regras numericas de sempre)', () => {
    recusa('{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":1,"ownerChatId":1,"pairedAt":1.5}}')
    recusa('{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":1,"ownerChatId":1,"pairedAt":-1}}')
  })

  it('o chat legado ZERO (sem piso no eixo "onde") migra para "0"', () => {
    const lido = parseStateDocument(
      '{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":1,"ownerChatId":0,"pairedAt":0}}',
      FONTE,
    )
    assert.deepEqual(lido.pairing, { ownerUserId: '1', ownerChatId: '0', pairedAt: 0 })
  })
})

describe('a migracao aditiva — o formato NOVO (string) e a politica do schema', () => {
  it('um id string maior do que o teto do CODEX (64) e aceite no estado persistido', () => {
    // O teto MAX_ID_CHARS e do TRANSPORTE (o codec IPC); o state.json e local
    // e o normalizarEixoDoDono so exige trim + nao vazio — um id de provedor
    // futuro pode ser comprido sem contaminar a linha IPC.
    const longo = 'id-'.repeat(40) // 120 chars
    const lido = parseStateDocument(
      `{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":"${longo}","ownerChatId":"1","pairedAt":0}}`,
      FONTE,
    )
    assert.equal(lido.pairing?.ownerUserId, longo)
  })

  it('a forma canonica (string) round-tripa pelo disco sem voltar a numero', () => {
    const lido = parseStateDocument(
      '{"version":1,"desiredState":"STOPPED","pairing":{"ownerUserId":"1057992969437413409","ownerChatId":"-1001234567890","pairedAt":0}}',
      FONTE,
    )
    const reescrito = serializeStateDocument(lido)
    assert.equal(reescrito.includes('"ownerUserId": "1057992969437413409"'), true)
    assert.equal(reescrito.includes('"ownerUserId": 1057992969437413409'), false, 'nunca volta a numero')
    assert.deepEqual(parseStateDocument(reescrito, FONTE).pairing, lido.pairing)
  })
})

describe('bordas da versao do documento', () => {
  it('version fracionada e corrupcao (a versao tem de ser inteiro >= 1)', () => {
    recusa('{"version":1.5,"desiredState":"STOPPED"}')
    recusa('{"version":0.5,"desiredState":"STOPPED"}')
  })
})
