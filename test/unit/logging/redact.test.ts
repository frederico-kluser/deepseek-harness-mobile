/**
 * `src/logging/redact.ts` -- Q-4: segredo nunca em log.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { redact, REDACTED } from '../../../src/logging/redact.ts'

describe('redact', () => {
  it('mascara um literal conhecido onde quer que ele apareca', () => {
    const token = '123456789:AAH-segredo-do-bot-que-nao-pode-vazar'
    const linha = `HTTPError: 401 for url https://api.telegram.org/bot${token}/getUpdates`

    const limpo = redact(linha, [token])

    assert.equal(limpo.includes(token), false, 'o token NAO pode sobreviver')
    assert.equal(limpo.includes(REDACTED), true)
    assert.equal(limpo.includes('api.telegram.org'), true, 'o resto da linha continua legivel')
  })

  it('mascara a FORMA de um token de bot mesmo sem o conhecer', () => {
    const linha = 'GET https://api.telegram.org/bot987654321:ZZZZZZZZZZZZZZZZZZZZZZZZ/sendMessage'

    const limpo = redact(linha)

    assert.equal(limpo.includes('ZZZZZZZZZZZZZZZZZZZZZZZZ'), false)
    assert.equal(limpo.includes('987654321:'), true, 'o id numerico nao e segredo')
  })

  it('mascara o VALOR de Authorization e de Cookie, mantendo o nome', () => {
    const dump = 'Authorization: Basic YWRtaW46czNjcjN0\nSet-Cookie: __Host-dsh_sid=abc123; Path=/'

    const limpo = redact(dump)

    assert.equal(limpo.includes('YWRtaW46czNjcjN0'), false)
    assert.equal(limpo.includes('abc123'), false)
    assert.equal(limpo.includes('Authorization: '), true)
    assert.equal(limpo.includes('Set-Cookie: '), true)
  })

  it('ignora literais curtos demais para serem segredo (evita ruido)', () => {
    // Mascarar `'x'` transformaria metade do log em [REDACTED].
    assert.equal(redact('o worker x saiu com codigo x', ['x']), 'o worker x saiu com codigo x')
  })

  it('e reentrante: duas chamadas seguidas dao o mesmo resultado', () => {
    const linha = 'Authorization: Basic YWRtaW46czNjcjN0'
    assert.equal(redact(linha), redact(linha))
  })
})

/* ========================================================================== */
/* EMENDA 4 DA COSTURA -- AS FORMAS PROMOVIDAS PARA `SECRET_SHAPES`            */
/* ========================================================================== */

/**
 * O cabecalho deste modulo declarava, por escrito, que o `mk` do link magico e o
 * URL do tunel NAO estavam aqui "ate os donos as fixarem". Foram fixadas -- e
 * viveram em `AUDIT_SHAPES` (`src/audit/format.ts`) durante uma onda inteira, o
 * que significa que so quem chamava `maskAuditText` as tinha. Quem chamava
 * `redact()` diretamente -- TODO o encaminhamento de stdout/stderr de
 * subprocesso -- nao tinha nenhuma das duas, e e por ai que o `cloudflared`
 * imprime a URL do tunel a cada arranque.
 */
describe('EMENDA 4: a URL do quick tunnel', () => {
  const URL_DO_TUNEL = 'https://marks-organization-moved-coupons.trycloudflare.com'

  it('desaparece, com esquema, caminho e query', () => {
    const limpo = redact(`INF |  ${URL_DO_TUNEL}/__guard/magic?mk=abc  |`)

    assert.equal(limpo.includes('trycloudflare'), false)
    assert.equal(limpo.includes('marks-organization'), false)
    assert.equal(limpo.includes(REDACTED), true)
  })

  it('desaparece mesmo COLADA a outro texto (nao ha ancora de fronteira)', () => {
    // Regressao medida: um `(\b)` a abrir capturava a string vazia e falhava em
    // `url1https://...`, onde nao ha fronteira de palavra entre `1` e `h`.
    assert.equal(redact(`url1${URL_DO_TUNEL}`).includes('trycloudflare'), false)
  })

  it('NAO come um dominio qualquer -- mascarar tudo nao e mascarar', () => {
    assert.equal(redact('falhou https://api.telegram.org/getMe'), 'falhou https://api.telegram.org/getMe')
  })
})

describe('EMENDA 4: o `mk` do link magico', () => {
  it('perde o valor e mantem o nome da chave', () => {
    const limpo = redact('abriu /__guard/magic?mk=9f8e7d6c5b4a39281706')

    assert.equal(limpo.includes('9f8e7d6c5b4a39281706'), false)
    assert.equal(limpo.includes('mk='), true, 'o nome da chave nao e segredo e diz o que se perdeu')
  })

  it('cobre o FRAGMENTO, que e a variante que nem chega ao servidor', () => {
    assert.equal(redact('#mk=9f8e7d6c5b4a39281706').includes('9f8e7d'), false)
  })

  it('NAO casa o sufixo de outra chave (`webhook_mk=`)', () => {
    // O lookbehind existe para isto: `webhook_mk=` e outra chave, nao o `mk`.
    assert.equal(redact('webhook_mk=publico').includes('publico'), true)
  })
})

