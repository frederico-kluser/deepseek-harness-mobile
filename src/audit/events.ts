/**
 * Vocabulario fechado de eventos de auditoria e de notificacao. DONO: T5.4.
 *
 * O COMMIT PREP 5 congela AQUI apenas o que o ponto de chamada em
 * `src/http/gate.ts` precisa para emitir sem depender de ninguem: a forma do
 * evento `sessao_nova`, o registo de observadores e o emit. O RESTO do
 * vocabulario (primeira falha de autenticacao por janela, toggle do tunel,
 * TTL, modo restrito, `magic.crawler-suspect`, relatorio periodico) e
 * preenchido por T5.4 nesta onda — sem tocar em gate.ts.
 *
 * A ORDEM E CONTRATO: o `audit.append` corre ANTES do fan-out (o ponto em
 * gate.ts chama `recordAudit` primeiro). "O log e a fonte da verdade; a
 * notificacao e best-effort" (03-ONDAS 10, T5.4).
 */

import type { AuditEvent } from '../contracts/auth.ts'
import type { GuardLogger } from '../logging/logger.ts'

/**
 * Evento: uma sessao autenticou com sucesso PELA PRIMEIRA VEZ.
 *
 * O que "primeira vez" significa exatamente: o portao ja viu (e autorizou)
 * pedidos com aquele `idHash`? O portao mantem a memoria por processo
 * (`src/http/gate.ts`, teto 1024 com eviccao da mais antiga); um reinicio do
 * DSH re-emite para a mesma sessao — aceite e deliberado: notificar duas
 * vezes e melhor do que nao notificar.
 *
 * NAO HA `ip_normalizado` neste evento, de proposito: sob tunel a identidade
 * de IP so e confiavel se `trustEdgeHeaders` estiver ligado (S2), e um
 * consumidor que dependa do campo decidiria por um dado que pode ser lixo.
 */
export interface SessaoNovaEvent extends AuditEvent {
  readonly evento: 'sessao_nova'
  readonly resultado: 'permitido'
  readonly sessao_id_hash: string
  readonly ip_normalizado?: never
}

/** Consumidor do evento. NUNCA lanca para o emit (ver `emitSessaoNova`). */
export type SessaoNovaObserver = (evento: SessaoNovaEvent) => void

const observadores: SessaoNovaObserver[] = []

/**
 * Regista um observador e devolve o desregisto. Idempotente: chamar o
 * desregisto duas vezes nao faz nada.
 */
export function registerSessaoNovaObserver(observador: SessaoNovaObserver): () => void {
  observadores.push(observador)
  let removido = false
  return () => {
    if (removido) return
    removido = true
    const indice = observadores.indexOf(observador)
    if (indice >= 0) observadores.splice(indice, 1)
  }
}

/**
 * Chamado pelo ponto congelado em `src/http/gate.ts`, DEPOIS do audit.
 * Best-effort: um observador que lance NAO derruba o pedido nem os
 * observadores seguintes — a notificacao nunca pode bloquear a requisicao do
 * utilizador (03-ONDAS 10, T5.4). O erro vai ao log do operador e segue
 * (05-QUALIDADE 6.3: o chamador nao pode fazer nada — propagar abortaria a
 * requisicao aprovada por causa de uma notificacao).
 */
export function emitSessaoNova(evento: SessaoNovaEvent, log: GuardLogger): void {
  // `slice()` e deliberado: um observador que se desregiste DURANTE o proprio
  // disparo nao pode fazer o seguinte saltar (splice a meio de for-of vivo).
  for (const observador of observadores.slice()) {
    try {
      observador(evento)
    } catch (error) {
      log.warn(
        'notificacao de sessao nova falhou (best-effort; o audit ja foi escrito): ' +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
