/**
 * =============================================================================
 * F1 (sub-tarefa 1.1) — A RESPOSTA DE INDICE DO DSH NAO RECEBE NADA DO PLUGIN.
 * =============================================================================
 *
 * O chrome da home (div #dsh-guard-ui + meta CSRF de fallback + script
 * `/__guard-ui/client.js`) era injetado por um `tapIndex` registrado pela
 * superficie de UI nativa. A remocao (onda 1) retirou o mecanismo POR
 * INTEIRO: a superficie nao toca o index.html — nem em tempo de init, nem em
 * tempo de erro/dispose.
 *
 * O que a guarda unitaria (espinho de `tapIndex` em surface.test.ts e
 * chrome-removido.test.ts) prova por doble, ESTE ficheiro prova por rede: o
 * `apply()` REAL sobre o `node:http.Server` REAL, com o "resto do DSH" a
 * servir um index REALISTA — o mesmo objeto que a injecao antiga tocava. A
 * resposta recebida pelo cliente tem de ser BYTE-A-BYTE a que o fallback
 * produziu: zero ocorrencias de "dsh-guard-ui", zero meta `dsh-csrf`, zero
 * script `/__guard-ui/client.js`.
 *
 *   Parte A (tunnel — o modo em que a superficie monta):
 *     - GET / atravessa a barreira e volta intocado;
 *     - `webServer.taps` fica VAZIO (zero transforms registados em init);
 *     - as 17 rotas API preservadas continuam registadas e o GET /api/csrf
 *       emite (a UNICA fonte de CSRF desde que o meta saiu);
 *     - nenhuma rota `/__guard-ui/client.js` existe;
 *     - apos o DESCARREGO, o indice segue intocado e as rotas saem.
 *
 *   Parte B (loopback — a superficie nem monta):
 *     - nenhum `/__guard-ui` registado; o indice segue intocado.
 *
 * A bancada e a MESMA de test/integration/http/barreira.test.ts (servidor
 * real a escutar, pedidos de rede reais) e de test/e2e/lifecycle-fiber-lifo
 * (apply real, descarga de efeitos). RAIZ DE ESTADO DESCARTAVEL: `DSH_HOME`
 * aponta para um diretorio temporario, nunca para o estado do utilizador.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import type { AddressInfo } from 'node:net'
import type { IncomingMessage } from 'node:http'

import { apply } from '../../src/index.ts'
import {
  UI_PATH_ACCESS,
  UI_PATH_AGENTS,
  UI_PATH_CONFIRM,
  UI_PATH_CSRF,
  UI_PATH_PAIR,
  UI_PATH_PAIR_STATE,
  UI_PATH_PRIVACIDADE,
  UI_PATH_RESET,
  UI_PATH_RESET_CONFIRM,
  UI_PATH_START,
  UI_PATH_STATE,
  UI_PATH_STOP,
  UI_PATH_TELEGRAM,
  UI_PATH_TELEGRAM_CLICK,
  UI_PATH_TOKEN,
  UI_PATH_TOKEN_STATE,
} from '../../src/ui-contrib/routes.ts'
import { FakeContext, FakeResponse } from '../support/ctx-double.ts'
import { makeConfig } from '../support/fixtures.ts'

/**
 * O INDICE REALISTA do DSH: a mesma cara do que o assento de fallback
 * (dsh-host-frontend-static) serve — e o MESMO html que, antes da remocao, o
 * `tapIndex` da superficie adornava com div + meta + script. Propositalmente
 * contem os pontos de ancoragem que o chrome antigo usava (`</body>`, o div
 * de raiz) para a guarda nao passar por um html que nem permitiria a injecao.
 */
const INDICE_DO_DSH = [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>DeepSeek Harness</title>',
  '<script type="module" crossorigin src="/assets/index-BOOT.js"></script>',
  '</head>',
  '<body>',
  '<div id="root"></div>',
  '</body>',
  '</html>',
].join('\n')

/** As marcas do chrome removido — nenhuma pode aparecer na resposta de indice. */
const MARCAS_DO_CHROME: readonly string[] = [
  'dsh-guard-ui', // o div e todo o resto do plugin na home
  'dsh-csrf', // o meta de fallback (a fonte de CSRF agora e a rota GET /api/csrf)
  '/__guard-ui/client.js', // o script do chrome
]

