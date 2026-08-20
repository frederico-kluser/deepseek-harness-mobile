/**
 * `src/audit/format.ts` -- o QUE fica escrito.
 *
 * Q-4 ("o segredo nunca entra num log") e o tema desta sub-tarefa, e a maior
 * parte destes casos existe para o falsificar: cada um poe um segredo real na
 * entrada e exige que ele NAO apareca na saida.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import {
  AuditFormatError,
  EVENTO_SEM_NOME,
  IP_INVALIDO,
  MAX_EVENTO_LENGTH,
  TRUNCATED_MARK,
  formatAuditLine,
  hashSessionId,
  maskAuditText,
  normalizeIp,
  toAuditRecord,
} from '../../../src/audit/format.ts'
import { REDACTED, redact } from '../../../src/logging/redact.ts'

/** Token com a forma real: id de 9-10 digitos + 35 caracteres de segredo. */
const TOKEN_REAL = '7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'

/** Segredo do plugin na forma de apresentacao (base32 RFC 4648, 256 bits). */
const SEGREDO_BASE32 = 'MZXW6YTBOI5DCMRTGQZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGE'

describe('maskAuditText -- token do bot DENTRO do URL (pergunta 1)', () => {
  it('mascara o token quando ele aparece no CAMINHO do URL da Bot API', () => {
    // Esta e a forma em que o token realmente vaza: nao como campo, mas como
    // parte do endereco de cada pedido HTTP.
    const bruto = `HTTPError 401 em https://api.telegram.org/bot${TOKEN_REAL}/sendMessage?chat_id=42`

    const limpo = maskAuditText(bruto)

    assert.equal(limpo.includes('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'), false, 'o segredo NAO sobrevive')
    assert.equal(limpo.includes(REDACTED), true)
    assert.equal(limpo.includes('api.telegram.org'), true, 'o resto do URL continua legivel')
  })

  it('mascara o token isolado, fora de qualquer URL', () => {
    assert.equal(maskAuditText(`token=bot${TOKEN_REAL}`).includes('AAHdqTcv'), false)
  })

  it('apanha o token CURTO que `redact()` deixa passar por desenho', () => {
    // A diferenca documentada em AUDIT_SHAPES, provada em vez de afirmada:
    // a forma de `redact.ts` exige >= 20 caracteres depois dos dois pontos.
    const url = 'https://api.telegram.org/bot7123456789:CURTO/getMe'

    assert.equal(redact(url).includes(':CURTO'), true, 'redact() sozinho deixa passar')
    assert.equal(maskAuditText(url).includes('CURTO'), false, 'maskAuditText() nao deixa')
  })
})

