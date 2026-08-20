/**
 * =============================================================================
 * Onboarding do Telegram: DETECTOR de estado + o texto que a pessoa le.
 * =============================================================================
 *
 * DONO: T4.1. Duas entregas num ficheiro, e elas nao se separam:
 *
 *   1. um DETECTOR PURO — recebe um retrato do ambiente e devolve o proximo
 *      passo. Zero I/O na funcao de decisao;
 *   2. o TEXTO — `TG-070` diz, com todas as letras, que o que a pessoa ve em
 *      cada um dos quatro estados e artefacto revisavel, nao improviso de quem
 *      implementa. Por isso ele vive aqui, em constantes, e nao espalhado por
 *      `console.log` dentro do CLI, onde ninguem o reve e qualquer refactor o
 *      troca por uma mensagem tecnica sem que nenhum teste caia.
 *
 * -----------------------------------------------------------------------------
 * E UMA SUB-MAQUINA DE ESTADOS, NAO UM README (`01-ARQUITETURA.md` 9.5)
 * -----------------------------------------------------------------------------
 *     SEM_TOKEN -> TOKEN_INVALIDO -> TOKEN_OK_SEM_DONO -> PRONTO
 *
 * A propriedade que interessa e "guiar SO O PASSO EM FALTA": correr a
 * ferramenta com o token ja configurado tem de SALTAR o passo do BotFather.
 * Um tutorial linear que reimprime tudo a cada execucao nao e onboarding, e um
 * ficheiro de texto com um `cat` a frente. A prova disso e testavel e esta
 * testada: o texto de `TOKEN_OK_SEM_DONO` e o de `PRONTO` nao contem `/newbot`.
 *
 * -----------------------------------------------------------------------------
 * REGRAS DO TEXTO, e cada uma tem uma razao operacional
 * -----------------------------------------------------------------------------
 *   - PORTUGUES, sem jargao. O publico e quem acabou de instalar o harness.
 *   - SEM STACK TRACE e SEM NOME DE SIMBOLO INTERNO. Um `TypeError: Cannot read
 *     properties of undefined` no ecra nao diz a ninguem o que fazer a seguir.
 *   - SEM CAMINHO ABSOLUTO QUE IDENTIFIQUE O UTILIZADOR. Este texto e copiado
 *     para issues e colado em chats; `/home/<nome>/...` leva o nome da conta
 *     junto. Ver {@link caminhoApresentavel}: o `~` ja e a forma anonima do
 *     mesmo caminho e continua a dizer QUAL o ficheiro.
 *   - SEM SEGREDO. O token nunca aparece no texto — nem truncado. O codigo de
 *     pareamento aparece EXATAMENTE num sitio (o texto de `TOKEN_OK_SEM_DONO`,
 *     que so o terminal imprime), e a funcao que o compoe exige-o como
 *     parametro explicito, para que nenhum outro chamador o obtenha por acaso.
 */