describe('EMENDA 4: o caminho absoluto -- o `$HOME`, e SO o `$HOME`', () => {
  /*
   * A REGRA ESCOLHIDA. O remendo local que isto substitui (`maskAbsolutePaths`,
   * em `src/panel/api.ts`) comia QUALQUER caminho absoluto com tres segmentos.
   * Mascarar caminhos e a forma mais facil de destruir uma mensagem de erro
   * util: `/opt/bin/cloudflared` e `/usr/lib/node_modules/...` sao estrutura de
   * sistema, iguais em todas as maquinas, e nao identificam ninguem -- sao
   * exatamente o que diz ao operador onde procurar.
   *
   * O que identifica o UTILIZADOR e o `$HOME`. E isso que sai; o que fica por
   * baixo continua a dizer QUAL o ficheiro sem dizer DE QUEM.
   */
  it('tira o `/home/<nome>` e deixa o resto do caminho legivel', () => {
    const limpo = redact('nao consegui abrir /home/ondokai/.dsh/guarded-bot/audit.log')

    assert.equal(limpo.includes('/home/ondokai'), false, 'o nome de conta identifica o dono')
    assert.equal(limpo.includes('.dsh/guarded-bot/audit.log'), true, 'o ficheiro tem de sobreviver')
  })

  it('cobre `/Users/<nome>` (darwin) e `/root`', () => {
    assert.equal(redact('/Users/ana/Library/x').includes('/Users/ana'), false)
    assert.equal(redact('/root/.dsh/state.json').includes('/root/'), false)
    assert.equal(redact('/root/.dsh/state.json').includes('.dsh/state.json'), true)
  })

  it('NAO toca em estrutura de sistema nem em caminho de ROTA', () => {
    for (const intacto of [
      'o binario /opt/bin/cloudflared nao existe',
      'falhou em /usr/lib/node_modules/dsh/index.js',
      'tente /__guard outra vez',
      'a sonda /api/state falhou',
      'escrevi em /tmp/dsh-guard-abc/audit.log',
    ]) {
      assert.equal(redact(intacto), intacto, intacto)
    }
  })

  it('NAO casa um prefixo que so PARECE `$HOME`', () => {
    assert.equal(redact('/homework/planos').includes('/homework/planos'), true)
    assert.equal(redact('/rootkit/x').includes('/rootkit/x'), true)
  })
})

/** PRNG deterministico: um teste de propriedade que nao reproduz nao e prova. */
function prng(seed: number): () => number {
  let estado = seed >>> 0
  return (): number => {
    estado = (estado * 1_664_525 + 1_013_904_223) >>> 0
    return estado / 0x1_00_00_00_00
  }
}

describe('EMENDA 4: as formas novas como PROPRIEDADE, nao como exemplo', () => {
  const PECAS = [
    'https://q1.trycloudflare.com/__guard/magic',
    'http://a-b-c.trycloudflare.com',
    '?mk=9f8e7d6c5b4a3928',
    '&mk=0011223344556677',
    '/home/ondokai/.dsh/audit.log',
    '/Users/ana/Library/Logs/dsh.log',
    '/root/.dsh/state.json',
    '/opt/bin/cloudflared',
    '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
    'Authorization: Basic YWRtaW46czNjcjN0',
    'tunel_arranque',
    ' ',
    '-',
    'url1',
    '"',
  ]
  const SEGREDOS = [
    'q1.trycloudflare.com',
    'a-b-c.trycloudflare.com',
    '9f8e7d6c5b4a3928',
    '0011223344556677',
    '/home/ondokai',
    '/Users/ana',
    'AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
  ]

  function montar(proximo: () => number, separador: string): string {
    let entrada = ''
    const partes = 1 + Math.floor(proximo() * 5)
    for (let j = 0; j < partes; j += 1) {
      entrada += (j === 0 ? '' : separador) + (PECAS[Math.floor(proximo() * PECAS.length)] ?? '')
    }
    return entrada
  }

  it('redact(redact(x)) === redact(x) SEMPRE, coladas ou separadas -- 20 000 casos', () => {
    // Um mascarador nao idempotente come o proprio marcador e volta a expor o
    // resto da linha na segunda passagem -- e ha caminhos que mascaram duas
    // vezes (`maskAuditText` chama `redact` e a auditoria formata depois).
    const proximo = prng(20_260_820)
    for (let i = 0; i < 20_000; i += 1) {
      const entrada = montar(proximo, i % 2 === 0 ? '' : ' ')
      const uma = redact(entrada)
      assert.equal(redact(uma), uma, `nao idempotente: ${JSON.stringify(entrada)}`)
    }
  })

  it('nenhum segredo sobrevive quando as pecas vem separadas -- 20 000 casos', () => {
    const proximo = prng(4_242)
    for (let i = 0; i < 20_000; i += 1) {
      const entrada = montar(proximo, ' ')
      const uma = redact(entrada)
      for (const segredo of SEGREDOS) {
        assert.equal(uma.includes(segredo), false, `${segredo} sobreviveu em ${JSON.stringify(entrada)}`)
      }
    }
  })

  it('e a estrutura de sistema sobrevive a TODAS as voltas -- mascarar nao e apagar', () => {
    // O caminho de sistema vem A FRENTE de proposito: a forma de
    // `Authorization:` corta ate ao FIM DA LINHA (o valor de `Basic <cred>` tem
    // um espaco no meio), logo tudo o que venha DEPOIS dela cai com ela. Isso e
    // desenho antigo e correcto -- nao e o que esta propriedade mede.
    const proximo = prng(777)
    for (let i = 0; i < 5_000; i += 1) {
      const entrada = `/opt/bin/cloudflared ${montar(proximo, ' ')}`
      assert.equal(redact(entrada).includes('/opt/bin/cloudflared'), true, entrada)
    }
  })
})
