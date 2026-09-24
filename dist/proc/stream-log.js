/**
 * Encaminhamento de `stdout`/`stderr` de um processo filho para o log do host.
 *
 * PORQUE E UM MODULO PROPRIO: e a unica parte do supervisor que toca em segredos,
 * e por isso merece ser lida sozinha. Q-4 diz "segredo nunca em log", e o caminho
 * por onde um segredo entra no log NAO e o nosso codigo — e a saida de um
 * processo de terceiros que decidiu imprimir um erro.
 *
 * O CASO CONCRETO: o worker e um cliente HTTP do Telegram, e a API do Telegram
 * poe o token DENTRO do caminho do URL
 * (`https://api.telegram.org/bot<n>:<token>/getUpdates`). Basta o bot imprimir um
 * erro de rede — o que qualquer cliente HTTP faz por omissao — para o token ficar
 * em claro no log do plano de controlo. O `cloudflared`, do seu lado, imprime
 * URLs de tunel e, em niveis verbosos, cabecalhos inteiros. Por isso TUDO passa
 * por `redact()` antes de chegar ao logger, nos dois sentidos e nos dois
 * processos.
 */
import { redact } from "../logging/redact.js";
/**
 * Liga os ouvintes e devolve o DESARME.
 *
 * O desarme remove SO os ouvintes de `'data'`. Os de `'error'` ficam de proposito:
 * um `EventEmitter` que emite `'error'` SEM ouvinte LANCA no processo
 * hospedeiro, e um EPIPE num stream de um filho ja morto derrubaria o DSH
 * inteiro. Um absorvedor que se remove no fim e um absorvedor que falta
 * exatamente quando o stream esta a fechar.
 */
export function attachStreamLogging(handle, options) {
    const { name, log, secrets } = options;
    const onStdout = (chunk) => {
        log.debug(`[${name} STDOUT]: ${redact(chunk.toString().trim(), secrets())}`);
    };
    const onStderr = (chunk) => {
        log.warn(`[${name} STDERR]: ${redact(chunk.toString().trim(), secrets())}`);
    };
    const absorbStreamError = (error) => {
        log.debug(`[${name} STREAM]: ${error.message}`);
    };
    const logStdout = options.stdoutIsProtocol !== true;
    if (logStdout)
        handle.stdout?.on('data', onStdout);
    handle.stderr?.on('data', onStderr);
    // Os absorvedores de `'error'` ficam nos DOIS streams em qualquer dos modos:
    // eles nao dependem de quem le os dados, e sim de o stream poder falhar.
    handle.stdout?.on('error', absorbStreamError);
    handle.stderr?.on('error', absorbStreamError);
    return () => {
        if (logStdout)
            handle.stdout?.removeListener('data', onStdout);
        handle.stderr?.removeListener('data', onStderr);
    };
}
//# sourceMappingURL=stream-log.js.map