/**
 * `src/http/host-header.ts` -- a camada L2.5, anti DNS rebinding.
 *
 * A pergunta que estes testes respondem e sempre a mesma: DUAS grafias do MESMO
 * endereco decidem igual, e duas grafias de enderecos DIFERENTES decidem
 * diferente? Uma allowlist que falhe a primeira metade recusa o dono; uma que
 * falhe a segunda aceita o atacante.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  arrivedViaTunnel,
  buildAllowedRequestHosts,
  canonicalRequestHost,
  hostOfOrigin,
  isAllowedRequestHost,
  isLoopbackRequestHost,
} from '../../../src/http/host-header.ts'
import { normalizeRemoteAddress } from '../../../src/http/origin.ts'

const LOOPBACK = ['127.0.0.1']

describe('canonicalizacao do Host', () => {
  it('colapsa TODAS as grafias equivalentes de loopback para a mesma chave', () => {
    const equivalentes = [
      '127.0.0.1',
      '127.0.0.1:3080',
      '127.0.0.1.',
      '::1',
      '[::1]',
      '[::1]:3080',
      '0:0:0:0:0:0:0:1',
      '0000:0000:0000:0000:0000:0000:0000:0001',
      '::ffff:127.0.0.1',
      '[::ffff:127.0.0.1]:3080',
      // Forma HEXADECIMAL do IPv4 mapeado -- a que `src/session/cookie.ts`
      // regista explicitamente como obrigacao de normalizacao DESTA camada.
      '::ffff:7f00:1',
      '[::ffff:7f00:1]:3080',
      // Zone id de link-local nao faz parte da identidade do par.
      '[::1%eth0]:3080',
      '127.0.0.1%25eth0'.replace('%25', '%'),
    ]

    for (const grafia of equivalentes) {
      assert.equal(canonicalRequestHost(grafia), '127.0.0.1', `grafia recusada: ${grafia}`)
    }
  })

  it('usa a MESMA normalizacao da ponta remota (nao ha duas verdades)', () => {
    // Duas normalizacoes divergentes sao a forma classica de uma allowlist
    // deixar passar o que julga recusar.
    for (const valor of ['::1', '::ffff:127.0.0.1', '[::1]', '0:0:0:0:0:0:0:1']) {
      assert.equal(canonicalRequestHost(valor), normalizeRemoteAddress(valor))
    }
  })

  it('nao confunde `host:porta` com um IPv6 nu', () => {
    assert.equal(canonicalRequestHost('evil.com:3080'), 'evil.com')
    // Um IPv6 que NAO e loopback fica na forma expandida -- que e uma CHAVE DE
    // COMPARACAO, nao um endereco para apresentar. O que importa e que as duas
    // grafias do mesmo endereco produzam a MESMA chave, e que ela nao tenha sido
    // partida ao meio como se o primeiro `:` fosse o separador da porta.
    assert.equal(canonicalRequestHost('fe80::1'), canonicalRequestHost('[fe80::1]:443'))
    assert.equal(canonicalRequestHost('fe80::1'), 'fe80:0:0:0:0:0:0:1')
    assert.notEqual(canonicalRequestHost('fe80::1'), 'fe80')
  })

  it('recusa o que nao e um Host utilizavel', () => {
    assert.equal(canonicalRequestHost(undefined), undefined)
    assert.equal(canonicalRequestHost(''), undefined)
    assert.equal(canonicalRequestHost('   '), undefined)
    // Dois cabecalhos `Host` colapsados pelo Node: request smuggling a bater.
    assert.equal(canonicalRequestHost('127.0.0.1, evil.com'), undefined)
  })

  it('nao lanca com entrada hostil', () => {
    for (const lixo of ['[', ']', '::::', '1:2:3:4:5:6:7:8:9', 'a'.repeat(5000), '%', '::ffff:999.1.1.1']) {
      assert.doesNotThrow(() => canonicalRequestHost(lixo), lixo)
    }
  })
})

describe('allowlist de Host', () => {
  it('aceita as grafias de loopback e recusa o Host forjado', () => {
    for (const bom of ['127.0.0.1:3080', '::1', '[::ffff:7f00:1]:3080', 'localhost:3080']) {
      assert.equal(isAllowedRequestHost(bom, LOOPBACK), true, bom)
    }
    for (const mau of ['evil.com', 'evil.com:3080', '127.0.0.1.evil.com', 'notlocalhost']) {
      assert.equal(isAllowedRequestHost(mau, LOOPBACK), false, mau)
    }
  })

  it('AUSENTE e recusado -- `Host` e obrigatorio em HTTP/1.1', () => {
    assert.equal(isAllowedRequestHost(undefined, LOOPBACK), false)
    assert.equal(isAllowedRequestHost('', LOOPBACK), false)
  })

  it('normaliza tambem as ENTRADAS da lista', () => {
    // Escrever `::1` na lista tem de funcionar contra um `Host: 127.0.0.1`.
    assert.equal(isAllowedRequestHost('127.0.0.1:3080', ['::1']), true)
    assert.equal(isAllowedRequestHost('[::1]:3080', ['::ffff:127.0.0.1']), true)
  })

  it('e allowlist EXATA, nunca "contem"', () => {
    assert.equal(isAllowedRequestHost('evil.com', ['meudominio.com']), false)
    assert.equal(isAllowedRequestHost('meudominio.com.evil.com', ['meudominio.com']), false)
    assert.equal(isAllowedRequestHost('xmeudominio.com', ['meudominio.com']), false)
  })
})

describe('a lista viva: o tunel entra em READY e SAI quando cai', () => {
  it('a origem do tunel entra na allowlist enquanto existe', () => {
    const comTunel = buildAllowedRequestHosts('127.0.0.1', 'https://abc-def.trycloudflare.com')
    assert.equal(isAllowedRequestHost('abc-def.trycloudflare.com', comTunel), true)

    const semTunel = buildAllowedRequestHosts('127.0.0.1', undefined)
    assert.equal(
      isAllowedRequestHost('abc-def.trycloudflare.com', semTunel),
      false,
      'entrada morta: um nome derrubado volta a ser distribuido a outra pessoa',
    )
  })

  it('o loopback esta sempre la, com ou sem tunel', () => {
    for (const origem of [undefined, 'https://abc.trycloudflare.com']) {
      const lista = buildAllowedRequestHosts('127.0.0.1', origem)
      assert.equal(isAllowedRequestHost('127.0.0.1:3080', lista), true)
    }
  })

  it('uma origem malformada NAO entra na lista e nao derruba nada', () => {
    const lista = buildAllowedRequestHosts('127.0.0.1', 'nao-e-uma-url')
    assert.deepEqual(hostOfOrigin('nao-e-uma-url'), undefined)
    assert.equal(isAllowedRequestHost('nao-e-uma-url', lista), false)
    assert.equal(isAllowedRequestHost('127.0.0.1', lista), true)
  })
})

describe('o pedido chegou pelo tunel?', () => {
  it('distingue o nome publico do loopback -- que e o que trustedRemotes ja nao faz', () => {
    const origem = 'https://abc-def.trycloudflare.com'
    assert.equal(arrivedViaTunnel('abc-def.trycloudflare.com', origem), true)
    assert.equal(arrivedViaTunnel('127.0.0.1:3080', origem), false)
    assert.equal(arrivedViaTunnel('outro.trycloudflare.com', origem), false)
  })

  it('sem tunel, nada chegou pelo tunel', () => {
    assert.equal(arrivedViaTunnel('abc-def.trycloudflare.com', undefined), false)
  })
})

describe('canal local apenas -- a pergunta que L2 e L2.5 nao respondem', () => {
  it('aceita 127.0.0.0/8 INTEIRO e as grafias de loopback', () => {
    for (const host of [
      '127.0.0.1',
      '127.0.0.1:3080',
      '127.1.2.3',
      '127.0.0.53',
      '[::1]:3080',
      '0:0:0:0:0:0:0:1',
      '[::ffff:7f00:1]',
      'localhost',
      'localhost:3080',
      'app.localhost',
    ]) {
      assert.equal(isLoopbackRequestHost(host), true, `loopback recusado: ${host}`)
    }
  })

  it('>>> a origem do tunel NAO e local, mesmo estando na allowlist de Host <<<', () => {
    // E o furo inteiro numa linha: a allowlist de `Host` ACEITA o nome do tunel
    // de proposito, e `trustedRemotes` aceita o socket do `cloudflared` porque
    // ele corre em 127.0.0.1. Nenhuma das duas responde "isto e local?".
    const comTunel = buildAllowedRequestHosts('127.0.0.1', 'https://abc-def.trycloudflare.com')
    assert.equal(isAllowedRequestHost('abc-def.trycloudflare.com', comTunel), true)
    assert.equal(isLoopbackRequestHost('abc-def.trycloudflare.com'), false)
  })

  it('recusa LAN, nomes publicos e ausencia', () => {
    for (const host of ['192.168.1.5:3080', '10.0.0.7', 'evil.com', '127.0.0.1.evil.com', undefined, '']) {
      assert.equal(isLoopbackRequestHost(host), false, `aceite indevidamente: ${String(host)}`)
    }
  })
})

describe('arrivedViaTunnel responde sobre o NOME, nao sobre o caminho fisico', () => {
  const ORIGEM = 'https://abc-def.trycloudflare.com'

  it('>>> LIMITE CONHECIDO: um processo LOCAL pode escrever o nome do tunel <<<', () => {
    // O JSDoc anterior chamava a esta funcao "o pedido chegou pelo tunel?", e
    // isso AFIRMAVA MAIS DO QUE ELA GARANTE. O que ela compara e uma string
    // escolhida pelo cliente. Um processo local que abra um socket direto para
    // `127.0.0.1:<porta>` e escreva este `Host` e, aqui, indistinguivel de um
    // pedido que atravessou mesmo a borda -- e ele passa L2, porque `127.0.0.1`
    // esta em `trustedRemotes` por desenho.
    //
    // Este teste existe para o limite ficar NOMEADO e nao insinuado: se alguem
    // vier a fechar o furo (um listener de loopback dedicado a exposicao, com o
    // portao a ler a porta local do socket em vez de um cabecalho), este teste
    // muda -- e a mudanca sera deliberada.
    assert.equal(arrivedViaTunnel('abc-def.trycloudflare.com', ORIGEM), true)
  })

  it('o residual pesa em `trustEdgeHeaders`, e NAO no modo restrito', () => {
    // No modo restrito, escrever o nome do tunel so pode FECHAR a porta a si
    // proprio -- a credencial passa a ser recusada. Ninguem forja isto para
    // ganhar acesso. O residual vive todo do lado de `trustEdgeHeaders`, que e
    // opt-in, vem `false` do manifesto e e recusado fora de `mode: 'tunnel'`.
    assert.equal(arrivedViaTunnel('127.0.0.1:3080', ORIGEM), false)
    assert.equal(arrivedViaTunnel('outro.trycloudflare.com', ORIGEM), false)
    assert.equal(arrivedViaTunnel('abc-def.trycloudflare.com', undefined), false)
  })
})
