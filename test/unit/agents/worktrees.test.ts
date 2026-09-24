/**
 * `src/agents/worktrees.ts` — a criacao de worktrees git (`worktree.create`).
 *
 * Preso aqui, SEM git real e SEM worktrees reais (o child process e um DUBLE
 * do assento `ctx.subprocess` — nunca `git` a correr nesta suite):
 *
 *   - a FORMULA do contrato `<BASE_DIR>/../<repo>-worktrees/<nome>`;
 *   - a revalidacao de host (S6) da gramatica do nome `/^[a-z0-9-]{1,40}$/` e
 *     da higiene de ref da base (sem `-` inicial — inject de opcoes bloqueada);
 *   - NUNCA destruir: caminho ocupado e `WORKTREE_ALREADY_EXISTS`, sem spawn;
 *   - o spec do child process (argv sem shell, cwd, env minimo, graceMs);
 *   - os erros honestos `WORKTREE_*` com diagnostico bruto em `detail` (SO log)
 *     e mensagem S3-segura (sem caminhos).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { SubprocessHandle, SubprocessSpawnSpec } from '../../../src/dsh/adapter.ts'
import {
  BASE_PREDEFINIDA,
  caminhoDeWorktree,
  criarServicoDeWorktrees,
  baseDeWorktreeValida,
  nomeDeWorktreeValido,
  WorktreeError,
  type AssentoDeSubprocesso,
} from '../../../src/agents/worktrees.ts'
import { createFakeLogger } from '../../support/ctx-double.ts'

/* ========================================================================== */
/* O assento FALSO — o `git` nunca corre; o teste dirige o exit/stderr         */
/* ========================================================================== */

interface SpawnRegisto {
  readonly spec: SubprocessSpawnSpec
}

interface AssentoFake extends AssentoDeSubprocesso {
  readonly spawns: SpawnRegisto[]
  /** Resolve o `done` do proximo handle com estes factos de saida. */
  readonly saida: { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; stdout: string }
  /** Em vez de publicar um handle, o spawn LANCA (falha de arranque). */
  spawnQueLanca: Error | undefined
}

function leitor(texto: string): { readFrom(from: number): { text: string; nextOffset: number; lossy: boolean } } {
  return { readFrom: () => ({ text: texto, nextOffset: texto.length, lossy: false }) }
}

function fazerAssento(): AssentoFake {
  const spawns: SpawnRegisto[] = []
  const saida = { exitCode: 0 as number | null, signal: null as NodeJS.Signals | null, stderr: '', stdout: '' }
  return {
    spawns,
    saida,
    spawnQueLanca: undefined,
    spawn(spec) {
      spawns.push({ spec })
      if (this.spawnQueLanca !== undefined) throw this.spawnQueLanca
      const handle: SubprocessHandle = {
        pid: 4242,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: {
          stdout: leitor(saida.stdout),
          stderr: leitor(saida.stderr),
        },
        done: Promise.resolve({ exitCode: saida.exitCode, signal: saida.signal }),
        terminate: (): void => {},
        waitForExit: async () => true,
      }
      return handle
    },
  }
}

interface Bancada {
  servico: ReturnType<typeof criarServicoDeWorktrees>
  assento: AssentoFake
  baseDir: string
}

function fazerBancada(opcoes: { semSubprocesso?: boolean; semBaseDir?: boolean } = {}): Bancada {
  const assento = fazerAssento()
  const baseDir = join(tmpdir(), 'guard-bancada-proj', 'repo')
  const log = createFakeLogger()
  const servico = criarServicoDeWorktrees({
    subprocess: () => (opcoes.semSubprocesso === true ? undefined : assento),
    baseDir: () => (opcoes.semBaseDir === true ? undefined : baseDir),
    log: log('worktrees'),
  })
  return { servico, assento, baseDir }
}

/** O `WorktreeError` como o teste o quer ver (o catch generico esconde-o). */
async function erroDe(promessa: Promise<unknown>): Promise<WorktreeError> {
  try {
    await promessa
  } catch (error) {
    assert.ok(error instanceof WorktreeError, `esperava WorktreeError, veio: ${String(error)}`)
    return error
  }
  throw new Error('esperava uma rejeicao e recebi um valor')
}

/* ========================================================================== */
/* A formula do contrato                                                     */
/* ========================================================================== */

