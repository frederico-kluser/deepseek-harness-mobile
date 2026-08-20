/**
 * Wrapper de `ctx.logger` com o escopo do plugin fixo.
 *
 * DUAS RAZOES, ambas medidas contra o `.d.ts` publicado do cordis@4.0.1:
 *
 *   1. `ctx.logger.info(format, ...param)` e PRINTF -- o primeiro argumento NAO
 *      e um escopo. O codigo legado escrevia `ctx.logger.info(LOG_SCOPE, msg)`,
 *      o que produzia a linha certa por acidente (o `msg` sobrava e era
 *      concatenado) e o escopo errado no registo estruturado. A forma correcta
 *      e `ctx.logger(name)`, que devolve um `Logger` NOMEADO.
 *
 *   2. Sendo printf, um `%` DENTRO da mensagem e reinterpretado como
 *      especificador de formato. Este plugin regista caminhos e comandos vindos
 *      da rede -- `/permission danger%2Dfull%2Daccess` e literalmente um dos
 *      casos de teste. Passar a mensagem como ARGUMENTO de um formato `'%s'`
 *      fixo torna o texto opaco ao formatador.
 */

import type { Context } from '../dsh/adapter.ts'

/** Escopo canonico usado em todas as linhas de log deste plugin. */
export const LOG_SCOPE = 'guarded-bot'

/** Superficie de log usada pelo plugin: mensagem ja pronta, sem formatacao. */
export interface GuardLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug(message: string): void
}

/**
 * Cria o logger nomeado do plugin.
 *
 * NAO devolve disposer: `ctx.logger(name)` e uma fachada, nao aloca recurso
 * (o unico registo com ciclo de vida em `LoggerService` e `exporter()`, que
 * este plugin nao usa). Q-2 nao se aplica.
 */
export function createGuardLogger(ctx: Context): GuardLogger {
  const logger = ctx.logger(LOG_SCOPE)

  return {
    info(message: string): void {
      logger.info('%s', message)
    },
    warn(message: string): void {
      logger.warn('%s', message)
    },
    error(message: string): void {
      logger.error('%s', message)
    },
    debug(message: string): void {
      logger.debug('%s', message)
    },
  }
}
