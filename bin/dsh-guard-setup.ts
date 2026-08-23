#!/usr/bin/env node
/**
 * =============================================================================
 * `dsh-guard-setup` — a superficie de terminal do onboarding.
 * =============================================================================
 *
 * DONO: T4.1.
 *
 * ESTE FICHEIRO E CASCA. Toda a decisao vive em `src/telegram/onboarding.ts`
 * (detector + texto) e `src/telegram/pairing.ts` (codigo de pareamento), que
 * sao puros e testados. Aqui so ha I/O: ler argumentos, ler o disco, escrever
 * no ecra, esperar. A razao nao e estetica — o painel local de T5.3 tem de
 * mostrar EXATAMENTE o mesmo passo que este terminal mostra, e isso so e
 * possivel se o passo nao for calculado dentro de um `console.log`.
 *
 * -----------------------------------------------------------------------------
 * O QUE ESTA FERRAMENTA NUNCA FAZ
 * -----------------------------------------------------------------------------
 *   - NAO aceita a chave do bot na linha de comando (TG-069). Ver
 *     `analisarArgumentos`: `argv` e legivel por toda a maquina.
 *   - NAO manda o codigo de pareamento por Telegram, nao o escreve em log e nao
 *     o devolve por HTTP (PAIR-010). Ele sai por `stdout` e mais nada.
 *   - NAO confirma updates no servidor do Telegram. O `offset` nunca avanca, e
 *     por isso o onboarding nao consome updates de que o worker precisaria.
 *   - NAO escreve nada na execucao por omissao quando ja esta tudo configurado
 *     (TG-067): correr duas vezes nao gera codigo novo, nao regenera segredo e
 *     nao reabre o pareamento.
 *
 * -----------------------------------------------------------------------------
 * CODIGOS DE SAIDA (para quem chamar isto de um script)
 * -----------------------------------------------------------------------------
 *   0  tudo pronto, ou a accao pedida foi concluida
 *   1  falha de execucao (disco, rede, permissao)
 *   2  uso incorrecto (argumento desconhecido, chave no `argv`, ou uma
 *      pergunta obrigatoria sem ninguem do outro lado para a responder)
 *   3  falta um passo — o texto do passo foi impresso
 */

import { once } from 'node:events'
import { createInterface } from 'node:readline/promises'
import { setTimeout as esperar } from 'node:timers/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AUDIT_FILE_NAME, openAuditLog } from '../src/audit/log.ts'
import { redact } from '../src/logging/redact.ts'
import {
  AVISOS_ANTES_DO_TUNEL,
  CHAVE_DO_TOKEN,
  COMANDO_CLI,
  LIMITE_DE_UPDATES,
  OnboardingError,
  analisarArgumentos,
  caminhoApresentavel,
  caminhoDoSecretsEnv,
  criarSondaHttp,
  gravarSecretsEnv,
  proximoPasso,
  resolverToken,
  validarFormatoDoToken,
  type EscritaDeSegredos,
  type RespostaGetMe,
  type RetratoDoAmbiente,
  type SondaTelegram,
  type TokenConfigurado,
} from '../src/telegram/onboarding.ts'
import {
  PairingError,
  TTL_DO_CODIGO_MS,
  criarSessaoDePareamento,
  type SessaoDePareamento,
} from '../src/telegram/pairing.ts'
import { createSecretStore } from '../src/secret/store.ts'
import { ensureStateDir, resolveStatePaths, type StatePaths } from '../src/state/paths.ts'
import { createStateStore } from '../src/state/store.ts'
import type { StateStore } from '../src/contracts/state.ts'

/** Intervalo entre sondagens curtas a espera do `/parear`. */
const INTERVALO_DE_SONDAGEM_MS = 2_000

/** A palavra que o operador tem de escrever para reabrir o pareamento. */
const PALAVRA_DE_CONFIRMACAO = 'reparear'

/**
 * Quantos codigos NOVOS uma so execucao pode gerar depois do primeiro.
 *
 * PORQUE HA TETO: sem ele, `--sim` renovava a janela indefinidamente — o que
 * contradizia, seis linhas abaixo, o comentario que diz que uma janela que se
 * renova sozinha e uma janela permanente com outro nome. Medido antes da
 * correccao: 31 codigos gerados e queimados numa so invocacao. Quatro janelas
 * de 5 minutos sao 20 minutos de tentativa, que chegam para ir buscar o
 * telemovel; depois disso, quem esta ao teclado decide de novo.
 */
const RENOVACOES_MAXIMAS = 3

/**
 * As dependencias que entram por fora.
 *
 * NAO SAO COSTURA DE TESTE, e a distincao importa. A `sonda` e o ponto em que
 * este comando deixa de depender de rede: hoje ele le os updates por HTTP,
 * porque nao ha alternativa; no dia em que o IPC host<->worker (T4.3) existir,
 * a fonte passa a ser o WORKER — que e a saida (a) que `docs/spikes/telegram.md`
 * 7 recomenda, e a unica que nunca disputa a fila com o polling. Trocar o
 * transporte nao pode obrigar a reescrever o pareamento, e por isso ele entra
 * por aqui. As saidas e o relogio acompanham pela mesma razao: o painel local
 * de T5.3 e a MESMA maquina com outra superficie.
 */
