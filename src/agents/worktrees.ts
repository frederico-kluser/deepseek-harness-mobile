/**
 * =============================================================================
 * A CRIACAO DE WORKTRETS GIT — a capacidade `worktree.create` (/worktree).
 * =============================================================================
 *
 * O dono pede `/worktree <nome> [base]`; o HOST cria uma worktree git ISOLADA
 * para a tarefa correr sem tocar no checkout principal. Este modulo e so isso:
 * um comando `git worktree add` por CHILD PROCESS, com erros honestos e sem
 * NUNCA destruir nada que exista.
 *
 * ---------------------------------------------------------------------------
 * O LAYOUT (contrato: `<BASE_DIR>/../<repo>-worktrees/<nome>`)
 * ---------------------------------------------------------------------------
 * `BASE_DIR` e a raiz de trabalho do harness — o `cwd` do agente-raciz vivo
 * (a MESMA fonte que o dispatch de subagentes usa como workspace:
 * `src/agents/registry.ts`, `parent.session.header.cwd`). `<repo>` e o
 * `basename(BASE_DIR)`. As worktrees nascem entao como IRMAOS do projeto:
 *
 *     <BASE_DIR>/../<repo>-worktrees/<nome>
 *
 * que, para BASE_DIR=/home/u/Proj/repo, da /home/u/Proj/repo-worktrees/<nome> —
 * o mesmo padrao que o orquestrador deste repo usa para as suas worktrees.
 * DECISAO REGISTADA: "ou melhor encaixe, documenta" — o layout de irmaos e o
 * escolhido porque (a) segue a formula do contrato, (b) mantem as worktrees
 * FORA da arvore do git (o `git status` do projeto nao as ve) e (c) nao exige
 * nenhuma chave de config nova. O caminho e ABSOLUTO e so serve para
 * `meta.cwd` de sessoes (`src/agents/chats.ts`) — NUNCA para mensagens ao dono
 * (S3: um caminho absoluto numa mensagem que sai da maquina divulga o layout
 * do disco).
 *
 * ---------------------------------------------------------------------------
 * SEGURANCA / HONESTIDADE
 * ---------------------------------------------------------------------------
 * - NOME: gramatica FECHADA `/^[a-z0-9-]{1,40}$/` (o MESMO regex do codec,
 *   `src/ipc/channel.ts:337-338`, e do contrato congelado). O worker ja a
 *   valida; aqui e a REVALIDACAO de host (S6 — defesa em profundidade).
 * - BASE: texto limpo <= 256 (higiene do transporte e do codec,
 *   `src/ipc/channel.ts:514`); aqui valida-se alem disso a higiene de REF do
 *   git (sem espacos, sem controlo, sem `-` inicial — bloqueia inject de
 *   opcoes via positional —, sem `..`, sem `@{`, sem sufixo `.lock`). O
 *   comando corre SEM shell (`argv` do `SubprocessSpawnSpec`, que "is never
 *   shell-interpreted" — espelho em `types/dsh-subprocess/types.d.ts`), logo a
 *   inject de comando nao existe; o que se defende e a inject de OPCOES.
 * - NUNCA destruir: se o caminho ja existe, o resultado e `WORKTREE_ALREADY_EXISTS`
 *   (o run de tarefa responde `noop` ao dono — "ja estava no estado pedido").
 *   Nenhum `git worktree remove/prune`, nenhum `rm`, em nenhhum caminho.
 * - SUBPROCESSO: o padrao do repo (`src/proc/*`) — o assento `ctx.subprocess`
 *   (`spawn(spec: SubprocessSpawnSpec) -> SubprocessHandle`, o mesmo de
 *   `src/proc/supervisor.ts:264`), com `graceMs` + `terminate()` tree-scoped e
 *   o `AbortSignal` do run a matar o `git` no cancelamento. `env` e minimo:
 *   `GIT_TERMINAL_PROMPT=0` para o git NUNCA ficar pendurado num prompt de
 *   credenciais (um child pendurado e um run 'running' eterno).
 * - PRAZO: o chamador manda o `signal` (cancel do run); alem dele ha um teto
 *   proprio ({@link WORKTREE_TIMEOUT_MS}) — "caller owns deadlines", mas um
 *   `git` pendurado num FS lento nao pode viver para sempre.
 * - ERROS: vocabulario FECHADO {@link WorktreeErrorCode} (`WORKTREE_*`, no
 *   estilo dos codigos estaveis de `src/errors.ts`), mensagem PT e S3-segura
 *   (sem caminhos), diagnostico bruto no campo `detail` — SO para o log.
 * =============================================================================
 */

import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '../dsh/adapter.ts'
import { spawnErrno } from '../proc/failure.ts'
import type { GuardLogger } from '../logging/logger.ts'

