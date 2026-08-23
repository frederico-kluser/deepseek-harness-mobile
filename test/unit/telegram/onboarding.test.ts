/**
 * `src/telegram/onboarding.ts` — o detector dos quatro estados e o TEXTO.
 *
 * COBRE `TG-060` a `TG-072`, e as seis perguntas da revisao de T4.1.
 *
 * -----------------------------------------------------------------------------
 * PORQUE O TEXTO ESTA COPIADO AQUI DENTRO, INTEIRO
 * -----------------------------------------------------------------------------
 * `TG-070` pede um teste que "compara com o texto congelado e falha se alguem o
 * trocar por uma mensagem tecnica". Um teste que so verificasse `contains`
 * deixaria passar exatamente o caso que interessa: alguem substituir o roteiro
 * por `Error: ETELEGRAM 401` e acrescentar as palavras-chave por baixo. Por
 * isso os quatro textos estao AQUI, byte a byte, e a asercao e de igualdade.
 * Mudar a redaccao passa a exigir mudar este ficheiro — que e precisamente o
 * ponto: a redaccao e entrega revisavel, e muda-se de propria vontade, nunca
 * por efeito colateral de um refactor.
 *
 * -----------------------------------------------------------------------------
 * NENHUM TESTE FALA COM `api.telegram.org`
 * -----------------------------------------------------------------------------
 * Ha duas classes de duble aqui, e as duas sao locais:
 *   - um duble de `SondaTelegram` em memoria, para os casos de decisao;
 *   - um servidor `node:http` REAL em `127.0.0.1`, que devolve os corpos
 *     MEDIDOS na Onda 0 (`docs/spikes/telegram.md` 2.1 e 6) — o `401` com
 *     `Unauthorized: invalid token specified`, o `404 Not Found` e o `409
 *     Conflict`. E ele que exerce o `fetch` de verdade, sem sair da maquina.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { promisify } from 'node:util'

import {
  CHAVE_DO_TOKEN,
  MODO_DO_SECRETS_ENV,
  OnboardingError,
  analisarArgumentos,
  analisarSecretsEnv,
  caminhoApresentavel,
  caminhoDoSecretsEnv,
  classificarFalha,
  criarSondaHttp,
  detectarEstado,
  fundirSecretsEnv,
  lerSecretsEnv,
  proximoPasso,
  resolverToken,
  validarFormatoDoToken,
  type EstadoOnboarding,
  type RetratoDoAmbiente,
} from '../../../src/telegram/onboarding.ts'
// Os TEXTO do onboarding vivem em texts.ts desde a costura da Onda 5 (item 6).
import {
  AVISOS_ANTES_DO_TUNEL,
  TITULO_PRONTO,
  TITULO_SEM_DONO,
  TITULO_SEM_TOKEN,
  TITULO_TOKEN_INVALIDO,
} from '../../../src/telegram/texts.ts'
import { statePathsAt } from '../../../src/state/paths.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'

const executar = promisify(execFile)

/* -------------------------------------------------------------------------- */
/* Retratos                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Um token SINTETICO, construido por concatenacao em tempo de execucao.
 *
 * Nenhum literal com forma de token existe neste ficheiro — e a mesma regra que
 * os spikes da Onda 0 seguiram (`docs/spikes/telegram.md` 0). Um `grep` por
 * forma de token sobre o repositorio tem de continuar a nao encontrar nada.
 */
const TOKEN_VALIDO = `123456789${':'}${'A'.repeat(2)}${'b'.repeat(33)}`

const BOT = { id: 123_456_789, username: 'meu_painel_bot' }
const CAMINHO_APRESENTAVEL = '~/.dsh/guarded-bot/secrets.env'
const OPCOES = { caminhoSecretsEnv: CAMINHO_APRESENTAVEL, minutosDoCodigo: 5 }

const SEM_TOKEN: RetratoDoAmbiente = { token: undefined, getMe: undefined, dono: undefined }

const TOKEN_INVALIDO: RetratoDoAmbiente = {
  token: { origem: 'secrets.env', formato: { valido: true, botId: 123_456_789 } },
  getMe: {
    ok: false,
    falha: {
      causa: 'recusado',
      httpStatus: 401,
      errorCode: 401,
      description: 'Unauthorized: invalid token specified',
    },
  },
  dono: undefined,
}

const SEM_DONO: RetratoDoAmbiente = {
  token: { origem: 'secrets.env', formato: { valido: true, botId: BOT.id } },
  getMe: { ok: true, bot: BOT },
  dono: undefined,
}

const PRONTO: RetratoDoAmbiente = {
  ...SEM_DONO,
  dono: { ownerUserId: 111, ownerChatId: 222, pairedAt: 1 },
}

/* -------------------------------------------------------------------------- */
/* Servidor local com os corpos MEDIDOS da Bot API                             */
/* -------------------------------------------------------------------------- */

interface BotApiFalsa {
  readonly apiRoot: string
  readonly chamadas: string[]
  responder(estado: number, corpo: unknown): void
  fechar(): Promise<void>
}

async function iniciarBotApiFalsa(): Promise<BotApiFalsa> {
  let proxima: { estado: number; corpo: unknown } = { estado: 200, corpo: { ok: true, result: BOT } }
  const chamadas: string[] = []

  const servidor: Server = createServer((req, res) => {
    // Grava so o METODO, nunca o caminho: o caminho leva o token dentro.
    chamadas.push(String(req.url ?? '').split('/').pop() ?? '')
    req.resume()
    res.writeHead(proxima.estado, { 'content-type': 'application/json' })
    res.end(JSON.stringify(proxima.corpo))
  })
  servidor.listen(0, '127.0.0.1')
  await once(servidor, 'listening')
  const porta = (servidor.address() as AddressInfo).port

  return {
    apiRoot: `http://127.0.0.1:${String(porta)}`,
    chamadas,
    responder(estado: number, corpo: unknown): void {
      proxima = { estado, corpo }
    },
    async fechar(): Promise<void> {
      servidor.close()
      await once(servidor, 'close')
    },
  }
}

/* ========================================================================== */
/* TG-070 — os quatro textos, congelados                                      */
/* ========================================================================== */

const TEXTO_SEM_TOKEN = `Ainda não há nenhum bot do Telegram ligado a esta máquina. Criar um leva um
minuto e faz-se todo dentro da aplicação do Telegram:

  1. Abra o Telegram e procure por  @BotFather
     É a conta oficial da Telegram para criar bots.

  2. Escreva-lhe exatamente isto e envie:

         /newbot

  3. Ele pergunta o nome do bot. É o nome que aparece no topo da conversa e
     pode ser mudado mais tarde. Escreva o que quiser, por exemplo:

         Meu painel

  4. Ele pergunta o nome de utilizador do bot. Este tem regras: entre 5 e 32
     caracteres, só letras sem acento, algarismos e "_", e tem de TERMINAR
     em bot. Por exemplo:

         meu_painel_bot

     Este nome não pode ser mudado depois. Escolha-o com calma.

  5. Ele responde com uma linha parecida com esta:

         123456789:AA… (e mais uns trinta caracteres)

     Essa linha é a chave do seu bot: quem a tiver comanda o bot inteiro.
     Não a cole em conversa nenhuma, nem sequer na conversa com o próprio bot.

  6. Volte a este terminal e escreva:

         dsh-guard-setup --pedir-token

     A chave é pedida aqui, não aparece no ecrã enquanto a escreve, e fica
     guardada em ${CAMINHO_APRESENTAVEL}, que só a sua conta consegue ler.
     Nunca a passe na própria linha de comando: o que se escreve na linha de
     comando fica à vista de qualquer programa desta máquina.`

const TEXTO_TOKEN_INVALIDO = `O Telegram respondeu que esta chave não vale. Isso costuma ser uma de duas
coisas: ou a chave foi substituída (pedir uma nova ao BotFather revoga a
anterior no mesmo instante), ou ficou mal copiada — falta um pedaço no fim,
ou veio um espaço junto.

O que fazer:

  1. Abra o Telegram e escreva ao  @BotFather :

         /token

  2. Ele pergunta de que bot se trata. Escolha o seu na lista.

  3. Ele responde com uma chave nova. A antiga deixa de funcionar nesse
     instante — é isso que a torna segura de substituir.

  4. Volte a este terminal e escreva:

         dsh-guard-setup --pedir-token

Enquanto a chave não for aceite, o bot não recebe nem envia nada.`

const TEXTO_SEM_DONO = `O bot @meu_painel_bot está a funcionar. Falta ligá-lo a si — e só a si.

    O seu código de pareamento:   481516

Ele vale 5 minutos, serve uma única vez, e existe apenas aqui, neste
terminal. Não o reencaminhe a ninguém.

  1. Abra o Telegram e abra a conversa com @meu_painel_bot.
     Se a conversa ainda não existir, toque em Iniciar: um bot nunca consegue
     começar uma conversa consigo, quem tem de falar primeiro é sempre você.

  2. Envie ao bot exatamente isto:

         /parear 481516

  3. Volte a este terminal. Assim que a mensagem chegar, fica gravado que o
     dono é você, e esta janela fecha-se de vez.

Porquê um código, e não simplesmente a primeira pessoa que escrever ao bot:
o nome de um bot é fácil de adivinhar, e quem escrevesse primeiro ficaria dono
do seu computador sem nunca ter visto a sua senha. O código só existe neste
terminal, e ter este terminal é a prova de que a máquina é sua.

Uma mensagem /start não pareia ninguém. Se alguém escrever ao bot antes de si,
a mensagem é ignorada e contada, e nada lhe é revelado.

Se os 5 minutos passarem, não fica nada trancado: peça outro código com

         dsh-guard-setup --parear`

const TEXTO_PRONTO = `  bot     @meu_painel_bot
  dono    pareado
  chave   guardada em ${CAMINHO_APRESENTAVEL} (só a sua conta lê)

Não há nada a fazer aqui. Executar este comando outra vez não gera código novo,
não troca a senha e não reabre o pareamento.

Para trocar de dono é preciso estar nesta máquina e escrever:

         dsh-guard-setup --reset-pairing

${AVISOS_ANTES_DO_TUNEL}`

