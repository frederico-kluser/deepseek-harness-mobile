/**
 * O que acontece quando a REDE cai — e porque, sem este ficheiro, nao acontecia
 * nada.
 *
 * ===========================================================================
 * O DEFEITO QUE ISTO CORRIGE (achado de revisao adversarial, ALTA)
 * ===========================================================================
 * Uma falha de rede durante o long polling produzia SILENCIO TOTAL. Medido no
 * artefacto compilado, contra um servidor que destroi todos os sockets:
 *
 *     t=5s   vivo=true  linhas em stderr=1  tentativas getUpdates=2
 *     t=10s  vivo=true  linhas em stderr=1  tentativas getUpdates=4
 *     t=20s  vivo=true  linhas em stderr=1  tentativas getUpdates=7
 *     stderr integral: a linha de ARRANQUE, e mais nada.
 *
 * Duas causas, e nenhuma delas era obvia:
 *
 *  1. O grammY manda o erro de polling para `debugErr` — o pacote `debug`, que
 *     e MUDO sem a variavel `DEBUG`. E `DEBUG` nao esta (nem deve estar) na
 *     `WORKER_ENV_ALLOWLIST`: o ambiente do worker e construido, nao herdado.
 *
 *  2. `bot.catch` NAO e chamado. Ele cobre erros de MIDDLEWARE, e o ciclo de
 *     polling nao passa por middleware nenhum. Quem escreve `bot.catch` a
 *     pensar que apanhou a rede — como este repositorio escrevia — apanhou
 *     metade.
 *
 * O custo era exatamente o que o cabecalho de `./client.ts` diz estar a evitar:
 * «o operador ve "o bot para sozinho de vez em quando"». Pior: o processo NAO
 * morre, portanto o host tambem nao ve `close`, e nao tem por onde projetar
 * `DEGRADED`. Sem `stderr` e sem `close`, a falha e literalmente inobservavel.
 *
 * ===========================================================================
 * PORQUE UM TRANSFORMER, E PORQUE O MAIS INTERNO
 * ===========================================================================
 * MEDIDO em `out/core/client.js`: o `toHttpError` e lancado DENTRO da funcao
 * `call` que os transformers embrulham (`:58`), e `use()` faz
 * `transformers.reduce(concatTransformer, this.call)` — logo o ULTIMO instalado
 * fica por FORA. Instalando este PRIMEIRO, ele fica encostado a rede e ve cada
 * tentativa HTTP real, incluindo as do `getUpdates`, que nao passam por
 * middleware nenhum.
 *
 * REGISTA E RELANCA. Nunca engole: o grammY tem de continuar a ver o erro para
 * dormir 3 s e voltar a tentar, que e o comportamento certo para uma queda de
 * Wi-Fi. O que faltava nao era tratamento — era TESTEMUNHO.
 *
 * ===========================================================================
 * PORQUE NAO UMA LINHA POR FALHA
 * ===========================================================================
 * O grammY repete a cada 3 s. Uma linha por tentativa sao ~1200 linhas por hora
 * de rede em baixo, num `stderr` que o host encaminha para o log do DSH: o
 * incidente afogaria tudo o resto, e um log que ninguem consegue ler nao e
 * melhor do que um log vazio.
 *
 * A amostragem e por POTENCIA DE DOIS (1, 2, 4, 8, 16, ...). Duas propriedades
 * que importam: a PRIMEIRA falha e SEMPRE registada — que e a que corrige o
 * defeito — e o numero de linhas cresce com o LOGARITMO da duracao da avaria,
 * portanto uma queda de uma hora custa ~11 linhas, nao 1200.
 */

import type { Transformer } from 'grammy'

import type { WorkerLogger } from './log.ts'
import { describeForLog } from './redact.ts'

/**
 * A partir daqui a falha deixa de ser "um blip" e passa a `error`.
 *
 * Cinco tentativas com o retry de 3 s do grammY sao ~15 s sem rede. Abaixo
 * disso, gritar seria alarme falso a cada suspensao de portatil.
 */
export const ESCALATE_AFTER = 5

export interface TransportLogOptions {
  readonly log: WorkerLogger
  /** Segredos literais a mascarar. FUNCAO, para acompanhar rotacao. */
  readonly secrets?: () => readonly string[]
}

/** `true` para 1, 2, 4, 8, 16... Ver a amostragem no cabecalho. */
export function isSamplePoint(consecutive: number): boolean {
  return consecutive > 0 && (consecutive & (consecutive - 1)) === 0
}

export function createTransportLogTransformer(options: TransportLogOptions): Transformer {
  const secretsOf = options.secrets ?? ((): readonly string[] => [])
  /* Estado do CLOSURE, nao do modulo: duas instancias de bot contam as suas
     proprias falhas, que e o que torna o teste honesto. */
  let consecutive = 0

  return async (prev, method, payload, signal) => {
    try {
      const response = await prev(method, payload, signal)
      if (consecutive > 0) {
        options.log.info('transporte recuperado: a Bot API voltou a responder', {
          method,
          falhas_seguidas: consecutive,
        })
        consecutive = 0
      }
      return response
    } catch (error) {
      consecutive += 1
      if (isSamplePoint(consecutive)) {
        const mensagem =
          'o pedido HTTP a Bot API falhou (rede). O bot continua vivo e volta a tentar.'
        const campos = {
          method,
          falhas_seguidas: consecutive,
          // A causa vem do `node-fetch`, cuja mensagem cita a URL — e a URL
          // leva o token. Por isso passa por `describeForLog`, sempre.
          detail: describeForLog(error, secretsOf()),
        }
        // Chamada explicita em vez de guardar o metodo numa variavel: destacar
        // um metodo do objeto perde o `this`, e ainda que este logger nao o use,
        // depender disso e apostar no que a implementacao faz hoje.
        if (consecutive >= ESCALATE_AFTER) options.log.error(mensagem, campos)
        else options.log.warn(mensagem, campos)
      }
      // RELANCA. O grammY precisa do erro para decidir dormir e repetir.
      throw error
    }
  }
}