export interface DependenciasDoSetup {
  readonly sonda?: SondaTelegram | undefined
  readonly escrever?: ((texto: string) => void) | undefined
  readonly avisar?: ((texto: string) => void) | undefined
  readonly agora?: (() => number) | undefined
  readonly intervaloMs?: number | undefined
  /** Raiz do estado ja resolvida. Omitido: a canonica do ambiente. */
  readonly paths?: StatePaths | undefined
  /** Pergunta VISIVEL (confirmacoes). Omitido: uma linha do terminal. */
  readonly perguntar?: ((rotulo: string) => Promise<string | undefined>) | undefined
  /**
   * Pergunta OCULTA (a chave do bot). Omitido: uma linha do terminal sem eco.
   *
   * Separada da anterior de proposito: perguntar um segredo e perguntar uma
   * confirmacao sao operacoes com regras diferentes (uma nunca aparece no ecra,
   * a outra tem de aparecer), e um so ponto de entrada acabaria por ecoar uma
   * das duas pelo lado errado.
   */
  readonly pedirSegredo?: ((rotulo: string) => Promise<string | undefined>) | undefined
}

/**
 * Imprime um erro SEM stack trace e SEM nome de simbolo colado a prosa.
 *
 * O `code` sai numa linha propria, no fim: ele e para quem abre uma issue, nao
 * para quem esta a tentar ligar um bot. A `stack` nunca sai — ela nomeia
 * ficheiros internos e caminhos absolutos desta maquina.
 */
export function relatarErro(
  erro: unknown,
  // Injetavel para ser exercivel: uma mutacao que tire o `redact` daqui tem de
  // ficar vermelha, e nao ha forma barata de provocar, de fora, um erro cru
  // cuja mensagem contenha o `$HOME`.
  escreverErro: (texto: string) => void = (texto: string): void => void process.stderr.write(texto),
): void {
  if (erro instanceof OnboardingError || erro instanceof PairingError) {
    const semPrefixo = erro.message.replace(/^\[[^\]]+\]\s*[A-Z_]+:\s*/u, '')
    escreverErro(`${redact(semPrefixo)}\n\ncódigo: ${erro.code}\n`)
    return
  }
  if (erro instanceof Error) {
    // Erros de terceiros (`StateError`, `AuditOpenError`, `ErrnoException`) ja
    // trazem mensagem acionavel neste repositorio. O que se corta e a `stack`;
    // o `redact` tira a casa do utilizador de qualquer caminho que venha na
    // mensagem, porque este texto e colado em issues.
    escreverErro(`${redact(erro.message)}\n`)
    return
  }
  escreverErro(`${redact(String(erro))}\n`)
}

/* ========================================================================== */
/* Recolha do retrato — o unico sitio onde ha I/O antes da decisao            */
/* ========================================================================== */

/**
 * `EscritaDeSegredos` e `gravarSecretsEnv` vivem em
 * `src/telegram/onboarding.ts` (o destinho UNICO da escrita do `secrets.env`,
 * partilhado com a rota POST /__guard-ui/api/token). O CLI re-exporta-os: nao
 * ha um segundo writer do ficheiro de segredos para a mesma chave, a sequencia
 * atomica (temporario O_EXCL|NOFOLLOW + fchmod 0600 + fsync + rename) e UMA.
 */
export type { EscritaDeSegredos } from '../src/telegram/onboarding.ts'
export { gravarSecretsEnv } from '../src/telegram/onboarding.ts'

interface Contexto extends EscritaDeSegredos {
  readonly store: StateStore
  readonly apresentavel: string
  readonly sonda: SondaTelegram
  readonly escrever: (texto: string) => void
  readonly avisar: (texto: string) => void
  readonly agora: () => number
  readonly intervaloMs: number
  readonly perguntar: (rotulo: string) => Promise<string | undefined>
  readonly pedirSegredo: (rotulo: string) => Promise<string | undefined>
  /** Ha alguem do outro lado para responder a uma pergunta? */
  readonly interativo: boolean
}

/**
 * Compoe o retrato do ambiente.
 *
 * A ORDEM E A POLITICA: formato ANTES de rede (TG-061). Um token malformado
 * nunca e enviado — a chamada de rede so acontece no ramo em que o formato
 * passou. Isso e visivel no fluxo abaixo e e o que o teste assere.
 */
