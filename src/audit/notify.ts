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
import type { HostIpcChannel } from '../telegram/ipc.ts'

/**
 * Fabrica do observador de "sessao nova". A notificacao viaja pelo IPC
 * host -> worker (mensagem `notify` de `src/contracts/ipc.ts`) e e renderizada
 * por T5.2. `canal` e o canal que T5.1 cria na fiacao (`src/index.ts`) e
 * entrega AQUI — um observador com zero argumentos obrigaria T5.4 a um
 * singleton de modulo, que a regra "nada de estado global" (05-QUALIDADE 4.2)
 * proibe. TODO(T5.4): preencher o corpo.
 *
 * O corpo atual e INERTE de proposito: enquanto o consumidor nao existe, o
 * evento so escreve o audit — que ja e o controlo primario (o Telegram e
 * entrega best-effort, nunca a fonte da verdade).
 */
export function criarObservadorSessaoNova(canal: Pick<HostIpcChannel, 'send'>): SessaoNovaObserver {
  void canal
  return () => {}
}
