/**
 * Relogio e espera INJETADOS. Nenhum modulo deste worker chama `Date.now()` ou
 * `setTimeout` diretamente.
 *
 * PORQUE (`04-TESTES.md` 8.1, e os casos TG-043 e TG-049 em concreto): o
 * espacamento de 1 mensagem/segundo por chat e a espera de `retry_after` do 429
 * sao, os dois, "o programa dorme N milissegundos". Um teste que esperasse esse
 * tempo real seria lento e instavel; um que mockasse `setTimeout` globalmente
 * contaminaria a suite inteira. A dependencia entra pela porta da frente.
 *
 * NAO se reutiliza `test/support/clock.ts`: aquele e apoio de TESTE (e so tem
 * `now()`), e codigo de producao nao importa de `test/`.
 */


/** Origem do tempo. Separado de {@link Sleeper} porque ha quem so precise de ler. */
export interface WorkerClock {
  now(): number
}

/**
 * Sinal de cancelamento, ESTRUTURAL.
 *
 * PORQUE NAO `AbortSignal`: o grammY 1.45.1 tipa (e instancia) o sinal a partir
 * do pacote `abort-controller`, cujo `AbortSignal` NAO tem `reason` nem
 * `throwIfAborted` e por isso nao e atribuivel ao `AbortSignal` nativo do
 * `@types/node` 24. Um `as unknown as` calaria o compilador e mentiria sobre o
 * objeto que chega em runtime. Pedir so o que se usa faz os DOIS caberem — o
 * nativo e o do shim — sem cast nenhum.
 */
export interface AbortLike {
  readonly aborted: boolean
  addEventListener(type: 'abort', listener: () => void): void
  removeEventListener(type: 'abort', listener: () => void): void
}

/** Quem sabe esperar. `signal` encurta a espera — usado na paragem do worker. */
export interface Sleeper {
  sleep(ms: number, signal?: AbortLike): Promise<void>
}

/** As duas coisas juntas, que e o que quase todo o consumidor quer. */
export interface TimeSource extends WorkerClock, Sleeper {}

/**
 * Implementacao real.
 *
 * O timer e SEMPRE limpo e o ouvinte SEMPRE removido — nos dois caminhos. Um
 * `setTimeout` esquecido segura o event loop e adia a saida do processo; um
 * ouvinte de `abort` esquecido e uma fuga por cada espera que ocorre, e este
 * worker espera uma vez por mensagem.
 *
 * Abortar RESOLVE em vez de rejeitar. Rejeitar obrigaria cada chamador a apanhar
 * uma excecao que nao descreve erro nenhum — o processo esta a fechar, e isso
 * nao e uma falha. Quem precisa de saber consulta `signal.aborted` a seguir, que
 * e o que o transformer de `./auto-retry.ts` faz.
 *
 * `ms <= 0` resolve JA, sem agendar nada.
 */
export const systemTime: TimeSource = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortLike): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!(ms > 0) || signal?.aborted === true) {
        resolve()
        return
      }
      const onAbort = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal?.addEventListener('abort', onAbort)
    }),
}
