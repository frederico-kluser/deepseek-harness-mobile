/**
 * `/ligar` e `/desligar` — a superficie das duas acoes centrais.
 *
 * DONO: T5.2.
 *
 * ===========================================================================
 * /LIGAR — CONFIRMACAO DE 2 ETAPAS COM NONCE DO HOST (TG-082, CTL-023)
 * ===========================================================================
 * `tunnel.up` AUMENTA exposicao: exige nonce, e o nonce e emitido e consumido
 * no HOST (S5). O worker pede-o pelo porte {@link EmitirNonce} e transporta-o
 * OPACO dentro do `callback_data` — nao o gera, nao o valida, nao o guarda.
 * So o clique no botao (segunda etapa) envia o intent; o primeiro passo, sem
 * nonce, nao existe: sem nonce o comando falha FECHADO (nenhum intent, nenhum
 * spawn) — e a face worker de CTL-023.
 *
 * ===========================================================================
 * /DESLIGAR — CONFIRMACAO DE 2 ETAPAS COM TOKEN LOCAL (TG-083, CTL-024)
 * ===========================================================================
 * `tunnel.down` REDUZ exposicao: NAO exige nonce (CTL-024 — em panico o botao
 * tem de funcionar de primeira) e o intent sai SEM campo `nonce`. Ainda assim
 * a confirmacao em 2 etapas existe (TG-020/083: destrutiva do ponto de vista
 * do utilizador) e o seu token e LOCAL ao worker:
 *
 *   - quem o emite e o WORKER (efemero, TTL 60 s, uso unico, ligado ao
 *     emissor) — e NAO e um nonce: o host nao o consome e o intent nao o
 *     carrega. E a unica forma de ter 2 etapas sem envolver o host, dado que
 *     qualquer `tunnel.down` enviado de primeira seria executado de imediato
 *     (CTL-024) — e o que trava o deputado-confuso do botao forjado (TG-025):
 *     um teclado alheio nao carrega um token nosso, e o clique morre em
 *     silencio (answer sem texto).
 *
 * O mapa de tokens e ESTADO DE FLUXO, nao de autorizacao: a identidade e
 * revalidada pela allowlist em cada callback (S6) e a decisao da acao e do
 * host. O mapa e limitado (MAX_TOKENS_DESLIGAR) e cada token morre no uso ou
 * no TTL — nunca reabre.
 */

import { buildCallbackData } from '../auth/guard.ts'
import type { UpdateIdentity } from '../auth/allowlist.ts'
import { buildInlineKeyboard } from '../lib/keyboard.ts'
import { gerarRequestId, gerarTokenOpaque, type ContextoDoComando } from './router.ts'

/** TTL do token local de /desligar — o mesmo espirito dos 60 s do host. */
export const TTL_TOKEN_DESLIGAR_MS = 60_000

/** Teto defensivo do mapa de tokens (o dono e um; 16 e folga de sobra). */
const MAX_TOKENS_DESLIGAR = 16

interface TokenDeDesligar {
  readonly token: string
  readonly from: number
  readonly chat: number
  readonly expiresAt: number
}

export interface ComandosOnOff {
  ligar(identidade: UpdateIdentity): Promise<void>
  desligar(identidade: UpdateIdentity): Promise<void>
  /** O clique no botao de confirmacao. Responde SEMPRE ao callback. */
  confirmarDesligar(
    identidade: UpdateIdentity,
    token: string,
    callbackQueryId: string,
    messageId: number | undefined,
  ): Promise<void>
}

export function criarOnOff(ctx: ContextoDoComando): ComandosOnOff {
  const tokens = new Map<string, TokenDeDesligar>()

  function emitirTokenDeDesligar(from: number, chat: number): string {
    const token = gerarTokenOpaque()
    if (tokens.size >= MAX_TOKENS_DESLIGAR) {
      const maisAntigo = tokens.keys().next().value
      if (maisAntigo !== undefined) tokens.delete(maisAntigo)
    }
    tokens.set(token, { token, from, chat, expiresAt: ctx.time.now() + TTL_TOKEN_DESLIGAR_MS })
    return token
  }

  return {
    async ligar(identidade): Promise<void> {
      // 1a etapa: pedir o nonce ao host. OPACO — o worker nao o le (S5).
      const nonce = ctx.emitirNonce('tunnel.up')
      if (nonce === undefined) {
        // Fail-closed (CTL-023): sem nonce nao ha confirmacao possivel, e sem
        // confirmacao nao ha intent. O dono fica a saber o porquê.
        await ctx.enviar(
          identidade.chat,
          'Não foi possível obter a confirmação do host. Tente de novo em alguns segundos.',
        )
        return
      }
      // 2a etapa: o teclado com o nonce no callback_data.
      const teclado = buildInlineKeyboard([
        [{ text: '✅ Sim, ligar', data: buildCallbackData('tunnel.up', nonce) }],
      ])
      await ctx.enviar(identidade.chat, 'Ligar o túnel de acesso?', { reply_markup: teclado })
    },

    async desligar(identidade): Promise<void> {
      // Confirmacao em 2 etapas (TG-020/083), com token LOCAL — sem nonce
      // (CTL-024): o intent de confirmacao nao carrega campo `nonce`.
      const token = emitirTokenDeDesligar(identidade.from, identidade.chat)
      const teclado = buildInlineKeyboard([
        [{ text: '⛔ Sim, desligar', data: buildCallbackData('tunnel.down', token) }],
      ])
      await ctx.enviar(identidade.chat, 'Desligar o túnel?', { reply_markup: teclado })
    },

    async confirmarDesligar(identidade, token, callbackQueryId, messageId): Promise<void> {
      // TG-027: responder em TODOS os caminhos — inclusive no de recusa.
      const registado = tokens.get(token)
      if (registado === undefined) {
        // Token desconhecido: teclado forjado (TG-025) ou de um fluxo antigo
        // ja evictado. Silencio de conteudo: o answer para o girador e nao diz
        // mais nada — confirmar a existencia de um fluxo a um teclado alheio
        // seria dar-lhe o oraculo que TG-025 fecha.
        await ctx.responderCallback(callbackQueryId)
        return
      }
      const agora = ctx.time.now()
      if (
        agora >= registado.expiresAt ||
        registado.from !== identidade.from ||
        registado.chat !== identidade.chat
      ) {
        // Expirado (TG-023) ou apresentado por outro emissor (TG-024): o
        // token e de uso unico e ligado a quem o pediu. O dono legitimo ve o
        // aviso; o estranho — impossivel, a allowlist ja o barrou (S6).
        tokens.delete(token)
        await ctx.responderCallback(callbackQueryId, {
          text: 'Confirmação expirada ou inválida. Mande /desligar de novo.',
        })
        return
      }
      // Uso unico: consumido antes de qualquer efeito.
      tokens.delete(token)
      await ctx.responderCallback(callbackQueryId)
      // O intent REDUZ exposicao e NAO carrega nonce (CTL-024). O pendente
      // fica registado para o ack editar a propria mensagem do teclado.
      const requestId = gerarRequestId(ctx.time.now())
      const aceite = ctx.ipc.send({
        v: 1,
        type: 'intent',
        intent: 'tunnel.down',
        requestId,
        from: identidade.from,
        chat: identidade.chat,
      })
      if (aceite) {
        ctx.pendente.registar(requestId, identidade.chat, 'tunnel.down', messageId)
      }
    },
  }
}
