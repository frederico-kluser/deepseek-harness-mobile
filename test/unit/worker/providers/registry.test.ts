/**
 * `worker/providers/registry.ts` — a resolucao do provedor e a ponte de intent.
 *
 * DONO: Onda 4. Testa os DOIS contratos de saida:
 *   1. {@link resolverProvedor}: ausente->telegram, telegram explicito, valor
 *      desconhecido -> falha CLARA (fail-closed, nunca degrada em silencio).
 *   2. {@link montarEnvelopeDeIntent}: a ponte monta o `IpcIntentMessage`
 *      COMPLETO com `v`/`type`/`from`/`chat` NUMERICOS, a partir das chaves
 *      STRING neutras (o PORQUE: envelope IPC V1 numerico — ver o ficheiro).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  criarPonteDeNonce,
  criarSurfaceIpcBridge,
  DEFAULT_PROVIDER_ID,
  montarEnvelopeDeIntent,
  ProvedorDesconhecidoError,
  PROVIDERS,
  resolverProvedor,
  WORKER_PROVIDER_ENV_VAR,
  type IntencaoNeutra,
} from '../../../../worker/providers/registry.ts'
import type { TimeSource } from '../../../../worker/lib/clock.ts'
import type { WorkerLogger } from '../../../../worker/lib/log.ts'
import type { WorkerIpc } from '../../../../worker/ipc.ts'

const ARGV_LIMPO = ['/usr/bin/node', '/pacote/dist/worker/telegram-bot.js']

/** Logger que descarta — a ponte de nonce so regista em caminhos de falha. */
function loggerMudo(): WorkerLogger {
  return { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
}

describe('worker/providers/registry — resolucao do provedor (fail-closed)', () => {
  it('variavel ausente -> default `telegram` (D1: quem corre sem provider e o telegram)', () => {
    const prov = resolverProvedor({})
    assert.equal(prov.id, DEFAULT_PROVIDER_ID)
    assert.equal(prov.id, 'telegram')
  })

  it('variavel presente mas vazia/so espacos -> default `telegram`', () => {
    assert.equal(resolverProvedor({ [WORKER_PROVIDER_ENV_VAR]: '' }).id, 'telegram')
    assert.equal(resolverProvedor({ [WORKER_PROVIDER_ENV_VAR]: '   ' }).id, 'telegram')
  })

  it('telegram explicito resolve para a tabela (e o create e o do telegram)', () => {
    const prov = resolverProvedor({ [WORKER_PROVIDER_ENV_VAR]: 'telegram' })
    assert.equal(prov.id, 'telegram')
    assert.equal(PROVIDERS.telegram, prov, 'a tabela e a unica fonte da descricao')
  })

  it('valor desconhecido -> erro CLARO (fail-closed, nao degrada para o default)', () => {
    assert.throws(
      () => resolverProvedor({ [WORKER_PROVIDER_ENV_VAR]: 'whatsapp' }),
      (error: unknown) => {
        if (!(error instanceof ProvedorDesconhecidoError)) {
          assert.fail('o erro tem de ser ProvedorDesconhecidoError')
        }
        assert.match(error.message, /whatsapp/u)
        assert.match(error.message, /telegram/u, 'nomeia os antecipados')
        assert.match(error.message, /DSH_GUARD_PROVIDER/u, 'nomeia a variavel')
        return true
      },
    )
  })

  it('cada descricao traz o que o boot genericamente usa (token + assert + create)', () => {
    const prov = resolverProvedor({ [WORKER_PROVIDER_ENV_VAR]: 'telegram' })
    assert.equal(typeof prov.lerToken, 'function')
    assert.equal(typeof prov.assertTokenNaoEmArgv, 'function')
    assert.equal(typeof prov.create, 'function')
    // O assert do telegram recusa um token em argv (TG-069) — contrato vivo.
    assert.throws(() => prov.assertTokenNaoEmArgv([...ARGV_LIMPO, '--token', provToken()]))
  })
})

function provToken(): string {
  return '123456789:AAHfalso-so-para-teste_0123456789abcd'
}

describe('worker/providers/registry — a ponte de intent monta o envelope numerico', () => {
  it('monta v:1, type:intent, e from/chat NUMERICOS a partir das chaves string', () => {
    const envelope = montarEnvelopeDeIntent({
      intent: 'tunnel.up',
      requestId: '01HZ0000000000000000000000',
      userKey: '123456',
      chatKey: '78910',
    })

    assert.equal(envelope.v, 1)
    assert.equal(envelope.type, 'intent')
    assert.equal(envelope.intent, 'tunnel.up')
    assert.equal(envelope.requestId, '01HZ0000000000000000000000')
    assert.equal(typeof envelope.from, 'number')
    assert.equal(envelope.from, 123456)
    assert.equal(typeof envelope.chat, 'number')
    assert.equal(envelope.chat, 78910)
    assert.equal('nonce' in envelope, false, 'sem nonce, o campo NAO aparece')
  })

  it('carrega o nonce opaco quando presente (S5: transporta, nao interpreta)', () => {
    const envelope = montarEnvelopeDeIntent({
      intent: 'secret.rotate',
      requestId: '01HZ1111111111111111111111',
      userKey: '111',
      chatKey: '222',
      nonce: 'abc-xyz-nonce-opaco',
    })

    assert.equal(envelope.nonce, 'abc-xyz-nonce-opaco')
  })

  it('o provisor numerico e fiel ao alfabeto do Telegram (`[0-9]+`)', () => {
    // `Number` de uma string de digitos e exacto; o contrato exige SafeInteger.
    const envelope = montarEnvelopeDeIntent({
      intent: 'emergency',
      requestId: '01HZ2222222222222222222222',
      userKey: '9007199254740991',
      chatKey: '42',
    })
    assert.equal(envelope.from, 9007199254740991)
    assert.equal(envelope.chat, 42)
  })
})

describe('worker/providers/registry — a ponte de intent REAL (criarSurfaceIpcBridge)', () => {
  it('aceita UMA intent NEUTRA e envia o envelope NUMERICO montado pelo canal WorkerIpc', () => {
    let enviado: Parameters<WorkerIpc['send']>[0] | undefined
    const ipc: WorkerIpc = {
      send: (m) => {
        enviado = m
        return true
      },
      log: () => undefined,
      dispose: () => undefined,
    }
    const bridge = criarSurfaceIpcBridge(ipc)
    const pedido: IntencaoNeutra = {
      intent: 'tunnel.up',
      requestId: '01HZ3333333333333333333333',
      userKey: '555',
      chatKey: '666',
    }

    const aceite = bridge.send(pedido)

    assert.equal(aceite, true)
    assert.deepEqual(enviado, montarEnvelopeDeIntent(pedido), 'o envelope numerico e montado pela ponte')
    assert.notEqual(enviado, pedido, 'a ponte monta um IpcIntentMessage NOVO; a intent neutra nao e o envelope')
  })

  it('devolve false quando o canal recusa (host indisponivel/fila cheia)', () => {
    const ipc: WorkerIpc = {
      send: () => false,
      log: () => undefined,
      dispose: () => undefined,
    }
    const bridge = criarSurfaceIpcBridge(ipc)
    assert.equal(
      bridge.send({ intent: 'tunnel.down', requestId: 'x', userKey: '1', chatKey: '2' }),
      false,
    )
  })
})

describe('worker/providers/registry — a ponte de nonce (EMENDA-COSTURA-5)', () => {
  /** Relogio + espera que SO anda quando o teste pedir. */
  class RelogioVazio implements TimeSource {
    agora = 0
    now(): number {
      return this.agora
    }
    async sleep(ms: number): Promise<void> {
      this.agora += ms
    }
  }

  it('`tunnel.up` pede `nonce.request` (acao start) e `nonce.issued` resolve o nonce', async () => {
    const enviados: Array<{ type: string; acao?: string; requestId?: string }> = []
    const ipc: WorkerIpc = {
      send: (m) => {
        enviados.push(m as { type: string; acao?: string; requestId?: string })
        return true
      },
      log: () => undefined,
      dispose: () => undefined,
    }
    const relogio = new RelogioVazio()
    const ponte = criarPonteDeNonce({ log: loggerMudo(), time: relogio, ipc })

    const pedido = ponte.emitir('tunnel.up')
    const pedidoEnviado = enviados[0]
    assert.ok(pedidoEnviado !== undefined, 'o pedido saiu do canal')
    assert.equal(pedidoEnviado.type, 'nonce.request')
    assert.equal(pedidoEnviado.acao, 'start')

    // O host responde `nonce.issued` com o MESMO requestId — a ponte resolve.
    const resolvido = ponte.onMessage({
      v: 1,
      type: 'nonce.issued',
      acao: 'start',
      requestId: pedidoEnviado.requestId ?? '',
      nonce: 'nonce-opaco',
      expiresAt: 1,
    })

    assert.equal(resolvido, true, 'a mensagem foi consumida pela ponte')
    assert.equal(await pedido, 'nonce-opaco')
  })

  it('falha FECHADO por timeout: sem `nonce.issued` a tempo resolve undefined (CTL-023)', async () => {
    const ipc: WorkerIpc = { send: () => true, log: () => undefined, dispose: () => undefined }
    const relogio = new RelogioVazio()
    const ponte = criarPonteDeNonce({ log: loggerMudo(), time: relogio, ipc })

    const pedido = ponte.emitir('tunnel.up')
    // A espera do timeout anda so quando o relogio anda 5000 ms.
    relogio.agora += 5_000

    assert.equal(await pedido, undefined, 'sem nonce a tempo, a confirmacao fica indisponivel')
  })

  it('`secret.rotate` pede `reset` (a acao destrutiva regenera o segredo)', () => {
    const enviados: Array<{ acao?: string }> = []
    const ipc: WorkerIpc = {
      send: (m) => {
        enviados.push(m as { acao?: string })
        return true
      },
      log: () => undefined,
      dispose: () => undefined,
    }
    const ponte = criarPonteDeNonce({ log: loggerMudo(), time: new RelogioVazio(), ipc })
    void ponte.emitir('secret.rotate')
    assert.equal(enviados[0]?.acao, 'reset')
  })
})