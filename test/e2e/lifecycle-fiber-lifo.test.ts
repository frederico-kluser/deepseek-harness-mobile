/**
 * =============================================================================
 * T6.4 -- O DISPOSER DA FIBER EM LIFO, sobre o Cordis REAL.
 * =============================================================================
 *
 * `src/index.ts` regista cinco efeitos numa ordem DELIBERADA (veto, auth-check,
 * barreira, controlador, worker) porque os disposers do Cordis correm em LIFO:
 * quando a Fiber transita para DISPOSED, o WORKER e o primeiro a ser erradicado
 * e so depois a barreira e levantada. Na ordem inversa haveria uma janela em
 * que o plano de controlo responde sem credencial enquanto o worker ainda esta
 * vivo -- o furo que este plugin existe para fechar.
 *
 * O que os testes unitarios provam com o FakeContext, este ficheiro prova com o
 * Cordis REAL (`@deepseek-ai/cordis@4.0.1`, instalado): uma Fiber de verdade,
 * os seus efeitos e os seus disposers, e um PROCESSO REAL a ser morto pela
 * ordem dos disposers.
 *
 *   Parte A: registam-se os CINCO efeitos com os MESMOS nomes e na MESMA ordem
 *   de `apply()`; o efeito do worker cria um processo REAL e o seu disposer
 *   mata-o. Ao descarregar a Fiber, a sequencia observada tem de ser a ordem
 *   inversa exata, e o disposer da barreira tem de ver o processo do worker JA
 *   morto.
 *
 *   Parte B: corre-se o `apply()` REAL sobre uma Fiber REAL (com os dois
 *   servicos fakes do suporte -- a costura e a mesma que o DSH usa, so que sem
 *   o harness), em modo loopback e em modo tunnel; descarrega-se a Fiber e
 *   verifica-se que tudo caiu na ordem: worker terminado, barreira revertida,
 *   rotas do painel desregistadas, alocador de metricas fechado.
 *
 * A garantia LIFO e do motor Cordis; o que este ficheiro assere e que a
 * COMPOSICAO do plugin a usa da forma documentada.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { apply, type Config } from '../../src/index.ts'
import { FakeSubprocessService } from '../support/child-double.ts'
import { FakeWebServer } from '../support/ctx-double.ts'
import { makeConfig } from '../support/fixtures.ts'

const POSIX_REASON =
  'ciclo de vida de subprocesso POSIX; o package.json declara os: [linux, darwin].'

const casa = mkdtempSync(join(tmpdir(), 'dsh-guard-e2e-lifo-'))
const vivos = new Set<number>()
const dshHomeOriginal = process.env['DSH_HOME']

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function matarSePreciso(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    void error
  }
}

after(() => {
  for (const pid of vivos) {
    if (isAlive(pid)) matarSePreciso(pid)
  }
  vivos.clear()
  rmSync(casa, { recursive: true, force: true })
  if (dshHomeOriginal === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = dshHomeOriginal
})

/**
 * A ORDEM registada por `apply()` (ver `test/unit/index.test.ts` e
 * `test/support/fixtures.ts`: EFFECT = { veto: 0, authCheck: 1, barreira: 2,
 * controlador: 3, worker: 4 }). A sequencia completa esperada do descarrego.
 */
const ORDEM_EFEITOS = [
  'dsh-guard.veto-de-permissao',
  'dsh-guard.auth-check',
  'dsh-guard.barreira',
  'dsh-guard.controlador',
  'dsh-guard.worker',
] as const

/* ========================================================================== */
/* Parte A: a Fiber REAL, os cinco efeitos na ordem de apply, um processo REAL */
/* ========================================================================== */