describe('caminhoDeWorktree — `<BASE_DIR>/../<repo>-worktrees/<nome>`', () => {
  const caminho = caminhoDeWorktree('/home/u/Proj/repo', 'feat-x')

  it('poe as worktrees como IRMAOS do projeto, com o nome do repo no prefixo', () => {
    assert.equal(caminho, '/home/u/Proj/repo-worktrees/feat-x')
  })

  it('e sempre ABSOLUTO (o `meta.cwd` do harness LANCA com relativo)', () => {
    assert.ok(caminho.startsWith('/'))
  })
})

/* ========================================================================== */
/* A gramatica (revalidacao S6 de host)                                       */
/* ========================================================================== */

describe('a gramatica do nome e a higiene da base', () => {
  it('o nome aceita o alfabeto fechado e o teto de 40', () => {
    assert.equal(nomeDeWorktreeValido('a'), true)
    assert.equal(nomeDeWorktreeValido('feat-2-x'), true)
    assert.equal(nomeDeWorktreeValido('a'.repeat(40)), true)
    assert.equal(nomeDeWorktreeValido(''), false)
    assert.equal(nomeDeWorktreeValido('a'.repeat(41)), false)
    assert.equal(nomeDeWorktreeValido('Feat'), false)
    assert.equal(nomeDeWorktreeValido('fe at'), false)
    assert.equal(nomeDeWorktreeValido('feat/../x'), false)
    assert.equal(nomeDeWorktreeValido(123), false)
    assert.equal(nomeDeWorktreeValido(undefined), false)
  })

  it('a base recusa inject de opcoes e refs tortas', () => {
    assert.equal(baseDeWorktreeValida('HEAD'), true)
    assert.equal(baseDeWorktreeValida('main'), true)
    assert.equal(baseDeWorktreeValida('feature/x'), true)
    assert.equal(baseDeWorktreeValida('v1.0.0'), true)
    assert.equal(baseDeWorktreeValida('--upload-pack=rm'), false)
    assert.equal(baseDeWorktreeValida('-b'), false)
    assert.equal(baseDeWorktreeValida('/abs'), false)
    assert.equal(baseDeWorktreeValida('a..b'), false)
    assert.equal(baseDeWorktreeValida('a@{u}'), false)
    assert.equal(baseDeWorktreeValida('x.lock'), false)
    assert.equal(baseDeWorktreeValida('com espaco'), false)
    assert.equal(baseDeWorktreeValida(''), false)
    assert.equal(baseDeWorktreeValida('a'.repeat(257)), false)
    assert.equal(baseDeWorktreeValida(1), false)
  })
})

/* ========================================================================== */
/* criar() — o child process e os erros honestos                              */
/* ========================================================================== */