describe('TG-070: o que a pessoa ve em cada um dos quatro estados', () => {
  it('SEM_TOKEN — texto congelado', () => {
    const passo = proximoPasso(SEM_TOKEN, OPCOES)
    assert.equal(passo.estado, 'SEM_TOKEN')
    assert.equal(passo.titulo, TITULO_SEM_TOKEN)
    assert.equal(passo.texto, TEXTO_SEM_TOKEN)
  })

  it('TOKEN_INVALIDO — texto congelado', () => {
    const passo = proximoPasso(TOKEN_INVALIDO, OPCOES)
    assert.equal(passo.estado, 'TOKEN_INVALIDO')
    assert.equal(passo.titulo, TITULO_TOKEN_INVALIDO)
    assert.equal(passo.texto, TEXTO_TOKEN_INVALIDO)
  })

  it('TOKEN_OK_SEM_DONO — texto congelado', () => {
    const passo = proximoPasso(SEM_DONO, { ...OPCOES, codigo: '481516' })
    assert.equal(passo.estado, 'TOKEN_OK_SEM_DONO')
    assert.equal(passo.titulo, TITULO_SEM_DONO)
    assert.equal(passo.texto, TEXTO_SEM_DONO)
  })

  it('PRONTO — texto congelado', () => {
    const passo = proximoPasso(PRONTO, OPCOES)
    assert.equal(passo.estado, 'PRONTO')
    assert.equal(passo.titulo, TITULO_PRONTO)
    assert.equal(passo.texto, TEXTO_PRONTO)
  })

  it('nenhum dos quatro textos tem stack trace, simbolo interno ou ingles de erro', () => {
    // A lista e a forma concreta de "nao trocar por uma mensagem tecnica": sao
    // as cadeias que aparecem quando alguem imprime uma excecao em cru.
    const proibido = [
      'Error:',
      'TypeError',
      'at Object.',
      '.ts:',
      'undefined',
      'null',
      'NaN',
      '[object',
      'SEM_TOKEN',
      'TOKEN_INVALIDO',
      'TOKEN_OK_SEM_DONO',
      'PRONTO',
      'proximoPasso',
      'getMe',
      'getUpdates',
      'update_id',
      'from.id',
      'chat.id',
      'error_code',
    ]
    const retratos: ReadonlyArray<[EstadoOnboarding, RetratoDoAmbiente]> = [
      ['SEM_TOKEN', SEM_TOKEN],
      ['TOKEN_INVALIDO', TOKEN_INVALIDO],
      ['TOKEN_OK_SEM_DONO', SEM_DONO],
      ['PRONTO', PRONTO],
    ]
    for (const [nome, retrato] of retratos) {
      const passo = proximoPasso(retrato, { ...OPCOES, codigo: '481516' })
      const tudo = `${passo.titulo}\n${passo.texto}`
      for (const agulha of proibido) {
        assert.ok(!tudo.includes(agulha), `${nome} contem ${JSON.stringify(agulha)}`)
      }
      // Portugues: acentos presentes e nenhuma linha absurdamente longa.
      assert.match(tudo, /[áàâãéêíóôõúç]/u, `${nome} nao parece portugues`)
      for (const linha of tudo.split('\n')) {
        assert.ok(linha.length <= 90, `${nome} tem uma linha de ${String(linha.length)} colunas`)
      }
    }
  })

  it('nenhum texto contem caminho absoluto que identifique o utilizador', () => {
    for (const retrato of [SEM_TOKEN, TOKEN_INVALIDO, SEM_DONO, PRONTO]) {
      const { texto } = proximoPasso(retrato, { ...OPCOES, codigo: '481516' })
      assert.ok(!/\/(?:home|Users)\//u.test(texto), texto)
      assert.ok(!texto.includes('/root/'), texto)
    }
  })
})

/* ========================================================================== */
/* O detector                                                                 */
/* ========================================================================== */

describe('o detector dos quatro estados', () => {
  it('classifica os quatro retratos', () => {
    assert.equal(detectarEstado(SEM_TOKEN), 'SEM_TOKEN')
    assert.equal(detectarEstado(TOKEN_INVALIDO), 'TOKEN_INVALIDO')
    assert.equal(detectarEstado(SEM_DONO), 'TOKEN_OK_SEM_DONO')
    assert.equal(detectarEstado(PRONTO), 'PRONTO')
  })

  it('formato invalido da TOKEN_INVALIDO sem `getMe` nenhum', () => {
    assert.equal(
      detectarEstado({
        token: { origem: 'ambiente', formato: { valido: false, motivo: 'sem-dois-pontos' } },
        getMe: undefined,
        dono: undefined,
      }),
      'TOKEN_INVALIDO',
    )
  })

  it('um token que NINGUEM confirmou nao conta como bom', () => {
    // Falha-se para o lado que diz a verdade: supor o token bom levaria a
    // ferramenta a pedir um codigo de pareamento e a esperar por um `/parear`
    // que nunca chega, porque o bot pode nem existir.
    assert.equal(
      detectarEstado({
        token: { origem: 'secrets.env', formato: { valido: true, botId: 1 } },
        getMe: undefined,
        dono: undefined,
      }),
      'TOKEN_INVALIDO',
    )
  })

  it('e PURO: a mesma entrada da a mesma saida, e nao muda a entrada', () => {
    const antes = JSON.stringify(SEM_DONO)
    const um = proximoPasso(SEM_DONO, { ...OPCOES, codigo: '481516' })
    const dois = proximoPasso(SEM_DONO, { ...OPCOES, codigo: '481516' })
    assert.deepEqual(um, dois)
    assert.equal(JSON.stringify(SEM_DONO), antes)
  })
})

describe('pergunta 1 da revisao: ele SALTA o passo do BotFather?', () => {
  it('com o token ja configurado, o roteiro do BotFather desaparece', () => {
    // E este o teste que distingue um detector de um tutorial linear.
    for (const retrato of [SEM_DONO, PRONTO]) {
      const { texto } = proximoPasso(retrato, { ...OPCOES, codigo: '481516' })
      assert.ok(!texto.includes('/newbot'), 'o passo do BotFather nao pode voltar')
      assert.ok(!texto.includes('BotFather'), texto.slice(0, 120))
    }
  })

  it('e com o token em falta, so aparece o passo do BotFather', () => {
    const { texto } = proximoPasso(SEM_TOKEN, OPCOES)
    assert.ok(texto.includes('/newbot'))
    assert.ok(!texto.includes('/parear'), 'nao se pede o pareamento antes de haver bot')
    assert.ok(!texto.includes('--reset-pairing'))
  })

  it('quando ja esta pronto, nao se pede nem codigo nem chave', () => {
    const { texto } = proximoPasso(PRONTO, OPCOES)
    assert.ok(!texto.includes('/parear '), texto)
    assert.ok(!texto.includes('--pedir-token'), texto)
  })
})

/* ========================================================================== */
/* TG-060 / TG-062 / TG-063 / TG-072                                          */
/* ========================================================================== */

describe('TG-060: a instrucao do BotFather leva o texto exato a digitar', () => {
  it('traz `/newbot`, as regras do username e o sufixo obrigatorio', () => {
    const { texto } = proximoPasso(SEM_TOKEN, OPCOES)
    assert.ok(texto.includes('@BotFather'))
    assert.ok(texto.includes('/newbot'))
    assert.ok(texto.includes('entre 5 e 32'))
    assert.ok(texto.includes('TERMINAR\n     em bot'), 'o sufixo obrigatorio tem de estar la')
    assert.ok(texto.includes('não pode ser mudado'), 'o username e imutavel')
    assert.ok(texto.includes('meu_painel_bot'), 'falta um exemplo concreto de username')
  })

  it('avisa para nao colar a chave em conversa nenhuma', () => {
    const { texto } = proximoPasso(SEM_TOKEN, OPCOES)
    assert.ok(texto.includes('Não a cole em conversa nenhuma'))
    assert.ok(texto.includes('linha de comando'), 'o aviso do argv faz parte do passo')
  })
})

describe('TG-062: `getMe` devolve 401', () => {
  it('diz que a chave foi revogada ou esta errada e manda usar `/token`', () => {
    const { texto } = proximoPasso(TOKEN_INVALIDO, OPCOES)
    assert.ok(texto.includes('/token'))
    assert.ok(texto.includes('@BotFather'))
    assert.ok(texto.includes('substituída') && texto.includes('mal copiada'))
    // A `description` da API NAO e mostrada em cru: ela e ingles e nao acciona.
    assert.ok(!texto.includes('Unauthorized'), texto)
  })

  it('cada causa tem um diagnostico proprio — rede nao vira "chave errada"', () => {
    const causas = ['rede', 'conflito', 'limite-de-taxa', 'rota-inexistente'] as const
    const textos = causas.map((causa) => {
      const retrato: RetratoDoAmbiente = {
        ...TOKEN_INVALIDO,
        getMe: { ok: false, falha: { causa, httpStatus: 0 } },
      }
      return proximoPasso(retrato, OPCOES).texto
    })
    assert.equal(new Set(textos).size, causas.length, 'os diagnosticos nao podem ser iguais')
    assert.ok(textos[0]?.includes('ligação à internet'))
    assert.ok(textos[1]?.includes('outra ligação a usar este mesmo bot'))
  })

  it('formato invalido diz que NADA saiu da maquina', () => {
    const { texto } = proximoPasso(
      {
        token: { origem: 'secrets.env', formato: { valido: false, motivo: 'sem-dois-pontos' } },
        getMe: undefined,
        dono: undefined,
      },
      OPCOES,
    )
    assert.ok(texto.includes('nem chegou a ser enviada'))
    assert.ok(texto.includes('Nada saiu desta máquina'))
  })
})

describe('TG-063: sem dono, exibe o codigo e manda `/parear <codigo>`', () => {
  it('mostra os 6 digitos e o comando exato', () => {
    const { texto } = proximoPasso(SEM_DONO, { ...OPCOES, codigo: '481516' })
    assert.ok(texto.includes('481516'))
    assert.ok(texto.includes('/parear 481516'))
  })

  it('NAO instrui a mandar `/start`, e diz que nenhum `/start` pareia', () => {
    const { texto } = proximoPasso(SEM_DONO, { ...OPCOES, codigo: '481516' })
    assert.ok(!/Envie[^\n]*\/start/u.test(texto), 'nao se pode instruir um `/start`')
    assert.ok(texto.includes('/start não pareia ninguém'))
  })

  it('pergunta 3 da revisao: explica que um bot nao consegue iniciar conversa', () => {
    const { texto } = proximoPasso(SEM_DONO, { ...OPCOES, codigo: '481516' })
    assert.ok(texto.includes('um bot nunca consegue'))
    assert.ok(texto.includes('falar primeiro é sempre você'))
  })

  it('sem codigo fornecido, o texto nao inventa um — mostra um lugar vazio', () => {
    // Compor o texto sem passar o codigo tem de ser inofensivo: nenhum caminho
    // pode produzir um codigo "por omissao" que alguem tome por valido.
    const { texto } = proximoPasso(SEM_DONO, OPCOES)
    assert.ok(!/\d{6}/u.test(texto), texto)
  })
})

describe('TG-072: os cinco avisos, antes do primeiro tunel', () => {
  const avisos: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['1 — trustedRemotes fica inerte', ['trustedRemotes', 'INERTE']],
    ['2 — o tunel fura a firewall', ['fura a firewall', 'de dentro para fora']],
    ['3 — a Cloudflare ve em texto claro na borda', ['texto claro na borda', 'WAF', 'Access', 'cache']],
    ['4 — a URL nao e segredo', ['NÃO é segredo', 'amostragem pública', 'dezenas']],
    ['5 — reputacao de malware', ['reputação de malware', 'trycloudflare.com']],
  ]

  for (const [nome, agulhas] of avisos) {
    it(`aviso ${nome}`, () => {
      for (const agulha of agulhas) {
        assert.ok(AVISOS_ANTES_DO_TUNEL.includes(agulha), `falta ${JSON.stringify(agulha)}`)
      }
    })
  }

  it('os cinco chegam ao texto que a pessoa ve quando fica pronta', () => {
    const { texto } = proximoPasso(PRONTO, OPCOES)
    assert.ok(texto.includes(AVISOS_ANTES_DO_TUNEL))
  })
})

