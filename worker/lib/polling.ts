/**
 * LONG POLLING: as opcoes, e o que fazer quando ele morre.
 *
 * ===========================================================================
 * PORQUE LONG POLLING E NAO WEBHOOK — E A PROPRIEDADE QUE ISSO COMPRA
 * ===========================================================================
 * Com o token, um atacante personifica o bot e rouba a fila de updates (ver
 * `./token.ts`). O que ele NAO consegue neste desenho e FABRICAR um update com
 * identidade allowlistada: todas as accoes deste worker partem de updates de
 * ENTRADA, e em long polling nao existe endpoint nosso onde forjar um POST. Nao
 * ha superficie a receber; ha uma ligacao de saida que nos abrimos.
 *
 * ISSO E PROPRIEDADE DO DESENHO E TEM DE SER PRESERVADA.
 *
 *   >>> SE ALGUEM MIGRAR PARA WEBHOOK, `secret_token` PASSA A SER
 *   >>> OBRIGATORIO. `setWebhook` aceita `secret_token` (1-256 caracteres,
 *   >>> `A-Z a-z 0-9 _ -`), e o Telegram devolve-o em cada pedido no cabecalho
 *   >>> `X-Telegram-Bot-Api-Secret-Token`. A comparacao tem de ser em TEMPO
 *   >>> CONSTANTE (`crypto.timingSafeEqual` sobre buffers do mesmo tamanho): um
 *   >>> `===` sobre strings vaza o prefixo correto pelo tempo de resposta, e um
 *   >>> endpoint publico e exatamente onde alguem tem paciencia para medir isso.
 *   >>> Sem esse cabecalho verificado, o webhook e um endpoint aberto onde
 *   >>> QUALQUER pessoa injeta um update com `from.id` do dono — e a allowlist
 *   >>> de identidade (`worker/auth/allowlist.ts`) passa a validar dados do
 *   >>> atacante. A propriedade acima desaparece por completo.
 *
 * ===========================================================================
 * DESCARTE DA FILA NO BOOT — E O SITIO CERTO DA API
 * ===========================================================================
 * Os updates ficam ate 24 H no servidor («they will not be kept longer than 24
 * hours»). Um bot que LIGA E DESLIGA SERVIDOR nao pode executar uma avalanche
 * de comandos velhos ao voltar: o dono mandou `/ligar` as 3 da manha, desistiu,
 * e nao quer que isso aconteca quando o worker arrancar de manha.
 *
 *   >>> FACTO MEDIDO (`docs/spikes/telegram.md` 5), e corrige o que circula:
 *   >>> `drop_pending_updates` **NAO E PARAMETRO DE `getUpdates`**.
 *
 * E parametro de `setWebhook`/`deleteWebhook`. O `bot.start({
 * drop_pending_updates: true })` do grammY traduz-se numa chamada a
 * `deleteWebhook` (`out/bot.js`: `withRetries(() => this.api.deleteWebhook({
 * drop_pending_updates }))`), e a sequencia observada no fio foi
 * `getMe -> deleteWebhook{drop_pending_updates:true} -> getUpdates`. O
 * `deleteWebhook` faz as duas coisas de que precisamos: limpa a fila E garante
 * que nao ha webhook residual registado — obrigatorio, porque `getUpdates` com
 * webhook ativo da 409.
 *
 * O teste tem de asserir a chamada ONDE ELA EXISTE, e falhar se alguem a puser
 * no `getUpdates`.
 *
 * ===========================================================================
 * `allowed_updates` ENVIADO EXPLICITAMENTE — SEMPRE
 * ===========================================================================
 * «If not specified, the previous setting will be used.» Omitir NAO significa
 * "todos": significa MANTER O QUE LA ESTAVA — estado invisivel guardado no
 * servidor do Telegram, que ninguem neste repositorio consegue inspecionar e
 * que uma execucao anterior (ou outra pessoa com o mesmo token) definiu. E a
 * pior especie de configuracao: a que nao esta em lado nenhum do teu codigo.
 *
 * O grammY manda `allowed_updates` SO NO PRIMEIRO `getUpdates` do ciclo e
 * omite-o nos seguintes (poupa trafego, e correto — o valor ja ficou fixado no
 * servidor). O teste assere o PRIMEIRO.
 *
 * ===========================================================================
 * `timeout: 50`
 * ===========================================================================
 * `Client.h:1704` — `static constexpr int32 LONG_POLL_MAX_TIMEOUT = 50;`, e
 * `Client.cpp:16790` clampa o argumento a [0, 50]. Pedir mais e pedir 50 na
 * mesma; pedir menos e martelar o servidor sem ganhar nada.
 */

