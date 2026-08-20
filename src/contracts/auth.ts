/**
 * Contratos das primitivas de autenticacao. CONGELADO no COMMIT PREP 2.
 *
 * LEITURA LIVRE, ESCRITA PROIBIDA para toda sub-tarefa, em todas as ondas.
 * Este ficheiro existe para que as cinco sub-tarefas da Onda 2 possam ser
 * escritas em PARALELO sem se verem: elas acoplam-se por ESTE contrato, nao
 * por ficheiro partilhado. Quem precisar de o mudar PARA E REPORTA — a
 * alteracao acontece no COMMIT PREP da onda seguinte, nunca no meio da onda.
 *
 * Assinaturas e JSDoc apenas. SEM IMPLEMENTACAO.
 */
import type { SessionId } from '../brand.ts'

/** Identidade contra a qual o limitador conta falhas. */
export interface Identity {
  /**
   * IP normalizado do cliente, quando existe um confiavel.
   *
   * MEDIDO NA ONDA 0 (spike S2): sob `cloudflared`, `CF-Connecting-IP` traz o
   * IP real e a borda RECUSA com 403 quem o enviar do lado do cliente; mas
   * `X-Forwarded-For` e ACRESCENTADO ao valor do cliente, logo e FORJAVEL. E a
   * origem e sempre `127.0.0.1`, portanto qualquer processo local pode forjar
   * `CF-Connecting-IP` ligando-se direto. Enquanto `exposure.trustEdgeHeaders`
   * for `false`, isto e `undefined` e o limitador conta por sessao/global.
   */
  readonly ip?: string | undefined
  /** Sessao associada, quando ja existe uma. */
  readonly sessionId?: SessionId | undefined
}

/** Evento de auditoria. O vocabulario fechado e de `src/audit/events.ts` (T5.4). */
export interface AuditEvent {
  readonly evento: string
  readonly resultado: 'permitido' | 'negado'
  readonly ip_normalizado?: string | undefined
  readonly sessao_id_hash?: string | undefined
}

/** Sessao emitida pelo `SessionStore`. */
export interface Session {
  readonly id: SessionId
  readonly criadaEm: number
  readonly ultimoUsoEm: number
}

export interface SecretStore {
  /** Gera 256 bits por CSPRNG e persiste APENAS `sha256(segredo)` com modo 0600. */
  provision(): { display: string }
  /** Comparacao em tempo constante sobre digests de 32 bytes. */
  verify(candidate: string): boolean
  /** Invalida as sessoes vivas. */
  rotate(): { display: string }
}

export interface SessionStore {
  create(): SessionId
  validate(id: string): Session | null
  revokeAll(): void
}

export interface RateLimiter {
  /**
   * O atraso e INTERNO. A resposta e sempre `401` com corpo e cabecalhos
   * IDENTICOS aos de credencial errada — nunca `429`, nunca `Retry-After`,
   * que seriam o oraculo que `02-SEGURANCA.md` 6.1 proibe.
   */
  check(identity: Identity): { allowed: boolean; retryAfterMs: number }
}

export interface AuditSink {
  /** `O_APPEND`, modo 0600, com mascaramento obrigatorio antes de escrever. */
  append(event: AuditEvent): void
}
