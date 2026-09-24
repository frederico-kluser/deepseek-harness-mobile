/**
 * `redact()` -- mascara segredos antes de qualquer texto chegar ao log.
 *
 * PORQUE EXISTE, E PORQUE JA AGORA (Q-4: "segredo nunca em log"): o supervisor
 * encaminha stdout/stderr do worker para o logger do DSH. Esse worker e um
 * cliente HTTP do Telegram, e a API do Telegram poe o token DENTRO do caminho do
 * URL (`https://api.telegram.org/bot<n>:<token>/getUpdates`). Basta o bot
 * imprimir um erro de rede -- o que qualquer cliente HTTP faz por omissao -- para
 * o token do bot ficar em claro no log do plano de controlo. Nao e hipotetico:
 * e o formato normal de uma mensagem de excecao de `requests`/`httpx`.
 *
 * DUAS CAMADAS, e a ordem importa:
 *   1. LITERAIS CONHECIDOS. Se ja sabemos o segredo (o `worker.token` vem da
 *      configuracao), a substituicao literal e exata e nao depende de a agulha
 *      ter o formato esperado. E a camada fiavel.
 *   2. FORMAS. Para o que nao conhecemos: a forma de um token de bot, e o VALOR
 *      de um cabecalho `Authorization`/`Cookie` quando o texto e um dump de
 *      pedido. E heuristica, e esta declarada como tal -- apanha o caso comum,
 *      nao substitui a camada 1.
 *
 * O QUE ESTAVA EM FALTA E JA NAO ESTA (costura da Onda 3). Este cabecalho dizia
 * que o `mk` do link magico e o URL do tunel nao estavam aqui porque as formas
 * ainda nao tinham sido fixadas, e que os donos as acrescentariam. Foram
 * fixadas -- T2.2 fixou o `mk`, T3.1/T3.2 fixaram o URL do quick tunnel -- e
 * estao agora em {@link SECRET_SHAPES}, com o caminho do `$HOME` a acompanhar.
 *
 * ATE ENTAO ELAS VIVIAM EM DUPLICADO, e essa e a razao de a promocao ser uma
 * correccao e nao arrumacao: `maskAuditText` (`src/audit/format.ts`) tinha-as, e
 * quem chamasse `redact()` diretamente -- que e TODO o encaminhamento de
 * stdout/stderr de subprocesso, `src/proc/stream-log.ts` -- nao tinha nenhuma.
 * O `cloudflared` imprime a URL do tunel no proprio `stderr` que o supervisor
 * encaminha para o log: a forma faltava exatamente no caminho por onde o
 * segredo passa a cada arranque.
 *
 * O QUE CONTINUA A NAO ESTAR AQUI, e de proposito: as formas que so fazem
 * sentido num log de AUDITORIA (o token de bot CURTO com prefixo `bot`, a cauda
 * de um segredo engolido pela camada 1, e o segredo do plugin em base32). Ver
 * `AUDIT_SHAPES` em `src/audit/format.ts`, que explica cada uma -- sao mais
 * agressivas de proposito, e num log de operador o falso positivo delas custa
 * legibilidade sem comprar nada.
 */
/** Substituto visivel: um log com isto diz ao operador que houve corte. */
export declare const REDACTED = "[REDACTED]";
/**
 * Devolve `text` com os segredos mascarados.
 *
 * @param text texto arbitrario, tipicamente vindo de um processo de terceiros.
 * @param knownSecrets literais que sabemos ser segredos (ex.: `worker.token`).
 */
export declare function redact(text: string, knownSecrets?: readonly string[]): string;
//# sourceMappingURL=redact.d.ts.map