/* ========================================================================== */
/* TG-061 — formato ANTES da rede                                             */
/* ========================================================================== */

describe('TG-061: formato invalido e recusado antes de qualquer chamada de rede', () => {
  it('classifica cada forma errada com o seu motivo', () => {
    const casos: ReadonlyArray<readonly [string, string]> = [
      ['', 'vazio'],
      ['   ', 'vazio'],
      ['semdoispontos', 'sem-dois-pontos'],
      [`0123456${':'}${'a'.repeat(30)}`, 'id-comeca-por-zero'],
      [`abc${':'}${'a'.repeat(30)}`, 'id-nao-numerico'],
      [`123456789${':'}curto`, 'segredo-curto'],
      [`123456789${':'}${'a'.repeat(25)} com espaco`, 'caracteres-invalidos'],
      [`123456789${':'}${'a'.repeat(120)}`, 'comprimento-excessivo'],
    ]
    for (const [bruto, motivo] of casos) {
      const resultado = validarFormatoDoToken(bruto)
      assert.equal(resultado.valido, false, `${bruto} devia ser recusado`)
      assert.equal(resultado.valido === false ? resultado.motivo : '', motivo, bruto)
    }
  })

  it('aceita um token bem formado e extrai o id do bot', () => {
    const resultado = validarFormatoDoToken(` ${TOKEN_VALIDO} `)
    assert.equal(resultado.valido, true)
    assert.equal(resultado.valido === true ? resultado.botId : 0, 123_456_789)
  })

  /*
   * >>> M4 — ESTE TESTE JA NAO PODE PASSAR SOZINHO <<<
   *
   * A versao anterior REIMPLEMENTAVA a ordem dentro do proprio teste
   * (`if (formato.valido) await sonda.getMe(...)`) e depois assertava sobre o
   * servidor local. O ramo que chamaria a rede nunca corria, logo mutar
   * `recolherRetrato` para chamar `getMe` TAMBEM no ramo invalido deixava a
   * suite verde. A garantia estava implementada e nao estava presa.
   *
   * Agora quem conduz e `principal()`, com um `secrets.env` malformado no
   * disco e um espiao na sonda. Se alguem trocar a ordem, o contador sobe.
   */
  it('com um `secrets.env` malformado, `principal()` nao chama a rede', async () => {
    let chamadas = 0
    const espiao: SondaTelegram = {
      getMe: async () => {
        chamadas += 1
        return { ok: true, bot: BOT }
      },
      getUpdates: async () => {
        chamadas += 1
        return { ok: true, updates: [] }
      },
    }
    const bancada = montarBancada(espiao)
    try {
      mkdirSync(bancada.raiz, { recursive: true, mode: 0o700 })
      writeFileSync(join(bancada.raiz, 'secrets.env'), `${CHAVE_DO_TOKEN}=sem-dois-pontos\n`, {
        mode: 0o600,
      })
      assert.equal(await principal([], bancada.deps), 3)
      assert.equal(chamadas, 0, 'nenhum byte pode sair antes de o formato passar')
      assert.ok(bancada.saida().includes('Nada saiu desta máquina'))
    } finally {
      bancada.limpar()
    }
  })

  it('SEM_TOKEN — a senha do portão é provisionada e mostrada UMA vez (independente do Telegram)', async () => {
    const bancada = montarBancada({
      // Sem token não pode haver rede nenhuma: se `principal()` chamar a sonda
      // sem `secrets.env`, isto rebenta o teste em vez de mascarar o bug.
      getMe: async () => {
        throw new Error('rede não pode ser chamada sem token')
      },
      getUpdates: async () => ({ ok: true, updates: [] }),
    })
    try {
      // Fluxo default num SEM_TOKEN continua a ser "falta um passo" (exit 3),
      // mas a senha do portão HTTP é provisionada e mostrada MESMO ASSIM —
      // INSTALL.md Passo 4: o portão funciona só com a senha, sem Telegram.
      assert.equal(await principal([], bancada.deps), 3)
      const saida = bancada.saida()
      assert.ok(
        saida.includes('Esta é a sua senha de acesso'),
        'a senha precisa de ser mostrada na 1ª execução, sem bot configurado',
      )
      assert.ok(
        saida.includes('Falta criar o bot no Telegram'),
        'o próximo passo do Telegram continua a ser anunciado depois da senha',
      )
      const digest1 = bancada.estado().secretDigest
      assert.equal(typeof digest1, 'string', 'o digest da senha tem de ficar em disco')
      assert.ok((digest1 as string).length >= 40, 'digest não-trivial persistido')

      // Idempotência (TG-067): a 2ª execução não regenera senha nem digest.
      assert.equal(await principal([], bancada.deps), 3)
      assert.ok(
        bancada.saida().includes('já tinha sido gerada e é mostrada uma única vez'),
        'a 2ª execução avisa que a senha já tinha sido mostrada',
      )
      assert.equal(bancada.estado().secretDigest, digest1, 'digest inalterado na 2ª execução')
    } finally {
      bancada.limpar()
    }
  })

  it('cada uma das oito formas erradas continua a nao chegar a rede', async () => {
    const errados = [
      'semdoispontos',
      `0123456${':'}${'a'.repeat(30)}`,
      `abc${':'}${'a'.repeat(30)}`,
      `123456789${':'}curto`,
      `123456789${':'}${'a'.repeat(120)}`,
      '   ',
      `${':'}${'a'.repeat(30)}`,
      `123456789${':'}`,
    ]
    for (const bruto of errados) {
      let chamadas = 0
      const espiao: SondaTelegram = {
        getMe: async () => {
          chamadas += 1
          return { ok: true, bot: BOT }
        },
        getUpdates: async () => ({ ok: true, updates: [] }),
      }
      const bancada = montarBancada(espiao, { pedirSegredo: async () => bruto })
      try {
        await principal(['--pedir-token'], bancada.deps)
        assert.equal(chamadas, 0, `${JSON.stringify(bruto)} chegou a rede`)
        assert.throws(() => statSync(join(bancada.raiz, 'secrets.env')), /ENOENT/u, bruto)
      } finally {
        bancada.limpar()
      }
    }
  })
})

/* ========================================================================== */
/* A sonda contra um servidor local com os corpos MEDIDOS                     */
/* ========================================================================== */

describe('a sonda, contra um servidor HTTP local (nunca api.telegram.org)', () => {
  it('le a identidade do bot num 200', async () => {
    const api = await iniciarBotApiFalsa()
    try {
      const resposta = await criarSondaHttp({ apiRoot: api.apiRoot }).getMe(TOKEN_VALIDO)
      assert.equal(resposta.ok, true)
      assert.deepEqual(resposta.ok === true ? resposta.bot : undefined, BOT)
      assert.deepEqual(api.chamadas, ['getMe'])
    } finally {
      await api.fechar()
    }
  })

  it('401 com o corpo medido vira causa `recusado`', async () => {
    const api = await iniciarBotApiFalsa()
    try {
      api.responder(401, {
        ok: false,
        error_code: 401,
        description: 'Unauthorized: invalid token specified',
      })
      const resposta = await criarSondaHttp({ apiRoot: api.apiRoot }).getMe(TOKEN_VALIDO)
      assert.equal(resposta.ok, false)
      assert.equal(resposta.ok === false ? resposta.falha.causa : '', 'recusado')
    } finally {
      await api.fechar()
    }
  })

  it('404 `Not Found` (token sem `:`) vira causa `rota-inexistente`', async () => {
    const api = await iniciarBotApiFalsa()
    try {
      api.responder(404, { ok: false, error_code: 404, description: 'Not Found' })
      const resposta = await criarSondaHttp({ apiRoot: api.apiRoot }).getMe(TOKEN_VALIDO)
      assert.equal(resposta.ok === false ? resposta.falha.causa : '', 'rota-inexistente')
    } finally {
      await api.fechar()
    }
  })

  it('pergunta 6 da revisao: o 409 e DETECTADO, nao vira erro cru', async () => {
    const api = await iniciarBotApiFalsa()
    try {
      api.responder(409, {
        ok: false,
        error_code: 409,
        description:
          'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
      })
      const resposta = await criarSondaHttp({ apiRoot: api.apiRoot }).getUpdates(TOKEN_VALIDO)
      assert.equal(resposta.ok, false)
      assert.equal(resposta.ok === false ? resposta.falha.causa : '', 'conflito')
      // E ha texto em portugues para essa causa, sem `Conflict:` em cru.
      const { texto } = proximoPasso(
        { ...TOKEN_INVALIDO, getMe: { ok: false, falha: { causa: 'conflito', httpStatus: 409 } } },
        OPCOES,
      )
      assert.ok(texto.includes('outra ligação a usar este mesmo bot'))
      assert.ok(!texto.includes('Conflict'))
    } finally {
      await api.fechar()
    }
  })

  it('pergunta 2 da revisao: o `offset` NUNCA avanca — nada e confirmado', async () => {
    // O corpo do pedido e o que prova a propriedade: `offset: 0` nao confirma
    // update nenhum, logo o worker continua a ver tudo o que ha na fila.
    let corpo: unknown
    const sonda = criarSondaHttp({
      apiRoot: 'http://127.0.0.1:1',
      buscar: async (_url, init) => {
        corpo = JSON.parse(String(init?.body ?? '{}'))
        return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 })
      },
    })
    await sonda.getUpdates(TOKEN_VALIDO)
    assert.deepEqual(corpo, { offset: 0, timeout: 0, limit: 100, allowed_updates: ['message'] })
  })

  it('falha de rede vira causa `rede`, e a mensagem do `fetch` (com o token) e descartada', async () => {
    let visto: unknown
    const sonda = criarSondaHttp({
      apiRoot: 'http://127.0.0.1:1',
      buscar: async () => {
        throw new Error(`fetch failed: http://127.0.0.1:1/bot${TOKEN_VALIDO}/getMe`)
      },
    })
    const resposta = await sonda.getMe(TOKEN_VALIDO)
    visto = resposta
    assert.equal(resposta.ok, false)
    assert.equal(resposta.ok === false ? resposta.falha.causa : '', 'rede')
    assert.ok(!JSON.stringify(visto).includes(TOKEN_VALIDO), 'o token nao pode sair na falha')
  })

  it('classifica um corpo ininteligivel sem rebentar', () => {
    assert.equal(classificarFalha(502, undefined).causa, 'resposta-ininteligivel')
    assert.equal(classificarFalha(429, { parameters: { retry_after: 5 } }).retryAfter, 5)
  })
})

