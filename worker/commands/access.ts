/**
 * `/acessar` e `/rotacionar`.
 *
 * DONO: T5.2.
 *
 * ===========================================================================
 * /ACESSAR (TG-085) — session.issue
 * ===========================================================================
 * O worker envia o intent `session.issue` e o HOST responde: com o link
 * magico (se `control.magicLink` estiver ligado) ou com a instrucao do
 * caminho local (opt-out). A RESPOSTA viaja como `notify` (o marcador
 * `alerta:link-magico` e o de T5.4) e a superficie renderiza-a — este
 * ficheiro NAO compoe nem conhece o link: o `mk` do link viaja no FRAGMENTO
 * do URL composto pelo host e a renderizacao apenas liga
 * `disable_web_page_preview` (T5.4). A senha NUNCA sai daqui: nao ha caminho
 * neste worker que a transporte — nem para o Telegram nem para o canal (S3).
 *
 * O ACEITE do pedido e INVISIVEL de proposito (A2 da revisao): renderizar
 * «Pedido aceite.» ali editaria a ultima mensagem de estado IN-PLACE e
 * destruiria o painel — a resposta vem por notify. A RECUSA e o ERRO com
 * requestId sao MENSAGENS PROPRIAS (nunca uma edicao do painel — o erro
 * viaja pelo onError e tem o MESMO carve-out dos acks). Os tres caminhos
 * (aceite, recusa, erro) deixam o painel de estado intacto.
 *
 * /ROTACIONAR (TG-086) — secret.rotate
 * ===========================================================================
 * `secret.rotate` AUMENTA exposicao (regenera a senha e invalida as sessoes):
 * exige nonce do host — 2 etapas, o mesmo fluxo do /ligar (aumenta
 * exposicao -> confirma). A senha nova NAO viaja pelo chat: o host responde
 * com o notify do caminho local (QR/ott) e, se magicLink ligado, um link
 * magico para o painel — composto pelo host, renderizado por nos.
 */

import { buildCallbackData } from '../auth/guard.ts'
import type { UpdateIdentity } from '../auth/allowlist.ts'
import { buildInlineKeyboard } from '../lib/keyboard.ts'
import { gerarRequestId, type ContextoDoComando } from './router.ts'

export interface ComandosAccess {
  acessar(identidade: UpdateIdentity): Promise<void>
  rotacionar(identidade: UpdateIdentity): Promise<void>
}

export function criarAccess(ctx: ContextoDoComando): ComandosAccess {
  return {
    async acessar(identidade): Promise<void> {
      // Sem nonce: a emissao de sessao nao esta na lista de CTL-023
      // (/ligar, /rotacionar). A resposta (link ou instrucao) vem por notify.
      const requestId = gerarRequestId(ctx.time.now())
      const aceite = ctx.ipc.send({
        v: 1,
        type: 'intent',
        intent: 'session.issue',
        requestId,
        from: identidade.from,
        chat: identidade.chat,
      })
      // O pendente existe para a RECUSA renderizar — como MENSAGEM PROPIA, no
      // ack, nunca como edicao do painel de estado (A2); o aceite e invisivel
      // de proposito: a resposta (link ou instrucao) vem por notify (TG-085).
      // O painel de estado sobrevive aos dois caminhos.
      if (aceite) {
        ctx.pendente.registar(requestId, identidade.chat, 'session.issue', undefined)
      }
    },

    async rotacionar(identidade): Promise<void> {
      // 1a etapa: o nonce do host, opaco (S5) — 2 etapas porque AUMENTA
      // exposicao (CTL-023). A resposta chega pelo canal (EMENDA-COSTURA-5),
      // por isso o `await`; sem nonce, falha fechado.
      const nonce = await ctx.emitirNonce('secret.rotate')
      if (nonce === undefined) {
        await ctx.enviar(
          identidade.chat,
          'Não foi possível obter a confirmação do host. Tente de novo em alguns segundos.',
        )
        return
      }
      // 2a etapa: o teclado. O clique envia `secret.rotate` com o nonce opaco.
      const teclado = buildInlineKeyboard([
        [{ text: '✅ Sim, rodar', data: buildCallbackData('secret.rotate', nonce) }],
      ])
      await ctx.enviar(identidade.chat, 'Gerar uma senha nova (invalida as sessões atuais)?', {
        reply_markup: teclado,
      })
    },
  }
}
