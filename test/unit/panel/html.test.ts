/**
 * O painel e autocontido -- `03-ONDAS.md` T3.4 ("sem CDN, sem fonte remota, sem
 * build") e `04-TESTES.md` 3.2 (`panel/html.test.ts`).
 *
 * PORQUE ESTE TESTE VALE O QUE CUSTA. Um unico recurso externo (a) quebra o
 * painel offline, que e metade do caso de uso, e (b) faz o navegador anunciar o
 * `Referer` -- ou seja, entrega a URL do quick tunnel, que e o endereco publico
 * da maquina do dono, a um terceiro. E a regressao mais facil do mundo de
 * introduzir: uma fonte bonita, um icone, um `<link>` copiado de outro projeto.
 *
 * O `grep` corre sobre o HTML SERVIDO e nao sobre o ficheiro-fonte: e o que
 * chega ao navegador que interessa.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { Script } from 'node:vm'

import type { TunnelState } from '../../../src/contracts/tunnel.ts'
import { escapeHtml, jsonForScript, TUNNEL_STATE_LABEL } from '../../../src/panel/html.ts'
import { PANEL_PATH_MAGIC, PANEL_PATH_ROOT, PANEL_PATH_SECRET } from '../../../src/panel/routes.ts'
import { criarBancada, pedir, type Bancada } from './harness.ts'

/**
 * As formas proibidas. Cada uma corresponde a uma maneira REAL de o navegador
 * ser mandado buscar bytes fora desta resposta.
 */