/* ========================================================================== */
/* TG-069 — token no argv                                                     */
/* ========================================================================== */

describe('TG-069: a chave no `argv` e RECUSADA, com explicacao', () => {
  it('recusa a bandeira, a bandeira com valor colado, e o valor solto', () => {
    for (const argv of [
      ['--token', TOKEN_VALIDO],
      [`--token=${TOKEN_VALIDO}`],
      [TOKEN_VALIDO],
      ['--pedir-token', TOKEN_VALIDO],
      [`${CHAVE_DO_TOKEN}=${TOKEN_VALIDO}`],
      ['-t', TOKEN_VALIDO],
    ]) {
      let apanhado: unknown
      try {
        analisarArgumentos(argv)
      } catch (erro) {
        apanhado = erro
      }
      assert.ok(apanhado instanceof OnboardingError, `${argv.join(' ')} devia ser recusado`)
      assert.equal(apanhado.code, 'SETUP_TOKEN_IN_ARGV')
      assert.ok(apanhado.message.includes('ps'), 'a explicacao tem de dizer PORQUE')
      assert.ok(apanhado.message.includes('histórico da shell'))
      assert.ok(apanhado.message.includes('--pedir-token'), 'tem de dizer o que fazer em vez disso')
      assert.ok(!apanhado.message.includes(TOKEN_VALIDO), 'a recusa nao repete a chave')
    }
  })

  it('aceita os comandos que existem e recusa os que nao existem', () => {
    assert.deepEqual(analisarArgumentos([]), { comando: 'guiar', confirmado: false })
    assert.equal(analisarArgumentos(['--pedir-token']).comando, 'pedir-token')
    assert.equal(analisarArgumentos(['--parear']).comando, 'parear')
    assert.equal(analisarArgumentos(['--reset-pairing']).comando, 'reset-pairing')
    assert.equal(analisarArgumentos(['--ajuda']).comando, 'ajuda')
    assert.equal(analisarArgumentos(['--parear', '--sim']).confirmado, true)

    let apanhado: unknown
    try {
      analisarArgumentos(['--desconhecido'])
    } catch (erro) {
      apanhado = erro
    }
    assert.ok(apanhado instanceof OnboardingError)
    assert.equal(apanhado.code, 'SETUP_UNKNOWN_ARGUMENT')
  })
})

/* ========================================================================== */
/* TG-068 — `secrets.env`                                                     */
/* ========================================================================== */

describe('TG-068: `secrets.env` preserva as outras linhas e nasce 0600', () => {
  it('funde a chave nova sem tocar em comentarios, ordem nem outras chaves', () => {
    const antes = [
      '# credenciais deste plugin — nao versionar',
      'OUTRA_COISA=valor',
      '',
      '# a chave do bot',
      `${CHAVE_DO_TOKEN}=antigo`,
      'DEPOIS=fica',
      '',
    ].join('\n')

    const depois = fundirSecretsEnv(antes, CHAVE_DO_TOKEN, 'novo')
    assert.equal(
      depois,
      [
        '# credenciais deste plugin — nao versionar',
        'OUTRA_COISA=valor',
        '',
        '# a chave do bot',
        `${CHAVE_DO_TOKEN}=novo`,
        'DEPOIS=fica',
        '',
      ].join('\n'),
    )
  })

  it('acrescenta no fim quando a chave nao existe, sem colar a ultima linha', () => {
    assert.equal(fundirSecretsEnv('A=1', 'B', '2'), 'A=1\nB=2\n')
    assert.equal(fundirSecretsEnv('A=1\n', 'B', '2'), 'A=1\nB=2\n')
    assert.equal(fundirSecretsEnv('', 'B', '2'), 'B=2\n')
    assert.equal(fundirSecretsEnv('A=1\n\n\n', 'B', '2'), 'A=1\n\n\nB=2\n')
  })

  it('com a chave repetida, substitui a ULTIMA — que e a que vale', () => {
    assert.equal(fundirSecretsEnv('K=1\nK=2\n', 'K', '3'), 'K=1\nK=3\n')
  })

  it('nao confunde um comentario que menciona a chave com uma atribuicao', () => {
    assert.equal(
      fundirSecretsEnv(`# ${CHAVE_DO_TOKEN}=exemplo\n`, CHAVE_DO_TOKEN, 'x'),
      `# ${CHAVE_DO_TOKEN}=exemplo\n${CHAVE_DO_TOKEN}=x\n`,
    )
  })

  it('le `export CHAVE=valor` e tira as aspas de fora', () => {
    const lido = analisarSecretsEnv(['export A=1', 'B="dois"', "C='tres'", 'D=', '#E=5'].join('\n'))
    assert.equal(lido.get('A'), '1')
    assert.equal(lido.get('B'), 'dois')
    assert.equal(lido.get('C'), 'tres')
    assert.equal(lido.get('D'), '')
    assert.equal(lido.get('E'), undefined)
  })

  it('o ficheiro fica em 0600, no diretorio de estado, e fora do repositorio', () => {
    const temp = makeTempStateDir()
    try {
      const paths = statePathsAt(temp.path)
      const caminho = caminhoDoSecretsEnv(paths)
      assert.equal(caminho, join(temp.path, 'secrets.env'))
      // Fora do workspace por construcao: o diretorio de estado e o do
      // `state.json`, e ele vive na casa do harness, nunca no repositorio.
      assert.ok(!caminho.startsWith(process.cwd()), caminho)

      writeFileSync(caminho, `${CHAVE_DO_TOKEN}=x\n`, { mode: MODO_DO_SECRETS_ENV })
      assert.equal(statSync(caminho).mode & 0o777, 0o600)
      assert.equal(readFileSync(caminho, 'utf8'), `${CHAVE_DO_TOKEN}=x\n`)
    } finally {
      temp.cleanup()
    }
  })

  it('RECUSA carregar um `secrets.env` legivel por outras contas', () => {
    const temp = makeTempStateDir()
    try {
      const caminho = join(temp.path, 'secrets.env')
      writeFileSync(caminho, `${CHAVE_DO_TOKEN}=x\n`)
      chmodSync(caminho, 0o644)

      let apanhado: unknown
      try {
        lerSecretsEnv(caminho)
      } catch (erro) {
        apanhado = erro
      }
      assert.ok(apanhado instanceof OnboardingError)
      assert.equal(apanhado.code, 'SECRETS_MODE_TOO_OPEN')
      assert.ok(apanhado.message.includes('/token'), 'tem de mandar rodar a chave, nao so chmod')
      assert.ok(!apanhado.message.includes('=x'), 'a recusa nao pode mostrar o conteudo')
    } finally {
      temp.cleanup()
    }
  })

  it('a ausencia do ficheiro e o primeiro arranque, nao um erro', () => {
    const temp = makeTempStateDir()
    try {
      assert.equal(lerSecretsEnv(join(temp.path, 'nao-existe.env')), undefined)
      assert.equal(resolverToken(join(temp.path, 'nao-existe.env'), {}), undefined)
    } finally {
      temp.cleanup()
    }
  })

  it('o `secrets.env` tem precedencia sobre a variavel de ambiente', () => {
    const temp = makeTempStateDir()
    try {
      const caminho = join(temp.path, 'secrets.env')
      writeFileSync(caminho, `${CHAVE_DO_TOKEN}=do-ficheiro\n`, { mode: MODO_DO_SECRETS_ENV })
      assert.deepEqual(resolverToken(caminho, { [CHAVE_DO_TOKEN]: 'do-ambiente' }), {
        token: 'do-ficheiro',
        origem: 'secrets.env',
      })
      assert.deepEqual(resolverToken(join(temp.path, 'x.env'), { [CHAVE_DO_TOKEN]: 'do-ambiente' }), {
        token: 'do-ambiente',
        origem: 'ambiente',
      })
    } finally {
      temp.cleanup()
    }
  })
})

/* ========================================================================== */
/* Caminho apresentavel                                                       */
/* ========================================================================== */

describe('o caminho mostrado nao identifica o utilizador', () => {
  it('a casa do utilizador vira `~`, e o resto do caminho continua legivel', () => {
    assert.equal(
      caminhoApresentavel('/home/ana/.dsh/guarded-bot/secrets.env', '/home/ana'),
      '~/.dsh/guarded-bot/secrets.env',
    )
    assert.equal(caminhoApresentavel('/home/ana', '/home/ana'), '~')
  })

  it('fora da casa, um caminho de sistema fica INTEIRO — ele diz onde procurar', () => {
    assert.equal(caminhoApresentavel('/opt/dsh/state/secrets.env', '/home/ana'), '/opt/dsh/state/secrets.env')
  })

  it('a casa de OUTRA conta e mascarada, nunca publicada', () => {
    assert.ok(!caminhoApresentavel('/home/outro/x', '/home/ana').includes('outro'))
  })
})

/* ========================================================================== */
/* TG-067 — idempotencia, medida no processo real                             */
/* ========================================================================== */

