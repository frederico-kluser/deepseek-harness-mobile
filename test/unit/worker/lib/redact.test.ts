/**
 * `worker/lib/redact.ts` — a rede de seguranca de que TODO o log do worker
 * depende.
 *
 * O caso central e o do `node-fetch`: o token viaja no CAMINHO da URL, e o
 * cliente HTTP do grammY imprime a URL na mensagem de erro. Sem esta funcao, uma
 * queda de DNS publica a senha de controlo total do bot no log do plano de
 * controlo.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeForLog, redact, REDACTED } from '../../../../worker/lib/redact.ts'
import { TOKEN_DE_TESTE } from './apoio.ts'

describe('worker/lib/redact — camada 1: literais conhecidos', () => {
  it('o token literal e substituido, esteja onde estiver', () => {
    const texto = `falhou o pedido a https://api.telegram.org/bot${TOKEN_DE_TESTE}/getUpdates`
    const saida = redact(texto, [TOKEN_DE_TESTE])
    assert.equal(saida.includes(TOKEN_DE_TESTE), false)
    assert.match(saida, /REDACTED/u)
  })

  it('todas as ocorrencias, e nao so a primeira', () => {
    const saida = redact(`${TOKEN_DE_TESTE} e outra vez ${TOKEN_DE_TESTE}`, [TOKEN_DE_TESTE])
    assert.equal(saida.includes(TOKEN_DE_TESTE), false)
  })

  it('um "segredo" curto e IGNORADO: mascara-lo transformaria o log em ruido', () => {
    assert.equal(redact('o x marca o sitio', ['x']), 'o x marca o sitio')
  })

  it('caracteres especiais de regex num segredo nao rebentam a substituicao', () => {
    const segredo = 'a.b*c+d(e)f[g]'
    assert.equal(redact(`antes ${segredo} depois`, [segredo]), `antes ${REDACTED} depois`)
  })
})

describe('worker/lib/redact — camada 2: formas', () => {
  it('a forma do token do bot apanha um token que nao conhecemos', () => {
    const saida = redact('GET /bot123456789:AAEEsegredo-de-outro-bot-qualquer/getMe')
    assert.equal(saida.includes('AAEEsegredo-de-outro-bot-qualquer'), false)
    assert.match(saida, /123456789:/u, 'o id numerico fica: sem ele a linha nao diz nada')
  })

  it('o valor de um cabecalho Authorization sai; o nome fica', () => {
    const saida = redact('Authorization: Basic YWRtaW46c2VucmE=')
    assert.equal(saida.includes('YWRtaW46c2VucmE='), false)
    assert.match(saida, /Authorization: /u)
  })

  it('o $HOME sai, mas /usr/lib fica — uma mensagem sem caminho nenhum nao vale nada', () => {
    const saida = redact('nao encontrei /home/fulano/.dsh/state.json')
    assert.equal(saida.includes('/home/fulano'), false)
    assert.match(saida, /\.dsh\/state\.json/u, 'diz QUAL o ficheiro sem dizer DE QUEM')
    assert.equal(redact('spawn /usr/lib/node_modules/x falhou'), 'spawn /usr/lib/node_modules/x falhou')
  })
})

describe('worker/lib/redact — describeForLog', () => {
  it('um Error mantem nome e mensagem, ja mascarados', () => {
    const erro = new Error(`token ${TOKEN_DE_TESTE} recusado`)
    const saida = describeForLog(erro, [TOKEN_DE_TESTE])
    assert.match(saida, /^Error: /u)
    assert.equal(saida.includes(TOKEN_DE_TESTE), false)
  })

  it('a `cause` e atravessada — e e nela que o erro do node-fetch se esconde', () => {
    const raiz = new Error(`request to https://api.telegram.org/bot${TOKEN_DE_TESTE}/getUpdates failed`)
    const topo = new Error('falhou', { cause: raiz })
    const saida = describeForLog(topo, [TOKEN_DE_TESTE])
    assert.equal(saida.includes(TOKEN_DE_TESTE), false)
    assert.match(saida, /<-/u, 'a cadeia de causas e visivel')
  })

  it('um objeto nao vira "[object Object]"', () => {
    assert.equal(describeForLog({ a: 1 }), '{"a":1}')
  })

  it('um valor nao serializavel diz o que aconteceu, em vez de desaparecer', () => {
    const ciclico: Record<string, unknown> = {}
    ciclico['eu'] = ciclico
    assert.match(describeForLog(ciclico), /nao serializavel/u)
  })

  it('undefined e null nao rebentam', () => {
    assert.equal(describeForLog(undefined), 'undefined')
    assert.equal(describeForLog(null), 'null')
  })
})