/* ========================================================================== */
/* Vocabulario de erro (estilo `src/errors.ts`: codigo estavel + mensagem PT)   */
/* ========================================================================== */

/**
 * Condicoes de `criar`, cada uma distinguivel por programa. FECHADO: um codigo
 * novo e mudanca de contrato (o summary do run e a UI renderizam por codigo).
 *
 *   - `WORKTREE_INVALID_NAME`      — nome fora de `/^[a-z0-9-]{1,40}$/`;
 *   - `WORKTREE_INVALID_BASE`      — ref de partida fora da higiene de ref;
 *   - `WORKTREE_ALREADY_EXISTS`    — o caminho ja existe; NADA foi destruido;
 *   - `WORKTREE_UNAVAILABLE`       — harness sem subprocesso/raiz de trabalho;
 *   - `WORKTREE_GIT_FAILED`        — o `git worktree add` saiu != 0 (ou o
 *                                    spawn falhou); `detail` leva o stderr;
 *   - `WORKTREE_CANCELLED`         — o `signal` do chamador abortou em curso;
 *   - `WORKTREE_TIMEOUT`           — o `git` nao terminou no prazo proprio.
 */
export type WorktreeErrorCode =
  | 'WORKTREE_INVALID_NAME'
  | 'WORKTREE_INVALID_BASE'
  | 'WORKTREE_ALREADY_EXISTS'
  | 'WORKTREE_UNAVAILABLE'
  | 'WORKTREE_GIT_FAILED'
  | 'WORKTREE_CANCELLED'
  | 'WORKTREE_TIMEOUT'

/**
 * Erro honesto da criacao de worktree.
 *
 * `message` e MOSTRAVEL (vai para o `summary` do run, que o Telegram mostra):
 * por isso e S3-segura — nunca caminho absoluto, nunca segredo, nunca o stderr
 * cru do git (que cita caminhos). O diagnostico bruto viaja em `detail`, que SO
 * vai para o log local.
 */
export class WorktreeError extends Error {
  override readonly name = 'WorktreeError'
  readonly code: WorktreeErrorCode
  /** Diagnostico bruto (pode conter caminhos): SO o log o pode ver (S3). */
  readonly detail: string | undefined

  // Campos a mao, nao "parameter property": `node --test` corre `.ts` em
  // strip-only mode e recusa essa sintaxe (a mesma regra de `src/errors.ts`).
  constructor(code: WorktreeErrorCode, mensagem: string, detail?: string) {
    super(mensagem)
    this.code = code
    this.detail = detail
  }
}

/* ========================================================================== */
/* Validacao (S6 host — revalida o que o worker ja validou)                    */
/* ========================================================================== */

/**
 * A gramatica FECHADA do nome: `/^[a-z0-9-]{1,40}$/`. O MESMO regex do codec
 * (`src/ipc/channel.ts:337-338`) e do contrato congelado — copiado de
 * proposito (revalidacao de host = defesa em profundidade; um codec avariado
 * nao chega a mandar o `git` correr).
 */
export function nomeDeWorktreeValido(nome: unknown): nome is string {
  return typeof nome === 'string' && /^[a-z0-9-]{1,40}$/.test(nome)
}

/** Teto da ref de partida (a higiene de TRANSPORTE e `src/ipc/channel.ts:140`). */
export const LIMITE_BASE_CHARS = 256

/**
 * Higiene de REF do git para a base de partida (alem da higiene de transporte
 * `texto limpo <= 256`, que o codec ja fez em `src/ipc/channel.ts:514`):
 * minusculas/maiusculas/digitos/`._/-`, 1..256, sem `-` inicial (inject de
 * opcoes no positional), sem `..`, sem `@{`, sem `/` inicial ou final, sem
 * `.` inicial nem sufixo `.lock` (as regras duras do `git check-ref-format`).
 * `HEAD` (o default) passa; `feature/x` passa; `--upload-pack=x` NAO passa.
 */
export function baseDeWorktreeValida(base: unknown): base is string {
  if (typeof base !== 'string') return false
  if (base.length === 0 || base.length > LIMITE_BASE_CHARS) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(base)) return false
  if (base.startsWith('-') || base.startsWith('.') || base.startsWith('/')) return false
  if (base.endsWith('/') || base.endsWith('.')) return false
  if (base.includes('..') || base.includes('@{')) return false
  return !base.endsWith('.lock')
}

/* ========================================================================== */
/* O servico                                                                 */
/* ========================================================================== */

/** A ref de partida quando o dono nao indica nenhuma. */
export const BASE_PREDEFINIDA = 'HEAD'