async function recolherRetrato(
  ctx: Contexto,
  ambiente: Readonly<Record<string, string | undefined>>,
): Promise<{ readonly retrato: RetratoDoAmbiente; readonly token: string | undefined }> {
  const dono = ctx.store.read().pairing
  const encontrado = resolverToken(ctx.caminhoSecrets, ambiente)
  if (encontrado === undefined) {
    return { retrato: { token: undefined, getMe: undefined, dono }, token: undefined }
  }

  const formato = validarFormatoDoToken(encontrado.token)
  const configurado: TokenConfigurado = { origem: encontrado.origem, formato }
  if (!formato.valido) {
    return { retrato: { token: configurado, getMe: undefined, dono }, token: encontrado.token }
  }

  const getMe: RespostaGetMe = await ctx.sonda.getMe(encontrado.token)
  return { retrato: { token: configurado, getMe, dono }, token: encontrado.token }
}

/* ========================================================================== */
/* Leitura da chave sem a mostrar no ecra                                     */
/* ========================================================================== */

/**
 * >>> M3 — A ENTRADA PODE ACABAR SEM NUNCA DAR UMA LINHA <<<
 *
 * `rl.question()` devolve uma promessa que, se o `stdin` fechar antes de
 * chegar uma linha, NUNCA SE RESOLVE. Com `dsh-guard-setup --reset-pairing <
 * /dev/null` o processo morria em `unsettled top-level await`: saida 13 (que
 * nem esta documentada), a palavra `await` no ecra, o nome do ficheiro
 * interno, e o CAMINHO ABSOLUTO desta maquina — as tres coisas que o cabecalho
 * deste modulo e o TG-070 proibem, de uma vez. O sentido era fail-closed (nada
 * foi alterado); a superficie e que estava errada.
 *
 * A correccao e correr a pergunta contra o `close` do proprio `readline`, que
 * e o evento que o fim da entrada dispara. `undefined` passa a significar,
 * explicitamente, "nao ha ninguem do outro lado" — e quem chama TEM de decidir
 * o que fazer com isso, porque o compilador o obriga.
 *
 * NAO se gasta aqui um `ctx.interativo`: `--pedir-token` por `pipe`
 * (`cat chave.txt | ...`) e um caminho legitimo e desejado, e `isTTY` nao o
 * distingue de `< /dev/null`. O que distingue os dois e chegar, ou nao chegar,
 * uma linha — que e exatamente o que isto mede.
 */
async function lerLinha(rotulo: string, ecoar: boolean): Promise<string | undefined> {
  // Sem `output`, o `readline` le e nao escreve: e assim que a chave nao
  // aparece no ecra enquanto se escreve. Por isso o rotulo sai a mao.
  if (!ecoar) process.stdout.write(rotulo)
  const rl = createInterface(
    ecoar
      ? { input: process.stdin, output: process.stdout }
      : { input: process.stdin, terminal: process.stdin.isTTY === true },
  )
  try {
    const fim = once(rl, 'close').then(() => undefined)
    const linha = await Promise.race([rl.question(ecoar ? rotulo : ''), fim])
    if (!ecoar && linha !== undefined) process.stdout.write('\n')
    return linha?.trim()
  } finally {
    rl.close()
  }
}

/** Pede uma linha ao operador SEM a ecoar. Para a chave do bot. */
async function pedirLinhaOculta(rotulo: string): Promise<string | undefined> {
  return lerLinha(rotulo, false)
}

/** Pede uma linha VISIVEL. Para confirmacoes, nunca para segredos. */
async function pedirLinha(rotulo: string): Promise<string | undefined> {
  return lerLinha(rotulo, true)
}

/* ========================================================================== */
/* Comandos                                                                   */
/* ========================================================================== */

/** Imprime o passo em falta. NAO escreve nada em lado nenhum. */
function mostrarPasso(retrato: RetratoDoAmbiente, ctx: Contexto, codigo?: string): number {
  const passo = proximoPasso(retrato, {
    caminhoSecretsEnv: ctx.apresentavel,
    ...(codigo === undefined ? {} : { codigo }),
    minutosDoCodigo: Math.round(TTL_DO_CODIGO_MS / 60_000),
  })
  ctx.escrever(`\n${passo.titulo}\n\n${passo.texto}\n`)
  return passo.estado === 'PRONTO' ? 0 : 3
}

/**
 * `--pedir-token`: recebe a chave pelo terminal e grava-a.
 *
 * O formato e validado ANTES de qualquer byte sair da maquina (TG-061), e o
 * `getMe` so corre depois de o ficheiro estar gravado — assim uma chave boa
 * nao se perde por uma falha de rede momentanea, e uma chave ma nunca chega a
 * ser enviada.
 */
