/**
 * `/status` e `/emergencia`.
 *
 * DONO: T5.2.
 *
 * ===========================================================================
 * /STATUS (TG-084) — tunnel.status
 * ===========================================================================
 * Leitura pura: o worker envia `tunnel.status` (o host audita e responde com o
 * estado autoritativo no ack) e responde com estado, seq, se ha tunel (URL so
 * em READY — o contrato torna impossivel divulga-la a partir de STARTING ou
 * DEGRADED), ha quanto tempo (derivado localmente da transicao para READY —
 * a mensagem de estado nao carrega `startedAt`) e quando o TTL expira. NUNCA
 * expoe o segredo nem o digest — nao ha segredo nenhum neste ficheiro.
 *
 * ===========================================================================
 * /EMERGENCIA (TG-087, CTL-024) — emergency
 * ===========================================================================
 * 1 etapa, sem nonce (reduz exposicao; em panico o botao funciona de
 * primeira): envia o intent, responde UMA vez e derruba o WORKER (para o
 * polling; o host derruba o tunel e decide nao reiniciar — ver handoff).
 * Idempotente: o segundo /emergencia (ou o clique duplo no botao de um notify)
 * nao re-envia intent nem re-responde — o estado seguro ja esta a caminho.
 */

import type { UpdateIdentity } from '../auth/allowlist.ts'
import { gerarRequestId, type ContextoDoComando } from './router.ts'

export interface ComandosStatus {
  status(identidade: UpdateIdentity): Promise<void>
  emergencia(identidade: UpdateIdentity): Promise<void>
}

export function criarStatus(ctx: ContextoDoComando): ComandosStatus {
  let emergenciaDisparada = false

  return {
    async status(identidade): Promise<void> {
      // Leitura pura; o ack traz o estado autoritativo e a resposta sai da
      // projecao actualizada (nao estende o TTL — contrato tunnel.status).
      const requestId = gerarRequestId(ctx.time.now())
      const aceite = ctx.ipc.send({
        v: 1,
        type: 'intent',
        intent: 'tunnel.status',
        requestId,
        from: identidade.from,
        chat: identidade.chat,
      })
      if (aceite) {
        ctx.pendente.registar(requestId, identidade.chat, 'tunnel.status', undefined)
      }
    },

    async emergencia(identidade): Promise<void> {
      if (emergenciaDisparada) {
        // Idempotente: ja esta a cair — nada de novo, nem resposta, nem intent.
        return
      }
      emergenciaDisparada = true
      ctx.ipc.send({
        v: 1,
        type: 'intent',
        intent: 'emergency',
        requestId: gerarRequestId(ctx.time.now()),
        from: identidade.from,
        chat: identidade.chat,
      })
      // Responde UMA vez, e so depois derruba o worker (o polling para e o
      // processo sai; o host derruba o tunel).
      await ctx.enviar(identidade.chat, 'Emergência: a desligar o túnel e este bot.')
      await ctx.parar()
    },
  }
}