/** As 17 rotas API da superficie — 16 exact + o prefixo de cancelamento. */
const ROTAS_UI_EXACT: readonly string[] = [
  UI_PATH_STATE,
  UI_PATH_START,
  UI_PATH_CONFIRM,
  UI_PATH_STOP,
  UI_PATH_RESET,
  UI_PATH_RESET_CONFIRM,
  UI_PATH_TELEGRAM,
  UI_PATH_TELEGRAM_CLICK,
  UI_PATH_TOKEN,
  UI_PATH_TOKEN_STATE,
  UI_PATH_PRIVACIDADE,
  UI_PATH_PAIR,
  UI_PATH_PAIR_STATE,
  UI_PATH_ACCESS,
  UI_PATH_AGENTS,
  UI_PATH_CSRF,
]

interface Instalacao {
  ctx: FakeContext
  limpar: () => void
}

const CASA = mkdtempSync(join(tmpdir(), 'dsh-guard-sem-chrome-'))
const DSH_HOME_ORIGINAL = process.env['DSH_HOME']

async function ouvir(ctx: FakeContext): Promise<number> {
  await new Promise<void>((resolve) => {
    ctx.webServer.server.listen(0, '127.0.0.1', resolve)
  })
  return (ctx.webServer.server.address() as AddressInfo).port
}

function pedir(porta: number, caminho: string): Promise<{ status: number; corpo: string; tipo: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: porta, path: caminho }, (res) => {
      let corpo = ''
      res.setEncoding('utf8')
      res.on('data', (pedaco: string) => {
        corpo += pedaco
      })
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, corpo, tipo: res.headers['content-type'] }),
      )
    })
    req.on('error', reject)
    req.end()
  })
}

function instalar(tunnel: boolean): Instalacao & { descarregado: boolean } {
  // RAIZ DE ESTADO DESCARTAVEL POR INSTALACAO: o boot recovery e a pilha de
  // auditoria nunca tocam o estado real do utilizador (o mesmo do lifecycle).
  process.env['DSH_HOME'] = join(CASA, `home-${tunnel ? 'tunnel' : 'loopback'}-${Math.random().toString(36).slice(2)}`)
  process.env['DSH_GUARD_AUDIT_LOG'] = join(CASA, `audit-${tunnel ? 'tunnel' : 'loopback'}-${Math.random().toString(36).slice(2)}.log`)
  const ctx = new FakeContext()
  ctx.webServer.onRequest = (req, res): void => {
    if ((req.url ?? '/') === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(INDICE_DO_DSH)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('fora do escopo deste e2e')
  }
  // O MESMO override do e2e de ciclo de vida: em modo tunnel o controlador
  // monta o painel e a UI nativa (autoStart desligado — so a estrutura).
  const config = makeConfig(
    tunnel
      ? {
          exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false },
          tunnel: { mode: 'quick', ttlMinutes: 60 },
        }
      : {},
  )
  apply(ctx.asContext(), config)
  const instalacao: Instalacao & { descarregado: boolean } = {
    ctx,
    descarregado: false,
    limpar: (): void => {
      if (instalacao.descarregado) return // idempotente (os efeitos sao sincronos)
      instalacao.descarregado = true
      for (const disposer of [...ctx.effects].toReversed()) disposer()
    },
  }
  return instalacao
}

function descartar(instalacao: Instalacao): Promise<void> {
  instalacao.limpar()
  return new Promise<void>((resolve) => {
    instalacao.ctx.webServer.server.close(() => resolve())
  })
}

/* ========================================================================== */
/* PARTE A — tunnel: o modo em que a superficie monta                          */
/* ========================================================================== */