import { GrammyError, type Bot, type Context, type PollingOptions } from 'grammy'

import { exitCodeFor, WORKER_EXIT, WorkerError, type WorkerErrorCode } from './errors.ts'
import type { WorkerLogger } from './log.ts'
import { describeForLog } from './redact.ts'

/** Tecto do servidor, do fonte do `telegram-bot-api`. Nao e opiniao nossa. */
export const LONG_POLL_MAX_TIMEOUT = 50

/**
 * Os DOIS tipos de update que este bot trata. Fechado de proposito: cada tipo a
 * mais e mais superficie de parsing exposta a Internet, e nao ha comando deste
 * plano que precise de outro.
 */
export const ALLOWED_UPDATES = Object.freeze(['message', 'callback_query'] as const)

/**
 * Prazo para o arranque chegar a receber updates.
 *
 * ===========================================================================
 * PORQUE ISTO EXISTE: UM BUG DE UNIDADES NO grammY 1.45.1
 * ===========================================================================
 * MEDIDO no artefacto compilado, com a rede a falhar NO BOOT (servidor que
 * aceita a ligacao e destroi o socket):
 *
 *     tentativas HTTP (ms desde o arranque): [50, 50, 52, 52]
 *     processo saiu? NAO — 60 s depois continuava vivo, e calado.
 *
 * Quatro tentativas em 52 ms, e depois NADA. A causa esta em `out/bot.js`:
 *
 *     const INITIAL_DELAY = 50; // ms          <- lastDelay e MILISSEGUNDOS
 *     ...
 *     await sleep(lastDelay, signal);          <- mas `sleep` recebe SEGUNDOS:
 *     async function sleep(seconds, ...) { ... setTimeout(res, 1000 * seconds) }
 *
 * O `withRetries` do grammY multiplica por 1000 um valor que ja estava em
 * milissegundos. A segunda tentativa dorme **100 segundos**, a terceira 200 s, e
 * o tecto `TWENTY_MINUTES = 20*60*1000` interpretado como segundos da
 * **~14 dias**. Nao ha erro visivel: o `debugErr` e mudo sem `DEBUG`.
 *
 * O efeito para nos e o mesmo defeito do ACHADO 1 noutro caminho: o worker fica
 * VIVO, CALADO e SEM SAIR durante minutos. O host nao ve `stderr` novo nem
 * `close`, portanto nao tem por onde projetar `DEGRADED` nem por onde aplicar a
 * politica de reinicio.
 *
 * A politica de reinicio DESTE projeto vive no supervisor
 * (`src/proc/supervisor.ts` + `retry.ts`): orcamento, backoff com jitter,
 * classificacao de causa, auditoria. Deixar o grammY dormir 100 s dentro do
 * nosso processo nao substitui nada disso — apenas torna a falha invisivel.
 * Passado o prazo, o worker RELATA e SAI, e a decisao volta para quem a deve
 * tomar.
 *
 * 45 s e folgado para um `getMe` + `deleteWebhook` (normal: < 1 s) e fica bem
 * abaixo dos 100 s do primeiro sono do grammY.
 *
 * ===========================================================================
 * E PORQUE O PROCESSO TEM DE SER **FORCADO** A SAIR DEPOIS DISTO
 * ===========================================================================
 * MEDIDO em `out/bot.js`, no inicio de `start()`:
 *
 *     if (!this.isInited()) {
 *         setup.push(this.init(this.pollingAbortController?.signal));  // <- 1
 *     }
 *     ...
 *     this.pollingAbortController = new AbortController();             // <- 2
 *
 * O `init()` (o `getMe`) recebe o sinal **antes** de o controlador existir, ou
 * seja recebe `undefined` no primeiro arranque. O sono de 100 s do `withRetries`
 * do `getMe` fica portanto SEM SINAL DE ABORTO: `bot.stop()` nao o cancela, e o
 * `setTimeout` continua agarrado ao event loop.
 *
 * Consequencia pratica: depois de `BOOT_TIMEOUT` o processo **nao consegue**
 * desmontar-se sozinho. Quem garante a saida e o temporizador de graca de
 * `worker/telegram-bot.ts` (`EXIT_GRACE_MS`), que chama `process.exit`. Medido
 * no artefacto compilado: prazo aos 45 s, saida com codigo 14 aos 47 s.
 *
 * >>> E TAMBEM PORQUE O TESTE DESTE PRAZO USA UM BOT FALSO. <<< Um teste
 * in-process contra um servidor de verdade herdaria esse mesmo temporizador
 * orfao e o processo do `node --test` ficaria pendurado 100 s — que foi
 * exatamente o que aconteceu quando este teste foi escrito com rede a serio.
 */
