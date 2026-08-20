/**
 * O TEXTO extraido do onboarding (`src/telegram/texts.ts`, costura da Onda 5).
 *
 * `onboarding.test.ts` congela os quatro textos byte a byte VIA
 * `proximoPasso`. Este ficheiro testa o modulo de texto DIRETAMENTE — as
 * funcoes exportadas com opcoes que o detector nao exercita, e os RAMOS
 * internos (`diagnostico` e `explicarFormato`) que nenhum retrato do detector
 * alcanca:
 *
 *   1. `textoTokenInvalido` com FORMATO INVALIDO — todos os sete motivos de
 *      `MotivoDeFormato` (o detector so exercita 'sem-dois-pontos');
 *   2. `textoTokenInvalido` com token VALIDO mas `getMe` ausente/positivo —
 *      a linha "ainda nao foi confirmada" (nenhum estado do detector chega la:
 *      um token sem getMe e TOKEN_INVALIDO, um token com getMe ok e
 *      TOKEN_OK_SEM_DONO; o texto composto e o mesmo, e e este teste que o
 *      prende);
 *   3. `textoTokenInvalido` com as seis causas de `FalhaDoGetMe` — o detector
 *      so exercita 'recusado';
 *   4. `textoSemDono` sem `codigo` (placeholder `·····`), com `minutosDoCodigo`
 *      proprio, e o contrato D8 (nenhum `/start` pareia) escrito no proprio
 *      texto;
 *   5. PAIR-010 — o codigo de pareamento viaja EXATAMENTE no texto de
 *      `textoSemDono`, e em mais lado nenhum deste modulo;
 *   6. As constantes (`COMANDO_CLI`, `TITULO_*`, `AVISOS_ANTES_DO_TUNEL` com
 *      os cinco avisos de TG-072) e a disciplina de conteudo (S3): sem
 *      segredo, sem caminho absoluto, sem caracteres de controlo.
 *
 * Nenhum destes caminhos fala com a rede nem toca em relogio: o modulo e PURO.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CausaDeFalha, MotivoDeFormato, RetratoDoAmbiente } from '../../../src/telegram/onboarding.ts'
import {
  AVISOS_ANTES_DO_TUNEL,
  COMANDO_CLI,
  TITULO_PRONTO,
  TITULO_SEM_DONO,
  TITULO_SEM_TOKEN,
  TITULO_TOKEN_INVALIDO,
  textoSemDono,
  textoSemToken,
  textoPronto,
  textoTokenInvalido,
} from '../../../src/telegram/texts.ts'

const CAMINHO_APRESENTAVEL = '~/.dsh/guarded-bot/secrets.env'
const BOT = '@meu_painel_bot'
const CODIGO = '481516'

function retratoBase(): RetratoDoAmbiente {
  return {
    token: {
      origem: 'secrets.env',
      formato: { valido: true, botId: 123_456_789 },
    },
    getMe: {
      ok: false,
      falha: { causa: 'recusado', httpStatus: 401, errorCode: 401 },
    },
    dono: undefined,
  }
}

/** Um retrato com formato invalido e nenhuma chamada de rede. */
function formatoInvalido(motivo: MotivoDeFormato): RetratoDoAmbiente {
  return {
    token: { origem: 'ambiente', formato: { valido: false, motivo } },
    getMe: undefined,
    dono: undefined,
  }
}

/** Um retrato com `getMe` que falhou com a causa dada. */
function falhaDeGetMe(causa: CausaDeFalha): RetratoDoAmbiente {
  return {
    ...retratoBase(),
    getMe: {
      ok: false,
      falha: { causa, httpStatus: 500 },
    },
  }
}

/** Um texto de onboarding so pode conter controlo NAO; `\n` e legitimo. */
function assertTextoLimpo(texto: string): void {
  for (const char of texto) {
    const code = char.charCodeAt(0)
    if (code === 0x0a) continue
    assert.ok(code >= 0x20 && code !== 0x7f, `caracter de controlo ${String(code)} em ${JSON.stringify(texto)}`)
  }
}

/* ========================================================================== */
/* 1. CONSTANTES                                                               */
/* ========================================================================== */

