/**
 * Contrato do store da CHAVE NO LINK do portao (onda 1, remocao do login).
 *
 * A chave no link e o que a Onda 2 vai compor na URL do bot (`?key=<token>`)
 * para autenticar um acesso pelo TUNEL SEM senha (o portao nunca desafia com
 * `WWW-Authenticate`). A implementacao live em `src/session/link-token.ts`,
 * no padrao do `MagicStore` -- mas e REUTILIZAVEL ate a rotacao do segredo.
 *
 * Este ficheiro NÃO tem header "congelado": e novo nesta onda e expressamente
 * o "contrato do link-store no padrao existente" que a sub-tarefa deve expor.
 * Consumidores: o portao (`src/http/gate.ts`) usa `verificar`; a superficie
 * IPC (Onda 2, dona de `src/control/surface-ipc.ts`) consume `emitir`/`revogar`
 * para compor a URL do bot; a fiacao em `src/index.ts` liga `revogar` a
 * `secret.rotate`.
 */
import type { LinkToken, LinkTokenStore } from '../session/link-token.ts'

export type { LinkToken, LinkTokenStore }

/**
 * A superficie minima que a composicao do link precisa (Onda 2).
 *
 * `expiraEm` e `number | undefined`: esta implementacao nao impoe TTL (a
 * chave fecha com a rotacao/queda do tunel), mas o valor NULL (ausencia) e
 * legitimo e a superficie tem de o tolerar.
 */
export interface LinkTokenSurface {
  /** Emite uma chave nova, reutilizavel ate `revogar()`. */
  emitir(): LinkToken
  /** Valida um candidato em tempo constante. */
  verificar(candidato: string): boolean
  /** Invalida a chave corrente (chamado na rotacao do segredo). */
  revogar(): void
}