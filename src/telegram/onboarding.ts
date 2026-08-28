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

import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

import { PLUGIN_NAME } from '../errors.ts'
import { redact } from '../logging/redact.ts'
import { EXPOSURE_MASK, STATE_FILE_MODE, type StatePaths } from '../state/paths.ts'
import type { DonoPareado } from './pairing.ts'
import type { ProviderId } from '../proc/env.ts'
import type { RespostaGetMe } from '../onboarding/sonda.ts'
// O TEXTO (registo de T4.1) foi extraido para `./texts.ts` pela costura da
// Onda 5 (item 6). Este ficheiro fica com o detector; re-exporta o que moveu
// para o CLI (`bin/`) e para os testes continuarem a encontrar a MESMA origem.
import {
  COMANDO_CLI,
  textoSemDono,
  textoSemToken,
  textoPronto,
  textoTokenInvalido,
  tituloSemToken,
  tituloTokenInvalido,
  TITULO_PRONTO,
  TITULO_SEM_DONO,
  type OpcoesDePasso,
} from './texts.ts'

export {
  AVISOS_ANTES_DO_TUNEL,
  COMANDO_CLI,
  textoSemDono,
  textoSemToken,
  textoPronto,
  textoTokenInvalido,
  tituloSemToken,
  tituloTokenInvalido,
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

/**
 * A forma de um token VALIDO, por provedor.
 *
 * `botId` e OPCIONAL de proposito: e o `bot_user_id` do TELEGRAM (a parte
 * antes dos dois pontos do token). O token do DISCORD nao tem id numerico —
 * a forma discord nao preenche o campo, e nenhum consumidor do retrato usa o
 * `botId` (os textos so leem `valido`/`motivo`).
 */
export type FormatoDoToken =
  | { readonly valido: true; readonly botId?: number | undefined }
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
  // Os TITULOS e o TEXTO sao provider-aware (rotulos: @BotFather no telegram,
  // portal de desenvolvimento no discord) — o provedor vem das opcoes, com o
  // default fechado telegram (D1).
  switch (estado) {
    case 'SEM_TOKEN':
      return { estado, titulo: tituloSemToken(opcoes.provedor), texto: textoSemToken(opcoes) }
    case 'TOKEN_INVALIDO':
      return {
        estado,
        titulo: tituloTokenInvalido(opcoes.provedor),
        texto: textoTokenInvalido(retrato, opcoes),
      }
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

/** O MINIMO que a escrita do `secrets.env` precisa de saber (o HOST + o CLI). */
export interface EscritaDeSegredos {
  readonly paths: StatePaths
  readonly caminhoSecrets: string
}

/**
 * Grava a chave preservando o resto do ficheiro, com modo 0600 (TG-068).
 *
 * A escrita e ATOMICA e pela mesma razao que a do `state.json`: o temporario
 * nasce no MESMO diretorio (`rename(2)` so e atomico dentro do mesmo sistema de
 * ficheiros), leva `fchmod` explicito (o `mode` do `open` passa pelo `umask` do
 * host, que so RETIRA bits) e um `fsync` antes do `rename`, para que a entrada
 * nova nunca aponte para bytes que ainda estao em cache. Um leitor concorrente
 * ve o ficheiro velho inteiro ou o novo inteiro — nunca meio `secrets.env`, que
 * seria um token truncado a arrancar o harness.
 *
 * `O_EXCL | O_NOFOLLOW` no temporario: nome novo a cada escrita, e nenhum link
 * simbolico e seguido.
 *
 * E o DESTINO UNICO da escrita do token em runtime: o CLI (`bin/dsh-guard-setup`)
 * e a rota POST /__guard-ui/api/token chamam EXATAMENTE esta funcao — nao ha
 * um segundo writer do `secrets.env` para a mesma chave.
 *
 * LANCAMENTO de `OnboardingError` quando a gravacao falha; o ficheiro antigo
 * fica intacto (o `rename` so acontece depois de o novo estar completo).
 */
export function gravarSecretsEnv(ctx: EscritaDeSegredos, chave: string, valor: string): void {
  const existente = lerSecretsEnv(ctx.caminhoSecrets) ?? ''
  const conteudo = fundirSecretsEnv(existente, chave, valor)

  const tmp = join(
    ctx.paths.dir,
    `.${NOME_DO_SECRETS_ENV}.tmp-${process.pid.toString(36)}-${randomBytes(6).toString('hex')}`,
  )
  try {
    const fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      MODO_DO_SECRETS_ENV,
    )
    try {
      const bytes = Buffer.from(conteudo, 'utf8')
      let escritos = 0
      // `writeSync` pode escrever menos do que se pediu: o laco e o que impede
      // um `secrets.env` truncado que passaria despercebido.
      while (escritos < bytes.byteLength) {
        escritos += writeSync(fd, bytes, escritos, bytes.byteLength - escritos)
      }
      fchmodSync(fd, MODO_DO_SECRETS_ENV)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, ctx.caminhoSecrets)
  } catch (erro) {
    try {
      unlinkSync(tmp)
    } catch (falhaDaLimpeza) {
      // Nao pode mascarar o erro real que trouxe o fluxo ate aqui; ja nao
      // existir e, alias, o caso normal (o `rename` consumiu o temporario).
      void falhaDaLimpeza
    }
    // As recusas tipadas ja tem codigo e mensagem acionavel: passam intactas.
    if (erro instanceof OnboardingError) throw erro
    // Um `EACCES` cru do `openSync` traz o caminho do temporario — que, em
    // producao, vive debaixo do `$HOME`. `redact()` tira a casa do utilizador
    // e deixa o resto do caminho, que e o que diz onde procurar.
    throw new OnboardingError(
      'SECRETS_WRITE_FAILED',
      `não foi possível gravar o ficheiro ${NOME_DO_SECRETS_ENV}: ` +
        `${redact(erro instanceof Error ? erro.message : String(erro))}. ` +
        'O ficheiro antigo NÃO foi alterado — a substituição só acontece depois ' +
        'de o novo estar inteiro e gravado no disco.',
    )
  }
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
 *
 * A `chave` e o NOME da variavel a ler nas DUAS fontes — a CHAVE do provedor
 * ativo (`PROVIDER_ENV[provider].tokenVar`): `TELEGRAM_BOT_TOKEN` por omissao,
 * `DISCORD_BOT_TOKEN` para o discord. O default e o telegram para que quem
 * chama sem provedor continue a correr exatamente como antes (D1).
 */
export function resolverToken(
  caminho: string,
  ambiente: Readonly<Record<string, string | undefined>> = process.env,
  chave: string = CHAVE_DO_TOKEN,
): { readonly token: string; readonly origem: OrigemDoToken } | undefined {
  const texto = lerSecretsEnv(caminho)
  const doFicheiro = texto === undefined ? undefined : analisarSecretsEnv(texto).get(chave)
  if (doFicheiro !== undefined && doFicheiro.trim().length > 0) {
    return { token: doFicheiro.trim(), origem: 'secrets.env' }
  }

  const doAmbiente = ambiente[chave]?.trim()
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
/* ========================================================================== */
/* A SONDA (portada para `src/onboarding/sonda.ts` — a camada provider-aware)  */
/* ========================================================================== */

// O TRANSPORTE de rede (`criarSondaHttp`, `SondaTelegram`, a classificacao de
// falha e a sonda comum por provedor) foi portado para
// `src/onboarding/sonda.ts`, onde vive ao lado da sonda discord — o probe
// comum `criarSonda(provider, ...)` e a superficie provider-aware que o
// painel de T5.3 consome. Este ficheiro re-exporta o que moveu para o CLI
// (`bin/`), o `src/index.ts` e os testes continuarem a encontrar a MESMA
// origem — o mesmo padrao da extracao de `texts.ts`. NAO se duplica a logica
// do getMe: quem a quer importa de la (ou daqui, pelo re-export).
export {
  API_ROOT_PADRAO,
  classificarFalha,
  criarSondaHttp,
  lerIdentidade,
  LIMITE_DE_UPDATES,
  TIMEOUT_DA_SONDA_MS,
  type CausaDeFalha,
  type FalhaDoGetMe,
  type IdentidadeDoBot,
  type OpcoesDaSonda,
  type RespostaGetMe,
  type ResultadoDeUpdates,
  type SondaTelegram,
} from '../onboarding/sonda.ts'

/* ========================================================================== */
/* A forma do token, por provedor                                             */
/* ========================================================================== */

/**
 * `true` se `texto` tem um espaco (`\s`, incluindo espacos unicode) ou um
 * caracter de controlo (U+0000 a U+001F). Checagem SEM regex de controlo
 * (`no-control-regex` do lint): a faixa de controlo sai por `charCodeAt`,
 * o espaco pelo meta-caracter `\s` — a mesma semantica da checagem
 * original (espacos OU controlo).
 */
function temEspacoOuControlo(texto: string): boolean {
  if (/\s/u.test(texto)) return true
  for (let i = 0; i < texto.length; i += 1) {
    if (texto.charCodeAt(i) < 0x20) return true
  }
  return false
}

/**
 * A forma minimamente exigida a um token do DISCORD pelo HOST.
 *
 * DELIBERADAMENTE FROUXA, e por duas razoes:
 *
 *   1. o juiz real de um token e a API (`GET /users/@me`), nunca uma regex —
 *      o mesmo principio do telegram, onde "o unico juiz de um token e o
 *      `getMe`" (`worker/providers/telegram/token.ts`);
 *   2. a gramatica do token discord (base64 do "Bot <id>:<segredo>", com
 *      pontos e ate ~75 caracteres) e do ADAPTADOR — `worker/providers/
 *      discord/token.ts` da Onda 3 — e nao se inventa aqui.
 *
 * O que esta checagem faz e impedir TG-061 de novo, por canal: recusar ANTES
 * da rede o que obviamente nao e um token — vazio, longo demais, ou com
 * espacos/controlo (uma linha inteira colada, ou um URL). Devolve a MESMA
 * {@link FormatoDoToken} do telegram (sem `botId`), para o retrato do
 * onboarding e os seus textos consumirem os dois provedores por igual.
 */

export function validarFormatoDoTokenDoDiscord(bruto: string): FormatoDoToken {
  const token = bruto.trim()
  if (token.length === 0) return { valido: false, motivo: 'vazio' }
  if (token.length > COMPRIMENTO_MAXIMO_DO_TOKEN) {
    return { valido: false, motivo: 'comprimento-excessivo' }
  }
  // Espacos ou controlo: o que se colou foi uma linha inteira, um URL, ou
  // lixo da area de transferencia — recusa-se antes da rede (TG-061).
  if (temEspacoOuControlo(token)) return { valido: false, motivo: 'caracteres-invalidos' }
  // Valido SEM `botId`: o token do discord nao tem id numerico (ver
  // {@link FormatoDoToken}).
  return { valido: true }
}

/**
 * A checagem de formato do PROVEDOR ATIVO (a porta usada pelo painel).
 *
 * Telegram: a forma estrita `\d{5,12}:[A-Za-z0-9_-]{20,}` (TG-061). Discord:
 * a forma frouxa de {@link validarFormatoDoTokenDoDiscord}. Um provedor novo
 * acrescenta o ramo aqui, nao nos chamadores.
 */
export function validarFormatoDe(provedor: ProviderId, bruto: string): boolean {
  if (provedor === 'discord') return validarFormatoDoTokenDoDiscord(bruto).valido
  return validarFormatoDoToken(bruto).valido
}