describe('as constantes do modulo de texto', () => {
  it('COMANDO_CLI e o comando publicado no PATH', () => {
    assert.equal(COMANDO_CLI, 'dsh-guard-setup')
  })

  it('os quatro titulos cobrem os quatro estados', () => {
    assert.equal(TITULO_SEM_TOKEN, 'Falta criar o bot no Telegram.')
    assert.equal(TITULO_TOKEN_INVALIDO, 'A chave do bot não foi aceite pelo Telegram.')
    assert.equal(TITULO_SEM_DONO, 'O bot já responde. Falta dizer-lhe quem é o dono.')
    assert.equal(TITULO_PRONTO, 'Está tudo ligado.')
  })

  it('AVISOS_ANTES_DO_TUNEL traz os cinco avisos obrigatorios de TG-072', () => {
    const avisos = AVISOS_ANTES_DO_TUNEL
    assert.ok(avisos.includes('trustedRemotes'), 'aviso 1: trustedRemotes fica inerte')
    assert.ok(avisos.includes('sai de dentro para fora'), 'aviso 2: o tunel fura a firewall')
    assert.ok(avisos.includes('O TLS termina lá'), 'aviso 3: TLS termina na borda')
    assert.ok(avisos.includes('O endereço do túnel NÃO é segredo'), 'aviso 4: amostragem publica')
    assert.ok(avisos.includes('reputação de malware'), 'aviso 5: reputacao do dominio')
    for (const numero of ['1. ', '2. ', '3. ', '4. ', '5. ']) {
      assert.ok(avisos.includes(numero), `falta o aviso ${numero}`)
    }
    assertTextoLimpo(avisos)
  })
})

/* ========================================================================== */
/* 2. TEXTO SEM TOKEN                                                          */
/* ========================================================================== */

