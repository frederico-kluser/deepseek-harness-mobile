/**
 * `worker/providers/registry.ts` — a resolucao do provedor e a ponte de intent.
 *
 * DONO: Onda 4. Testa os DOIS contratos de saida:
 *   1. {@link resolverProvedor}: ausente->telegram, telegram explicito, valor
 *      desconhecido -> falha CLARA (fail-closed, nunca degrada em silencio).
 *   2. {@link montarEnvelopeDeIntent}: a ponte monta o `IpcIntentMessage`
 *      COMPLETO com `v:2` e `from`/`chat` STRING, passando as chaves neutras
 *      adiante SEM conversao (EMENDA ONDA-1-IPC-ENVELOPE-STRING — o envelope
 *      V1 numerico morreu; ids nao-numericos atravessam intactos).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  criarPonteDeNonce,
  criarSurfaceIpcBridge,
  NONCE_REQUEST_TIMEOUT_MS,
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
        assert.match(error.message, /discord/u, 'nomeia os antecipados')
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
    // Onda 3-fix: cada provedor declara a SUA env de raiz da API — o boot le
    // `env[apiRootVar]` e nunca passa a env de outro canal ao create.
    assert.equal(prov.apiRootVar, 'TELEGRAM_API_ROOT')
    // O assert do telegram recusa um token em argv (TG-069) — contrato vivo.
    assert.throws(() => prov.assertTokenNaoEmArgv([...ARGV_LIMPO, '--token', provToken()]))
  })
})

function provToken(): string {
  return '123456789:AAHfalso-so-para-teste_0123456789abcd'
}

describe('worker/providers/registry — discord REGISTRADO (Onda 3)', () => {
  it('discord explicito resolve para a tabela (e o create e o do discord)', () => {
    const prov = resolverProvedor({ [WORKER_PROVIDER_ENV_VAR]: 'discord' })
    assert.equal(prov.id, 'discord')
    assert.equal(PROVIDERS.discord, prov, 'a tabela e a unica fonte da descricao')
    assert.equal(typeof prov.create, 'function')
    assert.equal(typeof prov.lerToken, 'function')
    assert.equal(typeof prov.assertTokenNaoEmArgv, 'function')
    assert.equal(prov.apiRootVar, 'DISCORD_API_ROOT')
  })

  it('o lerToken do discord le a SUA variavel (DISCORD_BOT_TOKEN), nao a do telegram', () => {
    const prov = resolverProvedor({ [WORKER_PROVIDER_ENV_VAR]: 'discord' })
    assert.throws(() => prov.lerToken({}), /DISCORD_BOT_TOKEN/u)
    assert.equal(
      prov.lerToken({ DISCORD_BOT_TOKEN: '  token-do-discord  ' }),
      'token-do-discord',
    )
  })

  it('o assert do discord recusa um token com FORMA discord em argv (TG-069)', () => {
    const prov = resolverProvedor({ [WORKER_PROVIDER_ENV_VAR]: 'discord' })
    assert.throws(() =>
      prov.assertTokenNaoEmArgv([...ARGV_LIMPO, 'MzQ0NTAzMDA4MzYyODU0NzE2OTk1Njk3OTIzNDU2Nzg5MDEyMzQ1Ng']),
    )
  })

  it('a tabela continua fechada: telegram e discord, e so', () => {
    assert.deepEqual(Object.keys(PROVIDERS).toSorted(), ['discord', 'telegram'])
  })
})

describe('worker/providers/registry — a ponte de intent monta o envelope STRING (V2)', () => {
  it('monta v:2, type:intent, e from/chat STRING a partir das chaves string', () => {
    const envelope = montarEnvelopeDeIntent({
      intent: 'tunnel.up',
      requestId: '01HZ0000000000000000000000',
      userKey: '123456',
      chatKey: '78910',
    })

    assert.equal(envelope.v, 2)
    assert.equal(envelope.type, 'intent')
    assert.equal(envelope.intent, 'tunnel.up')
    assert.equal(envelope.requestId, '01HZ0000000000000000000000')
    assert.equal(typeof envelope.from, 'string')
    assert.equal(envelope.from, '123456')
    assert.equal(typeof envelope.chat, 'string')
    assert.equal(envelope.chat, '78910')
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

  it('EMENDA ONDA-5: os params de agente viajam no envelope (dispatch/cancel)', () => {
    const envelope = montarEnvelopeDeIntent({
      intent: 'agent.dispatch',
      requestId: '01HZ4444444444444444444444',
      userKey: '111',
      chatKey: '222',
      nonce: 'nonce-opaco',
      params: { skill: 'eco', prompt: 'diz oi' },
    })
    assert.deepEqual(envelope.params, { skill: 'eco', prompt: 'diz oi' })

    const cancel = montarEnvelopeDeIntent({
      intent: 'agent.cancel',
      requestId: '01HZ5555555555555555555555',
      userKey: '111',
      chatKey: '222',
      params: { agentId: '01HZABCD' },
    })
    assert.deepEqual(cancel.params, { agentId: '01HZABCD' })
    // Sem params, o campo NAO aparece (a forma e aditiva).
    const status = montarEnvelopeDeIntent({
      intent: 'agent.status',
      requestId: '01HZ6666666666666666666666',
      userKey: '111',
      chatKey: '222',
    })
    assert.equal('params' in status, false, 'agent.status nao transporta params')
  })

  it('um id NAO-numerico (snowflake do Discord) atravessa INTACTO — sem Number(...) nem NaN', () => {
    // 1057992969437413409 > Number.MAX_SAFE_INTEGER: o antigo `Number(userKey)`
    // da V1 perdia precisao silenciosamente. Em V2 nao ha conversao.
    const envelope = montarEnvelopeDeIntent({
      intent: 'emergency',
      requestId: '01HZ2222222222222222222222',
      userKey: '1057992969437413409',
      chatKey: '-1001234567890',
    })
    assert.equal(envelope.from, '1057992969437413409')
    assert.equal(envelope.chat, '-1001234567890')
    assert.equal(Number.isNaN(Number(envelope.from)), false)
    assert.equal(String(Number(envelope.from)) === envelope.from, false, 'o cast numerico PERDERIA o valor — prova de que a string e o formato certo')
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
    assert.deepEqual(enviado, montarEnvelopeDeIntent(pedido), 'o envelope string (V2) e montado pela ponte')
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
      v: 2,
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

  it('EMENDA ONDA-5: `agent.dispatch` pede `reset` (a MESMA acao do /rotacionar)', () => {
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
    void ponte.emitir('agent.dispatch')
    assert.equal(enviados[0]?.acao, 'reset', 'o host consome o nonce do dispatch com reset')
  })

  it('EMENDA ONDA-5: `agent.cancel` NAO pede nonce (CTL-024 — cancela REDUZ exposicao)', async () => {
    const enviados: Array<{ acao?: string }> = []
    const linhas: string[] = []
    const ipc: WorkerIpc = {
      send: (m) => {
        enviados.push(m as { acao?: string })
        return true
      },
      log: () => undefined,
      dispose: () => undefined,
    }
    const ponte = criarPonteDeNonce({
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: (mensagem) => {
          linhas.push(mensagem)
        },
        error: () => undefined,
      },
      time: new RelogioVazio(),
      ipc,
    })

    const nonce = await ponte.emitir('agent.cancel')

    assert.equal(nonce, undefined, 'sem nonce, a confirmacao do cancel nao existe')
    assert.equal(enviados.length, 0, 'nenhum `nonce.request` para a acao que reduz')
    assert.match(linhas.join('\n'), /acao sem nonce: agent.cancel/u)
  })
})
/* ========================================================================== */
/* EMENDA ONDA-1-IPC-ENVELOPE-STRING: `pairingSuccess` da ponte monta o       */
/* `pairing.success` STRING (V2) — os dois eixos SEM `Number(...)`            */
/* ========================================================================== */