describe('F1 (tunnel): a resposta de indice NAO recebe nada do plugin', () => {
  const instalacao = instalar(true)
  let porta = 0

  before(async () => {
    porta = await ouvir(instalacao.ctx)
  })

  after(async () => {
    await descartar(instalacao)
  })

  it('GET / atravessa a barreira e volta BYTE-A-BYTE intocado — zero "dsh-guard-ui", sem div, sem meta, sem script', async () => {
    const resposta = await pedir(porta, '/')
    assert.equal(resposta.status, 200, 'o acesso local abre direto (onda 1)')
    assert.equal(resposta.corpo, INDICE_DO_DSH, 'o indice sai exatamente como o fallback o produziu')
    for (const marca of MARCAS_DO_CHROME) {
      assert.equal(
        resposta.corpo.includes(marca),
        false,
        `a resposta de indice contem a marca do chrome removido: "${marca}"`,
      )
    }
  })

  it('estrutura: webServer.taps fica VAZIO em init — zero transforms de indice registados', () => {
    assert.deepEqual(
      instalacao.ctx.webServer.taps,
      [],
      'a superficie registou um tap de indice (regresso do chrome)',
    )
  })

  it('as 17 rotas API preservadas continuam registadas e NENHUMA rota /__guard-ui/client.js existe', () => {
    const rotas = instalacao.ctx.webServer.routes
    for (const caminho of ROTAS_UI_EXACT) {
      const rota = rotas.find((r) => r.path === caminho)
      assert.ok(rota !== undefined, `rota API preservada ausente: ${caminho}`)
      assert.equal(rota.kind, 'exact', caminho)
    }
    // O cancelamento de agentes e a rota PREFIXO no MESMO caminho da lista.
    const cancelamento = rotas.find((r) => r.path === UI_PATH_AGENTS && r.kind === 'prefix')
    assert.ok(cancelamento !== undefined, 'o prefixo de cancelamento de agentes deve estar registado')
    assert.equal(
      rotas.some((r) => r.path.includes('client.js')),
      false,
      'a rota do script do chrome nao deveria existir',
    )
    // 16 exact (agents incluido) + 1 prefixo no MESMO caminho = as 17 rotas da
    // superficie. O teto exato e o que trava ressurreicoes silenciosas.
    const daSuperficie = rotas.filter((r) => String(r.path).startsWith('/__guard-ui'))
    assert.equal(daSuperficie.length, 17, `rotas /__guard-ui inesperadas: ${JSON.stringify(daSuperficie.map((r) => `${r.kind} ${String(r.path)}`))}`)
  })

  it('o GET /__guard-ui/api/csrf emite (a UNICA fonte de CSRF — sem meta de indice nenhum)', async () => {
    const rota = instalacao.ctx.webServer.routes.find((r) => r.path === UI_PATH_CSRF)
    assert.ok(rota !== undefined)
    const res = new FakeResponse()
    const req = {
      method: 'GET',
      url: UI_PATH_CSRF,
      headers: {},
    } as unknown as IncomingMessage
    ;(rota.handler as (req: IncomingMessage, res: FakeResponse) => void)(req, res)
    assert.equal(res.statusCode, 200)
    const corpo = JSON.parse(res.body) as { token?: unknown }
    assert.equal(typeof corpo.token, 'string')
    assert.ok((corpo.token as string).length > 0)
    // A emissao vive numa resposta JSON de API — nunca num meta de HTML.
    assert.equal(res.headers['content-type']?.includes('application/json'), true)
  })

  it('apos o DESCARREGO: o indice segue intocado e as rotas da superficie saem', async () => {
    instalacao.limpar()

    assert.deepEqual(instalacao.ctx.webServer.taps, [], 'nenhum tap sobrou do descarrego')
    assert.equal(
      instalacao.ctx.webServer.routes.filter((r) => String(r.path).startsWith('/__guard-ui')).length,
      0,
      'as rotas da superficie foram desregistadas',
    )

    // O servidor continua de pe (so os efeitos do plugin caem): o indice volta
    // ao cliente exatamente como era — sem chrome, antes e depois.
    const resposta = await pedir(porta, '/')
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo, INDICE_DO_DSH)
    for (const marca of MARCAS_DO_CHROME) {
      assert.equal(resposta.corpo.includes(marca), false, `marca "${marca}" na home apos o descarrego`)
    }
  })
})

/* ========================================================================== */
/* PARTE B — loopback: a superficie nem monta                                  */
/* ========================================================================== */

describe('F1 (loopback): sem tunel a superficie nem monta e o indice segue intocado', () => {
  const instalacao = instalar(false)
  let porta = 0

  before(async () => {
    porta = await ouvir(instalacao.ctx)
  })

  after(async () => {
    await descartar(instalacao)
  })

  it('nenhum /__guard-ui registado, taps vazio, e o GET / volta intocado', async () => {
    assert.deepEqual(instalacao.ctx.webServer.taps, [])
    assert.equal(
      instalacao.ctx.webServer.routes.filter((r) => String(r.path).startsWith('/__guard-ui')).length,
      0,
      'a superficie montou sem configuracao de tunel (o controlador nem nasce)',
    )
    const resposta = await pedir(porta, '/')
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo, INDICE_DO_DSH)
    for (const marca of MARCAS_DO_CHROME) {
      assert.equal(resposta.corpo.includes(marca), false, `marca "${marca}" na home em loopback`)
    }
  })

  it('apos o descarrego do loopback: o indice segue intocado', async () => {
    instalacao.limpar()
    const resposta = await pedir(porta, '/')
    assert.equal(resposta.corpo, INDICE_DO_DSH)
  })
})

after(() => {
  rmSync(CASA, { recursive: true, force: true })
  if (DSH_HOME_ORIGINAL === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = DSH_HOME_ORIGINAL
})
