/**
 * Contrato do canal IPC host <-> worker do Telegram. CONGELADO no COMMIT PREP 4;
 * EMENDADO pelo COMMIT PREP 5, que acrescentou `notify` e `pairing.challenge`.
 *
 * LEITURA LIVRE, ESCRITA PROIBIDA na Onda 5 (03-ONDAS.md 16).
 *
 * ===========================================================================
 * PORQUE O BOT E UM SUBPROCESSO, E NAO CODIGO DENTRO DA FIBER
 * ===========================================================================
 * `01-ARQUITETURA.md` 5. O modelo de Fibers do Cordis NAO e argumento a favor
 * de in-process aqui — e o contrario. Um subprocesso sob `ctx.effect()` com
 * disposer sincrono cumpre o contrato "o recurso e erradicado em LIFO quando a
 * Fiber morre" tao bem quanto um objecto em memoria, **com a vantagem de o
 * recurso ser separavel**.
 *
 * A parte do contrato que in-process **nao consegue** cumprir e a do ambiente
 * construido por allowlist (`buildWorkerEnv`), que e a **unica defesa entre um
 * parser de mensagens vindas da internet e a credencial do plano de controlo**.
 * Comprometido um bot in-process, `/proc/self/environ` entrega tudo.
 *
 * ===========================================================================
 * O CANAL: JSONL BIDIRECIONAL SOBRE `stdin`/`stdout` DO FILHO
 * ===========================================================================
 * Sem socket, sem porta, sem ficheiro. `stdio` passa de
 * `['ignore','pipe','pipe']` para `['pipe','pipe','pipe']` (T4.3), e o
 * protocolo e **uma linha JSON por mensagem**.
 *
 * Quatro propriedades que este canal da de graca, e que uma porta local nao dava:
 *
 * 1. **Nao abre superficie nova.** Um socket HTTP local de controlo seria mais
 *    uma porta para guardar e mais um caminho para auditar. O pipe so existe
 *    entre pai e filho.
 *
 * 2. **DEAD-MAN'S SWITCH.** Se o processo `dsh` for morto com `SIGKILL`, o
 *    `stdin` do filho fecha; o worker deteta EOF e **termina sozinho**. E a
 *    unica defesa que sobrevive a um `SIGKILL` no supervisor, porque
 *    `detached` + `kill(-pid)` no disposer depende de o disposer chegar a
 *    correr.
 *
 *    >>> ATENCAO — NAO COPIE A DECISAO DA ONDA 3 PARA AQUI. <<< Na Onda 3
 *    ficou registado que o dead-man's switch por pipe **nao servia** para o
 *    `cloudflared`. A razao era ESPECIFICA: o mecanismo exige que o filho
 *    **coopere** (detete o EOF e se mate), e o `cloudflared` e binario de
 *    terceiros que nao coopera. **O worker do Telegram e codigo NOSSO e
 *    coopera.** Aqui o controlo e exigivel, e `04-TESTES.md` mede-o:
 *    `SIGKILL` no host -> worker morto em **< 2 s medido**, nao afirmado.
 *
 * 3. **Segredos continuam fora do Telegram.** O que atravessa o canal e uma
 *    INTENCAO (`tunnel.up`), **nunca uma credencial**. Ver a invariante S3.
 *
 * 4. **Backpressure e recuperacao explicitas.** Uma linha malformada e
 *    detetada e **descartada sem derrubar o canal** — que e o comportamento
 *    certo quando a outra ponta e um processo que pode ter sido reiniciado a
 *    meio de uma escrita.
 */

// ---------------------------------------------------------------------------
// INVARIANTES — sao contrato, e cada uma tem um teste com dono
// ---------------------------------------------------------------------------

