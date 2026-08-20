/**
 * `GET /__guard/secret?ott=...` -- `04-TESTES.md` 5.9 (PANEL-004/PANEL-005) e
 * D3 ("sem `ott` valido a rota devolve 404 IDENTICO ao de rota inexistente").
 *
 * A COMPARACAO BYTE A BYTE NO FIO esta em
 * `test/security/panel-exemptions.test.ts`; aqui prova-se o comportamento e a
 * igualdade ao nivel do envelope.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { PANEL_PATH_SECRET } from '../../../src/panel/routes.ts'
import { SECRET_REJECTION_EVENT } from '../../../src/panel/secret.ts'
import { OTT_TTL_MS } from '../../../src/secret/ott.ts'
import { criarBancada, pedir, type Bancada } from './harness.ts'

const INEXISTENTE = '/__guard/rota-que-nunca-existiu'

describe('/__guard/secret', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada({ comSegredo: true })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  const comOtt = (ott: string): Promise<Awaited<ReturnType<typeof pedir>>> =>
    pedir(port, `${PANEL_PATH_SECRET}?ott=${encodeURIComponent(ott)}`)

  it('PANEL-004: sem `ott`, o 404 e igual ao de rota inexistente', async () => {
    const semOtt = await pedir(port, PANEL_PATH_SECRET)
    const desconhecida = await pedir(port, INEXISTENTE)

    assert.equal(semOtt.status, 404)
    assert.equal(semOtt.body, desconhecida.body)
    assert.deepEqual(semOtt.headers, desconhecida.headers)
    // Nada que confirme que a rota existe: nem desafio, nem dica de parametro.
    assert.equal(semOtt.headers['www-authenticate'], undefined)
    assert.equal(semOtt.body.toLowerCase().includes('ott'), false)
    assert.equal(semOtt.body.toLowerCase().includes('secret'), false)
  })

  it('PANEL-004: `ott` invalido tambem cai no MESMO 404', async () => {
    const desconhecida = await pedir(port, INEXISTENTE)
    const inventado = await comOtt('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')

    assert.equal(inventado.status, 404)
    assert.equal(inventado.body, desconhecida.body)
    assert.deepEqual(inventado.headers, desconhecida.headers)
  })

  it('PANEL-005: com `ott` valido mostra UMA vez; a segunda cai no mesmo 404', async () => {
    const ott = bancada.ott.issue().token

    const primeira = await comOtt(ott)
    assert.equal(primeira.status, 200)
    assert.ok(primeira.body.includes(String(bancada.segredo).slice(0, 4)))
    assert.equal(primeira.headers['cache-control'], 'no-store')
    assert.equal(primeira.headers['referrer-policy'], 'no-referrer')

    const segunda = await comOtt(ott)
    const desconhecida = await pedir(port, INEXISTENTE)
    assert.equal(segunda.status, 404)
    assert.equal(segunda.body, desconhecida.body)
    assert.deepEqual(segunda.headers, desconhecida.headers)
  })

  it('o `ott` aceita a forma agrupada e em minusculas, como o segredo', async () => {
    const ott = bancada.ott.issue().token
    const agrupado = (ott.match(/.{1,4}/gu) ?? []).join('-').toLowerCase()

    assert.equal((await comOtt(agrupado)).status, 200)
  })

  it('um palpite errado NAO queima o token que o dono ainda nao usou', async () => {
    const ott = bancada.ott.issue().token

    assert.equal((await comOtt('PALPITEERRADOPALPITEERRADOPALPITE')).status, 404)
    assert.equal((await comOtt(ott)).status, 200)
  })

  it('o `ott` expira pelo relogio injetado, sem esperar 10 minutos', async () => {
    const ott = bancada.ott.issue().token
    bancada.clock.advance(OTT_TTL_MS + 1)

    assert.equal((await comOtt(ott)).status, 404)
  })

  it('`ott` valido sem segredo em memoria: FECHA-SE, e o operador ve porque', async () => {
    const semSegredo = criarBancada()
    const porta = await semSegredo.servir()
    const ott = semSegredo.ott.issue().token

    const resposta = await pedir(porta, `${PANEL_PATH_SECRET}?ott=${encodeURIComponent(ott)}`)
    const desconhecida = await pedir(porta, INEXISTENTE)

    assert.equal(resposta.status, 404)
    assert.equal(resposta.body, desconhecida.body)
    assert.ok(semSegredo.logs.some((l) => l.includes('ott valido consumido sem segredo')))
    await semSegredo.fechar()
  })

  it('o segredo aparece NA RESPOSTA e em mais lado nenhum', () => {
    const canonico = String(bancada.segredo)

    assert.equal(bancada.logs.join('\n').includes(canonico), false)
    assert.equal(JSON.stringify(bancada.eventos).includes(canonico), false)
    // A auditoria regista QUE a tela foi servida, nunca O QUE ela continha.
    assert.ok(bancada.eventos.some((e) => e.evento === 'painel_segredo' && e.resultado === 'permitido'))
    // A recusa e AGREGADA e o nome leva a contagem da rajada (`_xN`).
    assert.ok(
      bancada.eventos.some(
        (e) => e.evento.startsWith(SECRET_REJECTION_EVENT) && e.resultado === 'negado',
      ),
    )
  })

  it('nem o proprio `ott` entra no log -- ele abre o segredo', () => {
    const registos = bancada.logs.join('\n')
    assert.equal(/ott=/u.test(registos), false)
  })
})