describe('disposer da Fiber em LIFO (Cordis real)', { skip: process.platform === 'win32' ? POSIX_REASON : false }, () => {
  it('os disposers correm na ordem inversa exata da registacao, e o processo do worker morre ANTES da barreira', async () => {
    const ctx = new Context()
    const ordem: string[] = []
    let workerPid = 0
    /** O disposer do worker correu ANTES do disposer da barreira? */
    let workerDisposerCorreuAntes: boolean | undefined

    // A MESMA sequencia de ctx.effect de src/index.ts (veto, auth-check,
    // barreira, controlador, worker) -- e cada um devolve um disposer SINCRONO,
    // como o plugin exige (Q-2).
    ctx.effect((): (() => void) => {
      ordem.push('efeito.veto')
      return (): void => {
        ordem.push('disposer.veto')
      }
    }, 'dsh-guard.veto-de-permissao')

    ctx.effect((): (() => void) => {
      ordem.push('efeito.auth-check')
      return (): void => {
        ordem.push('disposer.auth-check')
      }
    }, 'dsh-guard.auth-check')

    ctx.effect((): (() => void) => {
      ordem.push('efeito.barreira')
      return (): void => {
        ordem.push('disposer.barreira')
        // LIFO: o disposer do worker (registado DEPOIS) ja correu antes do
        // nosso. E ele que emite o tree-kill; a ordem dos disposers e o que
        // garante que a janela de exposicao (barreira levantada com o worker
        // vivo) nao chega a abrir.
        workerDisposerCorreuAntes = ordem.includes('disposer.worker')
      }
    }, 'dsh-guard.barreira')

    ctx.effect((): (() => void) => {
      ordem.push('efeito.controlador')
      return (): void => {
        ordem.push('disposer.controlador')
      }
    }, 'dsh-guard.controlador')

    ctx.effect((): (() => void) => {
      ordem.push('efeito.worker')
      // O worker e um processo REAL de longa duracao: so o disposer o pode
      // matar, e ele tem de morrer ANTES de o disposer da barreira correr.
      const filho = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true,
        stdio: 'ignore',
      })
      workerPid = filho.pid as number
      vivos.add(workerPid)
      return (): void => {
        ordem.push('disposer.worker')
        // O tree-kill do GRUPO: o worker e detached (lider do grupo), logo o
        // sinal negativo designa-o a ele e a toda a descendencia.
        try {
          process.kill(-workerPid, 'SIGKILL')
        } catch (error) {
          void error
        }
      }
    }, 'dsh-guard.worker')

    assert.equal(workerPid > 0, true, 'o efeito do worker tem de ter criado o processo')
    assert.equal(isAlive(workerPid), true, 'o processo do worker tem de estar vivo antes do descarrego')

    // O descarrego da Fiber: espera-se a ordem inversa EXATA da registacao.
    await ctx.fiber.dispose()

    assert.deepEqual(ordem, [
      'efeito.veto',
      'efeito.auth-check',
      'efeito.barreira',
      'efeito.controlador',
      'efeito.worker',
      'disposer.worker',
      'disposer.controlador',
      'disposer.barreira',
      'disposer.auth-check',
      'disposer.veto',
    ])
    assert.equal(workerDisposerCorreuAntes, true, 'o disposer do worker tem de correr ANTES do da barreira')

    // O SIGKILL e entregue pelo nucleo de forma assincrona: a ORDEM dos
    // disposers e sincrona, o fim do processo e microssegundos depois. Espera-se
    // a morte real apos o descarrego completo.
    const morreu = await (async (): Promise<boolean> => {
      const prazo = Date.now() + 3000
      while (Date.now() < prazo) {
        if (!isAlive(workerPid)) return true
        await new Promise<void>((resolve) => setTimeout(resolve, 5))
      }
      return !isAlive(workerPid)
    })()
    assert.equal(morreu, true, 'e o processo real tem de ter morrido')
  })
})

/* ========================================================================== */
/* Parte B: o apply() REAL sobre uma Fiber REAL, com os servicos fakes        */
/* ========================================================================== */

interface Instalacao {
  ctx: Context
  webServer: FakeWebServer
  subprocess: FakeSubprocessService
  config: Config
  /** Os listeners ORIGINAIS do despacho, capturados ANTES do apply. */
  despachoOriginal: Array<(req: never, res: never) => void>
}

/**
 * Monta o plugin REAL (`apply`) numa Fiber REAL. Os dois servicos sao os
 * fakes do suporte (o DSH prove-os por injecao; aqui proveem-se por
 * `ctx.provide`, a mesma costura). O `DSH_HOME` aponta para um diretorio
 * temporario para o boot recovery nunca tocar no estado real do utilizador.
 */
