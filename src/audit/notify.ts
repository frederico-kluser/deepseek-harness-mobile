/**
 * Composicao da notificacao proativa (best-effort, sempre DEPOIS do log).
 * DONO: T5.4.
 *
 * O COMMIT PREP 5 congela AQUI apenas a ASSINATURA de fabrica que T5.1 fia em
 * `src/index.ts` (a fiacao e dela; o corpo e de T5.4, que mergeia ANTES na
 * ordem de 13.1: T5.4 -> T5.2 -> T5.3 -> T5.1). T5.1 compila contra este
 * esqueleto; no snapshot da integracao o corpo real ja esta no ramo.
 */

import type { SessaoNovaObserver } from './events.ts'

/**
 * Fabrica do observador de "sessao nova". A notificacao viaja pelo IPC
 * host -> worker (mensagem `notify` de `src/contracts/ipc.ts`) e e renderizada
 * por T5.2. TODO(T5.4): preencher o corpo.
 *
 * O corpo atual e INERTE de proposito: enquanto o consumidor nao existe, o
 * evento so escreve o audit — que ja e o controlo primario (o Telegram e
 * entrega best-effort, nunca a fonte da verdade).
 */
export function criarObservadorSessaoNova(): SessaoNovaObserver {
  return () => {}
}
