/**
 * SUBSTITUTO da onda 3 do guarda interino da onda 2 (MESMO caminho, de
 * proposito — sobrepoe-o no merge). O ficheiro antigo afirmava o FAIL-CLOSED
 * dos STUBS «STUB do contrato (onda2) — onda 3 substitui» de
 * `worker/surface/core.ts`; os stubs MORRERAM e este prova o comportamento
 * REAL de `chat.new`/`worktree.create` (EMENDA ONDA-2-CONTRATO-CAPACIDADES):
 *
 *   - TG-027: todo clique e RESPONDIDO — o valido (answer vazio, o feedback e
 *     a edicao) e o de confirmacao morta (resposta UNIFORME);
 *   - o clique VALIDO envia a intent COM o nonce opaco (S5) e os params
 *     exactos `{prompt, worktree?}` / `{nome, base?}`;
 *   - o ACK mostra os textos FINAIS da confirmacao curta («Chat novo
 *     iniciado.» / «Worktree criado.») ou «Ja estava assim.» no noop.
 *
 * A confirmacao morta (forjada/expirada) e UNIFORME por acao: os dois caminhos
 * respondem EXACTAMENTE o mesmo texto (sem oraculo — o precedente do
 * «Codigo errado ou expirado…» do pareamento). O caminho e o de producao: os
 * COMANDOS REAIS (`criarComandosDeSuperficie`) fiiados no nucleo real, com
 * dubles so nas fronteiras (sender/ipc/host) e o relogio injetado.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { criarComandosDeSuperficie, TTL_CONFIRMACAO_DESPACHO_MS } from '../../../../worker/surface/commands.ts'
import { AUMENTA_EXPOSICAO } from '../../../../worker/surface/auth.ts'
import { accaoDoDono, comandoDoDono, montarBancada, tick, type Bancada } from './apoio.ts'

/** A bancada do caminho REAL: nucleo + comandos reais, dubles so nas fronteiras. */
function montarReal(): Promise<Bancada> {
  const bancada = montarBancada({ fabricaDeComandos: (ctx) => criarComandosDeSuperficie(ctx) })
  return bancada.tratar(comandoDoDono('/parear 123456')).then(() => bancada)
}

/** O botao positivo (e o id da mensagem) da ultima confirmacao. */
function botaoDaConfirmacao(bancada: Bancada): { token: string; messageId: string } {
  const confirmacao = bancada.sender.mensagens.at(-1)
  assert.ok(confirmacao !== undefined, 'ha confirmacao renderizada')
  const botao = confirmacao.opcoes?.actionRows?.[0]?.[0]
  assert.ok(botao !== undefined, 'a confirmacao traz o botao positivo')
  return { token: botao.token, messageId: confirmacao.id }
}

describe('Onda 3: chat.new/worktree.create — o comportamento REAL substituiu os stubs', () => {
  for (const [comando, action, params] of [
    ['/novo-chat diz oi', 'chat.new', { prompt: 'diz oi' }],
    ['/worktree feature-x main', 'worktree.create', { nome: 'feature-x', base: 'main' }],
  ] as const) {
    it(`clique VALIDO de \`${action}\`: intent COM nonce + params e resposta ao clique (TG-027)`, async () => {
      const bancada = await montarReal()
      await bancada.tratar(comandoDoDono(comando))
      const { token, messageId } = botaoDaConfirmacao(bancada)

      await bancada.tratar(accaoDoDono(action, token, messageId))

      assert.equal(bancada.sender.respostas.length, 1, `${action}: o clique e respondido (TG-027)`)
      assert.equal(bancada.sender.respostas[0]?.id, 'cq-1', `${action}: responde ao answerTarget`)
      const intent = bancada.ipc.intents.at(-1)
      assert.ok(intent !== undefined, `${action}: a intent SAI apos a confirmacao`)
      assert.equal(intent.intent, action)
      assert.equal(intent.nonce, token, `${action}: o nonce do botao viaja OPACO no intent (S5)`)
      assert.deepEqual(intent.params, params, `${action}: os params exactos do contrato`)
    })
  }

  for (const [comando, action, refazer] of [
    ['/novo-chat diz oi', 'chat.new', '/novo-chat de novo'],
    ['/worktree feature-x', 'worktree.create', '/worktree de novo'],
  ] as const) {
    it(`confirmacao morta de \`${action}\` (forjada OU expirada): resposta UNIFORME, NENHUM intent`, async () => {
      // (a) FORJADA — um token que o host nunca emitiu.
      const bancada = await montarReal()
      await bancada.tratar(accaoDoDono(action, 'FORJA', 'msg-9'))
      const respostaForjada = bancada.sender.respostas.at(-1)?.outras?.text

      // (b) EXPIRADA — o TTL de 60 s morreu (relogio injetado).
      await bancada.tratar(comandoDoDono(comando))
      const { token, messageId } = botaoDaConfirmacao(bancada)
      bancada.time.advance(TTL_CONFIRMACAO_DESPACHO_MS + 1)
      await bancada.tratar(accaoDoDono(action, token, messageId))
      const respostaExpirada = bancada.sender.respostas.at(-1)?.outras?.text

      // UNIFORME: os dois caminhos respondem EXACTAMENTE o mesmo (sem oraculo).
      assert.equal(respostaForjada, `Confirmação expirada ou inválida. Mande ${refazer}.`)
      assert.equal(respostaExpirada, respostaForjada, `${action}: expirada == forjada`)
      assert.equal(bancada.sender.respostas.length, 2, `${action}: os dois cliques morreram respondidos`)
      assert.equal(bancada.ipc.intents.length, 0, `${action}: NENHUM intent nos caminhos mortos`)
    })
  }

  for (const [action, textoAccepted, comando] of [
    ['chat.new', 'Chat novo iniciado.', '/novo-chat diz oi'],
    ['worktree.create', 'Worktree criado.', '/worktree feature-x'],
  ] as const) {
    it(`ack de \`${action}\`: accepted mostra a confirmacao curta; noop «Ja estava assim.»`, async () => {
      for (const [result, esperado] of [
        ['accepted', textoAccepted],
        ['noop', 'Já estava assim.'],
      ] as const) {
        const bancada = await montarReal()
        await bancada.tratar(comandoDoDono(comando))
        const { token, messageId } = botaoDaConfirmacao(bancada)
        await bancada.tratar(accaoDoDono(action, token, messageId))
        const intent = bancada.ipc.intents.at(-1)
        assert.ok(intent !== undefined)

        bancada.nucleo.onAck({ v: 2, type: 'ack', requestId: intent.requestId, result, state: 'STOPPED' })
        await tick(6)

        const edicao = bancada.sender.edicoes.at(-1)
        assert.equal(edicao?.messageId, messageId, `${action}/${result}: edita a mensagem da confirmacao`)
        assert.equal(edicao?.texto, esperado, `${action}/${result}: o texto FINAL do ack`)
      }
    })
  }
})

/* As acoes novas AUMENTAM exposicao — e por isso que a confirmacao e de 2
   etapas com nonce ('reset' na ponte: guardado pelo onda2-nonce-reset.test.ts). */
describe('Onda 3: as acoes novas estao no vocabulario fechado e aumentam exposicao', () => {
  it('AUMENTA_EXPOSICAO cobre chat.new/worktree.create como `true` (par de INCREASES_EXPOSURE)', () => {
    assert.equal(AUMENTA_EXPOSICAO['chat.new'], true, 'chat.new cria sessao e submete o prompt')
    assert.equal(AUMENTA_EXPOSICAO['worktree.create'], true, 'worktree.create cria worktree em disco')
  })
})