describe('worker/providers/registry — pairingSuccess monta o envelope STRING (V2)', () => {
  it('envia {v:2, type:pairing.success, from/chat string, pairedAt fiel} pelo canal', () => {
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

    bridge.pairingSuccess({
      userKey: '1057992969437413409',
      chatKey: '-1001234567890',
      pairedAt: 1_700_000_000_000,
    })

    assert.deepEqual(enviado, {
      v: 2,
      type: 'pairing.success',
      from: '1057992969437413409',
      chat: '-1001234567890',
      pairedAt: 1_700_000_000_000,
    })
    // A prova de que nao ha `Number(...)` na ponte: o deepEqual acima ja fixou
    // a string INTACTA no canal — e o cast numerico da mesma snowflake trunca
    // o valor (arredondaria para ...400), ou seja, uma conversao na ponte
    // teria sido visivel. A string e o formato certo, por construcao.
    assert.equal(String(Number('1057992969437413409')), '1057992969437413400', 'o cast numerico trunca')
  })

  it('best-effort (S4): o retorno do canal nao e observado — o aviso nao derruba a ponte', () => {
    const ipc: WorkerIpc = {
      send: () => false,
      log: () => undefined,
      dispose: () => undefined,
    }
    const bridge = criarSurfaceIpcBridge(ipc)
    // `pairingSuccess` devolve void: o handshake e fire-and-forget; quem
    // re-pareia depois re-envia. O que importa e NAO lancar.
    assert.doesNotThrow(() =>
      bridge.pairingSuccess({ userKey: '1', chatKey: '2', pairedAt: 1 }),
    )
  })
})

/* ========================================================================== */
/* EMENDA-COSTURA-5: os caminhos restantes da ponte de nonce                  */
/* ========================================================================== */

