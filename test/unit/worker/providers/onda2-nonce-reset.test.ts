/**
 * TEST-AFTER da onda 2 — a ponte de nonce das capacidades novas.
 *
 * Contrato congelado (EMENDA ONDA-2-CONTRATO-CAPACIDADES): `chat.new` e
 * `worktree.create` AUMENTAM exposicao (criam e poem em disco recursos novos no
 * host) e por isso pedem o nonce com a acao `'reset'` — o MESMO precedente de
 * `agent.dispatch`/`secret.rotate`, sem crescer o universo de `ControlAction`.
 * A ponte `criarPonteDeNonce` e que faz a traducao intent -> acao de controlo
 * (`ACAO_PARA_NONCE`); sem entrada na tabela, a acao ficaria sem nonce e o
 * fluxo de 2 etapas morreria em silencio (CTL-023).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { criarPonteDeNonce } from '../../../../worker/providers/registry.ts'
import type { TimeSource } from '../../../../worker/lib/clock.ts'
import type { WorkerLogger } from '../../../../worker/lib/log.ts'
import type { WorkerIpc } from '../../../../worker/ipc.ts'

/** Logger que descarta — a ponte so regista em caminhos de falha. */
const loggerMudo: WorkerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

/** Relogio que so anda quando o teste pedir. */
class RelogioVazio implements TimeSource {
  private agora = 0
  now(): number {
    return this.agora
  }
  async sleep(ms: number): Promise<void> {
    this.agora += ms
  }
}

describe('EMENDA ONDA-2: a ponte de nonce — chat.new/worktree.create pedem reset', () => {
  for (const acao of ['chat.new', 'worktree.create'] as const) {
    it(`\`${acao}\` AUMENTA exposicao e envia \`nonce.request\` com a acao 'reset'`, () => {
      const enviados: Array<{ type?: string; acao?: string }> = []
      const ipc: WorkerIpc = {
        send: (mensagem) => {
          enviados.push(mensagem as { type?: string; acao?: string })
          return true
        },
        log: () => undefined,
        dispose: () => undefined,
      }
      const ponte = criarPonteDeNonce({ log: loggerMudo, time: new RelogioVazio(), ipc })

      void ponte.emitir(acao)

      assert.equal(enviados.length, 1, `${acao}: UM nonce.request`)
      assert.equal(enviados[0]?.type, 'nonce.request', `${acao}: o pedido sai no canal`)
      assert.equal(enviados[0]?.acao, 'reset', `${acao}: a acao de controlo e 'reset' (o precedente de agent.dispatch)`)
    })
  }
})