async function comandoPedirToken(ctx: Contexto, ambiente: NodeJS.ProcessEnv): Promise<number> {
  ctx.escrever(
    `\nCole a chave que o @BotFather lhe deu. Ela não aparece no ecrã enquanto a escreve,\n` +
      `e fica guardada em ${ctx.apresentavel} (só a sua conta lê).\n`,
  )
  const bruto = await ctx.pedirSegredo('chave: ')
  if (bruto === undefined) {
    // M3: a entrada acabou sem uma linha (`< /dev/null`, ou um `pipe` vazio).
    // Nao ha default seguro para "qual e a chave", logo falha-se alto — mas com
    // uma frase, nao com um aviso do runtime a mostrar caminhos desta maquina.
    ctx.avisar(
      '\nNão chegou nenhuma chave: a entrada deste comando acabou sem uma linha.\n' +
        'Execute-o num terminal, ou passe a chave por um canal de entrada, por\n' +
        `exemplo:  cat a-minha-chave.txt | ${COMANDO_CLI} --pedir-token\n` +
        'Nada foi gravado.',
    )
    return 2
  }

  const formato = validarFormatoDoToken(bruto)
  if (!formato.valido) {
    // Nada saiu para a rede. O texto do estado explica O QUE esta errado na
    // forma, sem repetir a chave nem parte dela.
    return mostrarPasso(
      { token: { origem: 'secrets.env', formato }, getMe: undefined, dono: ctx.store.read().pairing },
      ctx,
    )
  }

  gravarSecretsEnv(ctx, CHAVE_DO_TOKEN, bruto)
  ctx.escrever(`\nChave guardada em ${ctx.apresentavel}, com permissão 0600.`)

  const { retrato } = await recolherRetrato(ctx, ambiente)
  return mostrarPasso(retrato, ctx)
}

/**
 * `--parear`: gera o codigo, mostra-o, e espera pelo `/parear <codigo>`.
 *
 * PORQUE A ESPERA E UM CICLO DE SONDAGENS CURTAS, e nao um long poll:
 * `docs/spikes/telegram.md` 6 mediu que um `getUpdates` novo MATA o long poll
 * pendente de outra instancia com `409`. Se este comando pendurasse um long
 * poll, ele derrubaria o worker; se o worker chegasse depois, derrubaria este.
 * Com `timeout: 0` e `offset: 0` (ver `SondaTelegram.getUpdates`) le-se sem
 * confirmar e sem pendurar — e um `409` que apareca mesmo assim e DETECTADO e
 * EXPLICADO aqui, nunca devolvido em cru.
 */
async function comandoParear(
  ctx: Contexto,
  token: string,
  retrato: RetratoDoAmbiente,
  confirmado: boolean,
): Promise<number> {
  if (retrato.dono !== undefined) {
    ctx.escrever(
      `\nEste bot já tem dono. Um segundo pareamento é recusado, mesmo com um código válido.\n` +
        `Para trocar de dono é preciso estar nesta máquina e escrever:\n\n` +
        `         ${COMANDO_CLI} --reset-pairing\n`,
    )
    return 0
  }

  const relogio = { now: ctx.agora }
  let sessao = criarSessaoDePareamento({ clock: relogio })

  /*
   * >>> A1 — PORQUE `vistos` VIVE AQUI E NAO DENTRO DA ESPERA <<<
   *
   * Este `Set` ja existia, mas nascia DENTRO de `esperarPareamento`, ou seja
   * uma vez por CODIGO. Com o `offset` que nunca avanca, cada codigo novo
   * relia a MESMA fila desde o principio — e cinco `/parear` errados
   * represados no servidor esgotavam o teto de tentativas do codigo seguinte
   * no primeiro poll, e do seguinte, e do seguinte.
   *
   * Medido antes da correccao, com uma fila fixa de cinco codigos errados:
   * 31 codigos gerados, 30 esgotamentos consecutivos, dono gravado: nao. Ou
   * seja: CINCO MENSAGENS DE GRACA negavam o onboarding para sempre, porque
   * avancar o `offset` esta proibido por desenho e a fila do Telegram so cede
   * sozinha ~24 h depois. Era exatamente o atacante que o texto deste
   * onboarding declara combater — "o nome de um bot e facil de adivinhar".
   *
   * Com o `Set` a viver na INVOCACAO, um `update_id` ja visto nao volta a ser
   * oferecido a sessao nenhuma, logo nao volta a gastar tentativa. Uma fila
   * represada custa o PRIMEIRO codigo, e nao todos.
   */
  const vistos = new Set<number>()
  let renovacoes = 0

  for (;;) {
    mostrarPasso(retrato, ctx, sessao.revelarCodigo())
    ctx.escrever(
      'Enquanto isto espera, o harness não deve estar a correr com este mesmo bot:\n' +
        'cada mensagem chega a exatamente uma ligação, e duas ligações ao mesmo bot\n' +
        'desligam-se uma à outra. Se isso acontecer, esta ferramenta avisa e para.\n',
    )

    const resultado = await esperarPareamento(ctx, token, sessao, vistos)
    if (resultado === 'pareado') return 0
    if (resultado === 'conflito') return 1

    // TG-064 — O CODIGO EXPIRA E NADA TRAVA. A ferramenta oferece gerar outro;
    // recusar deixa o sistema exatamente como estava (sem dono, sem janela
    // aberta), que e o estado seguro. O que NAO se faz e prolongar o codigo:
    // um codigo que se renova sozinho e uma janela permanente com outro nome.
    // B2: as duas saidas dizem coisas DIFERENTES de proposito. Antes desta
    // correccao, uma sessao ESGOTADA imprimia "chegaram N codigos errados" e,
    // uma linha abaixo, "o codigo expirou sem que nenhuma mensagem chegasse" —
    // duas frases contraditorias a uma linha de distancia.
    ctx.escrever(
      resultado === 'esgotado'
        ? '\nEste código foi fechado por excesso de tentativas erradas, e ninguém foi pareado.'
        : '\nO código expirou sem que nenhuma mensagem /parear chegasse.',
    )

    if (renovacoes >= RENOVACOES_MAXIMAS) {
      ctx.escrever(
        `\nJá foram gerados ${String(RENOVACOES_MAXIMAS + 1)} códigos nesta execução e nenhum foi usado.\n` +
          'Paro por aqui em vez de continuar a gerar códigos sozinho — uma janela que\n' +
          'se renova sem ninguém pedir é uma janela permanente com outro nome.\n' +
          'Nada ficou aberto e nada ficou trancado. Quando quiser, repita:\n\n' +
          `         ${COMANDO_CLI} --parear\n`,
      )
      return 3
    }
    // A PERGUNTA E FAIL-CLOSED: o `[s/N]` diz que carregar em Enter NAO gera
    // outro codigo. Sem alguem do outro lado, nem se pergunta — e so se
    // continua com `--sim`, que e um pedido explicito de quem chamou. Um ciclo
    // que se renova sozinho num script seria uma janela de pareamento
    // permanente com outro nome, que e exatamente o que o TTL existe para
    // impedir.
    const resposta = confirmado
      ? 's'
      : ctx.interativo
        ? ((await ctx.perguntar('Gerar outro código? [s/N] ')) ?? 'n')
        : 'n'
    if (!resposta.trim().toLowerCase().startsWith('s')) {
      ctx.escrever(
        `\nNada ficou aberto e nada ficou trancado. Quando quiser, repita:\n\n` +
          `         ${COMANDO_CLI} --parear\n`,
      )
      return 3
    }
    renovacoes += 1
    sessao = criarSessaoDePareamento({ clock: relogio })
  }
}

