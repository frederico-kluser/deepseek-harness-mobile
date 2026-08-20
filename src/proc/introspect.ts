/**
 * INTROSPECCAO DE PROCESSOS: quem e o programa por tras de um pid, e desde quando.
 *
 * PORQUE VIVE EM `src/proc/**` E NAO JUNTO DE QUEM O USA: nada aqui sabe o que e
 * um tunel. Sao leituras de `/proc` que respondem a duas perguntas genericas —
 * "que programa e este pid?" e "desde quando existe?" — e a POLITICA de o que
 * fazer com a resposta e de quem chama (`src/tunnel/pidfile.ts`). Separar as duas
 * coisas e o que permite testar a leitura contra o sistema operativo real e a
 * decisao contra valores escolhidos a mao.
 *
 * TUDO AQUI DEVOLVE `null` EM VEZ DE LANCAR. Ausencia de `/proc` (macOS), pid que
 * ja saiu, ficheiro de outro utilizador: sao todos "nao da para saber", que e uma
 * resposta legitima e diferente de um erro. Quem chama decide o que fazer com a
 * ignorancia — e em `pidfile.ts` essa decisao esta escrita em voz alta.
 */

import { readFileSync } from 'node:fs'
import { uptime as osUptime } from 'node:os'

/**
 * Le a linha de comando de um pid. `null` quando nao ha como saber.
 *
 * `/proc/<pid>/cmdline` traz o `argv` separado por bytes `NUL`. Ele NAO existe em
 * macOS, e ai a funcao devolve `null` de proposito em vez de inventar uma
 * alternativa que exigiria lancar um `ps` — spawnar um processo dentro da
 * varredura que corre "antes de qualquer outra inicializacao" trocaria um
 * controlo simples por uma dependencia de arranque.
 */
export function readProcessCmdline(pid: number): string | null {
  try {
    return readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8').replaceAll('\0', ' ').trim()
  } catch (error) {
    // ENOENT (processo ja saiu, ou nao ha `/proc`) e EACCES (o pid e de outro
    // utilizador) sao ambos "nao da para identificar". A distincao nao muda a
    // decisao, e a decisao esta em `sweepOrphanTunnel`.
    void error
    return null
  }
}

/**
 * O PROGRAMA de uma linha de comando: `argv[0]`, e nada mais.
 *
 * `/proc/<pid>/cmdline` traz o `argv` inteiro. O primeiro elemento e o programa;
 * todos os outros sao dados que ele recebeu, e um NOME QUE APARECE NUM ARGUMENTO
 * NAO E O PROGRAMA. Confundir os dois e a diferenca entre matar o tunel e matar
 * o editor que tem o ficheiro de configuracao aberto.
 */
export function programOf(cmdline: string): string {
  return cmdline.trim().split(/\s+/u)[0] ?? ''
}

/**
 * Instante em que um pid arrancou, em epoch ms. `null` quando nao ha como saber.
 *
 * PORQUE ISTO EXISTE (e o `cmdline` sozinho nao chega): a identificacao por linha
 * de comando responde "e outro PROGRAMA?". NAO responde "e outra INSTANCIA do
 * mesmo programa?", que e o caso classico de reciclagem de pid — e o mais caro,
 * porque a vitima e um `cloudflared` legitimo do utilizador, com o tunel de
 * producao dele por tras. Medido antes desta correccao: registo `pid: 424242,
 * startedAt: 1000` mais um `/usr/bin/cloudflared tunnel run o-tunel-do-utilizador`
 * a ocupar esse pid davam `outcome: 'killed'`.
 *
 * O campo 22 de `/proc/<pid>/stat` (`starttime`) e o instante do arranque em
 * TICKS desde o boot. Duas dificuldades, e as duas tem resposta sem dependencia
 * nenhuma:
 *
 *   - o `comm` (campo 2) pode conter espacos e parenteses, o que estraga um
 *     `split` ingenuo. Le-se a partir do ULTIMO `)`, que e como o proprio kernel
 *     documenta que se faz;
 *   - o Node nao expoe `CLK_TCK`. Em vez de assumir 100 (o valor quase universal,
 *     mas ainda assim uma suposicao), CALIBRA-SE com o proprio processo: sabemos
 *     ha quantos segundos ele arrancou (`os.uptime() - process.uptime()`) e
 *     sabemos quantos ticks isso deu. Se a calibracao nao for fiavel (processo
 *     acabado de arrancar), devolve-se `null` em vez de um numero inventado.
 */
export function readProcessStartMs(pid: number): number | null {
  const selfTicks = readStartTicks(process.pid)
  const ticks = readStartTicks(pid)
  if (selfTicks === null || ticks === null) return null

  const bootToSelfSeconds = osUptime() - process.uptime()
  // Calibracao pouco fiavel: `os.uptime()` tem resolucao de segundos, e num
  // processo acabado de arrancar o divisor e ruido. Melhor nao saber do que
  // afirmar mal — quem chama trata `null` como "sem informacao".
  if (!(bootToSelfSeconds > 1)) return null

  const ticksPerSecond = selfTicks / bootToSelfSeconds
  if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) return null

  const bootMs = Date.now() - osUptime() * 1000
  return bootMs + (ticks / ticksPerSecond) * 1000
}

/** Campo 22 de `/proc/<pid>/stat`, lido a partir do ULTIMO `)`. */
function readStartTicks(pid: number): number | null {
  let raw: string
  try {
    raw = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
  } catch (error) {
    // Sem `/proc` (macOS) ou sem o processo: e "nao da para saber", nao um erro.
    void error
    return null
  }

  const afterComm = raw.slice(raw.lastIndexOf(')') + 1).trim()
  if (afterComm.length === 0) return null
  // Depois do `)` o primeiro campo e o 3 (`state`), logo o 22 esta no indice 19.
  const ticks = Number(afterComm.split(/\s+/u)[19])
  return Number.isFinite(ticks) && ticks >= 0 ? ticks : null
}

/**
 * Folga entre "o processo arrancou" e "o dono do registo o gravou".
 *
 * O registo e escrito no gancho `onSpawned`, milissegundos DEPOIS de o processo
 * existir, portanto o arranque real e sempre ANTERIOR ao valor gravado. A folga
 * cobre a resolucao de segundos do `os.uptime()` e um relogio que ande um pouco;
 * um pid reciclado costuma se-lo minutos ou horas depois, muito alem disto.
 */
export const START_TIME_TOLERANCE_MS = 60_000


/**
 * `true` enquanto o pid existir. Usa `kill(pid, 0)`, que NAO entrega sinal nenhum
 * — so pergunta ao nucleo se ha alguem ali.
 *
 * `EPERM` conta como VIVO: significa que o processo existe e pertence a outra
 * conta. Tratar isso como "nao existe" faria a varredura de orfao concluir que
 * nao ha nada a derrubar precisamente quando ha.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