export const DEFAULT_BOOT_TIMEOUT_MS = 45_000

/** 409 de polling duplicado, verbatim de `tdlib/telegram-bot-api/Client.cpp`. */
export const CONFLICT_OTHER_GET_UPDATES = 409
/** 401: token errado ou revogado. */
export const UNAUTHORIZED = 401

/**
 * Opcoes de polling. Os tres valores que interessam sao explicitos, e nenhum
 * deles tem `undefined` como alternativa aceitavel.
 */
export function buildPollingOptions(
  overrides: Partial<Pick<PollingOptions, 'limit' | 'onStart'>> = {},
): PollingOptions {
  const options: PollingOptions = {
    timeout: LONG_POLL_MAX_TIMEOUT,
    allowed_updates: ALLOWED_UPDATES,
    // Ver o cabecalho: isto vira `deleteWebhook{drop_pending_updates:true}`.
    drop_pending_updates: true,
    limit: overrides.limit ?? 100,
  }
  return overrides.onStart === undefined ? options : { ...options, onStart: overrides.onStart }
}

/** Como o polling acabou. */
export type PollingOutcome =
  | { readonly kind: 'stopped'; readonly exitCode: number }
  | {
      readonly kind: 'fatal'
      readonly code: WorkerErrorCode
      readonly exitCode: number
      readonly error: unknown
    }

/**
 * Classifica um erro que fez `bot.start()` rejeitar.
 *
 * MEDIDO (`out/bot.js`, `handlePollingError`): o grammY faz retry de tudo menos
 * 401 e 409 — nesses dois RELANCA, e o `bot.start()` rejeita. Ou seja, chegar
 * aqui ja significa "terminal"; o que falta e dizer QUAL.
 */
export function classifyPollingError(error: unknown): {
  readonly code: WorkerErrorCode
  readonly exitCode: number
  readonly message: string
} {
  if (error instanceof GrammyError && error.error_code === CONFLICT_OTHER_GET_UPDATES) {
    return {
      code: 'POLLING_CONFLICT',
      exitCode: exitCodeFor('POLLING_CONFLICT'),
      message:
        'CONFLITO 409: outro getUpdates esta a correr com este mesmo token. ' +
        'Nao existe segundo consumidor legitimo — cada update chega a exatamente UM deles, ' +
        'e o que um confirmar desaparece para o outro. O processo SAI: reiniciar cegamente ' +
        'produz flapping infinito, porque o 409 mata a instancia que JA estava pendurada, ' +
        'nunca a que chega. Verifique se ha outro worker vivo (ou revogue o token no BotFather).',
    }
  }
  if (error instanceof GrammyError && error.error_code === UNAUTHORIZED) {
    return {
      code: 'POLLING_UNAUTHORIZED',
      exitCode: exitCodeFor('POLLING_UNAUTHORIZED'),
      message:
        'NAO AUTORIZADO 401: o token do bot foi recusado. Ele foi revogado, ' +
        'ou a variavel de ambiente traz outro valor. Fale com o @BotFather.',
    }
  }
  return {
    code: 'POLLING_FAILED',
    exitCode: exitCodeFor('POLLING_FAILED'),
    message: 'o long polling terminou com erro terminal.',
  }
}

