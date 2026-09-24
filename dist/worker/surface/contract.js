/**
 * O CONTRATO NEUTRO DA SUPERFICIE DE MENSAGERIA — o que QUALQUER provedor
 * (Telegram hoje, WhatsApp/Matrix/Signal/Slack amanha) implementa, e o
 * que o nucleo neutro consome.
 *
 * DONO: onda 1 do desacoplamento parler-to-providers. LEITURA LIVRE nos
 * ficheiros de referencia (`worker/commands/router.ts` §6-8,
 * `worker/auth/{guard,allowlist,pairing}.ts`, `worker/lib/{outbox,keyboard}.ts`
 * e `src/contracts/ipc.ts`); ESCRITA PROIBIDA em qualquer outro arquivo.
 *
 * ===========================================================================
 * A FRONTEIRA (D4): TELEGRAM VIRA STRING, E NADA DE grammY AQUI DENTRO
 * ===========================================================================
 * Os ids numericos do Telegram (`from.id`, `chat.id`) viram strings na fronteira
 * neutra: {@link SurfaceIdentity}. Cada provedor normaliza as suas chaves para
 * `userKey`/`chatKey` (ver `./ids.ts`) e o nucleo neutro nunca toca um `number`.
 * Manter os campos como `string` e deliberado:
 *   - remove a dependencia do alfabeto numerico de um provedor especifico
 *     (WhatsApp usa strings, Matrix urls, Signal numeros em formato proprio);
 *   - `chatKey` guarda o id da conversa, `userKey` o id de quem age — os DOIS
 *     eixos que `worker/auth/allowlist.ts` revalida em cada update (TG-002/003)
 *     e que `worker/auth/pairing.ts` grava no dono.
 *
 * NENHUM tipo aqui importa de `grammy`, de `worker/lib/*` nem de qualquer
 * arquivo existente fora de `src/contracts/`. O contrato e self-contained:
 * importa APENAS `IpcIntentName`/`IpcIntentMessage` (tipos puros de
 * `src/contracts/ipc.ts`, a unica coisa de `src/` que o worker pode importar —
 * `05-QUALIDADE-CODIGO.md` 5.5) — e, mesmo esses, so onde a semantica os exige.
 *
 * ===========================================================================
 * O PONTE DIVIDIDO: ADAPTADOR PRODUZ EVENTOS, SENDER ENTREGA, NUCLEO DECIDE
 * ===========================================================================
 * Um `ProviderAdapter` e DONO do seu proprio loop de consumo (long polling,
 * webhook, socket...) e EMPURRA {@link SurfaceEvent} para o handler que o
 * nucleo lhe passa no `start()`. O nucleo neutro nao sabe o que e polling nem
 * webhook — sabe apenas que, por cada evento, aplica a allowlist de dois eixos e
 * o receptor de pareamento, e produz uma ou mais saidas atraves do
 * {@link SurfaceSender}. O truque da divisao:
 *
 *   - ENTRADA (o que o provedor produz):  {@link SurfaceEvent} — COMANDO ou ACAO.
 *   - SAIDA  (o que o provedor entrega):  {@link SurfaceSender} — enviar/editar/
 *     responder, com {@link SurfaceSendOptions.actionRows} para botoes.
 *
 * O adaptador e assim responsavel por TRADUZIR o clique de um botao num evento
 * de ACAO neutro ({@link SurfaceEvent}), e por RENDERIZAR as linhas de acao
 * neutras ({@link ActionRow}) no formato visual do provedor.
 *
 * ===========================================================================
 * O TOKEN VIAJA OPACO (S5) — O HOST VALIDA, O NUCLEO NEUTRO SO TRANSPORTA
 * ===========================================================================
 * {@link SurfaceAction} carrega um token OPACO: o nucleo neutro nao o gera, nao
 * o valida, nao o guarda (invariante **S5** de `src/contracts/ipc.ts`). O token
 * e emitido pelo host e consumido pelo host; o nucleo apenas o transporta do
 * clique do botao ate ao `nonce`/target do intent. {@link SurfaceActionData}, o
 * payload serializado que o adaptador coloca no botao, e o equivalente neutro do
 * `callback_data` do Telegram — e a forma verifica-se por nos, o valor nao.
 */
export {};
//# sourceMappingURL=contract.js.map