describe('maskAuditText -- os outros tres segredos', () => {
  it('mascara o `mk` do link magico na query E no fragmento', () => {
    const query = maskAuditText('GET /__guard/magic?mk=9f8e7d6c5b4a39281706&next=/')
    assert.equal(query.includes('9f8e7d6c5b4a39281706'), false)
    assert.equal(query.includes('mk='), true, 'o nome do parametro nao e segredo')
    assert.equal(query.includes('next=/'), true, 'o que vem depois do & sobrevive')

    const frag = maskAuditText('abriu https://exemplo.com/p#mk=9f8e7d6c5b4a39281706')
    assert.equal(frag.includes('9f8e7d6c5b4a39281706'), false)
  })

  it('nao confunde `mk=` com o sufixo de outra chave', () => {
    assert.equal(maskAuditText('webhook_mk=visivel').includes('visivel'), true)
  })

  it('mascara o URL do tunel efemero -- o URL E a capacidade', () => {
    const limpo = maskAuditText('tunel pronto em https://brave-lion-runs-fast.trycloudflare.com')
    assert.equal(limpo.includes('brave-lion-runs-fast'), false)
    assert.equal(limpo.includes('trycloudflare.com'), false)
  })

  it('mascara o URL do tunel COLADO a um caractere de palavra (regressao)', () => {
    // A forma tinha um `(\b)` a abrir. Sem fronteira de palavra entre `1` e `h`
    // o padrao nao casava e o URL saia inteiro para o ficheiro.
    for (const prefixo of ['url1', 'MZXW6YTBOI', 'x']) {
      const limpo = maskAuditText(`${prefixo}https://brave-lion.trycloudflare.com/painel`)
      assert.equal(limpo.includes('trycloudflare'), false, `prefixo ${prefixo}`)
    }
  })

  it('mascara o URL de um tunel `named` pela camada de literais conhecidos', () => {
    // Um dominio proprio nao tem forma adivinhavel: e para isto que serve o
    // fornecedor de segredos de `openAuditLog`.
    const url = 'https://bot.exemplo-do-dono.net'
    assert.equal(maskAuditText(`tunel em ${url}/x`, [url]).includes('exemplo-do-dono'), false)
  })

  it('mascara o segredo do plugin pela FORMA (base32), sem o conhecer', () => {
    assert.equal(maskAuditText(`tentou ${SEGREDO_BASE32}`).includes(SEGREDO_BASE32), false)
  })

  it('mascara o segredo tambem na forma agrupada, ditavel ao telefone', () => {
    const agrupado = 'MZXW6-YTBOI-5DCMR-TGQZD-GNBVG-Y3TQO'
    assert.equal(maskAuditText(`ditou ${agrupado}`).includes('YTBOI'), false)
  })

  it('mascara o segredo com hifen COLADO de cada lado (regressao)', () => {
    // As fronteiras excluiam o hifen, e um hifen adjacente fazia o match falhar
    // POR COMPLETO -- na forma que e feita de hifens.
    for (const volta of [`-${SEGREDO_BASE32}`, `${SEGREDO_BASE32}-`, `-${SEGREDO_BASE32}-`]) {
      assert.equal(maskAuditText(`tentou ${volta}`).includes('MZXW6YTBOI'), false, volta.slice(0, 3))
    }
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

describe('maskAuditText -- idempotencia como PROPRIEDADE, nao como exemplo', () => {
  const PECAS = [
    `bot${TOKEN_REAL}`,
    SEGREDO_BASE32,
    'MZXW6-YTBOI-5DCMR-TGQZD-GNBVG-Y3TQO',
    'https://q.trycloudflare.com/x',
    '?mk=9f8e7d6c5b4a3928',
    'Authorization: Basic YWRtaW46czNjcjN0',
    'auth_falhou',
    ' ',
    '-',
    'url1',
    '"',
  ]
  const SEGREDOS = ['AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw', 'MZXW6YTBOI', 'q.trycloudflare.com', '9f8e7d6c5b4a3928']

  /** Monta uma entrada com `partes` pecas, coladas ou separadas. */
  function montar(proximo: () => number, separador: string): string {
    let entrada = ''
    const partes = 1 + Math.floor(proximo() * 5)
    for (let j = 0; j < partes; j += 1) {
      entrada += (j === 0 ? '' : separador) + (PECAS[Math.floor(proximo() * PECAS.length)] ?? '')
    }
    return entrada
  }

  it('mask(mask(x)) === mask(x) SEMPRE, mesmo com as pecas coladas -- 20 000 casos', () => {
    const proximo = prng(20_260_820)
    for (let i = 0; i < 20_000; i += 1) {
      const entrada = montar(proximo, i % 2 === 0 ? '' : ' ')
      const uma = maskAuditText(entrada)
      assert.equal(maskAuditText(uma), uma, `nao idempotente: ${JSON.stringify(entrada)}`)
    }
  })

  it('nenhum segredo sobrevive quando as pecas vem separadas -- 20 000 casos', () => {
    const proximo = prng(4_242)
    for (let i = 0; i < 20_000; i += 1) {
      const entrada = montar(proximo, ' ')
      const uma = maskAuditText(entrada)
      for (const segredo of SEGREDOS) {
        assert.equal(uma.includes(segredo), false, `${segredo} sobreviveu em ${JSON.stringify(entrada)}`)
      }
    }
  })

  it('apanha a CAUDA que a camada 1 engole em dois tokens colados', () => {
    // Achado pelo teste de propriedade: `redact()` e guloso e, em
    // `bot<id>:<s1>bot<id>:<s2>` sem separador, deixa `:<s2>` para tras. A forma
    // da cauda fecha isso -- ver AUDIT_SHAPES.
    const colados = `bot7123456789:${'A'.repeat(35)}bot9987654321:${'B'.repeat(35)}`
    const limpo = maskAuditText(colados)
    assert.equal(limpo.includes('A'.repeat(25)), false, 'o primeiro segredo cai')
    assert.equal(limpo.includes('B'.repeat(25)), false, 'e a cauda do segundo tambem')
  })

  it('fio de alarme: a forma da cauda tem o marcador literal la dentro', () => {
    assert.equal(REDACTED, '[REDACTED]', 'se isto mudar, AUDIT_SHAPES tem de mudar com ele')
  })
})

describe('normalizeIp', () => {
  it('desfaz o mapeamento v4-em-v6', () => {
    assert.equal(normalizeIp('::ffff:127.0.0.1'), '127.0.0.1')
  })

  it('tira colchetes, porta e zona de scope', () => {
    assert.equal(normalizeIp('[2001:DB8::1]:8443'), '2001:db8::1')
    assert.equal(normalizeIp('192.168.0.7:51234'), '192.168.0.7')
    assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1')
  })

  it('devolve null quando nao ha IP fiavel -- o caso NORMAL sob cloudflared', () => {
    assert.equal(normalizeIp(undefined), null)
    assert.equal(normalizeIp('   '), null)
  })

  it('nao escreve texto arbitrario num campo chamado `ip`', () => {
    // `X-Forwarded-For` e ACRESCENTADO ao valor do cliente (spike S2): o
    // conteudo deste campo pode ser escolhido por quem ataca.
    assert.equal(normalizeIp('<script>alert(1)</script>'), IP_INVALIDO)
  })
})

describe('hashSessionId', () => {
  it('devolve 64 nibbles hexadecimais, estaveis para o mesmo id', () => {
    const id = 'v9Xk2Lp7Qs4Tz1Rb8Nw3Cy'
    assert.match(hashSessionId(id), /^[0-9a-f]{64}$/u)
    assert.equal(hashSessionId(id), hashSessionId(id), 'correlacionavel entre linhas')
    assert.notEqual(hashSessionId(id), hashSessionId(`${id}x`))
  })

  it('nao deixa o id cru dentro do digest', () => {
    assert.equal(hashSessionId('v9Xk2Lp7Qs4Tz1Rb8Nw3Cy').includes('v9Xk'), false)
  })
})

describe('toAuditRecord -- lista branca (pergunta 4)', () => {
  it('nao ha caminho por onde um campo nao previsto chegue ao ficheiro', () => {
    // O cenario que a pergunta 4 descreve: alguem, um dia, acrescenta o segredo
    // tentado ao objeto de evento. A lista branca deixa-o de fora sem que este
    // ficheiro precise de conhecer o nome do campo.
    const hostil = {
      evento: 'auth_falhou',
      resultado: 'negado',
      segredo_tentado: 'HUNTER2-EM-CLARO',
      sha256_do_segredo: 'a'.repeat(64),
    } as unknown as AuditEvent

    const linha = formatAuditLine(hostil, 0)

    assert.equal(linha.includes('HUNTER2'), false)
    assert.equal(linha.includes('segredo_tentado'), false)
    assert.equal(linha.includes('sha256_do_segredo'), false)
  })

  it('a forma e sempre a mesma, pela mesma ordem, com null explicito', () => {
    const linha = formatAuditLine({ evento: 'auth_ok', resultado: 'permitido' }, 1_700_000_000_000)

    assert.deepEqual(Object.keys(JSON.parse(linha) as object), [
      'ts',
      'evento',
      'resultado',
      'ip_normalizado',
      'sessao_id_hash',
    ])
    assert.equal((JSON.parse(linha) as { ip_normalizado: unknown }).ip_normalizado, null)
    assert.equal((JSON.parse(linha) as { ts: string }).ts, '2023-11-14T22:13:20.000Z')
  })

  it('recusa `sessao_id_hash` que nao tem forma de digest -- seria o id cru', () => {
    const rec = toAuditRecord(
      { evento: 'e', resultado: 'negado', sessao_id_hash: 'v9Xk2Lp7Qs4Tz1Rb8Nw3Cy' },
      0,
    )
    assert.equal(rec.sessao_id_hash, REDACTED)
  })

  it('aceita um digest legitimo', () => {
    const hash = hashSessionId('v9Xk2Lp7Qs4Tz1Rb8Nw3Cy')
    assert.equal(toAuditRecord({ evento: 'e', resultado: 'negado', sessao_id_hash: hash }, 0).sessao_id_hash, hash)
  })

  it('LANCA com `resultado` invalido -- um registo invertido e pior que nenhum', () => {
    assert.throws(
      () => toAuditRecord({ evento: 'e', resultado: 'talvez' } as unknown as AuditEvent, 0),
      AuditFormatError,
    )
  })

  it('LANCA com `ts` fora do alcance de um Date, em vez de deixar sair um RangeError', () => {
    assert.throws(() => toAuditRecord({ evento: 'e', resultado: 'negado' }, 1e20), AuditFormatError)
    assert.throws(() => toAuditRecord({ evento: 'e', resultado: 'negado' }, Number.NaN), AuditFormatError)
  })

  it('regista o facto quando o nome do evento vem vazio, em vez de rebentar', () => {
    assert.equal(toAuditRecord({ evento: '   ', resultado: 'negado' }, 0).evento, EVENTO_SEM_NOME)
  })

  it('corta um `evento` sem fim -- linha curta e o que mantem o write atomico', () => {
    const rec = toAuditRecord({ evento: 'a'.repeat(5000), resultado: 'negado' }, 0)
    assert.equal(rec.evento.length, MAX_EVENTO_LENGTH + TRUNCATED_MARK.length)
    assert.equal(rec.evento.endsWith(TRUNCATED_MARK), true)
  })
})

describe('formatAuditLine -- uma linha e uma linha (injecao de log)', () => {
  it('um `evento` com quebras de linha NAO produz um segundo registo', () => {
    const forjado = 'auth_falhou\n{"ts":"1970-01-01T00:00:00.000Z","evento":"auth_ok","resultado":"permitido"}'

    const saida = formatAuditLine({ evento: forjado, resultado: 'negado' }, 0)

    assert.equal(saida.split('\n').filter((l) => l.length > 0).length, 1, 'exatamente UMA linha')
    assert.equal(saida.endsWith('\n'), true)
    assert.equal((JSON.parse(saida) as { resultado: string }).resultado, 'negado')
  })

  it('mascara o IP e o evento antes de serializar', () => {
    const linha = formatAuditLine(
      { evento: `chamou https://api.telegram.org/bot${TOKEN_REAL}/getMe`, resultado: 'negado', ip_normalizado: '::ffff:10.0.0.9' },
      0,
    )
    const rec = JSON.parse(linha) as { evento: string; ip_normalizado: string }
    assert.equal(rec.evento.includes('AAHdqTcv'), false)
    assert.equal(rec.ip_normalizado, '10.0.0.9')
  })
})