const FORMAS_PROIBIDAS: ReadonlyArray<readonly [string, RegExp]> = [
  ['esquema http', /http:\/\//iu],
  ['esquema https', /https:\/\//iu],
  ['URL relativa ao protocolo', /(?<!:)\/\/[a-z0-9-]+\.[a-z]/iu],
  ['script externo', /<script[^>]+\bsrc\s*=/iu],
  ['folha de estilo externa', /<link\b/iu],
  ['imagem', /<img\b/iu],
  ['moldura', /<iframe\b/iu],
  ['@import', /@import/iu],
  ['url() em CSS', /url\s*\(/iu],
  ['fonte remota', /@font-face/iu],
]

function assertAutocontido(rotulo: string, html: string): void {
  for (const [nome, forma] of FORMAS_PROIBIDAS) {
    assert.equal(forma.test(html), false, `${rotulo}: encontrou ${nome} no HTML servido`)
  }
}

describe('rendering puro', () => {
  it('ha um rotulo de interface para cada um dos SEIS estados de D7', () => {
    const estados: readonly TunnelState[] = [
      'STOPPED',
      'STARTING',
      'READY',
      'DEGRADED',
      'STOPPING',
      'FAILED',
    ]
    for (const estado of estados) {
      assert.equal(typeof TUNNEL_STATE_LABEL[estado], 'string')
      assert.ok(TUNNEL_STATE_LABEL[estado].length > 0)
    }
    // Os rotulos sao DISTINTOS: dois estados com o mesmo texto seriam um estado
    // invisivel para quem ler o painel.
    assert.equal(new Set(Object.values(TUNNEL_STATE_LABEL)).size, estados.length)
  })

  it('`escapeHtml` fecha os cinco caracteres que mudam de contexto', () => {
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })

  it('`jsonForScript` neutraliza o fecho do bloco de script', () => {
    const saida = jsonForScript({ x: '</script><script>alert(1)</script>' })
    assert.ok(!saida.includes('</script'))
    assert.ok(!saida.includes('<'))
  })
})

describe('as tres paginas servidas', () => {
  let bancada: Bancada
  let port = 0
  let paginaPainel = ''
  let paginaMagic = ''
  let paginaSegredo = ''

  before(async () => {
    bancada = criarBancada({ comSegredo: true, estado: { state: 'STOPPED', attempts: 0 } })
    port = await bancada.servir()

    const id = bancada.sessions.create()
    paginaPainel = (await pedir(port, PANEL_PATH_ROOT, { cookie: `__Host-dsh_sid=${id}` })).body
    paginaMagic = (await pedir(port, PANEL_PATH_MAGIC)).body

    const token = bancada.ott.issue().token
    paginaSegredo = (await pedir(port, `${PANEL_PATH_SECRET}?ott=${encodeURIComponent(token)}`)).body
  })

  after(async () => {
    await bancada.fechar()
  })

  it('o painel nao carrega um unico byte de fora', () => {
    assert.ok(paginaPainel.includes('<html'))
    assertAutocontido('painel', paginaPainel)
  })

  it('a pagina do link magico nao carrega um unico byte de fora', () => {
    assert.ok(paginaMagic.includes('<html'))
    assertAutocontido('magic', paginaMagic)
  })

  it('a pagina do segredo nao carrega um unico byte de fora', () => {
    assert.ok(paginaSegredo.includes('<html'))
    assertAutocontido('segredo', paginaSegredo)
  })

  it('a CSP servida faz o NAVEGADOR recusar recurso externo, e nao so a disciplina', async () => {
    const resposta = await pedir(port, PANEL_PATH_MAGIC)
    const csp = String(resposta.headers['content-security-policy'])

    assert.match(csp, /default-src 'none'/u)
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+'/u)
    assert.match(csp, /style-src 'nonce-[A-Za-z0-9_-]+'/u)
    assert.match(csp, /frame-ancestors 'none'/u)
    assert.equal(resposta.headers['referrer-policy'], 'no-referrer')
    assert.equal(resposta.headers['x-content-type-options'], 'nosniff')
    assert.equal(resposta.headers['cache-control'], 'no-store')
  })

  it('o nonce da CSP e o do bloco de script sao o MESMO -- senao o script nao corre', async () => {
    const resposta = await pedir(port, PANEL_PATH_MAGIC)
    const doCabecalho = /script-src 'nonce-([A-Za-z0-9_-]+)'/u.exec(
      String(resposta.headers['content-security-policy']),
    )
    const doCorpo = /<script nonce="([A-Za-z0-9_-]+)">/u.exec(resposta.body)

    assert.ok(doCabecalho !== null && doCorpo !== null)
    assert.equal(doCabecalho[1], doCorpo[1])
  })

  it('o nonce muda a cada resposta', async () => {
    const a = await pedir(port, PANEL_PATH_MAGIC)
    const b = await pedir(port, PANEL_PATH_MAGIC)

    assert.notEqual(
      /<script nonce="([A-Za-z0-9_-]+)">/u.exec(a.body)?.[1],
      /<script nonce="([A-Za-z0-9_-]+)">/u.exec(b.body)?.[1],
    )
  })

  it('os rotulos em portugues vao no HTML, e o vocabulario de D7 fica em ingles', () => {
    // O mapa e embutido pelo `html.ts`; os testes importam-no em vez de o
    // escrever a mao, para nao criar a segunda fonte da verdade que D7 proibe.
    for (const rotulo of Object.values(TUNNEL_STATE_LABEL)) {
      assert.ok(paginaPainel.includes(rotulo), `o painel nao embutiu o rotulo ${rotulo}`)
    }
  })

  it('o JavaScript embutido COMPILA -- um erro de sintaxe deixava o painel morto e mudo', () => {
    // Nenhum outro teste apanha isto: o servidor devolve 200 com o HTML inteiro,
    // os `grep` de recurso externo passam, e o painel fica em branco no
    // navegador do dono. `new Script(...)` COMPILA sem executar, que e
    // exatamente a pergunta ("isto e JavaScript valido?") e nada mais.
    for (const [rotulo, pagina] of [
      ['painel', paginaPainel],
      ['magic', paginaMagic],
    ] as const) {
      const bloco = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(pagina)
      assert.ok(bloco !== null, `${rotulo}: nao ha bloco de script`)
      assert.doesNotThrow(() => new Script(bloco[1] ?? ''), `${rotulo}: JavaScript invalido`)
    }
  })

  it('a pagina do segredo nao tem UMA LINHA de JavaScript', () => {
    // Ela mostra a senha. Um bloco de script vazio convidava a proxima pessoa a
    // "aproveitar que ja esta la" -- e o proximo passo e o segredo entrar num
    // objeto de JavaScript em vez de ficar em texto escapado.
    assert.equal(/<script/u.test(paginaSegredo), false)
  })

  it('a pagina do segredo mostra a senha e nao a esconde num script', () => {
    const canonico = String(bancada.segredo)
    assert.ok(paginaSegredo.includes(canonico.slice(0, 4)))
    assert.ok(!paginaSegredo.includes('<script nonce'))
  })
})
