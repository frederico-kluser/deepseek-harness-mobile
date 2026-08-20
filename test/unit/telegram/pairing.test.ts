/**
 * `src/telegram/pairing.ts` — o codigo de pareamento.
 *
 * COBRE: `PAIR-001` (6 digitos de CSPRNG, TTL 5 min, uso unico, so no
 * terminal), `PAIR-002` a `PAIR-005`, `PAIR-007`, `PAIR-009`, `PAIR-010`,
 * `TG-064`, `TG-065` e `TG-066`.
 *
 * AS TRES FALHAS QUE A REVISAO EXIGE PROVADAS (`03-ONDAS.md` 9, pergunta 5):
 * um `/parear` com codigo ERRADO nao pareia; um com codigo EXPIRADO nao pareia;
 * um `/start` de estranho que chegue ANTES do dono nao pareia. Estao nos tres
 * casos marcados com essas etiquetas.
 *
 * O relogio e SEMPRE injetado (`test/support/clock.ts`): nenhum teste aqui
 * espera cinco minutos reais, e nenhum mexe no `Date.now()` global.
 *
 * NENHUM TESTE FALA COM `api.telegram.org`. Este ficheiro nem sequer abre um
 * socket: os updates sao objetos, que e exatamente o que `getUpdates` devolve
 * depois do `JSON.parse`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inspect } from 'node:util'

import {
  DIGITOS_DO_CODIGO,
  PairingError,
  TENTATIVAS_MAXIMAS,
  TTL_DO_CODIGO_MS,
  codigoTemFormaValida,
  codigosSaoIguais,
  criarSessaoDePareamento,
  gerarCodigoDePareamento,
  lerComandoDePareamento,
  type ResultadoDeOferta,
  type SessaoDePareamento,
} from '../../../src/telegram/pairing.ts'
import { FakeClock } from '../../support/clock.ts'

/* -------------------------------------------------------------------------- */
/* Dubles de update — a forma medida da Bot API, sem rede                      */
/* -------------------------------------------------------------------------- */

/**
 * Um update de mensagem privada com AMBOS os ids que a allowlist valida.
 *
 * `fromId` e `chatId` sao DIFERENTES por omissao aqui, ao contrario da conversa
 * privada real onde coincidem: e a unica forma de provar que o codigo le os
 * DOIS campos e nao um deles duas vezes (A-12 de `05-QUALIDADE-CODIGO.md`).
 */
function updateDeMensagem(texto: string, fromId = 777_000_123, chatId = 555_000_999): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_800_000_000,
      from: { id: fromId, is_bot: false, first_name: 'Dono' },
      chat: { id: chatId, type: 'private' },
      text: texto,
    },
  }
}

/** Channel post: `message.from` AUSENTE — a doc marca o campo `Optional`. */
function updateDeCanal(texto: string): unknown {
  return {
    update_id: 2,
    channel_post: { message_id: 2, chat: { id: -100_123, type: 'channel' }, text: texto },
  }
}

function sessaoDeTeste(
  relogio: FakeClock,
  codigo = '123456',
  extra: { readonly ttlMs?: number; readonly tentativasMaximas?: number } = {},
): SessaoDePareamento {
  return criarSessaoDePareamento({ clock: relogio, codigo, ...extra })
}

function motivoDe(resultado: ResultadoDeOferta): string {
  return resultado.tipo === 'descartado' ? resultado.motivo : 'pareado'
}

/**
 * Apanha a excecao COM O TIPO, que `assert.throws` nao da (ele devolve `void`).
 * Sem isto, verificar o `code` obrigaria a um `as` sobre `void`.
 */
function capturar(fn: () => unknown): PairingError {
  try {
    fn()
  } catch (erro) {
    assert.ok(erro instanceof PairingError, `esperava-se PairingError, veio ${String(erro)}`)
    return erro
  }
  assert.fail('esperava-se uma excecao e nao houve nenhuma')
}

/* ========================================================================== */