describe('criar() — `git worktree add` por child process', () => {
  it('monta o spec sem shell, com branch `guard/<nome>` e env minimo', async () => {
    const h = fazerBancada()

    const criada = await h.servico.criar({ nome: 'feat-x', base: 'main' })

    assert.equal(criada.nome, 'feat-x')
    assert.equal(criada.branch, 'guard/feat-x')
    assert.equal(criada.base, 'main')
    assert.equal(criada.caminho, caminhoDeWorktree(h.baseDir, 'feat-x'))

    const spec = h.assento.spawns[0]?.spec
    assert.ok(spec)
    assert.deepEqual(spec.argv, [
      'git', 'worktree', 'add', '--branch', 'guard/feat-x',
      caminhoDeWorktree(h.baseDir, 'feat-x'), 'main',
    ])
    assert.equal(spec.cwd, h.baseDir)
    assert.deepEqual(spec.env, { GIT_TERMINAL_PROMPT: '0' })
    assert.equal(spec.graceMs > 0, true)
    assert.equal(spec.stdio.stdin, 'ignore')
  })

  it('sem base, parte de HEAD (o default do contrato)', async () => {
    const h = fazerBancada()

    const criada = await h.servico.criar({ nome: 'so-nome' })

    assert.equal(criada.base, BASE_PREDEFINIDA)
    assert.equal(h.assento.spawns[0]?.spec.argv.at(-1), 'HEAD')
  })

  it('nome invalido e recusado ANTES de qualquer spawn (WORKTREE_INVALID_NAME)', async () => {
    const h = fazerBancada()

    const erro = await erroDe(h.servico.criar({ nome: 'Fe at!' }))

    assert.equal(erro.code, 'WORKTREE_INVALID_NAME')
    assert.equal(h.assento.spawns.length, 0)
  })

  it('base invalida e recusada ANTES de qualquer spawn (WORKTREE_INVALID_BASE)', async () => {
    const h = fazerBancada()

    const erro = await erroDe(h.servico.criar({ nome: 'feat-x', base: '--upload-pack=x' }))

    assert.equal(erro.code, 'WORKTREE_INVALID_BASE')
    assert.equal(h.assento.spawns.length, 0)
  })

  it('NUNCA DESTRUIR: caminho ocupado e WORKTREE_ALREADY_EXISTS, sem spawn', async () => {
    // FIXTURE de teste: um diretorio temporario (NUNCA uma worktree git — o
    // `git` da suite inteiro e o duble) para o caminho calculado existir.
    const pai = mkdtempSync(join(tmpdir(), 'guard-wt-'))
    try {
      const baseDir = join(pai, 'repo')
      mkdirSync(caminhoDeWorktree(baseDir, 'feat-x'), { recursive: true })
      const assento = fazerAssento()
      const log = createFakeLogger()
      const servico = criarServicoDeWorktrees({
        subprocess: () => assento,
        baseDir: () => baseDir,
        log: log('worktrees'),
      })

      const erro = await erroDe(servico.criar({ nome: 'feat-x' }))

      assert.equal(erro.code, 'WORKTREE_ALREADY_EXISTS')
      assert.equal(erro.message.includes(pai), false, 'a mensagem NAO pode levar caminhos (S3)')
      assert.equal(assento.spawns.length, 0, 'um caminho ocupado nunca chega ao git')
    } finally {
      rmSync(pai, { recursive: true, force: true })
    }
  })

  it('subprocesso/raiz ausentes sao WORKTREE_UNAVAILABLE (fail-closed)', async () => {
    const semSubprocesso = fazerBancada({ semSubprocesso: true })
    const erro1 = await erroDe(semSubprocesso.servico.criar({ nome: 'feat-x' }))
    assert.equal(erro1.code, 'WORKTREE_UNAVAILABLE')

    const semBaseDir = fazerBancada({ semBaseDir: true })
    const erro2 = await erroDe(semBaseDir.servico.criar({ nome: 'feat-x' }))
    assert.equal(erro2.code, 'WORKTREE_UNAVAILABLE')
  })

  it('exit != 0 do git e WORKTREE_GIT_FAILED com o stderr em `detail` (SO log)', async () => {
    const h = fazerBancada()
    h.assento.saida.exitCode = 128
    h.assento.saida.stderr = "fatal: '/home/u/secret/path' ja existe"

    const erro = await erroDe(h.servico.criar({ nome: 'feat-x' }))

    assert.equal(erro.code, 'WORKTREE_GIT_FAILED')
    // O `detail` leva o diagnostico bruto (com caminhos) — para o LOG.
    assert.ok(erro.detail?.includes('/home/u/secret/path'))
    // A MENSAGEM e S3-segura: SEM caminho algum, para o Telegram.
    assert.equal(erro.message.includes('/home/u/'), false)
    assert.ok(erro.message.includes('feat-x'))
  })

  it('falha de spawn e WORKTREE_GIT_FAILED (classificada pelo padrao de src/proc)', async () => {
    const h = fazerBancada()
    h.assento.spawnQueLanca = Object.assign(new Error('spawn ENOENT'), { errno: -2, code: 'ENOENT' })

    const erro = await erroDe(h.servico.criar({ nome: 'feat-x' }))

    assert.equal(erro.code, 'WORKTREE_GIT_FAILED')
    assert.ok(erro.detail?.includes('ENOENT'))
  })

  it('cancelamento do run e WORKTREE_CANCELLED', async () => {
    const h = fazerBancada()
    const abortar = new AbortController()
    abortar.abort('cancelado pelo dono')

    const erro = await erroDe(h.servico.criar({ nome: 'feat-x' }, { signal: abortar.signal }))

    assert.equal(erro.code, 'WORKTREE_CANCELLED')
  })
})

/* ========================================================================== */
/* existe() — a guarda "nunca destruir"                                       */
/* ========================================================================== */

describe('existe() — o pre-check do noop honesto', () => {
  it('devolve true so para caminhos ocupados (o mesmo criterio do "nunca destruir")', () => {
    const pai = mkdtempSync(join(tmpdir(), 'guard-wt-ex-'))
    try {
      const baseDir = join(pai, 'repo')
      mkdirSync(caminhoDeWorktree(baseDir, 'ocupado'), { recursive: true })
      const assento = fazerAssento()
      const log = createFakeLogger()
      const servico = criarServicoDeWorktrees({
        subprocess: () => assento,
        baseDir: () => baseDir,
        log: log('worktrees'),
      })
      assert.equal(servico.existe('ocupado'), true)
      assert.equal(servico.existe('livre'), false)
    } finally {
      rmSync(pai, { recursive: true, force: true })
    }
  })
})