describe('textoSemToken — o passo do BotFather', () => {
  it('instrui /newbot, o exemplo do username e o comando CLI', () => {
    const texto = textoSemToken({ caminhoSecretsEnv: CAMINHO_APRESENTAVEL })
    assert.ok(texto.includes('/newbot'), 'o passo exato a digitar')
    assert.ok(texto.includes('@BotFather'), 'a conta oficial')
    assert.ok(texto.includes('meu_painel_bot'), 'o exemplo de username')
    assert.ok(texto.includes('5 e 32'), 'as regras do username citadas')
    // O texto original quebra a frase a meio do paragrafo: assert por pedaco.
    assert.ok(texto.includes('TERMINAR') && texto.includes('em bot'), 'o sufixo obrigatorio')
    assert.ok(texto.includes(`${COMANDO_CLI} --pedir-token`), 'o comando CLI')
    assert.ok(texto.includes(CAMINHO_APRESENTAVEL), 'o destino da chave')
    assertTextoLimpo(texto)
  })

  it('NAO exibe a chave nem um caminho absoluto que identifique o utilizador', () => {
    const texto = textoSemToken({ caminhoSecretsEnv: CAMINHO_APRESENTAVEL })
    // O exemplo didatico \`123456789:AA…\` (TG-060) e permitido; uma chave
    // COMPLETA (digitos:segredo de 20+) nunca.
    assert.ok(!/\d{5,12}:[A-Za-z0-9_-]{20,}/u.test(texto), 'nenhuma forma de token completa')
    assert.ok(!/\/(?:home|Users)\//u.test(texto))
    assert.ok(!texto.includes('/root/'))
  })
})

/* ========================================================================== */
/* 3. TEXTO DO TOKEN INVALIDO — diagnostico por causa                          */
/* ========================================================================== */

describe('textoTokenInvalido — o diagnostico', () => {
  it('formato invalido: nenhuma chamada de rede, e o motivo explicado', () => {
    const texto = textoTokenInvalido(formatoInvalido('vazio'))
    assert.ok(texto.startsWith('A chave nem chegou a ser enviada ao Telegram'), 'formato antes da rede (TG-061)')
    assert.ok(texto.includes('ela está vazia.'))
    assert.ok(texto.includes('Nada saiu desta máquina.'))
  })

  it('todos os sete motivos de formato tem um texto proprio (explicarFormato)', () => {
    const esperado: ReadonlyArray<[MotivoDeFormato, string]> = [
      ['vazio', 'ela está vazia.'],
      ['sem-dois-pontos', 'falta-lhe os dois pontos.'],
      ['id-comeca-por-zero', 'começa por zero'],
      ['id-nao-numerico', 'devia ser só algarismos'],
      ['segredo-curto', 'é curta demais: ficou cortada'],
      ['caracteres-invalidos', 'há caracteres que não pertencem a uma chave'],
      ['comprimento-excessivo', 'é longa demais para ser uma chave'],
    ]
    for (const [motivo, frase] of esperado) {
      const texto = textoTokenInvalido(formatoInvalido(motivo))
      assert.ok(texto.includes(frase), `${motivo}: falta ${JSON.stringify(frase)}`)
      assertTextoLimpo(texto)
    }
  })

  it('token valido sem getMe: a chave ainda nao foi confirmada', () => {
    const texto = textoTokenInvalido({
      token: { origem: 'secrets.env', formato: { valido: true, botId: 123_456_789 } },
      getMe: undefined,
      dono: undefined,
    })
    assert.ok(texto.includes('ainda não foi confirmada com o Telegram'))
    assert.ok(texto.includes('--pedir-token'), 'o passo seguinte continua presente')
  })

  it('getMe ok:true com dono ausente produz o MESMO diagnostico (nao confirmado)', () => {
    // O detector nunca chama `textoTokenInvalido` com getMe ok (vira
    // TOKEN_OK_SEM_DONO), mas a funcao e pura: um getMe positivo sem dono
    // tambem significa "a chave existe e esta confirmada" — o texto so pode
    // dizer a verdade e apontar o pareamento como passo em falta.
    const texto = textoTokenInvalido({
      token: { origem: 'secrets.env', formato: { valido: true, botId: 123_456_789 } },
      getMe: { ok: true, bot: { id: 123_456_789, username: 'meu_painel_bot' } },
      dono: undefined,
    })
    assert.ok(texto.includes('ainda não foi confirmada com o Telegram'))
  })

  it('todas as seis causas de FalhaDoGetMe tem um texto proprio', () => {
    const casos: ReadonlyArray<[string, string]> = [
      ['recusado', 'O Telegram respondeu que esta chave não vale'],
      ['rota-inexistente', 'O Telegram não reconheceu o endereço formado'],
      ['conflito', 'Já existe outra ligação a usar este mesmo bot'],
      ['limite-de-taxa', 'O Telegram está a pedir para abrandar'],
      ['rede', 'Não foi possível falar com o Telegram a partir desta máquina'],
      ['resposta-ininteligivel', 'não foi possível interpretar'],
    ]
    for (const [causa, frase] of casos) {
      const texto = textoTokenInvalido(falhaDeGetMe(causa as CausaDeFalha))
      assert.ok(texto.includes(frase), `${causa}: falta ${JSON.stringify(frase)}`)
      assertTextoLimpo(texto)
    }
  })

  it('limite-de-taxa com retryAfter: os segundos entram no texto; sem retryAfter, nao', () => {
    const comRetry = textoTokenInvalido({
      ...retratoBase(),
      getMe: { ok: false, falha: { causa: 'limite-de-taxa', httpStatus: 429, retryAfter: 30 } },
    })
    assert.ok(comRetry.includes('(30 segundos)'), 'o retry_after pedido aparece')

    const semRetry = textoTokenInvalido({
      ...retratoBase(),
      getMe: { ok: false, falha: { causa: 'limite-de-taxa', httpStatus: 429 } },
    })
    assert.ok(!semRetry.includes('segundos)'), 'sem retry_after nao ha numero magico')
  })

  it('resposta-ininteligivel: HTTP 0 nao inventa estado; HTTP real e citado', () => {
    const semHttp = textoTokenInvalido({
      ...retratoBase(),
      getMe: { ok: false, falha: { causa: 'resposta-ininteligivel', httpStatus: 0 } },
    })
    assert.ok(!semHttp.includes('HTTP'), 'nao houve resposta HTTP nenhuma')

    const comHttp = textoTokenInvalido({
      ...retratoBase(),
      getMe: { ok: false, falha: { causa: 'resposta-ininteligivel', httpStatus: 502 } },
    })
    assert.ok(comHttp.includes('(HTTP 502)'), 'o estado real ajuda quem vai investigar')
  })

  it('nenhum ramo do diagnostico revela o erro cru da API nem a chave', () => {
    const texto = textoTokenInvalido({
      ...retratoBase(),
      getMe: {
        ok: false,
        falha: { causa: 'recusado', httpStatus: 401, errorCode: 401, description: 'Unauthorized: invalid token specified' },
      },
    })
    assert.ok(!texto.includes('Unauthorized'), 'a description crua nao e mostrada')
    assert.ok(!texto.includes('invalid token specified'))
    assert.ok(!/\d{6,}:/.test(texto))
  })
})

/* ========================================================================== */
/* 4. TEXTO SEM DONO — o codigo de pareamento                                  */
/* ========================================================================== */

describe('textoSemDono — o codigo de pareamento', () => {
  it('com codigo e minutos dados: ambos entram no texto, em dois sitios', () => {
    const texto = textoSemDono(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL, codigo: CODIGO, minutosDoCodigo: 5 })
    assert.ok(texto.includes(`O seu código de pareamento:   ${CODIGO}`))
    assert.ok(texto.includes(`/parear ${CODIGO}`), 'a instrucao manda enviar /parear <codigo>')
    assert.ok(texto.includes('vale 5 minutos'), 'os minutos dados entram no texto')
    assertTextoLimpo(texto)
  })

  it('sem codigo: placeholder de DIGITOS_DO_CODIGO, minutos por omissao 5', () => {
    const texto = textoSemDono(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL })
    assert.ok(texto.includes('·'.repeat(6)), 'o placeholder tem o numero de digitos do codigo')
    assert.ok(texto.includes('vale 5 minutos'), 'o default de minutos e 5')
    assert.ok(!texto.includes('481516'), 'nenhum codigo real inventado')
  })

  it('D8 no proprio texto: nenhum /start pareia, e o bot nao comeca conversas', () => {
    const texto = textoSemDono(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL, codigo: CODIGO })
    assert.ok(texto.includes('Uma mensagem /start não pareia ninguém.'), 'a frase D8 literal')
    assert.ok(!texto.includes('Envie /start'), 'o texto NAO instrui a mandar /start')
    // O texto original quebra a frase a meio: assert por pedaco.
    assert.ok(texto.includes('um bot nunca consegue') && texto.includes('começar uma conversa consigo'), 'a limitacao da plataforma')
  })

  it('explica PORQUE existe o codigo: a posse do terminal e a prova', () => {
    const texto = textoSemDono(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL, codigo: CODIGO })
    assert.ok(texto.includes('o nome de um bot é fácil de adivinhar'))
    assert.ok(texto.includes('ter este terminal é a prova de que a máquina é sua'))
  })

  it('PAIR-010: o codigo aparece EXATAMENTE no texto de textoSemDono', () => {
    const semDono = textoSemDono(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL, codigo: CODIGO })
    const semToken = textoSemToken({ caminhoSecretsEnv: CAMINHO_APRESENTAVEL })
    const tokenInvalido = textoTokenInvalido(retratoBase())
    const pronto = textoPronto(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL })
    assert.ok(semDono.includes(CODIGO))
    assert.ok(!semToken.includes(CODIGO), 'sem-token nao pode levar o codigo')
    assert.ok(!tokenInvalido.includes(CODIGO), 'token-invalido nao pode levar o codigo')
    assert.ok(!pronto.includes(CODIGO), 'pronto nao pode levar o codigo')
  })
})