describe('PAIR-001: a geracao do codigo', () => {
  it('sao exatamente 6 digitos, e `000000` e um codigo legitimo', () => {
    // O `padStart` e o que mantem o espaco em 10^6. Sem ele, todo o codigo
    // comecado por zero desaparecia e o espaco encolhia para 900 000.
    assert.equal(gerarCodigoDePareamento(() => 0), '000000')
    assert.equal(gerarCodigoDePareamento(() => 999_999), '999999')
    assert.equal(gerarCodigoDePareamento(() => 42), '000042')
    for (const codigo of [
      gerarCodigoDePareamento(() => 0),
      gerarCodigoDePareamento(() => 7),
      gerarCodigoDePareamento(),
    ]) {
      assert.equal(codigo.length, DIGITOS_DO_CODIGO)
      assert.ok(codigoTemFormaValida(codigo), `${codigo} devia ter a forma \\d{6}`)
    }
  })

  it('pede o intervalo [0, 10^6) a fonte — uniforme, sem vies de modulo', () => {
    let visto: { min: number; max: number } | undefined
    gerarCodigoDePareamento((min, max) => {
      visto = { min, max }
      return 5
    })
    assert.deepEqual(visto, { min: 0, max: 1_000_000 })
  })

  it('a fonte por omissao e o CSPRNG do `node:crypto`, e nao repete trivialmente', () => {
    // Nao e teste de aleatoriedade (nenhum teste unitario o e): e a guarda
    // contra o erro real — alguem trocar `randomInt` por `Math.random` ou por
    // uma constante. 200 amostras com 10^6 valores dao colisao com
    // probabilidade ~2%, logo exigir >150 distintos e folgado e estavel.
    const amostras = new Set<string>()
    for (let i = 0; i < 200; i += 1) amostras.add(gerarCodigoDePareamento())
    assert.ok(amostras.size > 150, `so ${String(amostras.size)} codigos distintos em 200`)
  })

  it('o TTL por omissao e de 5 minutos', () => {
    assert.equal(TTL_DO_CODIGO_MS, 5 * 60 * 1000)
    const relogio = new FakeClock(1_000)
    const sessao = criarSessaoDePareamento({ clock: relogio })
    assert.equal(sessao.restanteMs(), 5 * 60 * 1000)
  })

  it('recusa um codigo com forma errada, e a recusa NAO mostra o codigo', () => {
    const relogio = new FakeClock(0)
    const erro = capturar(() => criarSessaoDePareamento({ clock: relogio, codigo: '12345' }))
    assert.equal(erro.code, 'PAIRING_CODE_MALFORMED')
    assert.ok(!erro.message.includes('12345'), 'a mensagem nao pode repetir o codigo recusado')
  })

  it('recusa TTL nao positivo e teto de tentativas nao positivo (fail loud)', () => {
    const relogio = new FakeClock(0)
    for (const ttlMs of [0, -1, Number.NaN]) {
      assert.throws(() => criarSessaoDePareamento({ clock: relogio, ttlMs }), PairingError)
    }
    for (const tentativasMaximas of [0, -3, 1.5]) {
      assert.throws(
        () => criarSessaoDePareamento({ clock: relogio, tentativasMaximas }),
        PairingError,
      )
    }
  })
})

describe('PAIR-010: o codigo existe no terminal e em mais lado nenhum', () => {
  it('`JSON.stringify` da sessao NAO contem o codigo', () => {
    // E este o caminho real de um vazamento: um objeto que vai parar a um corpo
    // HTTP, a um `sendMessage`, ou a uma linha de log estruturado.
    const sessao = sessaoDeTeste(new FakeClock(0), '314159')
    const serializado = JSON.stringify(sessao)
    assert.ok(!serializado.includes('314159'), serializado)
    assert.ok(serializado.includes('"estado":"aberto"'), 'o resumo tem de continuar util')
  })

  it('inspecionar a sessao (o que um `console.log` faz) NAO revela o codigo', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '271828')
    const inspecionado = inspect(sessao, { depth: 5 })
    assert.ok(!inspecionado.includes('271828'), inspecionado)
  })

  it('o resumo, que e o que pode ir para log e painel, nao tem campo com o codigo', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '161803')
    const resumo = sessao.resumo()
    assert.ok(!JSON.stringify(resumo).includes('161803'))
    assert.deepEqual(Object.keys(resumo).toSorted(), [
      'criadoEm',
      'descartados',
      'estado',
      'expiraEm',
      'tentativas',
      'tentativasRestantes',
    ])
  })

  it('`revelarCodigo()` e a unica porta, e fecha-se depois do pareamento', () => {
    const relogio = new FakeClock(0)
    const sessao = sessaoDeTeste(relogio, '123456')
    assert.equal(sessao.revelarCodigo(), '123456')
    sessao.oferecer(updateDeMensagem('/parear 123456'))
    const erro = capturar(() => sessao.revelarCodigo())
    assert.equal(erro.code, 'PAIRING_SESSION_CLOSED')
  })
})

