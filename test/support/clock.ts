/**
 * Relogio injetavel. PREP-OWNED: leitura livre, escrita proibida (PREP 2).
 *
 * PORQUE INJETADO E NAO `Date.now()` (`04-TESTES.md` 8.1): o TTL do tunel e de
 * 60 minutos e o timeout absoluto de sessao e de 8 horas. Um teste que esperasse
 * o tempo real seria inviavel; um que mockasse `Date.now()` globalmente
 * contaminaria a suite inteira. O relogio entra como dependencia.
 *
 * Strip-only mode: sem parameter properties, sem enum, sem namespace.
 */
export interface Clock {
  now(): number
}

export const systemClock: Clock = { now: () => Date.now() }

/** Relogio de teste: o tempo so anda quando o teste o manda andar. */
export class FakeClock implements Clock {
  private current: number
  constructor(startAtMs = 0) {
    this.current = startAtMs
  }
  now(): number {
    return this.current
  }
  /** Avanca o tempo. Devolve o novo instante. */
  advance(ms: number): number {
    this.current += ms
    return this.current
  }
  /** Salta para um instante absoluto (para testar relogio que anda para tras). */
  set(ms: number): void {
    this.current = ms
  }
}