/**
 * **S1 — UMA MENSAGEM POR LINHA, UTF-8, terminada em `\n`.**
 * Sem `\r`, sem pretty-print, sem `\n` dentro de string por escapar. O parser
 * do outro lado divide por `\n` e nada mais.
 *
 * **S2 — DISCIPLINA DE FLUXO, e ela e a que mais se viola.**
 * O worker escreve **EXCLUSIVAMENTE** JSONL em `stdout`. **TODO** log humano
 * vai para `stderr`. Regra de uma linha — mas violada, o parser do pai passa a
 * ver ruido, e o modo de falha e silencioso: o canal parece vivo e as
 * mensagens somem. Isto muda o habito anterior, em que o `stdout` do filho ia
 * para `logger.debug` linha a linha.
 *
 * **S3 — NENHUM SEGREDO NO PAYLOAD. Nem um.**
 * Nao viaja aqui: a senha do plugin, o seu digest, o token do bot, o `ott`, o
 * `mk` do link magico, nem caminho absoluto de ficheiro do utilizador. A URL
 * do tunel **pode** viajar (`02-SEGURANCA.md` 2.2: nao e segredo, e amostragem
 * publica devolveu dezenas de hostnames vivos). O criterio de aceite nao e o
 * `git grep` — e o teste comportamental que **provisiona um segredo conhecido**,
 * exercita **todos** os caminhos que produzem payload, serializa cada um, e
 * assere que a string do segredo **nao aparece em nenhum, em codificacao
 * nenhuma**.
 *
 * **S3-b — A EXCECAO UNICA E NOMEADA: O DIGEST DO CODIGO DE PAREAMENTO.**
 * (COMMIT PREP 5.) A mensagem `pairing.challenge` transporta o sha256 do
 * codigo de pareamento de 6 digitos, e S3 diz "nem o digest" — com razao,
 * para o SEGREDO PERMANENTE. O codigo de pareamento e diferente em TUDO o
 * que importa: espaco de 10^6 (o digest e reversivel por forca bruta em
 * milissegundos), TTL de 5 minutos, e IMPRESSO NO TERMINAL da maquina —
 * quem consegue ler este pipe ja esta na maquina e ja o pode ler no ecra.
 * A regra nao foi relaxada; foi SEPARADA EM DUAS:
 *
 *   - o digest NUNCA sai da maquina: proibido em log, em stderr, em payload
 *     para o Telegram, em `callback_data`, em qualquer resposta a um pedido;
 *   - o worker guarda-o apenas como VERIFICADOR em memoria (rotacao via
 *     `rotateChallenge` de T4.4) e nunca o devolve ao canal.
 *
 * O teste comportamental de S3 (SEC-14) permanece INTEGRAL: ele mede o
 * segredo PERMANENTE, e continua a exigir vazio.
 *
 * **S4 — LINHA MALFORMADA E DESCARTADA, O CANAL SOBREVIVE.**
 * JSON invalido, `v` desconhecido, `type` desconhecido, linha truncada:
 * regista-se e segue-se. **Nunca derrubar o canal** — a outra ponta pode ter
 * sido reiniciada a meio de uma escrita, e derrubar transforma um byte perdido
 * numa queda de servico.
 *
 * **S5 — O WORKER NAO VALIDA NONCE, E ISSO E ESTRUTURAL.**
 * O nonce de confirmacao de duas etapas e **emitido e consumido no HOST**
 * (`src/control/confirm.ts`, T5.1). O worker apenas o **transporta opaco**
 * dentro do `callback_data`. Um nonce validado no processo que fala com a
 * internet **nao e um controlo, e uma variavel**. Pela mesma razao,
 * `callback_data` **nunca** e prova de autorizacao: sao 1-64 **bytes**
 * fornecidos pelo cliente (um acento consome 2), e um cliente modificado manda
 * o que quiser.
 *
 * **S6 — A ALLOWLIST DE IDENTIDADE VIVE NO WORKER; O NONCE VIVE NO HOST.**
 * Os dois **nao podem trocar de lado**. A allowlist (`worker/auth/allowlist.ts`)
 * tem de rejeitar antes de o update chegar ao canal, senao o host vira
 * executor de qualquer coisa que a internet mande.
 */
export const IPC_PROTOCOL_VERSION = 1

/** Toda mensagem carrega a versao. Versao desconhecida cai na regra S4. */
export interface IpcEnvelope {
  readonly v: typeof IPC_PROTOCOL_VERSION
}