type FimDaEspera = 'pareado' | 'expirado' | 'esgotado' | 'conflito'

/**
 * O ciclo de espera. Descarta em silencio o que nao pareia, e CONTA (TG-066).
 *
 * `vistos` E DE FORA (A1): ele pertence a INVOCACAO, nao ao codigo. Ver o
 * bloco em {@link comandoParear} para a medicao que obrigou a esta mudanca.
 */
async function esperarPareamento(
  ctx: Contexto,
  token: string,
  sessao: SessaoDePareamento,
  vistos: Set<number>,
): Promise<FimDaEspera> {
  /*
   * >>> A2 — A FILA CHEIA ESCONDE O `/parear` DO DONO <<<
   *
   * Com `offset: 0`, cada sondagem devolve SEMPRE os mesmos primeiros
   * `LIMITE_DE_UPDATES` da fila. Um `/parear` na posicao 101 e inalcancavel, e
   * chegar la exigiria confirmar os anteriores — o que esta proibido, porque
   * apagaria do servidor updates de que o worker precisa.
   *
   * Medido: 100 mensagens de lixo a frente do codigo correcto -> dono gravado:
   * nao, ao fim de 12 sondagens, e o ciclo continuaria ate ao TTL. E mais
   * barato de disparar que A1 — nem e preciso acertar no formato do comando.
   *
   * Nao ha correccao possivel DENTRO desta ferramenta; ha correccao no que ela
   * DIZ. O sintoma deixa de ser silencio: avisa-se uma vez, com o que fazer.
   */
  let avisouDaFilaCheia = false

  while (sessao.estado() === 'aberto') {
    const lote = await ctx.sonda.getUpdates(token)

    if (!lote.ok) {
      if (lote.falha.causa === 'conflito') {
        // A pergunta 6 da revisao, respondida: o `409` NAO vira erro cru.
        ctx.avisar(
          '\nJá existe outra ligação a usar este bot — quase sempre o próprio harness,\n' +
            'a correr com o worker do Telegram ligado. O Telegram só entrega cada mensagem\n' +
            'a uma ligação, e desliga a mais antiga quando aparece outra.\n\n' +
            'Pare o harness (ou desligue este plugin), volte a executar\n' +
            `\`${COMANDO_CLI} --parear\` e depois volte a ligá-lo.`,
        )
        return 'conflito'
      }
      if (lote.falha.causa === 'recusado') {
        ctx.avisar(
          '\nA chave do bot deixou de ser aceite a meio da espera. Isso acontece quando\n' +
            'alguém pede uma chave nova ao @BotFather: a nova revoga a anterior.',
        )
        return 'conflito'
      }
      // Rede instavel ou limite de taxa: nao e motivo para desistir do codigo,
      // que continua valido ate ao TTL. Espera-se e tenta-se outra vez.
      await esperar(ctx.intervaloMs)
      continue
    }

    for (const update of lote.updates) {
      const id = identificadorDoUpdate(update)
      if (id !== undefined) {
        if (vistos.has(id)) continue
        vistos.add(id)
      }

      const resultado = sessao.oferecer(update)
      if (resultado.tipo === 'pareado') {
        // ESCRITA UNICA E FINAL: `pairing` fecha-se aqui, e o unico writer do
        // `state.json` e `src/state/store.ts`.
        ctx.store.update((estado) => ({ ...estado, pairing: resultado.dono }))
        registarAuditoria(ctx, token, 'pareamento_concluido', 'permitido')
        ctx.escrever(
          `\nPronto. O dono ficou gravado e esta janela fechou-se.\n` +
            `Um segundo /parear passa a ser recusado, mesmo com um código válido.\n`,
        )
        mostrarSegredoSeFaltar(ctx)
        ctx.escrever(`\n${AVISOS_ANTES_DO_TUNEL}\n`)
        return 'pareado'
      }
    }

    if (lote.updates.length >= LIMITE_DE_UPDATES && !avisouDaFilaCheia) {
      avisouDaFilaCheia = true
      ctx.avisar(
        `\nAtenção: este bot tem pelo menos ${String(LIMITE_DE_UPDATES)} mensagens por ler, e eu só\n` +
          'consigo ver as primeiras. Se você enviar o código agora, ele fica atrás\n' +
          'dessas mensagens e eu não chego a vê-lo.\n\n' +
          'Isto não é um defeito que eu possa contornar aqui: para chegar às mensagens\n' +
          'seguintes teria de marcar as anteriores como lidas, e isso apagá-las-ia do\n' +
          'servidor — inclusive as que o harness precisa de receber.\n\n' +
          'O que fazer: ligue o harness uma vez e deixe-o escoar a fila, ou apague a\n' +
          'conversa com o bot no Telegram. Depois volte a executar\n' +
          `\`${COMANDO_CLI} --parear\`.`,
      )
    }

    const resumo = sessao.resumo()
    if (sessao.estado() === 'esgotado') {
      // O teto de tentativas fechou a sessao. Nao e um lockout: gera-se outro
      // codigo no terminal, que e exatamente a prova de posse que se quer — e,
      // desde A1, os codigos errados ja vistos nao voltam a gastar tentativa
      // do codigo seguinte.
      ctx.escrever(`\nChegaram ${String(resumo.tentativas)} códigos errados a este código.`)
      return 'esgotado'
    }

    await esperar(ctx.intervaloMs)
  }

  if (sessao.estado() === 'consumido') return 'pareado'
  return sessao.estado() === 'esgotado' ? 'esgotado' : 'expirado'
}