import { constants, fstatSync, closeSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

import { PLUGIN_NAME } from '../errors.ts'
import { redact } from '../logging/redact.ts'
import { EXPOSURE_MASK, STATE_FILE_MODE, type StatePaths } from '../state/paths.ts'
import type { DonoPareado } from './pairing.ts'
// O TEXTO (registo de T4.1) foi extraido para `./texts.ts` pela costura da
// Onda 5 (item 6). Este ficheiro fica com o detector; re-exporta o que moveu
// para o CLI (`bin/`) e para os testes continuarem a encontrar a MESMA origem.
import {
  COMANDO_CLI,
  textoSemDono,
  textoSemToken,
  textoPronto,
  textoTokenInvalido,
  TITULO_PRONTO,
  TITULO_SEM_DONO,
  TITULO_SEM_TOKEN,
  TITULO_TOKEN_INVALIDO,
  type OpcoesDePasso,
} from './texts.ts'

export {
  AVISOS_ANTES_DO_TUNEL,
  COMANDO_CLI,
  textoSemDono,
  textoSemToken,
  textoPronto,
  textoTokenInvalido,
  TITULO_PRONTO,
  TITULO_SEM_DONO,
  TITULO_SEM_TOKEN,
  TITULO_TOKEN_INVALIDO,
  type OpcoesDePasso,
} from './texts.ts'

/* ========================================================================== */
/* Erro tipado                                                                */
/* ========================================================================== */

export type OnboardingErrorCode =
  /** O token veio na linha de comando. Recusado: `argv` e publico (TG-069). */
  | 'SETUP_TOKEN_IN_ARGV'
  /** Argumento que a ferramenta nao conhece. */
  | 'SETUP_UNKNOWN_ARGUMENT'
  /** O `secrets.env` esta legivel por outras contas desta maquina. */
  | 'SECRETS_MODE_TOO_OPEN'
  /** Nao foi possivel ler o `secrets.env` que existe. */
  | 'SECRETS_READ_FAILED'
  /** Nao foi possivel gravar o `secrets.env`. O ficheiro antigo ficou intacto. */
  | 'SECRETS_WRITE_FAILED'
  /** Nome de variavel invalido para um ficheiro de ambiente. */
  | 'SECRETS_KEY_INVALID'

export class OnboardingError extends Error {
  override readonly name = 'OnboardingError'
  readonly code: OnboardingErrorCode

  // Campo a mao: strip-only mode recusa parameter properties.
  constructor(code: OnboardingErrorCode, detail: string) {
    super(`[${PLUGIN_NAME}] ${code}: ${detail}`)
    this.code = code
  }
}

/* ========================================================================== */
/* O token: forma, antes de qualquer byte na rede                             */
/* ========================================================================== */

/** Nome da variavel, no `secrets.env` e no ambiente (`02-SEGURANCA.md` 8.1). */
export const CHAVE_DO_TOKEN = 'TELEGRAM_BOT_TOKEN'

/**
 * Teto de comprimento do token.
 *
 * Um token real tem ~46 caracteres (`<id de 8 a 10 digitos>:<35 caracteres>`).
 * 80 e folga generosa; acima disso o que se colou nao foi um token — foi uma
 * linha inteira, um URL, ou dois tokens colados. Recusar por comprimento ANTES
 * da rede evita mandar para o Telegram o que quer que a pessoa tenha colado.
 */
export const COMPRIMENTO_MAXIMO_DO_TOKEN = 80

export type MotivoDeFormato =
  | 'vazio'
  | 'sem-dois-pontos'
  | 'id-comeca-por-zero'
  | 'id-nao-numerico'
  | 'segredo-curto'
  | 'caracteres-invalidos'
  | 'comprimento-excessivo'

export type FormatoDoToken =
  | { readonly valido: true; readonly botId: number }
  | { readonly valido: false; readonly motivo: MotivoDeFormato }

/**
 * A parte antes dos dois pontos e o `bot_user_id`; a parte depois e o segredo.
 *
 * `\d{5,12}` sem zero a abrir: um id de utilizador do Telegram nunca comeca por
 * `0` (nao ha zero a esquerda em ids), logo `0123:...` e um token mal copiado ou
 * inventado. O segredo e `[A-Za-z0-9_-]`, que e o alfabeto observado e o mesmo
 * que `src/logging/redact.ts` usa para o mascarar.
 */
const FORMA_DO_TOKEN = /^([1-9]\d{4,11}):([A-Za-z0-9_-]{20,})$/u

/**
 * TG-061 — ERRO DE FORMATO ANTES DE QUALQUER CHAMADA DE REDE.
 *
 * Nao e so economia de latencia. Um token malformado enviado a API do Telegram
 * cai FORA da rota (`/bot<lixo>/getMe`) e devolve `404 Not Found` sem
 * `description` util — medido em `docs/spikes/telegram.md` 2.1. Ou seja: a rede
 * responde PIOR do que nos. E o que a pessoa colou (que pode ser qualquer coisa
 * que estivesse na area de transferencia) viaja para um terceiro sem precisar.
 */
export function validarFormatoDoToken(bruto: string): FormatoDoToken {
  const token = bruto.trim()
  if (token.length === 0) return { valido: false, motivo: 'vazio' }
  if (token.length > COMPRIMENTO_MAXIMO_DO_TOKEN) {
    return { valido: false, motivo: 'comprimento-excessivo' }
  }
  if (!token.includes(':')) return { valido: false, motivo: 'sem-dois-pontos' }

  const casamento = FORMA_DO_TOKEN.exec(token)
  if (casamento === null) return { valido: false, motivo: motivoDetalhado(token) }

  // O grupo 1 e `\d{5,12}` e cabe folgadamente num `number` seguro.
  return { valido: true, botId: Number(casamento[1]) }
}

/** Distingue as varias formas de "nao casou", para o texto poder ser especifico. */
function motivoDetalhado(token: string): MotivoDeFormato {
  const corte = token.indexOf(':')
  const id = token.slice(0, corte)
  const segredo = token.slice(corte + 1)
  if (id.startsWith('0')) return 'id-comeca-por-zero'
  if (!/^\d+$/u.test(id)) return 'id-nao-numerico'
  if (!/^[A-Za-z0-9_-]*$/u.test(segredo)) return 'caracteres-invalidos'
  return 'segredo-curto'
}

/* ========================================================================== */
/* `getMe`: a resposta, classificada                                          */
/* ========================================================================== */

/** O que interessa do `User` devolvido por `getMe` (`#getme`). */
export interface IdentidadeDoBot {
  readonly id: number
  readonly username: string
}

/** Porque o `getMe` nao confirmou o token. Cada causa tem um texto proprio. */
export type CausaDeFalha =
  /** `401 Unauthorized: invalid token specified` — revogado ou errado. */
  | 'recusado'
  /** `404 Not Found` — o token nem chega a formar uma rota valida. */
  | 'rota-inexistente'
  /** `409 Conflict` — ja ha outra ligacao a usar este bot. */
  | 'conflito'
  /** `429` com `retry_after`. */
  | 'limite-de-taxa'
  /** Nao houve resposta: DNS, proxy, cabo. */
  | 'rede'
  /** Houve resposta e nao se percebeu — HTTP inesperado ou corpo nao-JSON. */
  | 'resposta-ininteligivel'

export interface FalhaDoGetMe {
  readonly causa: CausaDeFalha
  /** `0` quando nao houve resposta HTTP nenhuma. */
  readonly httpStatus: number
  readonly errorCode?: number | undefined
  /** `description` da API. NAO e apresentada em cru: ver {@link diagnostico}. */
  readonly description?: string | undefined
  /** Segundos pedidos por um `429` (`ResponseParameters.retry_after`). */
  readonly retryAfter?: number | undefined
}

export type RespostaGetMe =
  | { readonly ok: true; readonly bot: IdentidadeDoBot }
  | { readonly ok: false; readonly falha: FalhaDoGetMe }

/**
 * Classifica um par (HTTP, corpo) da Bot API.
 *
 * Os valores vem MEDIDOS, nao presumidos (`docs/spikes/telegram.md` 2.1 e 6):
 *   - `401 {"ok":false,"error_code":401,"description":"Unauthorized: invalid
 *     token specified"}` — token bem formado sem conta por tras;
 *   - `404 {"ok":false,"error_code":404,"description":"Not Found"}` — token sem
 *     `:`, que cai fora da rota `/bot<token>/<metodo>`;
 *   - `409 Conflict: terminated by other getUpdates request...` — ha outra
 *     instancia a fazer long polling com o MESMO token.
 */
export function classificarFalha(httpStatus: number, corpo: unknown): FalhaDoGetMe {
  const errorCode = numeroDe(corpo, 'error_code')
  const description = textoDe(corpo, 'description')
  const retryAfter = numeroDe(propriedade(corpo, 'parameters'), 'retry_after')
  const codigo = errorCode ?? httpStatus

  const causa: CausaDeFalha =
    codigo === 401
      ? 'recusado'
      : codigo === 404
        ? 'rota-inexistente'
        : codigo === 409
          ? 'conflito'
          : codigo === 429
            ? 'limite-de-taxa'
            : 'resposta-ininteligivel'

  return {
    causa,
    httpStatus,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(description === undefined ? {} : { description }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  }
}

/** Le um `User` de `{"ok":true,"result":{...}}`, sem confiar na forma. */
export function lerIdentidade(corpo: unknown): IdentidadeDoBot | undefined {
  const result = propriedade(corpo, 'result')
  const id = numeroDe(result, 'id')
  const username = textoDe(result, 'username')
  if (id === undefined || username === undefined) return undefined
  return { id, username }
}

function propriedade(valor: unknown, chave: string): unknown {
  if (typeof valor !== 'object' || valor === null) return undefined
  return (valor as Record<string, unknown>)[chave]
}

function numeroDe(valor: unknown, chave: string): number | undefined {
  const bruto = propriedade(valor, chave)
  return typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : undefined
}

function textoDe(valor: unknown, chave: string): string | undefined {
  const bruto = propriedade(valor, chave)
  return typeof bruto === 'string' && bruto.length > 0 ? bruto : undefined
}

/* ========================================================================== */
/* O detector                                                                 */
/* ========================================================================== */

export type EstadoOnboarding = 'SEM_TOKEN' | 'TOKEN_INVALIDO' | 'TOKEN_OK_SEM_DONO' | 'PRONTO'

/** De onde veio o token — muda a instrucao de como o corrigir. */
export type OrigemDoToken = 'secrets.env' | 'ambiente'

export interface TokenConfigurado {
  readonly origem: OrigemDoToken
  readonly formato: FormatoDoToken
}

/**
 * O RETRATO DO AMBIENTE: tudo o que o detector precisa de saber, ja recolhido.
 *
 * Este e o ponto em que o I/O acaba. Quem recolhe (o CLI, ou o painel de T5.3)
 * faz as chamadas; quem decide nao faz nenhuma. E por isso que os quatro
 * estados sao testaveis sem rede, sem disco e sem relogio real.
 */
export interface RetratoDoAmbiente {
  /** `undefined` = nao ha token nenhum configurado. */
  readonly token: TokenConfigurado | undefined
  /** `undefined` = ninguem chamou `getMe` nesta execucao. */
  readonly getMe: RespostaGetMe | undefined
  /** `pairing` do `state.json`. `undefined` = pareamento por fazer. */
  readonly dono: DonoPareado | undefined
}

/**
 * A funcao de decisao. PURA: nao le disco, nao fala com a rede, nao ve relogio.
 *
 * A ordem das guardas e a maquina de estados de `01-ARQUITETURA.md` 9.5, e
 * duas delas merecem justificacao:
 *
 *   - FORMATO ANTES DE `getMe`: um token malformado nunca chega a ser enviado
 *     (TG-061), logo `getMe` vem `undefined` e nao ha ambiguidade.
 *   - `getMe` POR CONFIRMAR CONTA COMO NAO CONFIRMADO. Um token que ninguem
 *     validou nao e um token bom; supo-lo bom levaria a ferramenta a pedir o
 *     codigo de pareamento e a ficar a espera de um `/parear` que nunca chega,
 *     porque o bot nem sequer existe. Falha-se para o lado que diz a verdade.
 */
export function detectarEstado(retrato: RetratoDoAmbiente): EstadoOnboarding {
  if (retrato.token === undefined) return 'SEM_TOKEN'
  if (!retrato.token.formato.valido) return 'TOKEN_INVALIDO'
  if (retrato.getMe === undefined || !retrato.getMe.ok) return 'TOKEN_INVALIDO'
  if (retrato.dono === undefined) return 'TOKEN_OK_SEM_DONO'
  return 'PRONTO'
}


/**
 * O passo que a pessoa ve. `titulo` e uma linha; `texto` e o corpo.
 *
 * `estado` sai junto porque o painel (T5.3) precisa de o REPRESENTAR (icone,
 * cor), nao de o mostrar: o nome do estado e simbolo interno e nao entra no
 * texto — TG-070 assere-o.
 */
export interface PassoDeOnboarding {
  readonly estado: EstadoOnboarding
  readonly titulo: string
  readonly texto: string
}


/**
 * A FUNCAO DE DECISAO COMPLETA: retrato -> proximo passo, com o texto.
 *
 * Repare no que ela NAO faz: nao imprime, nao le, nao espera. Devolve uma
 * string. E por isso que o CLI e o painel podem ser duas superficies do MESMO
 * motor — uma implementacao, duas superficies (`03-ONDAS.md`, aceite de T4.1).
 */
export function proximoPasso(retrato: RetratoDoAmbiente, opcoes: OpcoesDePasso): PassoDeOnboarding {
  const estado = detectarEstado(retrato)
  switch (estado) {
    case 'SEM_TOKEN':
      return { estado, titulo: TITULO_SEM_TOKEN, texto: textoSemToken(opcoes) }
    case 'TOKEN_INVALIDO':
      return { estado, titulo: TITULO_TOKEN_INVALIDO, texto: textoTokenInvalido(retrato) }
    case 'TOKEN_OK_SEM_DONO':
      return {
        estado,
        titulo: TITULO_SEM_DONO,
        texto: textoSemDono(nomeDoBot(retrato), opcoes),
      }
    case 'PRONTO':
      return { estado, titulo: TITULO_PRONTO, texto: textoPronto(nomeDoBot(retrato), opcoes) }
  }
}

/** `@nome` do bot, ou um substituto neutro se o `getMe` nao trouxe username. */
function nomeDoBot(retrato: RetratoDoAmbiente): string {
  const identidade = retrato.getMe?.ok === true ? retrato.getMe.bot : undefined
  return identidade === undefined ? 'o seu bot' : `@${identidade.username}`
}

export type ComandoDoCli = 'guiar' | 'pedir-token' | 'parear' | 'reset-pairing' | 'ajuda'

export interface ArgumentosDoCli {
  readonly comando: ComandoDoCli
  /** `--sim`: confirmacao ja dada, para uso nao interativo deliberado. */
  readonly confirmado: boolean
}

/**
 * Qualquer coisa com forma de token. Deliberadamente FROUXA: aqui um falso
 * positivo custa uma mensagem de recusa, e um falso negativo custa o token no
 * `ps` de toda a maquina.
 */
const PARECE_TOKEN = /\d{4,}:[A-Za-z0-9_-]{8,}/u

/**
 * TG-069 — TOKEN NO `argv` E RECUSADO, COM EXPLICACAO.
 *
 * PORQUE E RECUSA E NAO AVISO: em Linux, `/proc/<pid>/cmdline` e legivel por
 * qualquer processo da maquina, e um `ps aux` de outra conta mostra a linha de
 * comando inteira. O token e a senha de controlo total do bot
 * (`bots/features#botfather`: *"it can be used by anyone to control your bot"*).
 * Aceitar "so desta vez" seria publicar a senha e depois pedir desculpa: no
 * instante em que o processo arranca, o valor ja esta a vista, e nenhum
 * tratamento posterior o desfaz. A linha de comando fica ainda no historico da
 * shell, que e um ficheiro em disco que ninguem se lembra de limpar.
 *
 * A recusa apanha as tres formas: a bandeira `--token`, a bandeira com valor
 * colado (`--token=...`), e um valor SOLTO com forma de token — porque a
 * tentativa mais provavel e `dsh-guard-setup 123456789:AA...`, sem bandeira
 * nenhuma.
 */
export function analisarArgumentos(argv: readonly string[]): ArgumentosDoCli {
  let comando: ComandoDoCli = 'guiar'
  let confirmado = false

  for (const bruto of argv) {
    const argumento = bruto.trim()
    const nome = argumento.split('=', 1)[0] ?? argumento

    if (nome === '--token' || nome === '-t' || PARECE_TOKEN.test(argumento)) {
      throw new OnboardingError(
        'SETUP_TOKEN_IN_ARGV',
        'a chave do bot não pode vir na linha de comando. Tudo o que se escreve ' +
          'na linha de comando fica visível para os outros programas desta máquina ' +
          '(um `ps` mostra-a por inteiro) e fica gravado no histórico da shell. ' +
          `Execute \`${COMANDO_CLI} --pedir-token\`: a chave é pedida no terminal, ` +
          'não aparece no ecrã enquanto a escreve, e é gravada num ficheiro que só ' +
          'a sua conta lê. Se a chave já foi escrita assim alguma vez, peça uma nova ' +
          'ao @BotFather com /token — isso revoga a anterior.',
      )
    }

    switch (nome) {
      case '--pedir-token':
        comando = 'pedir-token'
        break
      case '--parear':
        comando = 'parear'
        break
      case '--reset-pairing':
        comando = 'reset-pairing'
        break
      case '--ajuda':
      case '--help':
      case '-h':
        comando = 'ajuda'
        break
      case '--sim':
      case '--yes':
        confirmado = true
        break
      default:
        throw new OnboardingError(
          'SETUP_UNKNOWN_ARGUMENT',
          `não conheço a opção ${argumento}. Use \`${COMANDO_CLI} --ajuda\` para ver as que existem.`,
        )
    }
  }

  return { comando, confirmado }
}

/* ========================================================================== */
/* `secrets.env`                                                              */
/* ========================================================================== */

/** Vive ao lado do `state.json`, no diretorio de estado 0700 e FORA do git. */
export const NOME_DO_SECRETS_ENV = 'secrets.env'

/** Modo do ficheiro. O MESMO do `state.json`: so o dono le e escreve. */
export const MODO_DO_SECRETS_ENV = STATE_FILE_MODE

/** `A-Z`, `0-9` e `_`, comecando por letra ou `_`. E o que uma shell aceita. */
const CHAVE_DE_AMBIENTE = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Uma linha `CHAVE=valor`, tolerando espacos e um `export` a frente. */
const LINHA_DE_AMBIENTE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u

/**
 * Le um `secrets.env` em memoria. Formato deliberadamente MINIMO.
 *
 * Nao ha expansao de variavel, nao ha continuacao de linha, nao ha
 * interpolacao: este ficheiro guarda segredos, e cada regra de expansao e uma
 * forma nova de o conteudo de uma linha influenciar outra. Aspas simples ou
 * duplas EM VOLTA do valor inteiro sao retiradas, porque e o que toda a gente
 * escreve; o resto e literal.
 */
export function analisarSecretsEnv(texto: string): Map<string, string> {
  const valores = new Map<string, string>()
  for (const linha of texto.split('\n')) {
    if (linha.trim().startsWith('#')) continue
    const casamento = LINHA_DE_AMBIENTE.exec(linha)
    if (casamento === null) continue
    const chave = casamento[1]
    if (chave === undefined) continue
    valores.set(chave, desaspar((casamento[2] ?? '').trim()))
  }
  return valores
}

function desaspar(valor: string): string {
  if (valor.length >= 2) {
    const primeiro = valor[0]
    const ultimo = valor[valor.length - 1]
    if ((primeiro === '"' || primeiro === "'") && primeiro === ultimo) {
      return valor.slice(1, -1)
    }
  }
  return valor
}

/**
 * TG-068 — funde uma chave PRESERVANDO todas as outras linhas.
 *
 * "Preserva as outras linhas" e literal: comentarios, linhas em branco, ordem,
 * espacamento e chaves de outros componentes ficam byte a byte como estavam. A
 * alternativa obvia — ler para um mapa e reescrever o ficheiro a partir do mapa
 * — perderia os comentarios e reordenaria tudo, e o `secrets.env` e partilhado:
 * apagar a linha de outra pessoa e apagar o segredo de outra pessoa.
 *
 * A chave existente e substituida NO LUGAR (nao no fim), para que o ficheiro
 * nao ganhe uma linha a cada execucao e para que o comentario que explica
 * aquela linha continue por cima dela.
 */
export function fundirSecretsEnv(existente: string, chave: string, valor: string): string {
  if (!CHAVE_DE_AMBIENTE.test(chave)) {
    throw new OnboardingError(
      'SECRETS_KEY_INVALID',
      `${JSON.stringify(chave)} não é um nome de variável de ambiente válido.`,
    )
  }

  const nova = `${chave}=${valor}`
  const linhas = existente.split('\n')

  // DE TRAS PARA A FRENTE, e isso e correcao e nao estilo: num ficheiro de
  // ambiente com a mesma chave repetida, quem vale e a ULTIMA (e o que a shell
  // faz com `source`, e o que {@link analisarSecretsEnv} faz com `Map.set`).
  // Reescrever a primeira deixaria a segunda a mandar, e a chave nova nao teria
  // efeito nenhum — uma escrita que parece ter funcionado e nao funcionou.
  for (let i = linhas.length - 1; i >= 0; i -= 1) {
    const linha = linhas[i]
    if (linha === undefined || linha.trim().startsWith('#')) continue
    const casamento = LINHA_DE_AMBIENTE.exec(linha)
    if (casamento?.[1] !== chave) continue
    linhas[i] = nova
    return linhas.join('\n')
  }

  // Acrescenta no fim. So se ACRESCENTA uma quebra quando o ficheiro nao acaba
  // em uma — colapsar as linhas em branco do fim seria mexer no ficheiro alheio
  // para arrumar, e "preserva as outras linhas" nao tem asterisco. Um ficheiro
  // sem `\n` final receberia, sem isto, a chave nova COLADA a ultima linha.
  const corpo = existente.length === 0 || existente.endsWith('\n') ? existente : `${existente}\n`
  return `${corpo}${nova}\n`
}

/** Onde vive o `secrets.env`: ao lado do `state.json`, no mesmo diretorio 0700. */
export function caminhoDoSecretsEnv(paths: StatePaths): string {
  return join(paths.dir, NOME_DO_SECRETS_ENV)
}

/**
 * Le o `secrets.env`, RECUSANDO um ficheiro exposto a outras contas.
 *
 * A verificacao e a mesma de `src/state/store.ts` e pela mesma razao: o modo e
 * lido por `fstat` SOBRE O DESCRITOR de onde se le o conteudo, nunca por um
 * `stat` do caminho antes de abrir — assim nao ha janela entre verificar e
 * usar. `O_NOFOLLOW` faz um `secrets.env` trocado por link simbolico dar
 * `ELOOP` em vez de ser seguido em silencio para o alvo que outra pessoa
 * escolheu.
 *
 * Recusa-se em vez de "corrigir com chmod": um ficheiro com o token que esteve
 * legivel por outras contas e um token que PODE ja ter sido lido, e um chmod
 * nosso apagaria a unica pista de que ele tem de ser rodado no BotFather.
 */
export function lerSecretsEnv(caminho: string): string | undefined {
  let fd: number | undefined
  try {
    fd = openSync(caminho, constants.O_RDONLY | constants.O_NOFOLLOW)
    const estado = fstatSync(fd)
    const modo = estado.mode & 0o777
    if ((modo & EXPOSURE_MASK) !== 0) {
      throw new OnboardingError(
        'SECRETS_MODE_TOO_OPEN',
        `o ficheiro ${NOME_DO_SECRETS_ENV} está legível por outras contas desta máquina ` +
          `(modo 0${modo.toString(8).padStart(3, '0')}, e o exigido é 0600). Ele guarda a chave ` +
          'do bot. Corrija com `chmod 600` e, porque a chave esteve exposta, peça uma nova ' +
          'ao @BotFather com /token: o chmod fecha a porta, não desfaz quem já tenha entrado.',
      )
    }
    return readFileSync(fd, 'utf8')
  } catch (erro) {
    if (erro instanceof OnboardingError) throw erro
    const codigo = (erro as NodeJS.ErrnoException).code
    // A ausencia e legitima: e o primeiro arranque, e o estado e `SEM_TOKEN`.
    if (codigo === 'ENOENT' || codigo === 'ENOTDIR') return undefined
    if (codigo === 'ELOOP') {
      throw new OnboardingError(
        'SECRETS_READ_FAILED',
        `${NOME_DO_SECRETS_ENV} é um link simbólico. Por um link, quem controla o alvo ` +
          'escolhe de onde se lê a chave do bot; recusa-se.',
      )
    }
    throw new OnboardingError(
      'SECRETS_READ_FAILED',
      `não foi possível ler o ficheiro ${NOME_DO_SECRETS_ENV}: ${redact(mensagemDe(erro))}`,
    )
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function mensagemDe(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro)
}

/**
 * De onde sai o token, e por que ordem.
 *
 * `secrets.env` PRIMEIRO, ambiente a seguir: o ficheiro e a decisao deliberada
 * de quem correu o onboarding nesta maquina; a variavel de ambiente e o
 * fallback documentado (`02-SEGURANCA.md` 8.1) e pode vir herdada de um shell
 * qualquer sem ninguem reparar. NUNCA o `.env` do projeto: ele esta DENTRO do
 * workspace que o agente le, e injecao de prompt e premissa operacional deste
 * plano, nao risco residual (`01-ARQUITETURA.md` 9.5).
 */
export function resolverToken(
  caminho: string,
  ambiente: Readonly<Record<string, string | undefined>> = process.env,
): { readonly token: string; readonly origem: OrigemDoToken } | undefined {
  const texto = lerSecretsEnv(caminho)
  const doFicheiro = texto === undefined ? undefined : analisarSecretsEnv(texto).get(CHAVE_DO_TOKEN)
  if (doFicheiro !== undefined && doFicheiro.trim().length > 0) {
    return { token: doFicheiro.trim(), origem: 'secrets.env' }
  }

  const doAmbiente = ambiente[CHAVE_DO_TOKEN]?.trim()
  if (doAmbiente !== undefined && doAmbiente.length > 0) {
    return { token: doAmbiente, origem: 'ambiente' }
  }

  return undefined
}

/* ========================================================================== */
/* Caminho apresentavel                                                       */
/* ========================================================================== */

/**
 * Torna um caminho mostravel sem publicar o nome da conta.
 *
 * `/home/ana/.dsh/guarded-bot/secrets.env` -> `~/.dsh/guarded-bot/secrets.env`.
 * Continua a dizer QUAL o ficheiro, deixa de dizer DE QUEM — e este texto e
 * copiado para issues e colado em conversas. O `~` e a forma anonima do mesmo
 * caminho, e e por isso que `src/logging/redact.ts` nao lhe toca.
 *
 * Fora da casa do utilizador, `redact()` decide: ele mascara `$HOME` e deixa
 * `/opt`, `/etc` e afins em paz, porque essa estrutura e igual em todas as
 * maquinas e e ela que diz onde procurar.
 */
export function caminhoApresentavel(caminho: string, casa: string = homedir()): string {
  if (casa.length > 0 && (caminho === casa || caminho.startsWith(casa + sep))) {
    return `~${caminho.slice(casa.length)}`
  }
  return redact(caminho)
}

/* ========================================================================== */
/* A sonda: o unico I/O de rede deste modulo                                  */
/* ========================================================================== */

/** Raiz da Bot API. SEM barra final. */
export const API_ROOT_PADRAO = 'https://api.telegram.org'

/** Teto de espera de uma chamada. Curto: isto e um CLI, nao um servico. */
export const TIMEOUT_DA_SONDA_MS = 10_000

/**
 * Quantos updates uma sondagem pede. O teto da propria Bot API e 100
 * (`Client.cpp` clampa `limit` a 1-100).
 *
 * E EXPORTADO porque e um LIMITE OBSERVAVEL, nao um detalhe: com `offset: 0` a
 * fila nunca e confirmada, logo uma resposta com exatamente
 * `LIMITE_DE_UPDATES` elementos significa "ha pelo menos mais alguns que nunca
 * veremos". Quem espera pelo `/parear` tem de reconhecer esse caso e dize-lo —
 * ver A2 no cabecalho de `bin/dsh-guard-setup.ts`.
 */
export const LIMITE_DE_UPDATES = 100

export type ResultadoDeUpdates =
  | { readonly ok: true; readonly updates: readonly unknown[] }
  | { readonly ok: false; readonly falha: FalhaDoGetMe }

/**
 * O transporte, injetavel.
 *
 * PORQUE E UMA INTERFACE E NAO UM `fetch` solto: e por aqui que o motor de
 * pareamento deixa de depender de rede nenhuma. Hoje o CLI passa
 * {@link criarSondaHttp}; no dia em que o IPC host<->worker (T4.3) existir, a
 * fonte dos updates passa a ser o WORKER e nada no pareamento muda. Ver o
 * comentario de {@link SondaTelegram.getUpdates} para a razao dura.
 */
export interface SondaTelegram {
  getMe(token: string): Promise<RespostaGetMe>
  /**
   * Le updates SEM OS CONFIRMAR, e sem pendurar long poll.
   *
   * DUAS DECISOES, e as duas vem de medicao (`docs/spikes/telegram.md` 6 e 7):
   *
   *   1. `offset` NUNCA AVANCA. `getUpdates` com um `offset` maior que um
   *      `update_id` CONFIRMA e APAGA esse update no servidor — para sempre,
   *      para toda a gente. Se o onboarding confirmasse, os comandos que o
   *      worker precisava de ver desapareciam antes de ele nascer. Com
   *      `offset: 0` le-se a mesma fila as vezes que forem precisas e nao se
   *      apaga nada: o custo e reler updates ja vistos, que se descartam por
   *      `update_id` aqui dentro, e o beneficio e nao destruir a fila alheia.
   *   2. `timeout: 0` — sondagem curta, nunca long poll. Assim ESTA ferramenta
   *      nunca fica pendurada a espera, e nunca e ELA a vitima de um `409`
   *      quando o worker chegar depois.
   *
   * >>> O QUE ESTA POR CONFIRMAR, e fica escrito como tal <<<
   * Uma versao anterior deste comentario concluia que, por nao pendurar long
   * poll, esta ferramenta nao derrubaria o worker. ISSO NAO SE SEGUE. Pela
   * semantica do servidor oficial (`Client.cpp`, `abort_long_poll`), quem
   * termina o long poll pendente e a CHEGADA de um `getUpdates` novo, nao a
   * duracao dele — e esta ferramenta, chegando depois, e a que chega por
   * ultimo. O efeito de ~150 sondagens curtas ao longo do TTL sobre um worker
   * ja a fazer long polling NAO FOI MEDIDO: medi-lo exige trafego autenticado
   * contra `api.telegram.org`, que este repositorio proibe.
   *
   * O QUE SUSTENTAMOS, e que e o essencial: com `offset: 0` esta ferramenta
   * NUNCA CONFIRMA nada, logo nunca apaga do servidor um update de que o
   * worker precise. Nenhuma mensagem se perde por causa dela.
   *
   * O QUE SE FAZ COM A PARTE POR CONFIRMAR: a saida do CLI DECLARA a
   * pre-condicao ("o harness nao deve estar a correr com este mesmo bot") em
   * vez de a presumir resolvida, e um `409` que apareca e detectado e explicado
   * em portugues. `docs/spikes/telegram.md` 7 aponta a saida definitiva — o
   * update chega pelo IPC do worker (T4.3) — e e para isso que a sonda entra
   * por injecao.
   */
  getUpdates(token: string): Promise<ResultadoDeUpdates>
}

export interface OpcoesDaSonda {
  /** Raiz da API. Os testes apontam-na para um servidor local. SEM barra final. */
  readonly apiRoot?: string | undefined
  /** `fetch` injetavel. Omitido: o global do Node 24. */
  readonly buscar?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

export function criarSondaHttp(opcoes: OpcoesDaSonda = {}): SondaTelegram {
  const apiRoot = (opcoes.apiRoot ?? API_ROOT_PADRAO).replace(/\/+$/u, '')
  const buscar = opcoes.buscar ?? fetch
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_DA_SONDA_MS

  /**
   * Uma chamada a Bot API.
   *
   * O TOKEN VIAJA NO CAMINHO DO URL — e a forma da API (`/bot<token>/<metodo>`)
   * e nao ha alternativa. Por isso NADA do que sai daqui contem o URL: nem a
   * mensagem de erro, nem o `description`. E tambem por isso que
   * `src/logging/redact.ts` existe e tem uma forma para este token.
   */
  const chamar = async (
    token: string,
    metodo: string,
    corpo: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly httpStatus: number; readonly corpo: unknown } | { readonly rede: true }> => {
    try {
      const resposta = await buscar(`${apiRoot}/bot${token}/${metodo}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const texto = await resposta.text()
      let lido: unknown
      try {
        lido = JSON.parse(texto)
      } catch (erroDeJson) {
        // NAO se engole: um corpo nao-JSON e um proxy corporativo a devolver
        // uma pagina de bloqueio, e a pessoa tem de saber que houve resposta.
        void erroDeJson
        lido = undefined
      }
      return { httpStatus: resposta.status, corpo: lido }
    } catch (erroDeRede) {
      // A mensagem de `fetch` traz o URL, e o URL traz o token. Ela e
      // DELIBERADAMENTE descartada: a causa `rede` diz tudo o que a pessoa
      // pode accionar, e nada do que ela pode vazar.
      void erroDeRede
      return { rede: true }
    }
  }

  return {
    async getMe(token: string): Promise<RespostaGetMe> {
      const resposta = await chamar(token, 'getMe', {})
      if ('rede' in resposta) {
        return { ok: false, falha: { causa: 'rede', httpStatus: 0 } }
      }
      const identidade =
        resposta.httpStatus === 200 && propriedade(resposta.corpo, 'ok') === true
          ? lerIdentidade(resposta.corpo)
          : undefined
      if (identidade !== undefined) return { ok: true, bot: identidade }
      return { ok: false, falha: classificarFalha(resposta.httpStatus, resposta.corpo) }
    },

    async getUpdates(token: string): Promise<ResultadoDeUpdates> {
      // `offset: 0` e `timeout: 0`: ver o JSDoc da interface. Estes dois zeros
      // sao a entrega, nao um valor por omissao esquecido.
      const resposta = await chamar(token, 'getUpdates', {
        offset: 0,
        timeout: 0,
        limit: LIMITE_DE_UPDATES,
        allowed_updates: ['message'],
      })
      if ('rede' in resposta) {
        return { ok: false, falha: { causa: 'rede', httpStatus: 0 } }
      }
      const resultado = propriedade(resposta.corpo, 'result')
      if (resposta.httpStatus === 200 && Array.isArray(resultado)) {
        return { ok: true, updates: resultado as readonly unknown[] }
      }
      return { ok: false, falha: classificarFalha(resposta.httpStatus, resposta.corpo) }
    },
  }
}