describe('leitura do update: o que e e o que nao e um `/parear`', () => {
  it('le `/parear 123456` e devolve `from.id` E `chat.id`, que sao campos distintos', () => {
    const lido = lerComandoDePareamento(updateDeMensagem('/parear 123456', 111, 222))
    assert.deepEqual(lido, { userId: 111, chatId: 222, codigo: '123456' })
  })

  it('aceita o sufixo `@nome_do_bot` que o cliente acrescenta em grupo', () => {
    const lido = lerComandoDePareamento(updateDeMensagem('/parear@meu_painel_bot 123456'))
    assert.equal('codigo' in lido ? lido.codigo : undefined, '123456')
  })

  it('`/start` NAO e comando de pareamento — em nenhuma variante', () => {
    for (const texto of ['/start', '/start 123456', '/start@meu_bot', 'ola', '/parear']) {
      const lido = lerComandoDePareamento(updateDeMensagem(texto))
      assert.deepEqual(lido, { descarte: 'nao-e-comando-de-pareamento' }, texto)
    }
  })

  it('`/parear 1234567` nao e comando de pareamento — nao se trunca para `123456`', () => {
    // Sem a ancora no fim, um `\d+` leria `123456` de `1234567` e parearia com
    // um codigo que ninguem escreveu. E, por nao casar, tambem NAO gasta o teto
    // de tentativas — ver o bloco B3 no fim deste ficheiro.
    assert.deepEqual(lerComandoDePareamento(updateDeMensagem('/parear 1234567')), {
      descarte: 'nao-e-comando-de-pareamento',
    })
  })

  it('channel post (sem `message.from`) e negacao, nao "assume-se o chat"', () => {
    assert.deepEqual(lerComandoDePareamento(updateDeCanal('/parear 123456')), {
      descarte: 'nao-e-comando-de-pareamento',
    })
    // E a forma direta: `message` sem `from`.
    const semRemetente = {
      update_id: 3,
      message: { message_id: 3, chat: { id: 9, type: 'private' }, text: '/parear 123456' },
    }
    assert.deepEqual(lerComandoDePareamento(semRemetente), { descarte: 'sem-remetente' })
  })

  it('id nao inteiro, nao finito ou fora do inteiro seguro e recusado', () => {
    for (const id of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '123', null, 2 ** 60]) {
      const update = {
        update_id: 4,
        message: { chat: { id: 5 }, from: { id }, text: '/parear 123456' },
      }
      assert.deepEqual(lerComandoDePareamento(update), { descarte: 'sem-remetente' }, String(id))
    }
  })

  it('nao rebenta com lixo: `null`, numero, string, array, objeto vazio', () => {
    for (const lixo of [null, undefined, 42, 'texto', [], {}, { message: null }]) {
      assert.deepEqual(lerComandoDePareamento(lixo), {
        descarte: 'nao-e-comando-de-pareamento',
      })
    }
  })
})

describe('comparacao do codigo', () => {
  it('e por igualdade exata, e comprimentos diferentes nao rebentam', () => {
    assert.ok(codigosSaoIguais('123456', '123456'))
    assert.ok(!codigosSaoIguais('123456', '123457'))
    // `timingSafeEqual` lanca `RangeError` com comprimentos diferentes: a
    // guarda de comprimento e o que impede o processo de morrer com um update
    // vindo da internet.
    assert.doesNotThrow(() => codigosSaoIguais('123456', '1'))
    assert.ok(!codigosSaoIguais('123456', '1'))
    assert.ok(!codigosSaoIguais('', '123456'))
  })
})

describe('TG-065 / PAIR-002: o `/parear` correcto', () => {
  it('pareia, e le os ids DO UPDATE QUE CARREGA O CODIGO CORRECTO', () => {
    const relogio = new FakeClock(1_700_000_000_000)
    const sessao = sessaoDeTeste(relogio, '123456')

    // Um update ANTERIOR, de outra pessoa, com outros ids. Se a implementacao
    // lesse "o primeiro update", seria este o dono.
    sessao.oferecer(updateDeMensagem('/start', 999, 999))

    relogio.advance(10_000)
    const resultado = sessao.oferecer(updateDeMensagem('/parear 123456', 111, 222))
    assert.equal(resultado.tipo, 'pareado')
    assert.deepEqual(resultado.tipo === 'pareado' ? resultado.dono : undefined, {
      ownerUserId: 111,
      ownerChatId: 222,
      pairedAt: 1_700_000_010_000,
    })
  })

  it('fecha a sessao: o estado passa a `consumido`', () => {
    const sessao = sessaoDeTeste(new FakeClock(0))
    sessao.oferecer(updateDeMensagem('/parear 123456'))
    assert.equal(sessao.estado(), 'consumido')
  })
})