/* ========================================================================== */
/* 5. TEXTO PRONTO                                                             */
/* ========================================================================== */

describe('textoPronto — idempotencia e avisos', () => {
  it('promete idempotencia por escrito e aponta o reset de dono', () => {
    const texto = textoPronto(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL })
    assert.ok(texto.includes('Executar este comando outra vez não gera código novo,'))
    assert.ok(texto.includes('não troca a senha e não reabre o pareamento'))
    assert.ok(texto.includes(`${COMANDO_CLI} --reset-pairing`))
    assert.ok(texto.includes(CAMINHO_APRESENTAVEL))
  })

  it('embebe AVISOS_ANTES_DO_TUNEL — os cinco avisos precedem o primeiro tunel', () => {
    const texto = textoPronto(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL })
    assert.ok(texto.includes(AVISOS_ANTES_DO_TUNEL), 'os avisos viajam com o estado PRONTO')
    assertTextoLimpo(texto)
  })

  it('os tres textos de acao (sem-token, invalido, sem-dono) nao carregam os avisos', () => {
    const comAvisos = [textoSemToken({ caminhoSecretsEnv: CAMINHO_APRESENTAVEL }), textoTokenInvalido(retratoBase()), textoSemDono(BOT, { caminhoSecretsEnv: CAMINHO_APRESENTAVEL, codigo: CODIGO })]
    for (const texto of comAvisos) {
      assert.ok(!texto.includes('cinco coisas mudam'), 'os avisos so aparecem quando o tunel vai subir')
    }
  })
})