// ---------------------------------------------------------------------------
// host -> worker
// ---------------------------------------------------------------------------

/**
 * Difusao de estado. O host e a **fonte unica da verdade**; o bot e uma
 * PROJECCAO e nao mantem estado proprio alem do ultimo `seq` que viu.
 *
 * `seq` e **monotonico**. Serve para o worker descartar uma difusao fora de
 * ordem em vez de retroceder a UI — o que aconteceria num flapping de tunel,
 * onde duas difusoes podem cruzar-se no pipe.
 *
 * `url` esta presente **se e so se** `state === 'READY'`, pela mesma razao que
 * `TunnelSnapshot.info` o esta: a URL e informacao sensivel de operacao e o
 * contrato torna impossivel divulga-la a partir de `STARTING` ou `DEGRADED`.
 */
export interface IpcStateMessage extends IpcEnvelope {
  readonly type: 'state'
  /** Os SEIS estados de `./tunnel.ts`, em ingles. O rotulo PT e so texto de UI. */
  readonly state: 'STOPPED' | 'STARTING' | 'READY' | 'DEGRADED' | 'STOPPING' | 'FAILED'
  readonly seq: number
  /** Presente sse `state === 'READY'`. */
  readonly url?: string | undefined
  /** Epoch ms em que o TTL expira. Presente sse `state === 'READY'`. */
  readonly expiresAt?: number | undefined
}

/**
 * Resposta a uma intencao. **Sempre** emitida — inclusive nos caminhos de erro.
 * Sem `ack`, o cliente do Telegram fica com a barra de progresso eterna, e o
 * dono nao sabe se o comando chegou.
 *
 * `result`:
 * - `accepted`  — a intencao foi aceite e o estado esta a mudar.
 * - `noop`      — ja estava no estado pedido. **Idempotencia por `requestId`**:
 *                 um `start` em `READY` devolve a URL vigente, **nao** um
 *                 segundo tunel.
 * - `rejected`  — recusada. Ver `code`. **D29:** um `start` recebido em
 *                 `STOPPING` e **REJEITADO** com `SHUTDOWN_IN_PROGRESS`, e
 *                 **NUNCA enfileirado**. Enfileirar transforma o kill switch
 *                 numa operacao de resultado incerto: o dono manda
 *                 `/emergencia`, ve o tunel cair, e ele **volta sozinho**
 *                 porque havia um `start` na fila. Todo controlo temporal deste
 *                 plano (TTL, modo restrito, invalidacao de sessao) pressupoe
 *                 que derrubar a exposicao e **terminal** ate nova accao
 *                 explicita. Rejeitar e fail-closed; enfileirar e fail-open.
 */
export interface IpcAckMessage extends IpcEnvelope {
  readonly type: 'ack'
  /** O `requestId` da intencao que originou este `ack`. ULID gerado na superficie. */
  readonly requestId: string
  readonly result: 'accepted' | 'noop' | 'rejected'
  /** Estado apos a decisao, para o worker actualizar a mensagem in-place. */
  readonly state: IpcStateMessage['state']
  /** Presente sse `result === 'rejected'`. */
  readonly code?: IpcErrorCode | undefined
}

/**
 * Erro nao ligado a uma intencao especifica, ou falha durante a execucao de uma.
 *
 * `message` e **mostrada ao dono no Telegram**. Portanto, pela invariante S3 e
 * pela mesma regra que ja governa `TunnelFailure.message`: **sem segredo, sem
 * token, sem caminho absoluto de ficheiro**. Um caminho de ficheiro numa
 * mensagem que sai da maquina divulga o layout do disco do utilizador a um
 * terceiro — a infraestrutura do Telegram.
 */
export interface IpcErrorMessage extends IpcEnvelope {
  readonly type: 'error'
  /** Ausente quando o erro nao decorre de uma intencao. */
  readonly requestId?: string | undefined
  readonly code: IpcErrorCode
  /** Accionavel, em portugues, e sujeita a S3. */
  readonly message: string
}