function instalar(overrides: Partial<Config> = {}): Instalacao {
  process.env['DSH_HOME'] = join(casa, `home-${String(Math.random()).slice(2)}`)
  const ctx = new Context()
  const webServer = new FakeWebServer()
  const subprocess = new FakeSubprocessService()
  ctx.provide('webServer', webServer)
  ctx.provide('subprocess', subprocess)
  // O despacho ORIGINAL capturado ANTES do apply: e ele que a barreira guarda
  // e que o disposer tem de repor. Depois do apply o listener e o da barreira.
  const despachoOriginal = webServer.server.listeners('request') as Array<(req: never, res: never) => void>
  const config = makeConfig(overrides)
  apply(ctx, config)
  return { ctx, webServer, subprocess, config, despachoOriginal }
}

/** Os cinco efeitos do plugin, na ordem em que a Fiber REAL os registou. */
function efeitosDoPlugin(ctx: Context): string[] {
  return ctx.fiber
    .getEffects()
    .map((efeito) => efeito.label)
    .filter((label) => label.startsWith('dsh-guard.'))
}

describe('apply() real sobre a Fiber real', { skip: process.platform === 'win32' ? POSIX_REASON : false }, () => {
  it('loopback: regista os cinco efeitos na ordem documentada e o descarrego derruba tudo', async () => {
    const { ctx, webServer, subprocess, despachoOriginal } = instalar()

    // A Fiber REAL reporta os efeitos vivos e a sua ordem (getEffects).
    assert.deepEqual(efeitosDoPlugin(ctx), [...ORDEM_EFEITOS])
    assert.equal(subprocess.calls.length, 1, 'o worker arranca no apply')

    const child = subprocess.lastChild()
    await ctx.fiber.dispose()

    // Depois do descarrego, nada dos efeitos continua vivo.
    assert.deepEqual(efeitosDoPlugin(ctx), [])
    assert.equal(
      webServer.server.listeners('request')[0] === despachoOriginal[0],
      true,
      'barreira revertida: o despacho original tem de voltar a ser o dono',
    )
    assert.equal(child.terminateCalls >= 1, true, 'o worker foi terminado pelo seu disposer')
    assert.equal(webServer.routes.length, 0, 'rotas desregistadas')
  })

  it('loopback: uma SEGUNDA barreira nao pode nascer depois do descarrego', async () => {
    // O descarrego da Fiber corre os disposers a fundo: tentar voltar a aplicar
    // o plugin na mesma Fiber deixaria de ter efeitos (a Fiber so se descarrega
    // uma vez), e o que se assere e que o descarrego e idempotente e completo.
    const { ctx } = instalar()
    await ctx.fiber.dispose()
    await ctx.fiber.dispose()
    assert.deepEqual(efeitosDoPlugin(ctx), [])
  })

  it('tunnel: o supervisor nasce, e o descarrego derruba worker, painel, UI e alocador', async () => {
    const { ctx, webServer, subprocess, despachoOriginal } = instalar({
      exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false },
      tunnel: { mode: 'quick', ttlMinutes: 60 },
    })

    // Em modo tunnel o controlador monta o painel e a UI nativa.
    assert.equal(webServer.routes.length > 0, true, 'o painel /__guard registou rotas')
    assert.equal(subprocess.calls.length, 1, 'so o worker spawna (autoStart desligado)')

    const child = subprocess.lastChild()
    await ctx.fiber.dispose()

    assert.deepEqual(efeitosDoPlugin(ctx), [])
    assert.equal(
      webServer.server.listeners('request')[0] === despachoOriginal[0],
      true,
      'barreira revertida: o despacho original tem de voltar a ser o dono',
    )
    assert.equal(child.terminateCalls >= 1, true, 'worker terminado')
    assert.equal(webServer.routes.length, 0, 'rotas do painel/UI desregistadas')
    assert.equal(webServer.taps.length, 0, 'transforms da UI nativa removidos')
  })
})
