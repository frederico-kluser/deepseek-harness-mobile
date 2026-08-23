/**
 * T6.2 — o boot do PROCESSO REAL contra o servidor falso, apontado por
 * `apiRoot` (S5 do spike da Onda 0: o grammY aceita `apiRoot` e redireciona
 * mesmo as chamadas).
 *
 * O que os unitarios de `test/unit/worker/lib/polling.test.ts` provam com o
 * `bot` montado em processo, este ficheiro prova com o worker a correr:
 * `worker/telegram-bot.ts` spawned com o `node` do repositorio, com a costura
 * de producao ligada e o ambiente construido como o host o constroi.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  aguardar,
  assertSemTokenRealNoAmbiente,
  chamadasDe,
  startFakeBotApi,
  spawnWorkerProcess,
  TOKEN_DE_TESTE,
  type FakeBotApi,
  type WorkerFilho,
} from './telegram-apoio.ts'
import { LONG_POLL_MAX_TIMEOUT } from '../../worker/providers/telegram/polling.ts'

assertSemTokenRealNoAmbiente()

const abertos: FakeBotApi[] = []
const filhos: WorkerFilho[] = []

after(async () => {
  for (const filho of filhos) await filho.parar()
  await Promise.all(abertos.map((srv) => srv.close()))
})

describe('e2e boot — sequencia do processo real', () => {
  it('getMe -> deleteWebhook{drop_pending_updates:true} -> getUpdates; token na URL, fora do stderr', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const filho = spawnWorkerProcess({ srv })
    filhos.push(filho)

    await aguardar(() => chamadasDe(srv, 'getUpdates').length >= 1, 'primeiro getUpdates')

    // A costura de producao publicou a lista de comandos; o boot seguiu.
    const ordem = srv.calls.map((c) => c.method)
    assert.ok(ordem.includes('setmycommands'), 'a costura de producao correu (setMyCommands)')
    const idxMe = ordem.indexOf('getme')
    const idxDel = ordem.indexOf('deletewebhook')
    const idxGu = ordem.indexOf('getupdates')
    assert.ok(idxMe !== -1 && idxDel !== -1 && idxGu !== -1, `chamadas de boot presentes: ${ordem.join(',')}`)
    assert.ok(idxMe < idxDel, 'getMe antes de deleteWebhook')
    assert.ok(idxDel < idxGu, 'deleteWebhook antes do primeiro getUpdates')

    // TG-045: drop_pending_updates no SITIO CERTO — deleteWebhook, nunca getUpdates.
    const deletes = chamadasDe(srv, 'deleteWebhook')
    assert.equal(deletes.length, 1, 'exatamente um deleteWebhook, no boot')
    assert.equal(deletes[0]?.payload['drop_pending_updates'], true)
    for (const call of chamadasDe(srv, 'getUpdates')) {
      assert.equal(
        Object.hasOwn(call.payload, 'drop_pending_updates'),
        false,
        'drop_pending_updates NAO e parametro de getUpdates; se aparecer aqui, copiou-se a doc errada',
      )
    }

    // TG-046/047: o primeiro getUpdates e explicito e dentro dos tectos do servidor.
    const primeiro = chamadasDe(srv, 'getUpdates')[0]
    assert.ok(primeiro !== undefined)
    assert.deepEqual(
      primeiro.payload['allowed_updates'],
      ['message', 'callback_query'],
      'allowed_updates ENVIADO: omitido, o servidor manteria a configuracao anterior',
    )
    assert.equal(primeiro.payload['timeout'], LONG_POLL_MAX_TIMEOUT, 'timeout = 50, o tecto do servidor')
    assert.equal(primeiro.payload['limit'], 100)

    // O token viaja no CAMINHO da URL — e mesmo assim nao aparece no stderr.
    assert.equal(srv.calls[0]?.token, TOKEN_DE_TESTE)

    // Desligamento limpo pelo canal REAL: EOF no stdin -> dead-man's switch.
    filho.encerrar()
    const saida = await filho.saida
    assert.equal(saida.pendurado, false, 'o processo saiu sozinho, sem kill de seguranca')
    assert.equal(saida.code, 0, 'EOF no stdin termina o processo (dead-man switch)')
    assert.equal(filho.stderr().includes(TOKEN_DE_TESTE), false, 'o token nao aparece no stderr')
  })

  it('um token em argv e recusado pelo PROCESSO REAL, fail-closed (TG-069)', async () => {
    const srv = await startFakeBotApi()
    abertos.push(srv)
    const filho = spawnWorkerProcess({ srv, argvExtra: ['--token', TOKEN_DE_TESTE] })
    filhos.push(filho)

    const saida = await filho.saida
    assert.equal(saida.code, 10, 'CONFIG: token em argv recusa o arranque, nao e instabilidade')
    assert.equal(chamadasDe(srv, 'getMe').length, 0, 'nem chegou a falar com o servidor')
    assert.match(filho.stderr(), /TOKEN_IN_ARGV/u)
    assert.equal(filho.stderr().includes(TOKEN_DE_TESTE), false, 'a recusa nao vaza o que recusa')
  })
})