/**
 * Vocabulario FECHADO de codigos de erro. Fechado de proposito: o worker
 * renderiza texto por codigo, e um codigo novo que ele nao conheca vira
 * mensagem generica — logo acrescentar um e mudanca de contrato, nao detalhe.
 *
 * - `SHUTDOWN_IN_PROGRESS` — `start` durante `STOPPING` (D29).
 * - `EXPOSURE_DISABLED`    — `exposure.mode !== 'tunnel'`. Nao e erro do dono:
 *                            e configuracao, e a mensagem diz qual chave mudar.
 * - `RESTRICTED_MODE`      — o modo restrito esta activo no `state.json`. **Nao
 *                            sai por comando do bot**: o teto de 100 falhas
 *                            viraria decorativo se o atacante que ja controla o
 *                            chat pudesse reabrir a exposicao no comando
 *                            seguinte.
 * - `PROBE_FAILED`         — o gate nao esta armado. A mensagem NOMEIA a sonda.
 * - `TUNNEL_FAILED`        — estado terminal; exige `reset()` humano.
 * - `NOT_PAIRED`           — ainda nao houve `/parear`.
 * - `NONCE_INVALID`        — nonce ausente, expirado ou ja consumido. Note que
 *                            quem decide isto e o HOST (S5).
 * - `RATE_LIMITED`         — pedido a mais. Existe para o canal do bot, nao so
 *                            para o HTTP.
 * - `INTERNAL`             — o resto. A `message` nao pode denunciar topologia.
 */
export type IpcErrorCode =
  | 'SHUTDOWN_IN_PROGRESS'
  | 'EXPOSURE_DISABLED'
  | 'RESTRICTED_MODE'
  | 'PROBE_FAILED'
  | 'TUNNEL_FAILED'
  | 'NOT_PAIRED'
  | 'NONCE_INVALID'
  | 'RATE_LIMITED'
  | 'INTERNAL'

// ---------------------------------------------------------------------------
// worker -> host
// ---------------------------------------------------------------------------

/**
 * Vocabulario FECHADO de intencoes da v0.1. Casa com a lista de comandos que
 * `setMyCommands` publica (T5.2), menos os que nunca atravessam o canal.
 *
 * - `tunnel.up`     — `/ligar`.       AUMENTA exposicao -> **exige nonce**.
 * - `tunnel.down`   — `/desligar`.    REDUZ exposicao   -> **dispensa nonce**.
 * - `tunnel.status` — `/status`.      Leitura pura. **Nao estende o TTL**.
 * - `session.issue` — `/acessar`. Emite o link magico de uso unico.
 * - `secret.rotate` — `/rotacionar`.  AUMENTA exposicao -> **exige nonce**.
 * - `emergency`     — `/emergencia`.  REDUZ  -> **dispensa nonce**. Em panico,
 *                     o botao tem de funcionar **a primeira**.
 *
 * `/parear` NAO esta aqui: o pareamento resolve-se **dentro do worker**
 * (`worker/auth/pairing.ts`) e o host so e informado do resultado. `/start`
 * tambem nao: e boas-vindas inocuo e **nao pareia ninguem**.
 *
 * A **semantica de controlo** destas intencoes — transicoes legais, maquina de
 * estado, `ControlIntent` completo — e congelada no **COMMIT PREP 5**
 * (`src/contracts/control.ts`). Este ficheiro congela so o **transporte**.
 */
export type IpcIntentName =
  | 'tunnel.up'
  | 'tunnel.down'
  | 'tunnel.status'
  | 'session.issue'
  | 'secret.rotate'
  | 'emergency'

/**
 * Intencao vinda do worker.
 *
 * `from` e `chat` sao **ids numericos**, nunca username — username e mutavel e
 * sequestravel. Chegam aqui **ja filtrados** pela allowlist do worker (S6); o
 * host **volta a verificar** contra o pareamento persistido, porque uma
 * verificacao no processo que fala com a internet e a primeira a cair se esse
 * processo for comprometido.
 *
 * `nonce` viaja **opaco**. O worker nao o le, nao o valida e nao o gera (S5).
 */
