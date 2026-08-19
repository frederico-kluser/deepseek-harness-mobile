/**
 * Declaracoes locais para `@deepseek-ai/dsh-host-subprocess`.
 *
 * O pacote e "vendored" no monorepo do DeepSeek Harness e NAO e publicado no
 * npm publico; os seus tipos sao resolvidos via `compilerOptions.paths`.
 *
 * Modulo real (tem `export`) para permitir *module augmentation*.
 */
import type { ChildProcess, StdioOptions } from 'node:child_process'

/**
 * Opcoes aceites por `ctx.subprocess.spawn`. Subconjunto deliberado das
 * opcoes de `node:child_process`: a costura de capacidade (*capability seam*)
 * do DSH so expoe o que consegue governar no encerramento da Fiber.
 */
export interface SpawnOptions {
  /** Isolamento dos canais stdio, ex.: `['ignore', 'pipe', 'pipe']`. */
  stdio?: StdioOptions
  /** Canaliza a intencao de anulacao de forma nativa para o processo filho. */
  signal?: AbortSignal
  /** Ambiente do processo filho. */
  env?: NodeJS.ProcessEnv
  /** Diretorio de trabalho do processo filho. */
  cwd?: string
  /**
   * Isola o filho no seu proprio grupo de processos. Necessario para que
   * `process.kill(-pid, ...)` atinja a arvore processual inteira em POSIX.
   */
  detached?: boolean
}

/**
 * Servico `ctx.subprocess` injetado pelo pacote `dsh-host-subprocess`.
 *
 * Preferivel a `child_process.spawn` isolado: se o filho nao desvanecer apos
 * o fluxo de desativacao, o servico executa tree-kill (sinais no grupo de
 * processos em POSIX, `taskkill /T /F` em Windows).
 */
export interface SubprocessService {
  spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess
}

export type { ChildProcess, StdioOptions }