function identificadorDoUpdate(update: unknown): number | undefined {
  if (typeof update !== 'object' || update === null) return undefined
  const id = (update as Record<string, unknown>)['update_id']
  return typeof id === 'number' && Number.isSafeInteger(id) ? id : undefined
}

/**
 * `--reset-pairing` (PAIR-008): reabre o pareamento, com tres travas.
 *
 *   1. SO LOCALMENTE. Nao ha comando de Telegram nem rota HTTP que faca isto —
 *      e propositado: quem controla o canal do Telegram nao pode reatribuir a
 *      si proprio o bot. A prova de localidade e ter este terminal.
 *   2. EXIGE CONFIRMACAO ESCRITA. Nao um `s/n`: a palavra inteira. Reabrir o
 *      pareamento e reabrir a janela de corrida que todo este desenho existe
 *      para fechar, e isso nao pode acontecer por uma tecla trocada.
 *   3. EMITE EVENTO DE AUDITORIA, e falha se nao conseguir emitir. Um reset que
 *      nao ficou registado e a operacao mais interessante do sistema a
 *      acontecer sem rasto; o log de auditoria e fail-closed por desenho
 *      (`src/audit/log.ts`) e aqui herda-se essa politica.
 */
async function comandoResetPairing(ctx: Contexto, token: string | undefined): Promise<number> {
  const dono = ctx.store.read().pairing
  if (dono === undefined) {
    ctx.escrever('\nNão há dono pareado — não há nada para reabrir.')
    return 0
  }

  ctx.escrever(
    '\nIsto invalida o dono atual do bot e abre outra vez a janela de pareamento.\n' +
      'Enquanto ela estiver aberta, quem tiver o próximo código passa a comandar\n' +
      'este computador pelo Telegram. Faça-o só se for você a gerar o código a seguir.\n',
  )
  const resposta = await ctx.perguntar(`Escreva ${PALAVRA_DE_CONFIRMACAO} para confirmar: `)
  if (resposta === undefined) {
    // M3: sem ninguem para confirmar, NAO se reabre o pareamento. O sentido ja
    // era este; o que faltava era dize-lo em vez de morrer com um aviso do
    // runtime que publicava o caminho do utilizador.
    ctx.avisar(
      '\nNão foi possível pedir a confirmação: a entrada deste comando acabou sem\n' +
        'uma linha. Reabrir o pareamento é uma decisão que ninguém toma por si.\n' +
        `Execute-o num terminal, ou escreva:  echo ${PALAVRA_DE_CONFIRMACAO} | ${COMANDO_CLI} --reset-pairing\n` +
        'Nada foi alterado.',
    )
    return 2
  }
  if (resposta !== PALAVRA_DE_CONFIRMACAO) {
    ctx.escrever('\nNada foi alterado.')
    return 3
  }

  // AUDITORIA ANTES DA ALTERACAO: se o registo falhar, a alteracao nao
  // acontece. A ordem inversa deixaria o dono trocado e o registo por escrever.
  registarAuditoria(ctx, token, 'pareamento_reaberto', 'permitido')
  ctx.store.update((estado) => {
    const { pairing: anterior, ...resto } = estado
    void anterior
    return resto
  })

  ctx.escrever(
    `\nO dono anterior deixou de valer neste instante. Para parear outra vez:\n\n` +
      `         ${COMANDO_CLI} --parear\n`,
  )
  return 0
}