describe('worker/providers/registry — a ponte de nonce, caminhos de falha e de consumo', () => {
  class RelogioVazio implements TimeSource {
    agora = 0
    now(): number {
      return this.agora
    }
    async sleep(ms: number): Promise<void> {
      this.agora += ms
    }
  }

  it('a constante do timeout esta exportada (fail-closed: sem resposta a tempo, undefined)', () => {
    assert.equal(NONCE_REQUEST_TIMEOUT_MS, 5_000)
  })

  it('acao SEM nonce (tunnel.down/status): avisa, NAO envia nada e resolve undefined', async () => {
    const enviados: Array<{ type: string }> = []
    const avisos: string[] = []
    const ipc: WorkerIpc = {
      send: (m) => {
        enviados.push(m as { type: string })
        return true
      },
      log: () => undefined,
      dispose: () => undefined,
    }
    const log: WorkerLogger = {
      debug: () => undefined,
      info: () => undefined,
      error: () => undefined,
      warn: (mensagem: string) => void avisos.push(mensagem),
    }
    const ponte = criarPonteDeNonce({ log, time: new RelogioVazio(), ipc })

    assert.equal(await ponte.emitir('tunnel.down'), undefined, 'nao ha nonce para reduzir exposicao (CTL-024)')
    assert.equal(await ponte.emitir('tunnel.status'), undefined)
    assert.equal(enviados.length, 0, 'nada atravessa o canal')
    assert.equal(avisos.length, 2, 'o aviso diz que a acao nao exige nonce')
    assert.match(avisos[0] ?? '', /sem nonce/u)
  })

  it('CANAL indisponivel (send false): resolve undefined JA, sem esperar o timeout', async () => {
    const ipc: WorkerIpc = { send: () => false, log: () => undefined, dispose: () => undefined }
    const relogio = new RelogioVazio()
    const ponte = criarPonteDeNonce({ log: loggerMudo(), time: relogio, ipc })

    assert.equal(await ponte.emitir('tunnel.up'), undefined, 'fail-closed imediato (CTL-023)')
    assert.equal(relogio.agora, 0, 'o relogio NAO andou: nao houve espera')
  })

  it('um `error` com o requestId do pedido resolve undefined e CONSUME a mensagem', async () => {
    const enviados: Array<{ requestId?: string }> = []
    const ipc: WorkerIpc = {
      send: (m) => {
        enviados.push(m as { requestId?: string })
        return true
      },
      log: () => undefined,
      dispose: () => undefined,
    }
    const ponte = criarPonteDeNonce({ log: loggerMudo(), time: new RelogioVazio(), ipc })

    const pedido = ponte.emitir('tunnel.up')
    const requestId = enviados[0]?.requestId ?? ''
    const consumido = ponte.onMessage({
      v: 2,
      type: 'error',
      requestId,
      code: 'RESTRICTED_MODE',
      message: 'recusado',
    })
    assert.equal(consumido, true, 'o erro pertence ao pedido pendente: nao vai ao nucleo')
    assert.equal(await pedido, undefined, 'o host recusou emitir: falha fechado JA')
  })

  it('um `nonce.issued` TARDIO (pedido ja resolvido) e consumido sem resolver ninguem', async () => {
    const ipc: WorkerIpc = { send: () => true, log: () => undefined, dispose: () => undefined }
    const relogio = new RelogioVazio()
    const ponte = criarPonteDeNonce({ log: loggerMudo(), time: relogio, ipc })

    const pedido = ponte.emitir('tunnel.up')
    relogio.agora += 5_000
    assert.equal(await pedido, undefined, 'o timeout resolveu primeiro')

    // A resposta do host chega DEPOIS do timeout: tem de ser consumida (nao
    // ir ao nucleo) e nao pode resolver nada — o pedido ja resolveu.
    assert.equal(
      ponte.onMessage({
        v: 2,
        type: 'nonce.issued',
        acao: 'start',
        requestId: 'req-qualquer',
        nonce: 'tardio',
        expiresAt: 1,
      }),
      true,
      'resposta tardia e consumida',
    )
  })

  it('uma mensagem que NAO e do nonce nao e consumida (segue o despacho normal)', () => {
    const ponte = criarPonteDeNonce({
      log: loggerMudo(),
      time: new RelogioVazio(),
      ipc: { send: () => true, log: () => undefined, dispose: () => undefined },
    })
    assert.equal(
      ponte.onMessage({ v: 2, type: 'state', state: 'STOPPED', seq: 1 }),
      false,
      'o state nao diz respeito ao nonce',
    )
    // Um `error` SEM requestId tambem nao e do nonce (nao ha o que correlacionar).
    assert.equal(ponte.onMessage({ v: 2, type: 'error', code: 'INTERNAL', message: 'x' }), false)
  })
})
