/**
 * O tap do indice e o script da superficie — o mecanismo `tapIndex` medido
 * pelo spike S4 (docs/spikes/superficie-ui.md 4.1): o transform e executado
 * pelo dono do assento de fallback em TODA resposta de indice, e a injecao e
 * reversivel pelo disposer.
 *
 * O que esta suite prova:
 *  - os botoes LIGAR/DESLIGAR e a area de STATUS existem no HTML produzido;
 *  - o documento original (incluindo o `__DSH_BOOT__` dos taps do host) fica
 *    INTACTO — o tap so acrescenta, nunca transforma;
 *  - o HTML servido fica com ZERO ocorrencias de `https://` (a URL so entra
 *    no DOM por `textContent`, via a rota de estado);
 *  - o token anti-CSRF sai por render, e o script e um recurso EXTERNO
 *    (CSP-friendly), nao um script inline;
 *  - o texto do DESLIGAR desambigua: desliga o TUNEL, nao o bot nem o DSH
 *    (03-ONDAS 10);
 *  - o nonce viaja opaco no script: o cliente nao o mostra nem o valida.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createCsrfGuard } from '../../../src/ui-contrib/csrf.ts'
import {
  createClientScript,
  createIndexTap,
  CHROME_MARKER,
  escapeHtml,
} from '../../../src/ui-contrib/html.ts'
import { UI_PATH_CLIENT } from '../../../src/ui-contrib/routes.ts'
import { FakeClock } from '../../support/clock.ts'

const INDICE_FIXTURA =
  '<!doctype html><html><head><script>window.__DSH_BOOT__ = {}</script></head>' +
  '<body><div id="root"></div></body></html>'

function criarTap(clock: FakeClock) {
  const csrf = createCsrfGuard({ clock })
  return createIndexTap({ csrf, binding: 'ui-contrib', scriptSrc: UI_PATH_CLIENT })
}

function tokenDaRender(html: string): string {
  const m = /<meta name="dsh-guard-ui-csrf" content="([^"]+)">/u.exec(html)
  assert.ok(m !== null)
  const token = m[1]
  assert.equal(typeof token, 'string')
  return token ?? ''
}

describe('o tap do indice', () => {
  it('injeta os botoes LIGAR/DESLIGAR e a area de STATUS antes de </body>', () => {
    const tap = criarTap(new FakeClock(1_000))
    const saida = tap(INDICE_FIXTURA)
    const chrome = saida.slice(saida.lastIndexOf('<div id="dsh-guard-ui"'), saida.lastIndexOf('</body>'))
    assert.ok(chrome.includes('id="dsh-guard-ui-ligar"'), 'falta o botao de ligar')
    assert.ok(chrome.includes('id="dsh-guard-ui-desligar"'), 'falta o botao de desligar')
    assert.ok(chrome.includes('id="dsh-guard-ui-estado"'), 'falta a area de estado')
    assert.ok(chrome.includes('id="dsh-guard-ui-falha"'), 'falta a area de falha')
    assert.ok(chrome.includes('id="dsh-guard-ui-telegram-botao"'), 'falta o botao Telegram')
    assert.ok(chrome.includes('id="dsh-guard-ui-telegram-estado"'), 'falta o estado Telegram')
    assert.ok(chrome.includes('id="dsh-guard-ui-telegram-instrucoes"'), 'falta a area de instrucoes')
  })

  it('preserva o documento original INTACTO — os taps do host nao morrem', () => {
    const tap = criarTap(new FakeClock(1_000))
    const saida = tap(INDICE_FIXTURA)
    assert.ok(saida.includes('window.__DSH_BOOT__ = {}'), 'o tap do client-modules foi corrompido')
    assert.ok(saida.startsWith('<!doctype html>'), 'o cabecalho do documento foi alterado')
    assert.ok(saida.includes('<div id="root"></div>'), 'o corpo original foi alterado')
  })

  it('o HTML servido fica com ZERO ocorrencias de https:// (a URL entra por textContent)', () => {
    const tap = criarTap(new FakeClock(1_000))
    const saida = tap(INDICE_FIXTURA)
    assert.equal(saida.includes('https://'), false)
  })

  it('emite um token anti-CSRF por render e um script EXTERNO (nao inline)', () => {
    const clock = new FakeClock(1_000)
    const tap = criarTap(clock)
    const saida = tap(INDICE_FIXTURA)
    assert.match(saida, /<meta name="dsh-guard-ui-csrf" content="[^"]+">/u)
    // O script da superficie e EXTERNO — inline seria bloqueado por um CSP de
    // script-src sem 'unsafe-inline'. O unico script do tap e o com src; o
    // script sem src e o do FIXTURA, que nao e nosso.
    const tags = saida.match(/<script[^>]*>/gu) ?? []
    assert.equal(tags.filter((t) => t.includes('src=')).length, 1)
    assert.ok(saida.includes(`<script src="${UI_PATH_CLIENT}" defer></script>`))
  })

  it('renders diferentes emitem tokens diferentes (janelas de expiracao distintas)', () => {
    const clock = new FakeClock(1_000)
    const tap = criarTap(clock)
    const primeiro = tap(INDICE_FIXTURA)
    clock.advance(31 * 60 * 1000) // atravessa a janela de TTL do token
    const segundo = tap(INDICE_FIXTURA)
    assert.notEqual(tokenDaRender(primeiro), tokenDaRender(segundo))
  })

  it('documento sem </body>: o bloco e acrescentado ao fim, sem lancar', () => {
    const tap = criarTap(new FakeClock(1_000))
    const saida = tap('<html><body><p>sozinho</p>')
    assert.ok(saida.includes(CHROME_MARKER))
    assert.ok(saida.endsWith('</script>'))
  })

  it('documento que ja carrega o bloco nao e injetado duas vezes (idempotente)', () => {
    const clock = new FakeClock(1_000)
    const tap = criarTap(clock)
    const umaVez = tap(INDICE_FIXTURA)
    const duasVezes = tap(umaVez)
    assert.equal((duasVezes.match(/dsh-guard-ui-ligar/gu) ?? []).length, 1)
  })

  it('nao-lancamento com lixo na entrada', () => {
    const tap = criarTap(new FakeClock(1_000))
    assert.ok(tap('').includes(CHROME_MARKER), 'documento vazio recebe o bloco, sem lancar')
    assert.ok(tap('<html></html>').includes(CHROME_MARKER))
  })
})

describe('escapeHtml', () => {
  it('escapa os cinco caracteres de marcacao', () => {
    assert.equal(escapeHtml('<a href="x"&\'y\'>'), '&lt;a href=&quot;x&quot;&amp;&#39;y&#39;&gt;')
  })
})

describe('o script da superficie (client.js)', () => {
  it('fala com as rotas da superficie e envia o token anti-CSRF em todo POST', () => {
    const fonte = createClientScript()
    assert.ok(fonte.includes("'/start'"))
    assert.ok(fonte.includes("'/start/confirm'"))
    assert.ok(fonte.includes("'/stop'"))
    assert.ok(fonte.includes("'/state'"))
    assert.ok(fonte.includes("'x-dsh-csrf'"))
  })

  it('o DESLIGAR desambigua (03-ONDAS 10): desliga o TUNEL, nao o bot nem o DSH', () => {
    const fonte = createClientScript()
    assert.ok(fonte.includes('Desligar o TÚNEL?'))
    assert.ok(fonte.includes('O DSH continua a correr em loopback'))
    assert.ok(fonte.includes('o bot e o painel não são afetados'))
  })

  it('o nonce do LIGAR viaja opaco: o script nao o mostra nem o valida', () => {
    const fonte = createClientScript()
    assert.ok(fonte.includes('passo = r.dados.nonce'))
    assert.ok(fonte.includes('opaco: so o host valida'))
    // Nenhuma validacao de nonce no cliente: nao ha comparacoes sobre `passo`
    // alem de o reenviar no passo 2.
    assert.equal(fonte.includes('passo ==='), false)
  })

  it('o duplo clique no Confirmar e bloqueado: o botao desabilita no primeiro clique', () => {
    const fonte = createClientScript()
    assert.ok(fonte.includes('confirmar.disabled = true'))
    assert.ok(fonte.includes("confirmar.textContent = 'a confirmar…'"))
    // O re-armar so acontece no `.finally` — depois de a resposta chegar.
    assert.ok(fonte.includes('Promise.resolve(aConfirmar()).finally'))
  })

  it('erro de rede no pedir vira resposta legivel, nunca rejeicao nao tratada', () => {
    const fonte = createClientScript()
    assert.ok(fonte.includes("catch (ignorado) {"))
    assert.ok(fonte.includes("motivo: 'rede falhou — tente de novo'"))
    assert.ok(fonte.includes('status: 0'))
  })

  it('a URL entra no DOM por textContent, nunca por interpolacao de HTML', () => {
    const fonte = createClientScript()
    assert.ok(fonte.includes("texto('url',"))
    assert.equal(fonte.includes('innerHTML'), false)
  })

  it('o Telegram: fala com as rotas /telegram e /telegram/click e desenha as instrucoes via textContent', () => {
    const fonte = createClientScript()
    assert.ok(fonte.includes("'/telegram'"), 'o script le o estado Telegram')
    assert.ok(fonte.includes("'/telegram/click'"), 'o script faz o clique Telegram')
    assert.ok(fonte.includes('Telegram · offline'))
    assert.ok(fonte.includes('Telegram · online'))
    assert.ok(fonte.includes('passo.texto'), 'o script usa o texto de cada passo (textContent)')
    assert.ok(fonte.includes('textContent'), 'o script usa textContent, nunca marcacao interpolada')
  })
})