export interface IpcIntentMessage extends IpcEnvelope {
  readonly type: 'intent'
  readonly intent: IpcIntentName
  /** ULID gerado na superficie. E a CHAVE DE IDEMPOTENCIA: repetido devolve o resultado da primeira execucao. */
  readonly requestId: string
  /** `from.id` do update do Telegram. Numerico. */
  readonly from: number
  /** `chat.id` do update. Numerico. Distinto de `from` em grupo. */
  readonly chat: number
  /** Presente nas intencoes que aumentam exposicao. Opaco para o worker. */
  readonly nonce?: string | undefined
}

// ---------------------------------------------------------------------------
// PREP 5 — as duas mensagens novas
// ---------------------------------------------------------------------------

/**
 * Notificacao proativa. Composta pelo HOST (`src/audit/notify.ts`, T5.4),
 * renderizada pelo WORKER (T5.2). Best-effort por construcao: a falha de
 * entrega nao derruba o canal nem o pedido que a originou.
 *
 * `texto` e MOSTRADO ao dono no Telegram: vale a mesma regra de
 * `IpcErrorMessage.message` — sem segredo, sem token, sem caminho absoluto
 * (S3). O `\n` e legitimo (mensagem de varias linhas); controlo nao.
 *
 * O mapeamento texto -> botoes inline NAO viaja: e decisao de T5.2, dona dos
 * comandos, e usa a gramatica `g1:<accao>:<token>` de `worker/lib/keyboard.ts`.
 */
export interface IpcNotifyMessage extends IpcEnvelope {
  readonly type: 'notify'
  /** 1..4096 caracteres (limite de mensagem do Telegram). */
  readonly texto: string
}

/**
 * O desafio de pareamento, a UNICA forma em que o codigo pode atravessar o
 * canal: como DIGEST, nunca em claro (a lacuna reportada por T4.4 — o codigo
 * e gerado no host, verificado no worker, e antes nao havia canal).
 *
 * `digest` = sha256 hex de 64 caracteres do codigo de 6 digitos. O worker
 * constroi o VERIFICADOR a partir dele — a mesma reducao que
 * `createPairingChallenge` (T4.4) faz do claro — e rota o desafio com
 * `rotateChallenge`. Ver a invariante S3-b: o digest e reversivel em
 * milissegundos e NUNCA sai da maquina.
 */
export interface IpcPairingChallengeMessage extends IpcEnvelope {
  readonly type: 'pairing.challenge'
  /** sha256 hex, 64 caracteres. Nunca em log (S3-b). */
  readonly digest: string
  /** Epoch ms em que o codigo deixa de valer. TTL de 5 min decidido no host. */
  readonly expiresAt: number
}

// ---------------------------------------------------------------------------
// A uniao
// ---------------------------------------------------------------------------

/**
 * host -> worker. O COMMIT PREP 5 acrescentou `notify` e `pairing.challenge`
 * a esta uniao; a partir daqui e ela que define o vocabulario do sentido.
 */
export type IpcMessageToWorker =
  | IpcStateMessage
  | IpcAckMessage
  | IpcErrorMessage
  | IpcNotifyMessage
  | IpcPairingChallengeMessage

/** worker -> host. */
export type IpcMessageFromWorker = IpcIntentMessage

export type IpcMessage = IpcMessageToWorker | IpcMessageFromWorker

/**
 * Resultado de tentar ler uma linha do canal.
 *
 * Isto e um **tipo de retorno, nao uma excecao**, e e deliberado: a invariante
 * S4 exige que linha malformada seja descartada **sem derrubar o canal**, e um
 * `throw` no caminho de leitura convida quem chama a deixar o erro subir ate
 * matar o processo. Devolver um veredito obriga a decidir.
 */
export type IpcParseResult =
  | { readonly ok: true; readonly message: IpcMessage }
  | { readonly ok: false; readonly reason: 'json-invalido' | 'versao-desconhecida' | 'tipo-desconhecido' | 'forma-invalida' }