describe('PAIR-003: codigo ERRADO nao pareia — e e contado', () => {
  it('devolve descarte, conta tentativa, e nao diz quantos digitos acertou', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456')
    const resultado = sessao.oferecer(updateDeMensagem('/parear 123450'))
    assert.equal(motivoDe(resultado), 'codigo-errado')
    // O resultado nao traz posicao, distancia nem prefixo: se trouxesse, seria
    // um oraculo que reduz 10^6 a seis tentativas.
    assert.deepEqual(Object.keys(resultado).toSorted(), ['motivo', 'tipo'])
    const resumo = sessao.resumo()
    assert.equal(resumo.tentativas, 1)
    assert.equal(resumo.descartados, 1)
    assert.equal(sessao.estado(), 'aberto')
  })
})

describe('TG-064 / PAIR-004: codigo EXPIRADO nao pareia', () => {
  it('passado o TTL, o codigo certo e recusado — e o motivo e a expiracao', () => {
    const relogio = new FakeClock(0)
    const sessao = sessaoDeTeste(relogio, '123456', { ttlMs: TTL_DO_CODIGO_MS })

    relogio.advance(TTL_DO_CODIGO_MS - 1)
    assert.equal(sessao.estado(), 'aberto', 'um milissegundo antes ainda vale')

    relogio.advance(1)
    assert.equal(sessao.estado(), 'expirado')
    assert.equal(sessao.restanteMs(), 0)
    const resultado = sessao.oferecer(updateDeMensagem('/parear 123456'))
    assert.equal(motivoDe(resultado), 'codigo-expirado')
  })

  it('expirar NAO gasta tentativa nem abre janela permanente', () => {
    const relogio = new FakeClock(0)
    const sessao = sessaoDeTeste(relogio, '123456')
    relogio.advance(TTL_DO_CODIGO_MS)
    sessao.oferecer(updateDeMensagem('/parear 123456'))
    assert.equal(sessao.resumo().tentativas, 0)
    // E o estado NAO volta a `aberto` por o relogio andar mais: nao ha
    // renovacao implicita em lado nenhum.
    relogio.advance(1_000_000)
    assert.equal(sessao.estado(), 'expirado')
  })

  it('gerar OUTRA sessao e o unico caminho, e ela e independente da expirada', () => {
    const relogio = new FakeClock(0)
    const velha = sessaoDeTeste(relogio, '111111')
    relogio.advance(TTL_DO_CODIGO_MS + 1)
    const nova = sessaoDeTeste(relogio, '222222')

    assert.equal(motivoDe(nova.oferecer(updateDeMensagem('/parear 111111'))), 'codigo-errado')
    assert.equal(nova.oferecer(updateDeMensagem('/parear 222222')).tipo, 'pareado')
    assert.equal(velha.estado(), 'expirado')
  })
})

describe('TG-066: dois updates com codigos diferentes, um correcto', () => {
  it('so o correcto pareia; o outro e descartado em silencio e CONTADO', () => {
    const relogio = new FakeClock(500)
    const sessao = sessaoDeTeste(relogio, '123456')

    const errado = sessao.oferecer(updateDeMensagem('/parear 654321', 900, 900))
    const certo = sessao.oferecer(updateDeMensagem('/parear 123456', 111, 222))

    assert.equal(motivoDe(errado), 'codigo-errado')
    assert.equal(certo.tipo, 'pareado')
    assert.equal(certo.tipo === 'pareado' ? certo.dono.ownerUserId : undefined, 111)

    const resumo = sessao.resumo()
    assert.equal(resumo.descartados, 1, 'o descarte e silencioso mas nao invisivel')
    assert.equal(resumo.tentativas, 1)
  })

  it('a ordem nao importa: o correcto a seguir a varios errados continua a parear', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456')
    sessao.oferecer(updateDeMensagem('/parear 000000'))
    sessao.oferecer(updateDeMensagem('/start'))
    sessao.oferecer(updateDeCanal('/parear 123456'))
    assert.equal(sessao.oferecer(updateDeMensagem('/parear 123456', 7, 8)).tipo, 'pareado')
  })
})