const CLI = join(import.meta.dirname, '../../../bin/dsh-guard-setup.ts')

/** Ambiente do processo filho: raiz de estado descartavel e SEM chave herdada. */
function ambienteLimpo(raiz: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: raiz }
  delete env[CHAVE_DO_TOKEN]
  return env
}

describe('TG-067: a ferramenta e idempotente (executada de verdade)', () => {
  it('sem token: provisiona a senha do portão (1ª vez), guia o passo em falta, sai 3 e não toca no Telegram', async () => {
    const temp = makeTempStateDir()
    try {
      const env = ambienteLimpo(temp.path)
      let saida = ''
      let codigo = 0
      try {
        const r = await executar(process.execPath, [CLI], { env })
        saida = r.stdout
      } catch (erro) {
        const e = erro as { code?: number; stdout?: string }
        codigo = e.code ?? 0
        saida = e.stdout ?? ''
      }
      assert.equal(codigo, 3, 'falta um passo => 3')
      assert.ok(saida.includes('/newbot'), saida)

      // A senha do portão é provisionada na 1ª execução, SEM depender do
      // Telegram (INSTALL.md Passo 4): o `state.json` nasce com o digest.
      assert.ok(saida.includes('Esta é a sua senha de acesso'), 'a senha aparece mesmo sem bot')
      const estado = join(temp.path, 'guarded-bot', 'state.json')
      const estadoLido = JSON.parse(readFileSync(estado, 'utf8')) as Record<string, unknown>
      assert.equal(typeof estadoLido.secretDigest, 'string', 'digest da senha persistido')

      // O que NÃO é escrito: nada do Telegram (nem secrets.env, nem pairing).
      assert.throws(() => statSync(join(temp.path, 'guarded-bot', 'secrets.env')), /ENOENT/u)
      assert.equal(estadoLido.pairing, undefined)

      // E o diretório de estado nasce 0700.
      assert.equal(statSync(join(temp.path, 'guarded-bot')).mode & 0o777, 0o700)
    } finally {
      temp.cleanup()
    }
  })

  it('correr duas vezes: a senha aparece UMA vez; o passo do Telegram não se acumula', async () => {
    const temp = makeTempStateDir()
    try {
      const env = ambienteLimpo(temp.path)
      const correr = async (): Promise<string> => {
        try {
          return (await executar(process.execPath, [CLI], { env })).stdout
        } catch (erro) {
          return (erro as { stdout?: string }).stdout ?? ''
        }
      }
      const primeira = await correr()
      const segunda = await correr()
      assert.ok(primeira.includes('Esta é a sua senha de acesso'), '1ª execução mostra a senha')
      assert.ok(
        segunda.includes('já tinha sido gerada e é mostrada uma única vez'),
        '2ª execução não regenera a senha',
      )
      assert.ok(!/[▀▄█]/u.test(segunda), 'o QR não se repete na 2ª execução')
      // O passo seguinte do Telegram é idêntico nas duas execuções (idempotente).
      const passo = (s: string): string => s.slice(s.indexOf('Falta criar o bot no Telegram'))
      assert.ok(passo(primeira).length > 0 && passo(segunda).length > 0, 'o passo existe nas duas')
      assert.equal(passo(primeira), passo(segunda), 'o texto do próximo passo não se acumula')
    } finally {
      temp.cleanup()
    }
  })

  it('a chave no `argv` e recusada pelo processo real, com saida 2 e sem rede', async () => {
    const temp = makeTempStateDir()
    try {
      const env = ambienteLimpo(temp.path)
      let codigo = 0
      let erroSaida = ''
      try {
        await executar(process.execPath, [CLI, TOKEN_VALIDO], { env })
      } catch (erro) {
        const e = erro as { code?: number; stderr?: string }
        codigo = e.code ?? 0
        erroSaida = e.stderr ?? ''
      }
      assert.equal(codigo, 2, 'uso incorreto => 2')
      assert.ok(erroSaida.includes('linha de comando'), erroSaida)
      assert.ok(!erroSaida.includes(TOKEN_VALIDO), 'a recusa nao repete a chave')
      assert.ok(!erroSaida.includes('    at '), 'nenhum stack trace no ecra')
    } finally {
      temp.cleanup()
    }
  })

  it('`--ajuda` sai 0 e explica os comandos sem jargao', async () => {
    const temp = makeTempStateDir()
    try {
      const { stdout } = await executar(process.execPath, [CLI, '--ajuda'], {
        env: ambienteLimpo(temp.path),
      })
      assert.ok(stdout.includes('--pedir-token'))
      assert.ok(stdout.includes('--parear'))
      assert.ok(stdout.includes('--reset-pairing'))
      assert.ok(stdout.includes('nunca pode vir na linha de comando'))
    } finally {
      temp.cleanup()
    }
  })
})

/* ========================================================================== */
/* O motor completo, conduzido pela CLI real — sem rede e sem terminal        */
/* ========================================================================== */

/**
 * `bin/dsh-guard-setup.ts` exporta `principal(argv, deps)`, e as `deps` sao o
 * transporte, as saidas, o relogio e as perguntas. E o que permite exercer o
 * FLUXO INTEIRO — gerar o codigo, esperar, ler o update, gravar o dono — sem
 * abrir um socket para fora e sem um terminal interativo.
 */
import { principal, type DependenciasDoSetup } from '../../../bin/dsh-guard-setup.ts'
import { createStateStore } from '../../../src/state/store.ts'
import { TTL_DO_CODIGO_MS } from '../../../src/telegram/pairing.ts'
import { type SondaTelegram } from '../../../src/telegram/onboarding.ts'

/** Update de mensagem privada com `from.id` e `chat.id` DISTINTOS. */
function update(texto: string, updateId: number, fromId: number, chatId: number): unknown {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_800_000_000,
      from: { id: fromId, is_bot: false, first_name: 'Dono' },
      chat: { id: chatId, type: 'private' },
      text: texto,
    },
  }
}

interface Bancada {
  readonly raiz: string
  readonly linhas: string[]
  readonly erros: string[]
  readonly deps: DependenciasDoSetup
  saida(): string
  estado(): Record<string, unknown>
  limpar(): void
}

function montarBancada(sonda: SondaTelegram, extra: DependenciasDoSetup = {}): Bancada {
  const temp = makeTempStateDir()
  const paths = statePathsAt(temp.path)
  const linhas: string[] = []
  const erros: string[] = []
  return {
    raiz: temp.path,
    linhas,
    erros,
    deps: {
      paths,
      sonda,
      intervaloMs: 0,
      escrever: (texto: string): void => void linhas.push(texto),
      avisar: (texto: string): void => void erros.push(texto),
      perguntar: async (): Promise<string> => '',
      pedirSegredo: async (): Promise<string> => '',
      ...extra,
    },
    saida: (): string => linhas.join('\n'),
    estado: (): Record<string, unknown> => {
      const h = createStateStore({ paths })
      try {
        return h.store.read() as unknown as Record<string, unknown>
      } finally {
        h.dispose()
      }
    },
    limpar: (): void => temp.cleanup(),
  }
}

/**
 * Extrai o codigo mostrado no terminal. E a UNICA forma de o obter.
 *
 * O ULTIMO, e nao o primeiro: quando a ferramenta renova o codigo, a saida
 * acumulada tem varios, e ler o primeiro seria ler um codigo ja morto.
 */
function codigoMostrado(saida: string): string {
  const ultimo = codigoAtual(saida)
  assert.ok(ultimo !== undefined, `nao encontrei o codigo em:\n${saida}`)
  return ultimo
}

/** O mesmo, mas devolve `undefined` quando ainda nao ha codigo nenhum. */
function codigoAtual(saida: string): string | undefined {
  return [...saida.matchAll(/código de pareamento:\s+(\d{6})/gu)].at(-1)?.[1]
}

describe('TG-063/065/066: o pareamento, de ponta a ponta pela CLI', () => {
  it('pareia com o update que carrega o codigo CORRECTO, e so com esse', async () => {
    let sondagens = 0
    let saidaAteAgora = ''
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => {
        sondagens += 1
        // Primeira sondagem: a fila esta vazia, tal como estaria na vida real
        // enquanto a pessoa vai buscar o telemovel.
        if (sondagens === 1) return { ok: true, updates: [] }
        const codigo = codigoMostrado(saidaAteAgora)
        const errado = String((Number(codigo) + 1) % 1_000_000).padStart(6, '0')
        return {
          ok: true,
          updates: [
            update('/start', 10, 666, 666),
            update(`/parear ${errado}`, 11, 777, 777),
            update(`/parear ${codigo}`, 12, 111, 222),
            update(`/parear ${codigo}`, 13, 999, 999),
          ],
        }
      },
    }

    const bancada = montarBancada(sonda)
    // A sonda le a saida ja escrita: e assim que ela descobre o codigo, tal
    // como a pessoa o descobre — olhando para o terminal.
    const original = bancada.deps.escrever
    const comEspelho: DependenciasDoSetup = {
      ...bancada.deps,
      escrever: (texto: string): void => {
        saidaAteAgora += `${texto}\n`
        original?.(texto)
      },
    }
    try {
      escreverSecretsEnv(bancada.raiz)
      const codigo = await principal([], comEspelho)
      assert.equal(codigo, 0)

      // TG-065: os DOIS ids vem do update que trazia o codigo certo — nao do
      // `/start` que chegou antes (666) nem do codigo errado (777) nem do
      // segundo update com o codigo certo (999).
      const dono = bancada.estado()['pairing'] as
        | { ownerUserId: number; ownerChatId: number; pairedAt: number }
        | undefined
      assert.ok(dono !== undefined, 'o dono tinha de ficar gravado')
      assert.equal(dono.ownerUserId, 111)
      assert.equal(dono.ownerChatId, 222)
      assert.ok(Number.isFinite(dono.pairedAt) && dono.pairedAt > 0)
      assert.ok(bancada.saida().includes('Pronto.'))
      // TG-072: os cinco avisos chegam antes de o tunel poder subir.
      assert.ok(bancada.saida().includes(AVISOS_ANTES_DO_TUNEL))
      // A senha aparece uma vez, com o QR ao lado.
      assert.ok(bancada.saida().includes('senha de acesso'))
      assert.match(bancada.saida(), /[▀▄█]/u, 'faltou o QR ASCII')

      // PAIR-010, no caminho real: o codigo esteve no stdout e em mais lado
      // nenhum. O log de auditoria REGISTA o pareamento e nao regista o codigo.
      const mostrado = codigoMostrado(bancada.saida())
      const auditoria = readFileSync(join(bancada.raiz, 'audit.log'), 'utf8')
      assert.ok(auditoria.includes('pareamento_concluido'), auditoria)
      assert.ok(!auditoria.includes(mostrado), `o codigo vazou para o log:\n${auditoria}`)
      assert.ok(!auditoria.includes(TOKEN_VALIDO), 'a chave do bot vazou para o log')
      // E o estado persistido tambem nao o guarda: ele morre com o processo.
      assert.ok(!JSON.stringify(bancada.estado()).includes(mostrado))
    } finally {
      bancada.limpar()
    }
  })

  it('TG-064: o codigo expira, a ferramenta oferece outro, e nada fica aberto', async () => {
    let agora = 0
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => {
        // Ninguem mandou nada, e o tempo passou.
        agora += TTL_DO_CODIGO_MS
        return { ok: true, updates: [] }
      },
    }
    const bancada = montarBancada(sonda, { agora: () => agora })
    try {
      escreverSecretsEnv(bancada.raiz)
      const codigo = await principal([], bancada.deps)
      assert.equal(codigo, 3, 'expirar nao e sucesso, mas tambem nao e falha dura')
      assert.ok(bancada.saida().includes('O código expirou'))
      assert.ok(bancada.saida().includes('Nada ficou aberto e nada ficou trancado'))
      // NAO ficou dono nenhum, e nao ha janela permanente.
      assert.equal(bancada.estado()['pairing'], undefined)
    } finally {
      bancada.limpar()
    }
  })

  it('pergunta 6 da revisao: o 409 para o comando e EXPLICA, sem erro cru', async () => {
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => ({
        ok: false,
        falha: { causa: 'conflito', httpStatus: 409, errorCode: 409 },
      }),
    }
    const bancada = montarBancada(sonda)
    try {
      escreverSecretsEnv(bancada.raiz)
      assert.equal(await principal([], bancada.deps), 1)
      const aviso = bancada.erros.join('\n')
      assert.ok(aviso.includes('outra ligação a usar este bot'))
      assert.ok(aviso.includes('Pare o harness'))
      assert.ok(!aviso.includes('Conflict'), 'a descricao em ingles nao vai para o ecra')
      assert.equal(bancada.estado()['pairing'], undefined)
    } finally {
      bancada.limpar()
    }
  })
})