/**
 * A senha do gate: mostrada UMA unica vez, em texto e como QR na mesma tela.
 *
 * `hasSecret()` e a guarda de idempotencia (TG-067): correr a ferramenta outra
 * vez nao regenera segredo nenhum. E `rotate()` NUNCA e chamado daqui — ver o
 * `sessions` abaixo.
 */
function mostrarSegredoSeFaltar(ctx: Contexto): void {
  const segredos = createSecretStore({
    state: ctx.store,
    sessions: {
      /**
       * LANCA DE PROPOSITO. As sessoes vivas estao na memoria do processo do
       * HARNESS, e este e outro processo: um `revokeAll()` daqui nao revogaria
       * sessao nenhuma e devolveria sucesso — uma mentira sobre a unica coisa
       * que torna a rotacao segura. Como so `rotate()` o chama, e este CLI so
       * chama `provision()`, esta excecao e inalcancavel; se algum dia deixar
       * de ser, ela para o processo em vez de rodar um segredo em falso.
       */
      revokeAll: (): never => {
        throw new Error(
          'a rotação da senha tem de ser feita pelo harness a correr, porque só ele ' +
            'consegue invalidar as sessões abertas. Use /rotacionar no bot ou o painel.',
        )
      },
    },
  })

  if (segredos.hasSecret()) {
    ctx.escrever(
      '\nA senha de acesso já tinha sido gerada e é mostrada uma única vez.\n' +
        'Se a perdeu, use /rotacionar no bot ou o painel — isso gera outra e fecha as\n' +
        'sessões abertas.',
    )
    return
  }

  const { display } = segredos.provision()
  ctx.escrever(
    '\nEsta é a sua senha de acesso. Ela aparece UMA única vez e não fica em lado\n' +
      'nenhum em claro — em disco guarda-se apenas uma impressão digital dela.\n' +
      'Aponte a câmara ao quadrado para a levar para o telemóvel.\n',
  )
  ctx.escrever(display)
}

/* ========================================================================== */
/* Auditoria                                                                  */
/* ========================================================================== */

/**
 * Regista um evento, mascarando a chave do bot.
 *
 * O `workspaceRoot` que se passa e um caminho que NUNCA pode conter o log, e
 * isso e deliberado: a guarda de `openAuditLog` existe para impedir que o log
 * caia dentro do workspace SERVIDO pela Web UI, e esta ferramenta nao serve
 * nada nem sabe qual e esse workspace — o `cwd` dela e o da pessoa, que pode
 * perfeitamente ser a propria casa do utilizador. Usar o `cwd` aqui recusaria
 * escrever o log so porque alguem correu o comando a partir de `~`.
 *
 * O caminho do log NAO e escolhido por esta funcao: e o canonico do plugin, ao
 * lado do `state.json`, com o mesmo modo e o mesmo dono.
 */
function registarAuditoria(
  ctx: Contexto,
  token: string | undefined,
  evento: string,
  resultado: 'permitido' | 'negado',
): void {
  const log = openAuditLog({
    path: join(ctx.paths.dir, AUDIT_FILE_NAME),
    workspaceRoot: join(ctx.paths.dir, '.esta-ferramenta-nao-tem-workspace'),
    secrets: () => (token === undefined ? [] : [token]),
  })
  try {
    // O evento NUNCA leva o codigo de pareamento (PAIR-010) nem os ids do dono:
    // um log de auditoria diz O QUE aconteceu, e quem tem de saber com quem ja
    // tem o `state.json`.
    log.append({ evento, resultado })
  } finally {
    log.dispose()
  }
}

/* ========================================================================== */
/* Ajuda                                                                      */
/* ========================================================================== */