describe('PAIR-006: um `/start` de estranho ANTES do dono nao pareia ninguem', () => {
  it('o estranho e descartado e o dono continua a poder parear a seguir', () => {
    // Esta e a corrida que todo o desenho existe para fechar: o estranho chega
    // PRIMEIRO, com um `/start`, e nao ganha nada com isso.
    const sessao = sessaoDeTeste(new FakeClock(0), '123456')
    const estranho = sessao.oferecer(updateDeMensagem('/start', 666, 666))
    assert.equal(motivoDe(estranho), 'nao-e-comando-de-pareamento')
    assert.equal(sessao.estado(), 'aberto')

    const dono = sessao.oferecer(updateDeMensagem('/parear 123456', 111, 222))
    assert.equal(dono.tipo === 'pareado' ? dono.dono.ownerUserId : undefined, 111)
  })

  it('nem um `/start` com o codigo colado atras pareia', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456')
    assert.equal(
      motivoDe(sessao.oferecer(updateDeMensagem('/start 123456', 666, 666))),
      'nao-e-comando-de-pareamento',
    )
    assert.equal(sessao.estado(), 'aberto')
  })
})

describe('PAIR-005: o SEGUNDO `/parear` e recusado, mesmo com o codigo certo', () => {
  it('depois de haver dono, o mesmo codigo ja nao vale para mais ninguem', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456')
    assert.equal(sessao.oferecer(updateDeMensagem('/parear 123456', 111, 222)).tipo, 'pareado')

    const segundo = sessao.oferecer(updateDeMensagem('/parear 123456', 999, 999))
    assert.equal(motivoDe(segundo), 'ja-pareado')
    assert.equal(sessao.estado(), 'consumido')
  })
})

describe('PAIR-009: dois `/parear` correctos no mesmo tick', () => {
  it('um so dono, resultado determinista, o segundo recebe recusa', () => {
    // O relogio NAO anda entre as duas ofertas: e literalmente o mesmo
    // instante. `oferecer` e sincrono de ponta a ponta e nao ha `await` por
    // onde uma segunda chamada se possa intercalar.
    const relogio = new FakeClock(42)
    const sessao = sessaoDeTeste(relogio, '123456')
    const primeiro = sessao.oferecer(updateDeMensagem('/parear 123456', 111, 222))
    const segundo = sessao.oferecer(updateDeMensagem('/parear 123456', 333, 444))

    assert.equal(primeiro.tipo, 'pareado')
    assert.equal(primeiro.tipo === 'pareado' ? primeiro.dono.ownerUserId : undefined, 111)
    assert.equal(motivoDe(segundo), 'ja-pareado')
  })
})

describe('PAIR-007: teto de tentativas — 6 digitos sem teto sao enumeraveis', () => {
  it(`ao fim de ${String(TENTATIVAS_MAXIMAS)} codigos errados a sessao esgota-se`, () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456')
    for (let i = 0; i < TENTATIVAS_MAXIMAS; i += 1) {
      assert.equal(motivoDe(sessao.oferecer(updateDeMensagem('/parear 000000'))), 'codigo-errado')
    }
    assert.equal(sessao.estado(), 'esgotado')
    assert.equal(sessao.resumo().tentativasRestantes, 0)
  })

  it('esgotada, nem o codigo CERTO pareia — e as excedentes nem sao comparadas', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456', { tentativasMaximas: 2 })
    sessao.oferecer(updateDeMensagem('/parear 000000'))
    sessao.oferecer(updateDeMensagem('/parear 000001'))
    const certo = sessao.oferecer(updateDeMensagem('/parear 123456'))
    assert.equal(motivoDe(certo), 'tentativas-esgotadas')
    // A tentativa excedente nao incrementa o contador: ela nem chega a ser uma
    // tentativa, e um pedido recusado a porta.
    assert.equal(sessao.resumo().tentativas, 2)
  })

  it('updates que NAO trazem codigo nao gastam tentativa (so contam como descarte)', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456', { tentativasMaximas: 2 })
    for (let i = 0; i < 50; i += 1) sessao.oferecer(updateDeMensagem('/start'))
    assert.equal(sessao.resumo().tentativas, 0)
    assert.equal(sessao.resumo().descartados, 50)
    assert.equal(sessao.estado(), 'aberto')
    assert.equal(sessao.oferecer(updateDeMensagem('/parear 123456')).tipo, 'pareado')
  })
})

/* ========================================================================== */
/* Regressoes da revisao adversarial                                          */
/* ========================================================================== */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const FONTE = readFileSync(join(import.meta.dirname, '../../../src/telegram/pairing.ts'), 'utf8')

/** O ficheiro sem comentarios: uma asercao sobre o que ele EXECUTA. */
const CODIGO = FONTE.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '')