describe('TG-067: idempotencia depois de tudo ligado', () => {
  it('a segunda execucao nao gera codigo, nao troca a senha e nao reabre nada', async () => {
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => ({ ok: true, updates: [] }),
    }
    const bancada = montarBancada(sonda)
    try {
      escreverSecretsEnv(bancada.raiz)
      // Semeia o estado final SEM passar pelo pareamento, para isolar o que se
      // mede aqui: o comportamento de quem ja esta pronto.
      const h = createStateStore({ paths: statePathsAt(bancada.raiz) })
      h.store.update((estado) => ({
        ...estado,
        pairing: { ownerUserId: 111, ownerChatId: 222, pairedAt: 5 },
      }))
      h.dispose()

      assert.equal(await principal([], bancada.deps), 0)
      const primeira = bancada.saida()
      const estadoUm = bancada.estado()

      bancada.linhas.length = 0
      assert.equal(await principal([], bancada.deps), 0)
      const segunda = bancada.saida()
      const estadoDois = bancada.estado()

      assert.equal(estadoUm['secretDigest'], estadoDois['secretDigest'], 'a senha nao se regenera')
      assert.deepEqual(estadoUm['pairing'], estadoDois['pairing'], 'o pareamento nao se reabre')
      assert.ok(!/\d{6}/u.test(segunda), `nao pode surgir codigo novo:\n${segunda}`)
      assert.ok(segunda.includes('não gera código novo'))
      // A senha e mostrada UMA vez: na segunda execucao ja nao aparece o QR.
      assert.ok(primeira.includes('senha de acesso'))
      assert.ok(segunda.includes('já tinha sido gerada'))
      assert.ok(!/[▀▄█]/u.test(segunda), 'o QR nao se repete')
    } finally {
      bancada.limpar()
    }
  })
})

/** Semeia um dono ja pareado, para isolar o que o reset faz. */
function comDono(bancada: Bancada): void {
  const h = createStateStore({ paths: statePathsAt(bancada.raiz) })
  h.store.update((estado) => ({
    ...estado,
    pairing: { ownerUserId: 111, ownerChatId: 222, pairedAt: 5 },
  }))
  h.dispose()
}

describe('PAIR-008: `--reset-pairing`', () => {
  const sonda: SondaTelegram = {
    getMe: async () => ({ ok: true, bot: BOT }),
    getUpdates: async () => ({ ok: true, updates: [] }),
  }

  it('sem a palavra exata, NADA muda', async () => {
    const bancada = montarBancada(sonda, { perguntar: async () => 'sim' })
    try {
      escreverSecretsEnv(bancada.raiz)
      comDono(bancada)
      assert.equal(await principal(['--reset-pairing'], bancada.deps), 3)
      assert.ok(bancada.saida().includes('Nada foi alterado'))
      assert.deepEqual(bancada.estado()['pairing'], {
        ownerUserId: 111,
        ownerChatId: 222,
        pairedAt: 5,
      })
    } finally {
      bancada.limpar()
    }
  })

  it('com a palavra exata, invalida o dono anterior e EMITE evento de auditoria', async () => {
    const bancada = montarBancada(sonda, { perguntar: async () => 'reparear' })
    try {
      escreverSecretsEnv(bancada.raiz)
      comDono(bancada)
      assert.equal(await principal(['--reset-pairing'], bancada.deps), 0)
      assert.equal(bancada.estado()['pairing'], undefined, 'o dono anterior deixou de valer')

      const auditoria = readFileSync(join(bancada.raiz, 'audit.log'), 'utf8')
      assert.ok(auditoria.includes('pareamento_reaberto'), auditoria)
      assert.equal(statSync(join(bancada.raiz, 'audit.log')).mode & 0o777, 0o600)
      // O log NAO leva os ids do dono nem a chave do bot.
      assert.ok(!auditoria.includes('111'), auditoria)
      assert.ok(!auditoria.includes(TOKEN_VALIDO), auditoria)
    } finally {
      bancada.limpar()
    }
  })

  it('sem dono pareado, e um `no-op` que diz porque', async () => {
    const bancada = montarBancada(sonda, { perguntar: async () => 'reparear' })
    try {
      escreverSecretsEnv(bancada.raiz)
      assert.equal(await principal(['--reset-pairing'], bancada.deps), 0)
      assert.ok(bancada.saida().includes('não há nada para reabrir'))
    } finally {
      bancada.limpar()
    }
  })
})

describe('TG-068 de ponta a ponta: `--pedir-token` grava sem apagar o resto', () => {
  it('preserva as linhas que la estavam e grava 0600', async () => {
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => ({ ok: true, updates: [] }),
    }
    const bancada = montarBancada(sonda, {
      pedirSegredo: async () => TOKEN_VALIDO,
      // Depois de gravar, o estado passa a `TOKEN_OK_SEM_DONO` e o comando
      // segue para o passo seguinte; o `getUpdates` vazio + relogio parado
      // fazem-no terminar por expiracao sem esperar nada.
      agora: (() => {
        let t = 0
        return (): number => {
          t += TTL_DO_CODIGO_MS
          return t
        }
      })(),
    })
    try {
      const caminho = join(bancada.raiz, 'secrets.env')
      writeFileSync(caminho, '# nao versionar\nOUTRA=fica\n', { mode: 0o600 })

      await principal(['--pedir-token'], bancada.deps)

      const conteudo = readFileSync(caminho, 'utf8')
      assert.ok(conteudo.includes('# nao versionar'))
      assert.ok(conteudo.includes('OUTRA=fica'))
      assert.ok(conteudo.includes(`${CHAVE_DO_TOKEN}=${TOKEN_VALIDO}`))
      assert.equal(statSync(caminho).mode & 0o777, 0o600)
      // Fora do repositorio, no diretorio de estado.
      assert.ok(!caminho.startsWith(process.cwd()))
      // E a chave NUNCA aparece no ecra — nem no aviso de sucesso.
      assert.ok(!bancada.saida().includes(TOKEN_VALIDO), bancada.saida())
    } finally {
      bancada.limpar()
    }
  })

  it('formato invalido nao grava nada e nao chama a rede', async () => {
    let chamadas = 0
    const sonda: SondaTelegram = {
      getMe: async () => {
        chamadas += 1
        return { ok: true, bot: BOT }
      },
      getUpdates: async () => ({ ok: true, updates: [] }),
    }
    const bancada = montarBancada(sonda, { pedirSegredo: async () => 'isto-nao-e-uma-chave' })
    try {
      assert.equal(await principal(['--pedir-token'], bancada.deps), 3)
      assert.equal(chamadas, 0, 'TG-061: nada saiu para a rede')
      assert.throws(() => statSync(join(bancada.raiz, 'secrets.env')), /ENOENT/u)
      assert.ok(bancada.saida().includes('Nada saiu desta máquina'))
    } finally {
      bancada.limpar()
    }
  })
})

/** Semeia um `secrets.env` valido no diretorio de estado da bancada. */
function escreverSecretsEnv(raiz: string): void {
  mkdirSync(raiz, { recursive: true, mode: 0o700 })
  writeFileSync(join(raiz, 'secrets.env'), `${CHAVE_DO_TOKEN}=${TOKEN_VALIDO}\n`, { mode: 0o600 })
}

/* ========================================================================== */
/* Regressoes da revisao adversarial                                          */
/* ========================================================================== */

import { readlinkSync, symlinkSync } from 'node:fs'
import { gravarSecretsEnv, relatarErro } from '../../../bin/dsh-guard-setup.ts'
import { LIMITE_DE_UPDATES, OnboardingError as ErroDeOnboarding } from '../../../src/telegram/onboarding.ts'
import { lerComandoDePareamento } from '../../../src/telegram/pairing.ts'

/** Cinco `/parear` errados, com `update_id` FIXO — a fila represada do ataque. */
function filaDeCodigosErrados(): unknown[] {
  return [1, 2, 3, 4, 5].map((n) =>
    update(`/parear ${String(100_000 + n)}`, n, 666_000 + n, 666_000 + n),
  )
}

