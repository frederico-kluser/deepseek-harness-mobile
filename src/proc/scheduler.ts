/**
 * Agendador injetavel -- a costura minima sobre `setTimeout`/`clearTimeout`.
 *
 * PORQUE E UM MODULO PROPRIO: "agendar trabalho futuro" e uma responsabilidade
 * distinta de "supervisionar um processo filho". O supervisor CONSOME um
 * agendador; nao e dono da forma dele. Manter os dois juntos obrigava qualquer
 * consumidor futuro de tempo (o TTL do tunel da Onda 3, o nonce de confirmacao
 * da Onda 5) a importar o supervisor inteiro para lhe pedir um temporizador.
 *
 * PORQUE E INJETAVEL: um teste que espera 500 ms reais e um teste lento e
 * instavel. Com o agendador injetado, a progressao de backoff verifica-se em
 * microssegundos e de forma determinista, e o disposer prova que nao deixa
 * temporizadores vivos sem depender do relogio da maquina.
 */

/**
 * Handle opaco de temporizador. Opaco DE PROPOSITO: permite injetar um agendador
 * falso nos testes sem depender do tipo `NodeJS.Timeout`.
 */
export type TimerHandle = unknown

/** Costura minima sobre `setTimeout`/`clearTimeout`. */
export interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
}

/** Implementacao real, assente nos temporizadores do Node. */
export const nodeScheduler: Scheduler = {
  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return globalThis.setTimeout(callback, delayMs)
  },
  clearTimeout(handle: TimerHandle): void {
    // O handle so pode ter vindo do `setTimeout` acima; a asercao devolve-lhe o
    // tipo concreto que a API do Node exige.
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}

/**
 * Dependencias de TEMPO de qualquer supervisor: quando agendar, com que
 * dispersao, e que horas sao.
 *
 * Estao aqui, e nao no supervisor, pela mesma razao que o `Scheduler` esta: sao
 * a costura do tempo, nao a maquina de estados do processo filho. O supervisor
 * combina-as com as dependencias de SINAL, que sao de `tree-kill.ts`.
 */
export interface ClockDeps {
  scheduler: Scheduler
  random: () => number
  now: () => number
}

/** Relogio real do processo corrente. */
export const defaultClockDeps: ClockDeps = {
  scheduler: nodeScheduler,
  random: Math.random,
  now: Date.now,
}