export interface RunPollingDeps {
  /** O bot ja configurado (`./client.ts`). */
  readonly bot: Pick<Bot<Context>, 'start' | 'stop'>
  readonly log: WorkerLogger
  readonly options?: PollingOptions
  /** Segredos a mascarar no diagnostico. Omitido, nenhum. */
  readonly secrets?: () => readonly string[]
  /** Prazo de arranque. Omitido, {@link DEFAULT_BOOT_TIMEOUT_MS}. */
  readonly bootTimeoutMs?: number
}

/**
 * Corre o long polling ate ele acabar, e devolve um veredito.
 *
 * NAO chama `process.exit`: quem sai e o entrypoint. Uma funcao que mata o
 * processo nao se consegue testar sem subprocesso, e o veredito e a parte que
 * interessa verificar.
 *
 * O erro NUNCA e engolido: ou volta dentro do `PollingOutcome`, ou nao chega
 * aqui.
 */
export async function runPolling(deps: RunPollingDeps): Promise<PollingOutcome> {
  const options = deps.options ?? buildPollingOptions()
  const secretsOf = deps.secrets ?? ((): readonly string[] => [])

  /* A GUARDA CORRE AQUI, e nao so nos testes.
     ------------------------------------------------------------------------
     Achado de revisao adversarial: `assertPollingOptions` existia, era testada,
     e NUNCA era chamada em producao — `runPolling` aceitava o que lhe dessem.
     Com as degradacoes que este ficheiro diz recusar, o que foi para o fio foi
     `deleteWebhook: {"drop_pending_updates":false}` e
     `getUpdates: {"timeout":120,"allowed_updates":[]}`. Repare no
     `allowed_updates: []`: e o "reset to default" do grammY, ou seja a
     superficie FECHADA de dois tipos abria-se para o conjunto por omissao, em
     silencio.

     Uma guarda que nunca corre nao guarda nada — finge. Lanca ANTES de qualquer
     I/O: nao se faz meia ligacao para descobrir que a configuracao estava
     errada. */
  assertPollingOptions(options)

  deps.log.info('a arrancar o long polling', {
    timeout: options.timeout,
    allowed_updates: options.allowed_updates,
    drop_pending_updates: options.drop_pending_updates,
  })

  /* O PRAZO DE ARRANQUE. Ver DEFAULT_BOOT_TIMEOUT_MS para a medicao.
     ------------------------------------------------------------------------
     `onStart` e chamado pelo grammY DEPOIS do `getMe` e do `deleteWebhook` e
     IMEDIATAMENTE ANTES do primeiro `getUpdates` — e portanto o sinal exato de
     "o arranque terminou". Se ele nao chegar a tempo, o arranque encravou. */
  const bootTimeoutMs = deps.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS
  let arrancou = false
  const comOnStart: PollingOptions = {
    ...options,
    onStart: async (botInfo) => {
      arrancou = true
      deps.log.info('arranque concluido: a receber updates', { bot: botInfo.username })
      await options.onStart?.(botInfo)
    },
  }

  const prazo = new Promise<'boot-timeout'>((resolve) => {
    const timer = setTimeout(() => {
      if (!arrancou) resolve('boot-timeout')
    }, bootTimeoutMs)
    // `unref` para que o proprio prazo nunca seja a razao de o processo ficar
    // vivo: se tudo o resto acabar, o processo sai sem esperar por ele.
    timer.unref()
  })

  try {
    const started = deps.bot.start(comOnStart)
    /* Se o prazo ganhar a corrida, `started` fica pendente e pode rejeitar mais
       tarde, sem ninguem a ouvir — o que em Node e uma rejeicao nao tratada, e
       mata o processo com um rasto que nao aponta para nada. Este ouvinte NAO
       engole: a corrida abaixo ve exatamente a mesma rejeicao. */
    void started.catch(() => undefined)

    const resultado = await Promise.race([started.then(() => 'stopped' as const), prazo])

    if (resultado === 'boot-timeout') {
      const erro = new WorkerError(
        'BOOT_TIMEOUT',
        `o arranque nao chegou a receber updates em ${bootTimeoutMs} ms`,
      )
      deps.log.error(
        'ARRANQUE ENCRAVADO: passaram ' +
          `${bootTimeoutMs} ms sem o polling comecar. Causa tipica: a Bot API esta inalcancavel ` +
          'e o retry interno do grammY entrou num sono longo (medido: 100 s a segunda tentativa). ' +
          'O processo SAI para que o supervisor do host aplique a sua propria politica de reinicio.',
        { code: erro.code, exit_code: exitCodeFor(erro.code), boot_timeout_ms: bootTimeoutMs },
      )
      await pararComCuidado(deps)
      return {
        kind: 'fatal',
        code: erro.code,
        exitCode: exitCodeFor(erro.code),
        error: erro,
      }
    }

    deps.log.info('long polling terminado a pedido')
    return { kind: 'stopped', exitCode: WORKER_EXIT.OK }
  } catch (error) {
    const verdict = classifyPollingError(error)
    // Uma linha, `error`, com a causa mascarada: e ela que o operador vai ler.
    deps.log.error(verdict.message, {
      code: verdict.code,
      exit_code: verdict.exitCode,
      cause: describeForLog(error, secretsOf()),
    })
    return { kind: 'fatal', code: verdict.code, exitCode: verdict.exitCode, error }
  }
}