describe('M6: a comparacao do codigo e em tempo constante, e isso esta preso', () => {
  it('`codigosSaoIguais` usa `timingSafeEqual` e nao compara as strings com `===`', () => {
    /*
     * PORQUE ESTRUTURAL E NAO TEMPORAL: um teste de temporizacao sobre seis
     * digitos num runtime com JIT e colector de lixo mede ruido, e um teste
     * instavel acaba desligado — o que deixaria a propriedade sem guarda
     * nenhuma. O que se prende aqui e o que a mutacao troca: trocar
     * `timingSafeEqual` por `===` passava despercebido, e o proprio JSDoc da
     * funcao diz que isso e "um oraculo que reduz 10^6 a 60 tentativas".
     */
    const corpo = /export function codigosSaoIguais[\s\S]*?\n\}\n/u.exec(CODIGO)?.[0] ?? ''
    assert.ok(corpo.length > 0, 'nao encontrei o corpo de codigosSaoIguais')
    assert.ok(corpo.includes('timingSafeEqual('), 'a comparacao deixou de ser em tempo constante')
    // A UNICA comparacao permitida no corpo e a de COMPRIMENTO (que nao e
    // segredo, e sem a qual `timingSafeEqual` lanca `RangeError`).
    const comparacoes = [...corpo.matchAll(/[!=]==/gu)].length
    assert.equal(comparacoes, 1, `${String(comparacoes)} comparacoes diretas no corpo:\n${corpo}`)
    assert.ok(/byteLength\s*!==\s*/u.test(corpo), 'a unica comparacao tem de ser a de comprimento')
    assert.ok(CODIGO.includes("from 'node:crypto'"), 'o CSPRNG e o `timingSafeEqual` vem daqui')
  })

  it('a geracao continua a vir do CSPRNG, e nao de `Math.random`', () => {
    assert.ok(CODIGO.includes('randomInt'), 'a fonte por omissao deixou de ser CSPRNG')
    assert.ok(!CODIGO.includes('Math.random'), '`Math.random` nao e CSPRNG')
  })
})

describe('M1: o tipo da conversa e verificado', () => {
  it('a lista e BRANCA — so `private` passa', () => {
    const corpo = /export function lerComandoDePareamento[\s\S]*?\n\}\n/u.exec(CODIGO)?.[0] ?? ''
    assert.ok(corpo.includes("!== 'private'"), 'a verificacao do tipo de conversa desapareceu')
  })

  it('um `/parear` correto vindo de grupo nao produz `ComandoDePareamento`', () => {
    for (const type of ['group', 'supergroup', 'channel']) {
      const bruto = {
        update_id: 9,
        message: { from: { id: 1 }, chat: { id: -100, type }, text: '/parear 123456' },
      }
      assert.deepEqual(lerComandoDePareamento(bruto), { descarte: 'conversa-nao-privada' }, type)
    }
  })

  it('e a sessao tambem o recusa, contando o descarte', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456')
    const bruto = {
      update_id: 9,
      message: { from: { id: 1 }, chat: { id: -100, type: 'supergroup' }, text: '/parear 123456' },
    }
    assert.equal(motivoDe(sessao.oferecer(bruto)), 'conversa-nao-privada')
    assert.equal(sessao.estado(), 'aberto', 'nao pode ter parado a sessao')
    assert.equal(sessao.resumo().tentativas, 0, 'nao e uma tentativa de codigo')
    assert.equal(sessao.resumo().descartados, 1)
  })
})

describe('B3: o JSDoc e a medicao dizem o mesmo sobre `/parear 1234567`', () => {
  it('nao e tentativa, e o comentario ja o diz — cinco mensagens nao esgotam o teto', () => {
    const sessao = sessaoDeTeste(new FakeClock(0), '123456', { tentativasMaximas: 2 })
    for (const texto of ['/parear 1234567', '/parear 12345', 'olá', '/parear', '/start 123456']) {
      assert.equal(motivoDe(sessao.oferecer(updateDeMensagem(texto))), 'nao-e-comando-de-pareamento')
    }
    assert.equal(sessao.resumo().tentativas, 0)
    assert.equal(sessao.estado(), 'aberto')
    assert.ok(
      FONTE.includes('NAO gasta o teto de tentativas'),
      'o comentario tem de declarar a consequencia medida',
    )
    assert.ok(!FONTE.includes('tem de ser contado como\n * tal'), 'a afirmacao errada voltou')
  })
})
