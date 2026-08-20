/**
 * =============================================================================
 * Tree-kill do GRUPO de processos: `process.kill(-pid, 'SIGKILL')`.
 * Ramo win32 isolado e inerte.
 * =============================================================================
 *
 * -----------------------------------------------------------------------------
 * DIVERGENCIA DELIBERADA DO EXEMPLO CANONICO DA DOCUMENTACAO (nao "corrigir" de
 * volta): o disposer do doc-fonte escreve
 *
 *     if (child.pid && !child.killed) process.kill(-child.pid, 'SIGKILL')
 *
 * e essa guarda `!child.killed` TORNA O TREE-KILL CODIGO MORTO. Razao: o Node,
 * ao processar `abortController.abort()`, chama `child.kill()` de forma
 * SINCRONA, o que poe `child.killed = true` ANTES de a linha seguinte correr. A
 * condicao nunca e verdadeira no unico caminho em que interessa. Medido com
 * processos reais (pai `detached` + neto):
 *
 *     ANTES  do dispose()   filho 1326740 (pgid 1326740), neto 1326741
 *     DEPOIS do dispose()   filho MORTO,  neto 1326741 ppid=1830 <- ORFAO
 *
 * Removida a guarda, o neto morre com o grupo. Aqui o tree-kill e portanto
 * SEMPRE tentado quando ha `pid`, independentemente de qualquer estado anterior.
 *
 * `killed` significava apenas "um sinal foi entregue com sucesso ao filho", e
 * nao "o filho e a sua descendencia ja nao existem" -- so o kill do GRUPO
 * garante a segunda coisa. (Ressalva honesta: se o grupo ja tiver terminado por
 * completo, o `pid` podia em teoria ter sido reutilizado pelo sistema; POSIX so
 * garante a nao-reutilizacao do pgid enquanto o grupo existir. E o mesmo risco
 * residual do exemplo canonico, e o custo de o nao correr -- netos orfaos a
 * consumir descritores e memoria ate ao fim do processo hospedeiro -- e maior.)
 * -----------------------------------------------------------------------------
 *
 * O QUE MUDOU NESTA ONDA, E PORQUE ESTA CAMADA FICA NA MESMA
 * -----------------------------------------------------------------------------
 * O assento real (`SubprocessHandle.terminate()`, tambem accionado pelo
 * `AbortSignal` do spec) JA E TREE-SCOPED EM TODAS AS PLATAFORMAS: em
 * `dsh-subprocess-local/lib/index.js:508-516`, `signalTree()` faz
 * `process.kill(-pid, sig)` em POSIX e `taskkill /T /F` em Windows. O `.d.ts`
 * publicado diz o mesmo em prosa normativa ("tree-scoped on every platform").
 * Esta camada e portanto REDUNDANTE, e passa a ser defesa em profundidade em vez
 * de ser o unico mecanismo.
 *
 * Fica, por tres razoes concretas:
 *   1. o caminho POSIX do assento cai para o filho DIRECTO quando o grupo ja nao
 *      existe ("falling back to the direct child when the group is gone") -- e a
 *      partir daqui nao ha forma de observar qual dos dois ramos correu;
 *   2. `ctx.subprocess` e um assento ABSTRACTO: o `-local` e uma implementacao
 *      entre outras possiveis, e a garantia de arvore e do contrato, nao do
 *      objeto que temos em maos;
 *   3. o custo e uma syscall que devolve ESRCH quando ja nao ha nada.
 *
 * INTERACAO COM `graceMs`, declarada e nao acidental: `terminate()` inicia
 * `SIGTERM -> graceMs -> SIGKILL`. Este SIGKILL ao GRUPO corre no MESMO disposer
 * sincrono, logo a seguir, e portanto ANTECIPA essa janela de cortesia para a
 * arvore do worker. E deliberado: o worker e um long-poller sem estado para
 * descarregar, o disposer tem de ser sincrono (Q-2, e esperar `waitForExit()`
 * torna-lo-ia assincrono), e era ja este o comportamento antes desta onda --
 * zero mudanca. O `graceMs` continua a governar o que so o assento pode fazer:
 * o dreno dos canais ainda abertos depois da saida.
 * =============================================================================
 */

/** Superficie minima que o tree-kill precisa de conhecer de um processo. */
export interface KillableProcess {
  /** Id do processo (raiz da arvore); `-1` quando o proprio spawn falhou. */
  readonly pid: number
}

/** Dependencias de plataforma, substituiveis nos testes. */
export interface TreeKillDeps {
  readonly platform: NodeJS.Platform
  readonly kill: (pid: number, signal: NodeJS.Signals) => void
}

/**
 * Mata o GRUPO de processos de um filho concreto.
 *
 * O sinal negativo alveja o grupo inteiro. Sem guarda por estado anterior: ver a
 * divergencia documentada no cabecalho deste ficheiro.
 */
export function treeKill(target: KillableProcess, deps: TreeKillDeps): void {
  const { pid } = target

  // `pid === -1` e o valor que o assento publica quando o spawn falhou; um pid
  // nao positivo nunca designa um grupo de processos valido.
  if (!Number.isInteger(pid) || pid <= 0) return

  if (deps.platform === 'win32') {
    // `process.kill(-pid, ...)` NAO EXISTE no Windows: nao ha grupos de
    // processos POSIX. Nessa plataforma o proprio `ctx.subprocess` executa
    // `taskkill /T /F` internamente, pelo que basta o abort/terminate.
    return
  }

  try {
    deps.kill(-pid, 'SIGKILL')
    // ESRCH e o caso #1 nomeado em 05-QUALIDADE-CODIGO.md §6.3; o comentario
    // do corpo explica porque. O selector `body.body.length=0` conta
    // statements e nao ve comentarios, entao a excecao vai explicita.
    // eslint-disable-next-line no-restricted-syntax
  } catch {
    // ESRCH: o processo (ou o grupo) ja nao existe na tabela. Excecao mitigada
    // de proposito -- o objetivo ja esta cumprido.
  }
}