/**
 * Tenta parar o bot depois de o prazo de arranque expirar.
 *
 * NAO engole em silencio: uma falha aqui e registada. Mas tambem nao propaga —
 * o veredito ja esta decidido, e trocar "arranque encravado" por "falhou a
 * parar" perderia a causa que interessa.
 */
async function pararComCuidado(deps: RunPollingDeps): Promise<void> {
  try {
    await deps.bot.stop()
  } catch (error) {
    deps.log.debug('bot.stop falhou depois do prazo de arranque', {
      detail: describeForLog(error),
    })
  }
}

/**
 * Guarda de sanidade sobre as opcoes, para o caso de alguem "otimizar" isto
 * mais tarde. Lanca em vez de corrigir em silencio: uma correcao silenciosa
 * seria mais uma configuracao invisivel, que e o defeito que este ficheiro
 * inteiro existe para evitar.
 */
export function assertPollingOptions(options: PollingOptions): void {
  if (options.allowed_updates === undefined) {
    throw new WorkerError(
      'POLLING_FAILED',
      'allowed_updates omitido: o servidor MANTERIA a configuracao anterior, ' +
        'que e estado invisivel guardado do lado do Telegram.',
    )
  }
  /* A LISTA VAZIA E PIOR DO QUE A OMISSAO, e esta verificacao so existe porque
     o teste da revisao adversarial a apanhou a passar.
     ------------------------------------------------------------------------
     `allowed_updates: []` NAO significa "nenhum". A doc da Bot API e explicita:
     «Specify an empty list to receive all update types except chat_member,
     message_reaction, and message_reaction_count (default).» E o RESET PARA O
     CONJUNTO POR OMISSAO — a superficie FECHADA de dois tipos abre-se para mais
     de vinte, em silencio, e o parser deste worker passa a receber updates que
     ninguem desenhou para ele.

     Omitir e mau porque MANTEM estado invisivel; a lista vazia e mau porque
     ABRE. Sao defeitos diferentes e sao recusados em separado. */
  if (options.allowed_updates.length === 0) {
    throw new WorkerError(
      'POLLING_FAILED',
      'allowed_updates vazio: na Bot API isso NAO e "nenhum", e o reset para o ' +
        'conjunto por omissao — abre a superficie fechada de dois tipos para mais de vinte.',
    )
  }
  if (options.timeout === undefined || options.timeout > LONG_POLL_MAX_TIMEOUT) {
    throw new WorkerError(
      'POLLING_FAILED',
      `timeout tem de existir e ser <= ${LONG_POLL_MAX_TIMEOUT} (o servidor clampa la de qualquer forma).`,
    )
  }
  if (options.drop_pending_updates !== true) {
    throw new WorkerError(
      'POLLING_FAILED',
      'drop_pending_updates tem de ser true no boot: ate 24 h de comandos represados ' +
        'executariam de uma vez ao arrancar.',
    )
  }
}