/** Grace da terminacao do `git` (SIGTERM -> graceMs -> SIGKILL, tree-scoped). */
export const WORKTREE_GRACE_MS = 5_000

/** Teto do `git worktree add` (um FS lento nao pode manter um run eterno). */
export const WORKTREE_TIMEOUT_MS = 60_000

/** Teto do stdout/stderr recolhidos (o `git` fala pouco; o tail chega). */
const WORKTREE_SAIDA_MAX_BYTES = 4 * 1024

/**
 * O assento de subprocessos, no corte consumido: e o `SubprocessRuntime` do
 * harness (`ctx.subprocess`, `types/dsh-subprocess/index.d.ts:49,80`), que
 * `src/proc/supervisor.ts:264` ja usa como `ctx.subprocess.spawn(spec)`.
 * Aqui e um tipo proprio para o teste injetar o duble SEM fingir o Context.
 */
export interface AssentoDeSubprocesso {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

export interface WorktreeDeps {
  /** O assento `ctx.subprocess` — LAZY (a doutrina de `src/agents/registry.ts`). */
  readonly subprocess: () => AssentoDeSubprocesso | undefined
  /**
   * `BASE_DIR` ABSOLUTO — a raiz de trabalho do harness (o cwd do agente-raciz
   * vivo; ver o cabecalho). Ausente => `WORKTREE_UNAVAILABLE` (fail-closed:
   * sem raiz nao ha git que valha).
   */
  readonly baseDir: () => string | undefined
  readonly log: GuardLogger
}

export interface PedidoDeWorktree {
  /** Nome curto (gramatica fechada) — vira `guard/<nome>` e `<repo>-worktrees/<nome>`. */
  readonly nome: string
  /** Ref de partida opcional (default {@link BASE_PREDEFINIDA}). */
  readonly base?: string | undefined
}

export interface WorktreeCriada {
  readonly nome: string
  /** A branch criada: `guard/<nome>` (a `guard/` do contrato). */
  readonly branch: string
  /** A ref de partida efetiva. */
  readonly base: string
  /** Caminho ABSOLUTO da worktree — para `meta.cwd` de sessao; nunca para mensagens (S3). */
  readonly caminho: string
}

export interface WorktreeService {
  /** O caminho ABSOLUTO onde o `nome` vive (ou viveria) — compose pura. */
  caminhoDe(nome: string): string
  /** `true` quando ja ha algo nesse caminho (o pre-check "nunca destruir"). */
  existe(nome: string): boolean
  /**
   * Cria a worktree: `git worktree add --branch guard/<nome> <caminho> <base>`.
   * LANCA {@link WorktreeError} — sempre com codigo estavel e mensagem S3-segura.
   */
  criar(
    pedido: PedidoDeWorktree,
    opts?: { readonly signal?: AbortSignal | undefined },
  ): Promise<WorktreeCriada>
}

/**
 * A formula do contrato `<BASE_DIR>/../<repo>-worktrees/<nome>`, numa funcao
 * pura (e o unico sitio onde ela vive — `chats.ts` resolve o cwd da sessao por
 * aqui, nunca recompoe a formula).
 */
export function caminhoDeWorktree(baseDir: string, nome: string): string {
  const raiz = resolve(baseDir)
  return resolve(raiz, '..', `${basename(raiz)}-worktrees`, nome)
}

export function criarServicoDeWorktrees(deps: WorktreeDeps): WorktreeService {
  const caminhoDe = (nome: string): string => {
    const baseDir = deps.baseDir()
    if (baseDir === undefined) {
      throw new WorktreeError(
        'WORKTREE_UNAVAILABLE',
        'o harness nao esta disponivel para criar worktrees (sem raiz de trabalho).',
      )
    }
    return caminhoDeWorktree(baseDir, nome)
  }

  return {
    caminhoDe,

    existe(nome) {
      try {
        return existsSync(caminhoDe(nome))
      } catch {
        // Um caminho que nao se consegue inspecionar e tratado como ocupado:
        // NUNCA destruir e a regra que sobrevive a qualquer duvida.
        return true
      }
    },

    async criar(pedido, opts) {
      // 1. VALIDACAO (S6 host) — antes de qualquer I/O ou child process.
      if (!nomeDeWorktreeValido(pedido.nome)) {
        throw new WorktreeError(
          'WORKTREE_INVALID_NAME',
          'o nome do worktree e invalido (so minusculas, digitos e hifen; 1..40 caracteres).',
        )
      }
      const base = pedido.base ?? BASE_PREDEFINIDA
      if (pedido.base !== undefined && !baseDeWorktreeValida(pedido.base)) {
        throw new WorktreeError(
          'WORKTREE_INVALID_BASE',
          'a ref de partida indicada e invalida.',
        )
      }

      // 2. NUNCA DESTRUIR — o caminho ocupado e um fim honesto, nunca um overwrite.
      const caminho = caminhoDe(pedido.nome)
      if (existsSync(caminho)) {
        throw new WorktreeError(
          'WORKTREE_ALREADY_EXISTS',
          `ja existe um worktree com o nome "${pedido.nome}"; nada foi destruido.`,
        )
      }

      // 3. O ASSENTO — fail-closed antes de qualquer spawn.
      const subprocess = deps.subprocess()
      const baseDir = deps.baseDir()
      if (subprocess === undefined || baseDir === undefined) {
        throw new WorktreeError(
          'WORKTREE_UNAVAILABLE',
          'o harness nao esta disponivel para criar worktrees (subprocesso/raiz ausentes).',
        )
      }

      const branch = `guard/${pedido.nome}`

      // 4. O CHILD PROCESS (o padrao `src/proc/*`): spec completo, sem shell,
      //    com cancel do run + teto proprio a compor o sinal do spawn.
      const juncao = new AbortController()
      const canceladoPor = (): void => juncao.abort()
      opts?.signal?.addEventListener('abort', canceladoPor, { once: true })
      if (opts?.signal?.aborted === true) juncao.abort()
      const prazo = setTimeout(() => {
        juncao.abort()
      }, WORKTREE_TIMEOUT_MS)

      const spec: SubprocessSpawnSpec = {
        // Sem shell: positional seguro (caminho absoluto; base sem `-` inicial
        // pela validacao acima; branch derivada de nome validado).
        argv: ['git', 'worktree', 'add', '--branch', branch, caminho, base],
        cwd: baseDir,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: WORKTREE_SAIDA_MAX_BYTES },
          stderr: { maxBytes: WORKTREE_SAIDA_MAX_BYTES },
        },
        graceMs: WORKTREE_GRACE_MS,
        signal: juncao.signal,
        // O git NUNCA fica pendurado a pedir credenciais a um terminal que nao
        // existe (um child pendurado e um run 'running' eterno).
        env: { GIT_TERMINAL_PROMPT: '0' },
      }

      try {
        let handle: SubprocessHandle
        try {
          handle = subprocess.spawn(spec)
        } catch (error) {
          throw new WorktreeError(
            'WORKTREE_GIT_FAILED',
            `o git recusou criar o worktree "${pedido.nome}" (detalhe no log do plugin).`,
            `spawn: ${spawnErrno(error) ?? String(error)}`,
          )
        }

        let resultado: SubprocessOutcome
        try {
          resultado = await handle.done
        } catch (error) {
          throw new WorktreeError(
            'WORKTREE_GIT_FAILED',
            `o git recusou criar o worktree "${pedido.nome}" (detalhe no log do plugin).`,
            `done: ${spawnErrno(error) ?? String(error)}`,
          )
        }

        // Os streams recolhidos sao legiveis DEPOIS do settle (contrato do
        // assento: "collected output remains readable after exit").
        const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
        const stdout = handle.collected.stdout?.readFrom(0).text ?? ''

        // 5. CLASSIFICACAO HONESTA: cancelamento do dono, teto proprio, ou o
        //    exit do git — nunca um sucesso inventado.
        if (opts?.signal?.aborted === true) {
          throw new WorktreeError(
            'WORKTREE_CANCELLED',
            `a criacao do worktree "${pedido.nome}" foi cancelada.`,
            stderr || stdout,
          )
        }
        if (juncao.signal.aborted) {
          throw new WorktreeError(
            'WORKTREE_TIMEOUT',
            `o git nao terminou a criacao do worktree "${pedido.nome}" no prazo.`,
            stderr || stdout,
          )
        }
        if (resultado.exitCode !== 0) {
          throw new WorktreeError(
            'WORKTREE_GIT_FAILED',
            `o git recusou criar o worktree "${pedido.nome}" (detalhe no log do plugin).`,
            `exit=${String(resultado.exitCode)} signal=${String(resultado.signal)}\n${stderr || stdout}`,
          )
        }

        deps.log.info(`worktree "${pedido.nome}" criada (branch ${branch}, a partir de ${base}).`)
        return { nome: pedido.nome, branch, base, caminho }
      } catch (error) {
        // O diagnostico bruto fica NO LOG (S3); o que sobe e a mensagem segura.
        if (error instanceof WorktreeError && error.detail !== undefined && error.detail.length > 0) {
          deps.log.warn(`worktree "${pedido.nome}": ${error.code}: ${error.detail}`)
        }
        throw error
      } finally {
        clearTimeout(prazo)
        opts?.signal?.removeEventListener('abort', canceladoPor)
      }
    },
  }
}
