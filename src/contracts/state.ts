/**
 * Contrato do estado persistente. CONGELADO no COMMIT PREP 2.
 *
 * LEITURA LIVRE, ESCRITA PROIBIDA. Sem este contrato, T2.1 (digest), T2.2
 * (sessoes), T2.3 (modo restrito) e T5.1 (`desiredState`) escreveriam no MESMO
 * ficheiro, em ondas diferentes, sem esquema e sem writer unico — que e
 * exatamente a classe de conflito que o plano existe para evitar.
 *
 * INVARIANTE, congelada com o contrato: `src/state/store.ts` (T2.5) e o UNICO
 * writer do `state.json` em todo o repositorio.
 *
 * A URL do tunel NAO e persistida — e efemera e muda a cada restart. O que se
 * persiste e o `pid` e o `startedAt`, que e o que permite a varredura de orfao
 * no boot (`02-SEGURANCA.md` 9).
 */
export interface PersistedState {
  readonly version: 1
  /** Hex de `sha256(segredo)`. NUNCA o segredo. */
  secretDigest?: string | undefined
  desiredState: 'READY' | 'STOPPED'
  restricted?: { since: number; reason: 'brute-force-ceiling' } | undefined
  tunnel?: { pid: number; startedAt: number; mode: 'quick' | 'named' } | undefined
  pairing?: { ownerUserId: number; ownerChatId: number; pairedAt: number } | undefined
  /**
   * Provedor de mensageria persistido (desacoplamento do bot, D3).
   *
   * ADITIVO e OPCIONAL: ausente = `telegram`. A preservacao v1 no disco
   * continua valida intacta — um `state.json` v1 sem este campo le como o
   * default fechado, e nenhum `emptyState()` ganha a chave. A escrita so o
   * grava quando for relevante; enquanto so existir o telegram, o campo tende
   * a nem aparecer, e e essa ausencia que o schema le como `telegram`.
   */
  provider?: 'telegram' | undefined
}

export interface StateStore {
  /** RECUSA carregar se o modo do ficheiro for mais frouxo que 0600 (fail loud). */
  read(): PersistedState
  /** Escrita atomica: ficheiro temporario NO MESMO DIRETORIO, `fsync`, `rename`. */
  update(fn: (s: PersistedState) => PersistedState): void
}
