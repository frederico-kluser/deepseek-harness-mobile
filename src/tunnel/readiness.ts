/**
 * =============================================================================
 * READINESS DO TUNEL — "a URL ja responde?", e SO isso.
 * =============================================================================
 *
 * DONO: T3.2. Implementa `TunnelReadiness` de `src/contracts/tunnel.ts`
 * (CONGELADO no COMMIT PREP 3 — leitura livre, escrita proibida).
 *
 * >>> A FRONTEIRA QUE JA CUSTOU CARO. LEIA ANTES DE MEXER. <<<
 * -----------------------------------------------------------------------------
 * Existem DUAS perguntas parecidas, e confundi-las expos o DSH real do
 * utilizador publicamente durante cerca de 40 segundos durante a pesquisa que
 * originou este plugin:
 *
 *   READINESS (este ficheiro)   "a URL do tunel ja responde?"
 *                               Corre DEPOIS de o tunel subir.
 *
 *   PROBE FAIL-CLOSED (T3.1,    "o portao esta armado, isto e, responde 401 a
 *   `src/tunnel/probe.ts`)      quem nao tem credencial?"
 *                               Corre ANTES de o tunel subir, contra
 *                               `127.0.0.1`, e e PRE-CONDICAO de
 *                               `STOPPED -> STARTING`.
 *
 *       "a aplicacao responde"  !=  "a aplicacao responde 401 a quem nao tem
 *                                    credencial"
 *
 * Consequencia directa e contra-intuitiva, escrita aqui para nao ser
 * "corrigida" por engano: um `200` observado por este modulo conta como PRONTO.
 * Ele NAO e o sitio onde se descobre que o portao esta aberto — nessa altura o
 * tunel JA ESTA no ar e a fuga JA aconteceu. Quem tem de recusar um `200`
 * anonimo e o probe de T3.1, antes de existir tunel nenhum. Transformar este
 * ficheiro num segundo probe de seguranca da uma sensacao de rede dupla e
 * fabrica exactamente o buraco que ja se pagou uma vez: a verificacao mudava
 * para DEPOIS da exposicao.
 *
 * E por isso, tambem, que `ReadinessOutcome` carrega `status: number | null` em
 * vez de um booleano so: "porta aberta" e "aplicacao respondeu" nao sao a mesma
 * afirmacao, e o contrato obriga quem chama a olhar para o codigo observado.
 * Um socket que aceita a ligacao e nunca escreve nada devolve
 * `{ usable: false, status: null }` — nao ha nenhum codigo para mostrar porque
 * nunca houve resposta nenhuma.
 *
 * O QUE ESTE MODULO NAO FAZ
 * -----------------------------------------------------------------------------
 *   - NAO envia credencial. As sondagens sao ANONIMAS: mandar a senha do dono
 *     para a borda a cada volta do ciclo era espalhar o segredo por um caminho
 *     que nao precisa dele. Isto tem DOIS fechos, porque a promessa e forte
 *     demais para depender de um: `parseUsableUrl` RECUSA um endereco com
 *     `utilizador:senha@`, e `probeHttp` forca `auth: null` para o caso de
 *     aparecer um chamador que nao passe por aqui. Em `tunnel.mode: 'named'` a
 *     URL vem do dominio do utilizador, por configuracao, e NAO passa por
 *     `discover()` — o caminho e alcancavel em producao.
 *   - NAO ESCREVE EM DISCO (TUN-015), pela mesma razao de `discover.ts`: a URL
 *     de um quick tunnel muda a cada arranque e um valor velho entrega um link
 *     morto com toda a confianca.
 *   - NAO poe a URL em mensagem de erro nenhuma. A invariante de apresentacao
 *     do contrato e explicita: `message` e mostrada ao dono no painel e no
 *     Telegram, e a URL do tunel e informacao sensivel de operacao.
 *
 * Strip-only mode: sem `enum`, sem `namespace`, sem parameter properties.
 */

import { setTimeout as timersSleep } from 'node:timers/promises'

import { probeHttp, TunnelError, type HttpProbe } from './discover.ts'

import type { ReadinessOutcome, TunnelReadiness } from '../contracts/tunnel.ts'

/* ========================================================================== */
/* Politica: que codigo conta como "a aplicacao respondeu"                    */
/* ========================================================================== */

