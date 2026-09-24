/**
 * Contrato do canal IPC host <-> worker do Telegram. CONGELADO no COMMIT PREP 4;
 * EMENDADO pelo COMMIT PREP 5, que acrescentou `notify` e `pairing.challenge`.
 *
 * EMENDA-COSTURA-5 (costura da Onda 5, a RATIFICAR no COMMIT PREP 6): acrescenta
 * `nonce.request` e `nonce.issued` — o transporte do nonce de confirmacao de
 * 2 etapas entre o worker e o host. O worker NAO gera nem valida nonce (S5);
 * pede-o por `nonce.request` e recebe-o por `nonce.issued`, sempre OPACO e
 * NUNCA logado (S3). Antes desta emenda o fluxo de /ligar do Telegram nao
 * fechava ponta a ponta (BLOQUEIO T5.2 reportado no handoff).
 *
 * LEITURA LIVRE, ESCRITA PROIBIDA na Onda 5 (03-ONDAS.md 16).
 *
 * EMENDA ONDA-1-IPC-ENVELOPE-STRING (onda 1 da rodada de provedores): o
 * envelope V2 — `from`/`chat` passam de `number` (heranca Telegram) a `string`
 * em `IpcIntentMessage`, `IpcPairingOwnerMessage` e `IpcPairingSuccessMessage`.
 * `IPC_PROTOCOL_VERSION` sobe para 2; a invariante S4 (versao desconhecida =
 * linha descartada, canal sobrevive) torna o bump seguro — host e worker sao
 * spawnados pelo MESMO build, e uma ponta antiga descarta a linha nova em vez
 * de partir. O vocabulario de intents e de codigos de erro NAO muda. A
 * conversao numerica morre na FRONTEIRA dos provedores (o adaptador Telegram
 * converte `from.id`/`chat.id` numericos para string UMA vez, no parse do
 * update); todo o resto do pipeline e string — o prerequisito para provedores
 * com ids nao-numericos (ids grandes nao numericos estouram Number.MAX_SAFE_INTEGER).
 *
 * EMENDA ONDA-4-AGENTS-HOST (onda 4 — o DISPATCHER DE AGENTES no HOST): o
 * vocabulario de intents ganha TRES membros — `agent.dispatch`, `agent.status`
 * e `agent.cancel` — e o `IpcIntentMessage` ganha o campo ADITIVO `params`
 * (presente sse a intent o exige; ver {@link IpcAgentIntentParams}). A NOVA
 * mensagem host -> worker `agent.report` (a lista de runs) fecha o ciclo:
 * resposta a `agent.status` E difusao proativa quando um run termina. Nenhum
 * segredo viaja nestes campos (S3): skill, prompt e agentId sao dados do dono,
 * nunca credenciais — e o request do agente NUNCA recebe token nenhum (o agente
 * roda com as permissoes do harness, nunca com as credenciais deste plugin).
 * A superficie de comandos do bot (Onda 5) e dona de RENDERIZAR estas intents;
 * este contrato congela so o transporte.
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
export const IPC_PROTOCOL_VERSION = 2;
//# sourceMappingURL=ipc.js.map