describe('A1: cinco `/parear` errados NAO podem trancar o onboarding', () => {
  it('a fila represada custa o primeiro código, e não todos', async () => {
    /*
     * A reproducao do revisor, ponto por ponto: uma fila FIXA de cinco codigos
     * errados que volta em todas as sondagens, porque o `offset` nunca avanca.
     * Antes da correccao: 31 codigos gerados, 30 esgotamentos, dono: nenhum.
     *
     * O codigo CORRECTO so aparece a partir da segunda sessao, e sempre DEPOIS
     * dos cinco errados no mesmo lote — a posicao que, com o `Set` a nascer por
     * sessao, garantia que o teto era gasto antes de se chegar a ele.
     */
    let saidaAteAgora = ''
    const codigosVistos = new Set<string>()
    let sessoes = 0

    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => {
        const atual = codigoAtual(saidaAteAgora)
        if (atual !== undefined && !codigosVistos.has(atual)) {
          codigosVistos.add(atual)
          sessoes = codigosVistos.size
        }
        const lote = filaDeCodigosErrados()
        if (sessoes >= 2 && atual !== undefined) {
          lote.push(update(`/parear ${atual}`, 900 + sessoes, 111, 222))
        }
        return { ok: true, updates: lote }
      },
    }

    const bancada = montarBancada(sonda)
    const espelho: DependenciasDoSetup = {
      ...bancada.deps,
      escrever: (texto: string): void => {
        saidaAteAgora += `${texto}\n`
        bancada.linhas.push(texto)
      },
    }
    try {
      escreverSecretsEnv(bancada.raiz)
      assert.equal(await principal(['--parear', '--sim'], espelho), 0, 'tinha de parear')

      const dono = bancada.estado()['pairing'] as { ownerUserId: number } | undefined
      assert.ok(dono !== undefined, 'o dono tinha de ficar gravado')
      assert.equal(dono.ownerUserId, 111)
      // O ponto de A1: dois codigos, nao trinta e um.
      assert.ok(
        codigosVistos.size <= 2,
        `foram queimados ${String(codigosVistos.size)} códigos — a fila voltou a contar`,
      )
    } finally {
      bancada.limpar()
    }
  })

  it('um `update_id` já visto não volta a gastar tentativa', async () => {
    // O mesmo lote, repetido muitas vezes, com um codigo que nunca acerta: se a
    // deduplicacao falhasse, a sessao esgotava-se; como ela vale, a sessao
    // chega ao fim do TTL ainda ABERTA, gastando UMA tentativa por update.
    let agora = 0
    let sondagens = 0
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => {
        sondagens += 1
        // Um unico codigo errado, sempre o mesmo update.
        if (sondagens > 20) agora += TTL_DO_CODIGO_MS
        return { ok: true, updates: [update('/parear 000000', 42, 777, 777)] }
      },
    }
    const bancada = montarBancada(sonda, { agora: () => agora })
    try {
      escreverSecretsEnv(bancada.raiz)
      assert.equal(await principal(['--parear'], bancada.deps), 3)
      assert.ok(sondagens > 20, 'a sessao tinha de sobreviver as 20 sondagens')
      assert.ok(
        bancada.saida().includes('O código expirou'),
        'a sessao acabou por ESGOTAMENTO e devia ter acabado por EXPIRACAO',
      )
    } finally {
      bancada.limpar()
    }
  })
})

describe('M2/B1: `--sim` tem teto — a janela não se renova indefinidamente', () => {
  it('para ao fim de quatro códigos, mesmo com um atacante ativo', async () => {
    // Codigos errados SEMPRE NOVOS: e o ataque sustentado, que a deduplicacao
    // nao apanha (nem deve). O que tem de o conter e o teto de renovacoes.
    let id = 1_000
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => {
        const lote = [1, 2, 3, 4, 5].map(() => {
          id += 1
          return update('/parear 000000', id, 666, 666)
        })
        return { ok: true, updates: lote }
      },
    }
    const bancada = montarBancada(sonda)
    try {
      escreverSecretsEnv(bancada.raiz)
      assert.equal(await principal(['--parear', '--sim'], bancada.deps), 3)
      const saida = bancada.saida()
      const gerados = new Set(
        [...saida.matchAll(/código de pareamento:\s+(\d{6})/gu)].map((m) => m[1]),
      )
      assert.ok(gerados.size <= 4, `gerou ${String(gerados.size)} códigos — o teto não valeu`)
      assert.ok(saida.includes('Paro por aqui em vez de continuar a gerar códigos sozinho'))
      assert.equal(bancada.estado()['pairing'], undefined)
    } finally {
      bancada.limpar()
    }
  })

  it('B2: esgotamento e expiração dizem coisas diferentes, nunca as duas', async () => {
    let id = 2_000
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => ({
        ok: true,
        updates: [1, 2, 3, 4, 5].map(() => {
          id += 1
          return update('/parear 000000', id, 666, 666)
        }),
      }),
    }
    const bancada = montarBancada(sonda, { perguntar: async () => 'n' })
    try {
      escreverSecretsEnv(bancada.raiz)
      await principal(['--parear'], bancada.deps)
      const saida = bancada.saida()
      assert.ok(saida.includes('fechado por excesso de tentativas erradas'))
      assert.ok(
        !saida.includes('expirou sem que nenhuma mensagem'),
        'não pode dizer que expirou sem mensagens logo depois de contar as mensagens',
      )
    } finally {
      bancada.limpar()
    }
  })

  it('`--ajuda` declara o teto de renovações', async () => {
    const bancada = montarBancada({
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => ({ ok: true, updates: [] }),
    })
    try {
      await principal(['--ajuda'], bancada.deps)
      assert.ok(bancada.saida().includes('--sim'))
      assert.ok(bancada.saida().includes('janela que se renova sozinha'))
    } finally {
      bancada.limpar()
    }
  })
})

describe('A2: uma fila de 100 updates esconde o `/parear` — e isso é DITO', () => {
  it('avisa uma vez, com o que fazer, em vez de ficar em silêncio', async () => {
    let agora = 0
    let sondagens = 0
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => {
        sondagens += 1
        if (sondagens > 3) agora += TTL_DO_CODIGO_MS
        return {
          ok: true,
          updates: Array.from({ length: LIMITE_DE_UPDATES }, (_, i) =>
            update('olá', 5_000 + i, 666, 666),
          ),
        }
      },
    }
    const bancada = montarBancada(sonda, { agora: () => agora })
    try {
      escreverSecretsEnv(bancada.raiz)
      assert.equal(await principal(['--parear'], bancada.deps), 3)
      const avisos = bancada.erros.join('\n')
      assert.ok(avisos.includes('mensagens por ler'), avisos)
      assert.ok(avisos.includes('ligue o harness uma vez'), avisos)
      // UMA vez, nao a cada sondagem: um aviso repetido 150 vezes e ruido.
      assert.equal(
        [...avisos.matchAll(/mensagens por ler/gu)].length,
        1,
        'o aviso repetiu-se e afogou o resto',
      )
      assert.equal(bancada.estado()['pairing'], undefined)
    } finally {
      bancada.limpar()
    }
  })
})

describe('M1: um `/parear` de grupo NÃO pareia', () => {
  it('rejeita supergroup, group e channel, e aceita só `private`', () => {
    const tipos = ['group', 'supergroup', 'channel', undefined, 'sender', 'privado']
    for (const tipo of tipos) {
      const bruto = {
        update_id: 7,
        message: {
          from: { id: 111 },
          chat: tipo === undefined ? { id: -1_001_234_567_890 } : { id: -1_001_234_567_890, type: tipo },
          text: '/parear@meu_painel_bot 123456',
        },
      }
      assert.deepEqual(
        lerComandoDePareamento(bruto),
        { descarte: 'conversa-nao-privada' },
        `chat.type=${String(tipo)} devia ser recusado`,
      )
    }
    assert.deepEqual(lerComandoDePareamento(update('/parear 123456', 1, 111, 222)), {
      userId: 111,
      chatId: 222,
      codigo: '123456',
    })
  })

  it('de ponta a ponta: um supergrupo com o código certo não grava dono nenhum', async () => {
    let agora = 0
    let saidaAteAgora = ''
    let sondagens = 0
    const sonda: SondaTelegram = {
      getMe: async () => ({ ok: true, bot: BOT }),
      getUpdates: async () => {
        sondagens += 1
        if (sondagens > 3) agora += TTL_DO_CODIGO_MS
        const atual = codigoAtual(saidaAteAgora) ?? '000000'
        return {
          ok: true,
          updates: [
            {
              update_id: 8_000 + sondagens,
              message: {
                from: { id: 111 },
                chat: { id: -1_001_234_567_890, type: 'supergroup' },
                text: `/parear@meu_painel_bot ${atual}`,
              },
            },
          ],
        }
      },
    }
    const bancada = montarBancada(sonda, { agora: () => agora })
    const espelho: DependenciasDoSetup = {
      ...bancada.deps,
      escrever: (texto: string): void => {
        saidaAteAgora += `${texto}\n`
        bancada.linhas.push(texto)
      },
    }
    try {
      escreverSecretsEnv(bancada.raiz)
      assert.equal(await principal(['--parear'], espelho), 3)
      // O `ownerChatId` e PARA ONDE o bot responde: um id de grupo ali punha o
      // link mágico de uso único a chegar a todos os membros.
      assert.equal(bancada.estado()['pairing'], undefined)
    } finally {
      bancada.limpar()
    }
  })
})

