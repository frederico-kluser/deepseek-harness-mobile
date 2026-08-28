/**
 * E2E DO DISCORD — o PROCESSO REAL contra o duble (REST + gateway WS no
 * mesmo listener), no padrao de `telegram-boot.test.ts`.
 *
 * O worker e spawned com o ambiente CONSTRUIDO como o host o constroi, com
 * `DSH_GUARD_PROVIDER=discord`: o registry resolve o adaptador discord, o
 * gateway conecta (Hello -> Identify -> READY) e o processo fica vivo.
 *
 * Fluxos cobertos:
 *   1. boot feliz: identify no duble, READY, token fora do stderr, e o
 *      desligamento limpo pelo dead-man's switch (EOF no stdin -> exit 0);
 *   2. mensagem -> comando -> resposta: o teste semeia o dono pelo canal IPC
 *      (`pairing.owner` no stdin), enfileira um MESSAGE_CREATE `/status` no
 *      gateway, e o worker responde por `POST /channels/{id}/messages`;
 *   3. clique -> intent: um INTERACTION_CREATE com botao `g1:tunnel.up:<nonce>`
 *      faz o worker responder ao clique (callback type 6 — o girador para,
 *      TG-027) E enviar a `intent` pelo canal IPC (stdout JSONL);
 *   4. token em argv recusado (TG-069) e 401 no boot -> processo sai.
 */

import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'

import {
  aguardar,
  assertSemTokenRealNoAmbiente,
  chamadasDe,
  DONO,
  spawnWorkerDiscord,
  startFakeDiscord,
  TOKEN_DE_TESTE_DISCORD,
  type FakeDiscordE2E,
  type WorkerFilho,
} from './discord-apoio.ts'
import { WORKER_EXIT } from '../../worker/lib/errors.ts'

assertSemTokenRealNoAmbiente()

const abertos: FakeDiscordE2E[] = []
const filhos: WorkerFilho[] = []

after(async () => {
  for (const filho of filhos) await filho.parar()
  await Promise.all(abertos.map((srv) => srv.close()))
})

