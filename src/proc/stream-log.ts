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

import type { SubprocessHandle } from '../dsh/adapter.ts'
import type { GuardLogger } from '../logging/logger.ts'
import { redact } from '../logging/redact.ts'

export interface StreamLogOptions {
  /** Nome curto do processo, usado como prefixo das linhas. */
  readonly name: string
  readonly log: GuardLogger
  /**
   * Literais conhecidos a mascarar (token do bot, token do named tunnel).
   *
   * >>> FORNECEDOR, avaliado a CADA linha -- nao uma lista capturada aqui. <<<
   * E o mesmo padrao de `openAuditLog` (`src/audit/log.ts`) e pela mesma razao:
   * o segredo pode mudar depois de os ouvintes estarem ligados. O token de um
   * named tunnel vive num ficheiro `0600` que o dono pode rodar, e o hostname do
   * tunel so existe depois de a descoberta correr -- uma lista capturada no
   * `attach` ficava obsoleta exatamente no instante em que passava a importar.
   *
   * A camada de FORMAS (`SECRET_SHAPES`) nao substitui isto: ela cobre o que tem
   * forma conhecida (`*.trycloudflare.com`), e o dominio de um named tunnel e o
   * do PROPRIO DONO -- nenhuma regex o adivinha.
   */
  readonly secrets: () => readonly string[]
}

/**
 * Liga os ouvintes e devolve o DESARME.
 *
 * O desarme remove SO os ouvintes de `'data'`. Os de `'error'` ficam de proposito:
 * um `EventEmitter` que emite `'error'` SEM ouvinte LANCA no processo
 * hospedeiro, e um EPIPE num stream de um filho ja morto derrubaria o DSH
 * inteiro. Um absorvedor que se remove no fim e um absorvedor que falta
 * exatamente quando o stream esta a fechar.
 */
export function attachStreamLogging(
  handle: SubprocessHandle,
  options: StreamLogOptions,
): () => void {
  const { name, log, secrets } = options

  const onStdout = (chunk: Buffer): void => {
    log.debug(`[${name} STDOUT]: ${redact(chunk.toString().trim(), secrets())}`)
  }

  const onStderr = (chunk: Buffer): void => {
    log.warn(`[${name} STDERR]: ${redact(chunk.toString().trim(), secrets())}`)
  }

  const absorbStreamError = (error: Error): void => {
    log.debug(`[${name} STREAM]: ${error.message}`)
  }

  handle.stdout?.on('data', onStdout)
  handle.stderr?.on('data', onStderr)
  handle.stdout?.on('error', absorbStreamError)
  handle.stderr?.on('error', absorbStreamError)

  return (): void => {
    handle.stdout?.removeListener('data', onStdout)
    handle.stderr?.removeListener('data', onStderr)
  }
}