/**
 * Codigos que NAO contam como aplicacao pronta.
 *
 * Nao e uma lista de "erros": um `404` fica de fora desta lista de proposito,
 * porque um `404` foi PRODUZIDO pela aplicacao e portanto prova que o caminho
 * borda -> conector -> aplicacao esta inteiro. O que esta aqui e o conjunto que
 * a BORDA devolve enquanto o conector ainda nao registou, ou seja, respostas em
 * que a aplicacao nunca chegou a ser consultada:
 *
 *   - `502` / `504` — a borda nao conseguiu falar com o conector.
 *   - `503` — indisponivel; e tambem o que o proprio `/ready` do `cloudflared`
 *     devolve enquanto `readyConnections` for `0`.
 *   - `520`-`527` e `530` — a familia de erros da propria Cloudflare. O `530` e
 *     o classico "Argo Tunnel error 1033": o hostname existe na borda e nao ha
 *     tunel do outro lado.
 *
 * NOTA MEDIDA, e e ela que justifica ter uma lista em vez de aceitar qualquer
 * resposta: o `/quicktunnel` devolve o hostname ANTES de o registo DNS existir,
 * e nesse intervalo a borda ja responde — com um destes codigos. Aceitar
 * "qualquer HTTP" declarava o tunel pronto no exacto momento em que ele ainda
 * nao serve para nada, e o dono recebia um link que falha na primeira tentativa.
 */
const EDGE_NOT_READY: ReadonlySet<number> = new Set([
  502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530,
])

/**
 * A aplicacao produziu esta resposta?
 *
 * Exportado para que a decisao seja exercitavel sozinha: e a linha que a revisao
 * adversarial vai querer falsificar, e uma politica que so se consegue observar
 * atraves de um ciclo de sondagem e uma politica que ninguem revê.
 *
 * REPARE NO QUE ESTA AUSENTE: nao ha nenhuma comparacao com `401`. Ver o
 * cabecalho do ficheiro — este modulo NAO e o probe de seguranca.
 */
export function isApplicationResponse(status: number): boolean {
  if (status < 100 || status > 599) return false
  return !EDGE_NOT_READY.has(status)
}

/* ========================================================================== */
/* Limites                                                                    */
/* ========================================================================== */

/**
 * Tecto do `timeoutMs`.
 *
 * Existe para matar, pela raiz, o mutante "timeout infinito": um readiness que
 * se pode configurar para esperar para sempre tem o mesmo defeito que um
 * `Infinity` escrito a mao — o arranque fica preso e nenhum estado terminal
 * chega a ser observado. Dez minutos ja e generoso face aos 6-7 s medidos.
 */
export const MAX_READINESS_TIMEOUT_MS = 600_000

/** Corpo descartado: para esta pergunta so o codigo de estado importa. */
const DISCARD_BODY = 0

/* ========================================================================== */
/* Dependencias injetaveis                                                    */
/* ========================================================================== */

export interface ReadinessDeps {
  readonly now: () => number
  /** Tem de REJEITAR quando `signal` aborta — e o que torna o corte imediato. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly probeUrl: (target: URL, signal: AbortSignal, timeoutMs: number) => Promise<HttpProbe>
  readonly pollIntervalMs: number
  readonly attemptTimeoutMs: number
}

export const defaultReadinessDeps: ReadinessDeps = {
  now: Date.now,
  sleep: async (ms: number, signal: AbortSignal): Promise<void> => {
    await timersSleep(ms, undefined, { signal })
  },
  probeUrl: (target: URL, signal: AbortSignal, timeoutMs: number): Promise<HttpProbe> =>
    probeHttp({ target, signal, timeoutMs, maxBodyBytes: DISCARD_BODY }),
  pollIntervalMs: 500,
  // Mais folgado do que o do `/quicktunnel`: aquele fala com `127.0.0.1`, este
  // atravessa a borda da Cloudflare e volta.
  attemptTimeoutMs: 5000,
}

/* ========================================================================== */
/* Validacao de fronteira                                                     */
/* ========================================================================== */

/**
 * A URL nunca entra na mensagem de erro.
 *
 * Nao e zelo excessivo: um `url` malformado que chegue aqui pode ser exactamente
 * o endereco bom com um caractere a mais, e esta mensagem viaja para o Telegram.
 * O que o operador precisa de saber e QUE passo esta errado, nao qual foi o
 * texto — esse esta no codigo de quem chamou.
 */
function parseUsableUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (cause) {
    throw new TunnelError(
      'INVALID_CONFIG',
      'O endereco entregue a verificacao de disponibilidade nao e um endereco ' +
        'absoluto valido. Quem chama tem de passar o resultado de `discover()`, ' +
        'que ja vem normalizado com esquema.',
      false,
      { cause },
    )
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TunnelError(
      'INVALID_CONFIG',
      'O endereco entregue a verificacao de disponibilidade nao usa HTTP nem ' +
        'HTTPS. Quem chama tem de passar o resultado de `discover()`, que ja vem ' +
        'normalizado com esquema.',
      false,
    )
  }
  // >>> CREDENCIAL EMBUTIDA NO ENDERECO: RECUSA-SE, NAO SE LIMPA. <<<
  //
  // `http.request` copia `username`/`password` de um `URL` para `options.auth`
  // e transforma-os num cabecalho `Authorization: Basic` sem uma palavra. Como
  // esta sondagem corre em ciclo, o segredo iria para a borda ate 1200 vezes
  // por sessao (600 000 ms / 500 ms).
  //
  // O caminho E alcancavel: em `tunnel.mode: 'named'` a URL vem do DOMINIO DO
  // UTILIZADOR, por configuracao de T3.3, e nunca passa por `discover()`. A
  // invariante de `discover()` nao cobre esse caso.
  //
  // RECUSAR e nao limpar em silencio: quem escreveu `dono:senha@` na
  // configuracao tem de saber que aquilo foi ignorado. Limpar sem dizer nada
  // deixa o utilizador convencido de que a credencial esta a ser usada.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TunnelError(
      'INVALID_CONFIG',
      'O endereco do tunel traz credencial embutida (a forma ' +
        '`utilizador:senha@servidor`). A verificacao de disponibilidade e ' +
        'ANONIMA por desenho e recusa-se a enviar essa credencial: ela seria ' +
        'transformada num cabecalho de autenticacao e repetida a cada volta da ' +
        'sondagem, espalhando o segredo por um caminho que nao precisa dele. ' +
        'Retire a credencial do endereco — quem autentica quem entra e o portao ' +
        'do plugin, nao o endereco.',
      false,
    )
  }
  return parsed
}

function assertUsableTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_READINESS_TIMEOUT_MS) {
    throw new TunnelError(
      'INVALID_CONFIG',
      'O prazo da verificacao de disponibilidade tem de ser um numero inteiro de ' +
        `milissegundos entre 1 e ${String(MAX_READINESS_TIMEOUT_MS)}. Um prazo infinito ` +
        'deixa o arranque a espera para sempre e nenhum estado final chega a ser ' +
        'observado. Corrija o valor em vez de esperar que ele seja corrigido por si.',
      false,
    )
  }
}

/* ========================================================================== */
/* Espera                                                                     */
/* ========================================================================== */

/**
 * Constroi a implementacao de {@link TunnelReadiness}.
 *
 * FABRICA e nao singleton, pela mesma razao de `createTunnelDiscovery`: nada de
 * estado global de modulo.
 */
export function createTunnelReadiness(deps: ReadinessDeps = defaultReadinessDeps): TunnelReadiness {
  async function waitUntilUsable(input: {
    readonly url: string
    readonly signal: AbortSignal
    readonly timeoutMs: number
  }): Promise<ReadinessOutcome> {
    const target = parseUsableUrl(input.url)
    assertUsableTimeout(input.timeoutMs)

    const { signal } = input
    const deadline = deps.now() + input.timeoutMs
    // Ultimo codigo OBSERVADO, nao "o codigo do sucesso". Ele sobrevive ao
    // fracasso de proposito: dizer ao chamador que se ficou preso em `502` e
    // informacao operacional, e dizer `null` seria apagar a unica pista.
    let lastStatus: number | null = null

    // `signal.aborted` e mutado de FORA — por quem e dono do processo, no
    // `'close'`/`'error'` dele. O compilador nao sabe disso: depois da primeira
    // leitura ele estreita a propriedade para `false` e NAO volta a alargar nem
    // sequer depois de um `await`. A segunda leitura passava a parecer codigo
    // morto ao `no-unnecessary-condition`, sendo ela precisamente a que apanha
    // o processo a morrer NO MEIO da sondagem. Ler por chamada de funcao e o
    // que faz o compilador e o leitor concordarem — e um aviso de lint que se
    // aprende a ignorar e um aviso que deixou de proteger.
    const aborted = (): boolean => signal.aborted

    for (;;) {
      // Desistir aqui NAO e lancar. O contrato de `waitUntilUsable` nao tem
      // canal de falha, e a resposta honesta a "ja e utilizavel?" quando o
      // processo morreu no meio e simplesmente "nao" — com o ultimo codigo
      // observado, que e o que permite ao supervisor distinguir "nunca atendeu"
      // de "atendeu sempre 502".
      if (aborted()) return { usable: false, status: lastStatus }

      const probe = await deps.probeUrl(target, signal, deps.attemptTimeoutMs)

      if (aborted()) return { usable: false, status: lastStatus }

      if (probe.kind === 'response') {
        lastStatus = probe.status
        if (isApplicationResponse(probe.status)) return { usable: true, status: probe.status }
      }

      if (deps.now() >= deadline) return { usable: false, status: lastStatus }

      try {
        await deps.sleep(deps.pollIntervalMs, signal)
      } catch (error) {
        // Abortar durante a espera e o caso normal de o processo ter morrido.
        // Qualquer outra falha sobe intacta — engolir uma excepcao aqui
        // transformava um defeito de programacao num "nao ficou pronto".
        if (aborted()) return { usable: false, status: lastStatus }
        throw error
      }
    }
  }

  return { waitUntilUsable }
}