describe('e2e discord — boot do processo real', () => {
  it('identify -> READY; o processo fica vivo e sai limpo pelo dead-man switch (exit 0)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const filho = spawnWorkerDiscord({ srv })
    filhos.push(filho)

    await aguardar(() => srv.gatewayState.sessions >= 1, 'o identify chega e o READY volta')
    await aguardar(() => filho.stderr().includes('gateway pronto (READY)'), 'o worker loga o READY')

    // O token do identify viaja no corpo do gateway — e nunca para o stderr.
    assert.equal(srv.gatewayState.identify[0]?.['token'], TOKEN_DE_TESTE_DISCORD)
    assert.equal(filho.stderr().includes(TOKEN_DE_TESTE_DISCORD), false, 'o token nao aparece no stderr')

    // Desligamento limpo pelo canal REAL: EOF no stdin -> dead-man's switch.
    filho.encerrar()
    const saida = await filho.saida
    assert.equal(saida.pendurado, false, 'o processo saiu sozinho, sem kill de seguranca')
    assert.equal(saida.code, 0, 'EOF no stdin termina o processo (dead-man switch)')
  })

  it('mensagem -> comando /status -> resposta: o dono semeado pelo canal IPC responde via REST', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const filho = spawnWorkerDiscord({ srv })
    filhos.push(filho)

    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY')
    // O HOST semeia o dono pelo canal (os DOIS eixos, STRING — V2).
    filho.escrever({
      v: 2,
      type: 'pairing.owner',
      from: DONO.from,
      chat: DONO.chat,
      pairedAt: 1_700_000_000_000,
    })

    // O gateway entrega uma mensagem de texto do dono.
    srv.enfileirarEvento({
      t: 'MESSAGE_CREATE',
      d: {
        id: 'm1',
        channel_id: DONO.chat,
        author: { id: DONO.from },
        content: '/status',
      },
    })

    // O worker pede o estado ao HOST pela intent tunnel.status (JSONL no
    // stdout) e a RESPOSTA chega pelo ack — o teste faz o papel do host.
    await aguardar(() => filho.stdout().includes('"intent":"tunnel.status"'), 'a intent de status sai pelo canal')
    const linha = filho
      .stdout()
      .split('\n')
      .find((l) => l.includes('"intent":"tunnel.status"'))
    assert.ok(linha !== undefined)
    const requestId = (JSON.parse(linha) as { requestId?: string }).requestId
    assert.ok(requestId !== undefined && requestId !== '', 'a intent carrega o requestId')
    filho.escrever({
      v: 2,
      type: 'ack',
      requestId,
      result: 'accepted',
      state: 'STOPPED',
    })

    // O worker responde por POST /channels/{chat}/messages (o fio REST real).
    await aguardar(() => chamadasDe(srv, '/channels/').length >= 1, 'a resposta chega ao REST do duble')
    const enviada = chamadasDe(srv, '/channels/')[0]
    assert.ok(enviada !== undefined)
    assert.equal(enviada.method, 'POST')
    assert.equal(enviada.path, `/channels/${DONO.chat}/messages`)
    assert.equal(enviada.authorization, `Bot ${TOKEN_DE_TESTE_DISCORD}`)

    filho.encerrar()
    const saida = await filho.saida
    assert.equal(saida.code, 0)
  })

  it('clique em botao -> intent pelo canal + callback (o girador para, TG-027)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const filho = spawnWorkerDiscord({ srv })
    filhos.push(filho)

    await aguardar(() => srv.gatewayState.sessions >= 1, 'READY')
    filho.escrever({
      v: 2,
      type: 'pairing.owner',
      from: DONO.from,
      chat: DONO.chat,
      pairedAt: 1_700_000_000_000,
    })

    // O botao do cartao: custom_id na gramatica g1 (token opaco S5).
    srv.enfileirarEvento({
      t: 'INTERACTION_CREATE',
      d: {
        id: 'i100',
        type: 3,
        token: 'tok-interacao',
        channel_id: DONO.chat,
        user: { id: DONO.from },
        message: { id: 'm100', channel_id: DONO.chat },
        data: { custom_id: 'g1:tunnel.up:nonce-do-host', component_type: 2 },
      },
    })

    // A intent atravessa o canal IPC (JSONL no stdout) com as chaves STRING.
    await aguardar(() => filho.stdout().includes('"type":"intent"'), 'a intent sai pelo canal')
    const stdout = filho.stdout()
    assert.match(stdout, /"intent":"tunnel\.up"/u)
    assert.ok(stdout.includes(`"from":"${DONO.from}"`), 'o snowflake gigante atravessa BYTE A BYTE (D4)')
    assert.ok(stdout.includes(`"chat":"${DONO.chat}"`))

    // TG-027: o girador para — o callback com messageTarget (o botao vive na
    // mensagem m100) e type 7 (UPDATE_MESSAGE, DISCORD-027); sem data, a
    // mensagem fica intacta e a edicao real vem pelo PATCH separado.
    await aguardar(() => chamadasDe(srv, '/interactions/').length >= 1, 'o callback chega ao REST')
    assert.deepEqual(chamadasDe(srv, '/interactions/')[0]?.body, { type: 7 })

    filho.encerrar()
    const saida = await filho.saida
    assert.equal(saida.code, 0)
  })

  it('um token em argv e recusado pelo PROCESSO REAL, fail-closed (TG-069)', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    const filho = spawnWorkerDiscord({ srv, argvExtra: ['--token', TOKEN_DE_TESTE_DISCORD] })
    filhos.push(filho)

    const saida = await filho.saida
    // O veredito e TERMINAL e fail-closed (recusa o arranque, nao conecta).
    // Com o boot generico por CODIGO (Onda 3-fix), o fatal do discord sai com
    // o codigo CERTO: 10 (CONFIG) — antes caia em 13 (POLLING_FAILED) por o
    // boot classificar por `instanceof` da classe do telegram.
    assert.equal(saida.code, WORKER_EXIT.CONFIG, 'token em argv = CONFIG (10), nao instabilidade')
    assert.equal(srv.gatewayState.sessions, 0, 'nem chegou a falar com o gateway')
    assert.match(filho.stderr(), /TOKEN_IN_ARGV/u)
    assert.equal(filho.stderr().includes(TOKEN_DE_TESTE_DISCORD), false, 'a recusa nao vaza o que recusa')
  })

  it('401 no boot (GET /gateway/bot recusa o token): o processo SAI com veredito', async () => {
    const srv = await startFakeDiscord()
    abertos.push(srv)
    srv.queueError('gateway', { status: 401, body: { message: '401: Unauthorized', code: 0 } })
    const filho = spawnWorkerDiscord({ srv })
    filhos.push(filho)

    const saida = await filho.saida
    assert.equal(saida.pendurado, false, 'sai sozinho, sem kill de seguranca')
    assert.equal(saida.code, WORKER_EXIT.UNAUTHORIZED, '401 no boot = 12, espelho do telegram')
    assert.match(filho.stderr(), /GATEWAY_UNAUTHORIZED|token foi recusado/u)
    assert.equal(filho.stderr().includes(TOKEN_DE_TESTE_DISCORD), false, 'o token nao vaza')
  })
})