function mostrarAjuda(escrever: (texto: string) => void): void {
  escrever(`${COMANDO_CLI} — liga este computador ao seu bot do Telegram.

Sem opções, a ferramenta mostra a sua senha de acesso (uma única vez, em texto
e em QR — a senha do portão HTTP não depende do Telegram) e depois o passo que
falta. Correr outra vez quando já está tudo pronto não muda nada.

  --pedir-token     pede a chave do bot aqui no terminal e guarda-a com
                    permissão 0600, fora da pasta do projeto
  --parear          mostra um código de 6 dígitos e espera que você o envie ao
                    bot com ${'/parear <código>'}
  --reset-pairing   invalida o dono atual e permite parear outra vez
  --sim             não pergunta antes de gerar outro código quando o anterior
                    expira. Mesmo assim para ao fim de ${String(RENOVACOES_MAXIMAS + 1)} códigos numa
                    execução: uma janela que se renova sozinha é uma janela
                    permanente com outro nome
  --ajuda           mostra este texto

A chave do bot nunca pode vir na linha de comando: o que se escreve na linha de
comando fica à vista dos outros programas desta máquina.

Códigos de saída: 0 pronto · 1 falha · 2 uso incorreto · 3 falta um passo.
"Uso incorreto" inclui pedir uma operação que precisa de resposta sua quando não
há nada ligado à entrada deste comando — nesse caso nada é alterado.`)
}

/* ========================================================================== */
/* Entrada                                                                    */
/* ========================================================================== */

export async function principal(
  argv: readonly string[],
  deps: DependenciasDoSetup = {},
): Promise<number> {
  const escrever = deps.escrever ?? ((texto: string): void => void process.stdout.write(`${texto}\n`))
  const avisar = deps.avisar ?? ((texto: string): void => void process.stderr.write(`${texto}\n`))

  const argumentos = analisarArgumentos(argv)
  if (argumentos.comando === 'ajuda') {
    mostrarAjuda(escrever)
    return 0
  }

  const paths = deps.paths ?? resolveStatePaths({ env: process.env })
  ensureStateDir(paths)
  const handle = createStateStore({ paths })
  const caminhoSecrets = caminhoDoSecretsEnv(paths)
  const ctx: Contexto = {
    paths,
    store: handle.store,
    caminhoSecrets,
    apresentavel: caminhoApresentavel(caminhoSecrets, homedir()),
    sonda: deps.sonda ?? criarSondaHttp(),
    escrever,
    avisar,
    agora: deps.agora ?? Date.now,
    intervaloMs: deps.intervaloMs ?? INTERVALO_DE_SONDAGEM_MS,
    perguntar: deps.perguntar ?? pedirLinha,
    pedirSegredo: deps.pedirSegredo ?? pedirLinhaOculta,
    interativo: deps.perguntar !== undefined || process.stdin.isTTY === true,
  }

  try {
    if (argumentos.comando === 'pedir-token') {
      return await comandoPedirToken(ctx, process.env)
    }

    const { retrato, token } = await recolherRetrato(ctx, process.env)

    if (argumentos.comando === 'reset-pairing') {
      return await comandoResetPairing(ctx, token)
    }

    // `guiar` e `parear` convergem: o passo em falta em `TOKEN_OK_SEM_DONO` E o
    // pareamento, e uma ferramenta que soubesse disso e mesmo assim mandasse a
    // pessoa escrever outro comando estaria a pedir-lhe que fizesse o trabalho
    // dela. Nos outros estados, `--parear` diz o que falta primeiro.
    const estado = proximoPasso(retrato, { caminhoSecretsEnv: ctx.apresentavel }).estado
    if (token !== undefined && (estado === 'TOKEN_OK_SEM_DONO' || argumentos.comando === 'parear')) {
      if (estado === 'TOKEN_OK_SEM_DONO' || estado === 'PRONTO') {
        return await comandoParear(ctx, token, retrato, argumentos.confirmado)
      }
    }

    // A senha do portão é independente do Telegram (INSTALL.md, Passo 4: o
    // portão HTTP funciona só com a senha). O boot nunca a mostra — a tela
    // /__guard/secret é da Onda 6 (src/index.ts, `reveal: () => null`) — e o
    // plano (03-ONDAS.md, T4.1) atribui a este CLI o provision() + senha + QR.
    // Logo, na primeira execução ela é provisionada e mostrada AQUI, antes do
    // próximo passo do Telegram. `hasSecret()` mantém a idempotência (TG-067)
    // e `rotate()` continua fora deste CLI.
    mostrarSegredoSeFaltar(ctx)
    return mostrarPasso(retrato, ctx)
  } finally {
    handle.dispose()
  }
}

/**
 * So corre quando este ficheiro E o programa — nunca quando e importado.
 *
 * `process.argv[1]` e o caminho do script; compara-se por URL de ficheiro para
 * nao depender de o caminho vir absoluto ou relativo.
 */
const somosOPrograma =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`

if (somosOPrograma) {
  try {
    process.exitCode = await principal(process.argv.slice(2))
  } catch (erro) {
    relatarErro(erro)
    process.exitCode = erro instanceof OnboardingError && erro.code.startsWith('SETUP_') ? 2 : 1
  }
}