describe('M3: `stdin` fechado não pode publicar o $HOME do utilizador', () => {
  it('`--reset-pairing` sem resposta: sai 2, nada muda, e a mensagem é limpa', async () => {
    const bancada = montarBancada(
      {
        getMe: async () => ({ ok: true, bot: BOT }),
        getUpdates: async () => ({ ok: true, updates: [] }),
      },
      { perguntar: async () => undefined },
    )
    try {
      escreverSecretsEnv(bancada.raiz)
      comDono(bancada)
      assert.equal(await principal(['--reset-pairing'], bancada.deps), 2)
      assert.deepEqual(bancada.estado()['pairing'], {
        ownerUserId: 111,
        ownerChatId: 222,
        pairedAt: 5,
      })
      const aviso = bancada.erros.join('\n')
      assert.ok(aviso.includes('Nada foi alterado'))
      for (const proibido of ['await', '.ts:', '/home/', 'Warning:', 'top-level']) {
        assert.ok(!aviso.includes(proibido), `${proibido} apareceu:\n${aviso}`)
      }
    } finally {
      bancada.limpar()
    }
  })

  it('`--pedir-token` sem resposta: sai 2 e não grava nada', async () => {
    const bancada = montarBancada(
      {
        getMe: async () => ({ ok: true, bot: BOT }),
        getUpdates: async () => ({ ok: true, updates: [] }),
      },
      { pedirSegredo: async () => undefined },
    )
    try {
      assert.equal(await principal(['--pedir-token'], bancada.deps), 2)
      assert.throws(() => statSync(join(bancada.raiz, 'secrets.env')), /ENOENT/u)
      assert.ok(bancada.erros.join('\n').includes('Nada foi gravado'))
    } finally {
      bancada.limpar()
    }
  })

  it('o processo REAL com `< /dev/null` sai 2 e não imprime caminho nenhum', async () => {
    const temp = makeTempStateDir()
    try {
      // COM DONO: sem ele o comando termina antes de chegar a pergunta, e o
      // teste passava sem exercer nada. Era este o caminho que dava saida 13.
      const raiz = join(temp.path, 'guarded-bot')
      mkdirSync(raiz, { recursive: true, mode: 0o700 })
      const h = createStateStore({ paths: statePathsAt(raiz) })
      h.store.update((estado) => ({
        ...estado,
        pairing: { ownerUserId: 111, ownerChatId: 222, pairedAt: 5 },
      }))
      h.dispose()

      let codigo = 0
      let erroSaida = ''
      let saida = ''
      try {
        // Literalmente o comando do relatorio: `< /dev/null`.
        const r = await executar(
          '/bin/sh',
          ['-c', `"${process.execPath}" "${CLI}" --reset-pairing < /dev/null`],
          { env: ambienteLimpo(temp.path) },
        )
        saida = r.stdout
      } catch (erro) {
        const e = erro as { code?: number; stderr?: string; stdout?: string }
        codigo = e.code ?? 0
        erroSaida = e.stderr ?? ''
        saida = e.stdout ?? ''
      }
      const tudo = `${saida}\n${erroSaida}`
      assert.equal(codigo, 2, `saiu ${String(codigo)} — 13 não é um código documentado`)
      // E o dono continua exatamente onde estava: fail-closed de verdade.
      const depois = createStateStore({ paths: statePathsAt(raiz) })
      try {
        assert.deepEqual(depois.store.read().pairing, {
          ownerUserId: 111,
          ownerChatId: 222,
          pairedAt: 5,
        })
      } finally {
        depois.dispose()
      }
      for (const proibido of ['await', '.ts:', 'Warning:', 'top-level', 'node:internal']) {
        assert.ok(!tudo.includes(proibido), `${proibido} apareceu:\n${tudo}`)
      }
      assert.ok(!/\/(?:home|Users)\//u.test(tudo), tudo)
    } finally {
      temp.cleanup()
    }
  })
})

describe('M5: a escrita atómica do `secrets.env`, exercida e não só comentada', () => {
  function bancadaDeEscrita(dir: string): { paths: ReturnType<typeof statePathsAt>; caminhoSecrets: string } {
    const paths = statePathsAt(dir)
    return { paths, caminhoSecrets: caminhoDoSecretsEnv(paths) }
  }

  it('um symlink no lugar do ficheiro é RECUSADO, e o alvo fica intacto', () => {
    const temp = makeTempStateDir()
    try {
      const alvo = join(temp.path, 'alvo-de-outra-pessoa.txt')
      writeFileSync(alvo, 'conteúdo alheio\n', { mode: 0o600 })
      symlinkSync(alvo, join(temp.path, 'secrets.env'))

      const ctx = bancadaDeEscrita(temp.path)
      let apanhado: unknown
      try {
        gravarSecretsEnv(ctx, CHAVE_DO_TOKEN, TOKEN_VALIDO)
      } catch (erro) {
        apanhado = erro
      }
      assert.ok(apanhado instanceof ErroDeOnboarding, 'o symlink tinha de ser recusado')
      assert.equal(apanhado.code, 'SECRETS_READ_FAILED')
      assert.ok(apanhado.message.includes('link simbólico'))
      // O alvo NAO foi tocado, e a chave nao chegou perto dele.
      assert.equal(readFileSync(alvo, 'utf8'), 'conteúdo alheio\n')
      assert.equal(readlinkSync(join(temp.path, 'secrets.env')), alvo)
    } finally {
      temp.cleanup()
    }
  })

  it('sob um `umask` hostil o ficheiro nasce 0600 — é o `fchmod` que o garante', () => {
    const temp = makeTempStateDir()
    // 0377 tira TODOS os bits menos a leitura do dono: sem o `fchmod`, o
    // ficheiro sairia 0400 e a escrita seguinte falharia.
    const anterior = process.umask(0o377)
    try {
      gravarSecretsEnv(bancadaDeEscrita(temp.path), CHAVE_DO_TOKEN, TOKEN_VALIDO)
      assert.equal(statSync(join(temp.path, 'secrets.env')).mode & 0o777, 0o600)
    } finally {
      process.umask(anterior)
      temp.cleanup()
    }
  })

  it('se a escrita falhar, o ficheiro antigo fica INTACTO e não sobra temporário', () => {
    const temp = makeTempStateDir()
    try {
      const caminho = join(temp.path, 'secrets.env')
      writeFileSync(caminho, `${CHAVE_DO_TOKEN}=o-antigo\nOUTRA=fica\n`, { mode: 0o600 })
      // Diretório sem permissão de escrita: o temporário nem chega a nascer.
      chmodSync(temp.path, 0o500)
      let apanhado: unknown
      try {
        gravarSecretsEnv(bancadaDeEscrita(temp.path), CHAVE_DO_TOKEN, 'o-novo')
      } catch (erro) {
        apanhado = erro
      }
      chmodSync(temp.path, 0o700)

      assert.ok(apanhado instanceof ErroDeOnboarding)
      assert.equal(apanhado.code, 'SECRETS_WRITE_FAILED')
      assert.ok(apanhado.message.includes('NÃO foi alterado'))
      // A mensagem crua do `openSync` traria o caminho; o `$HOME` sai fora.
      assert.ok(!/\/(?:home|Users)\//u.test(apanhado.message), apanhado.message)

      assert.equal(readFileSync(caminho, 'utf8'), `${CHAVE_DO_TOKEN}=o-antigo\nOUTRA=fica\n`)
      const sobras = readdirSync(temp.path).filter((n) => n.startsWith('.secrets.env.tmp-'))
      assert.deepEqual(sobras, [], `sobraram temporários: ${sobras.join(', ')}`)
    } finally {
      temp.cleanup()
    }
  })

  it('grava mesmo, e o resultado é atómico por `rename` (não por truncar)', () => {
    const temp = makeTempStateDir()
    try {
      const caminho = join(temp.path, 'secrets.env')
      writeFileSync(caminho, '# cabeçalho\nOUTRA=fica\n', { mode: 0o600 })
      const inodeAntes = statSync(caminho).ino
      gravarSecretsEnv(bancadaDeEscrita(temp.path), CHAVE_DO_TOKEN, TOKEN_VALIDO)
      const depois = readFileSync(caminho, 'utf8')
      assert.ok(depois.includes('# cabeçalho'))
      assert.ok(depois.includes(`${CHAVE_DO_TOKEN}=${TOKEN_VALIDO}`))
      // Inode NOVO: o ficheiro foi SUBSTITUÍDO, não reescrito por cima. Um
      // `writeFileSync` no lugar disto mantinha o inode.
      assert.notEqual(statSync(caminho).ino, inodeAntes)
      assert.deepEqual(
        readdirSync(temp.path).filter((n) => n.startsWith('.secrets.env.tmp-')),
        [],
      )
    } finally {
      temp.cleanup()
    }
  })

  it('as bandeiras que nenhum comportamento observa estão no código, e nomeadas', () => {
    // `O_EXCL`, `O_NOFOLLOW` e `fsync` não têm efeito observável barato: um
    // temporário com nome aleatório nunca colide, e o `fsync` só se mede
    // cortando a energia. A alternativa a NÃO os prender é prendê-los aqui.
    const fonte = readFileSync(CLI, 'utf8')
    const corpo = /export function gravarSecretsEnv[\s\S]*?\n\}\n/u.exec(fonte)?.[0] ?? ''
    assert.ok(corpo.length > 0, 'não encontrei o corpo de gravarSecretsEnv')
    for (const bandeira of ['O_EXCL', 'O_NOFOLLOW', 'fsyncSync', 'fchmodSync', 'renameSync']) {
      assert.ok(corpo.includes(bandeira), `${bandeira} desapareceu da escrita atómica`)
    }
    assert.ok(!corpo.includes('writeFileSync'), 'a escrita voltou a ser não-atómica')

    const onboarding = readFileSync(
      join(import.meta.dirname, '../../../src/telegram/onboarding.ts'),
      'utf8',
    )
    const leitura = /export function lerSecretsEnv[\s\S]*?\n\}\n/u.exec(onboarding)?.[0] ?? ''
    assert.ok(leitura.includes('O_NOFOLLOW'), 'a LEITURA deixou de recusar symlink')
    assert.ok(leitura.includes('fstatSync'), 'o modo voltou a ser lido pelo caminho, não pelo fd')
  })
})

describe('o relato de erro não publica o $HOME nem a `stack`', () => {
  it('um erro cru de terceiros sai mascarado e sem pilha', () => {
    const linhas: string[] = []
    const erro = new Error("EACCES: permission denied, open '/home/ana/.dsh/guarded-bot/secrets.env'")
    relatarErro(erro, (texto: string): void => void linhas.push(texto))
    const saida = linhas.join('')
    assert.ok(!saida.includes('/home/ana'), saida)
    assert.ok(saida.includes('/.dsh/guarded-bot/secrets.env'), 'o resto do caminho tem de ficar')
    assert.ok(!saida.includes('    at '), 'a stack nunca sai')
  })

  it('um erro nosso perde o prefixo técnico e ganha o código numa linha à parte', () => {
    const linhas: string[] = []
    relatarErro(new ErroDeOnboarding('SETUP_UNKNOWN_ARGUMENT', 'não conheço a opção --xpto.'), (t) =>
      void linhas.push(t),
    )
    const saida = linhas.join('')
    assert.ok(saida.startsWith('não conheço'), saida)
    assert.ok(saida.includes('código: SETUP_UNKNOWN_ARGUMENT'))
    assert.ok(!saida.includes('[dsh-guarded-bot-orchestrator]'), 'o prefixo é ruído para quem lê')
  })
})
