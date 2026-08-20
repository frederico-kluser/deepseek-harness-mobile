/**
 * S12 — composicao Cordis minima que reproduz a superficie HTTP real do DSH Web.
 *
 * Rotas espelhadas da composicao enviada (`@deepseek-ai/dsh-web-app@0.1.0-rc.8`
 * `cordis.patch.yml`, linhas 115-160):
 *   - prefix `/api`               -> `@deepseek-ai/dsh-client-connection` (lib/index.js:551-562)
 *   - prefix `/plugins`           -> `@deepseek-ai/dsh-client-modules`
 *   - exact  `/__dsh_invariant_probe__` -> sonda de invariante
 *   - upgrade `/api/events.mux` e `/api/events.host` (lib/index.js:567-586)
 *   - assento de fallback         -> `@deepseek-ai/dsh-host-frontend-static` (REAL, o pacote publicado)
 */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as frontendStatic from '@deepseek-ai/dsh-host-frontend-static'

const DIST_INDEX = fileURLToPath(new URL('./fixtures/web-dist/index.html', import.meta.url))

/** Responde JSON simples numa rota nomeada. */
function responderJson(res, corpo) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(corpo))
}

/** Plugin vitima: as rotas nomeadas que outro plugin possui. */
const rotasNomeadas = {
  name: 'lab-rotas-nomeadas',
  inject: ['webServer'],
  apply(ctx) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api',
      handler: (req, res) => responderJson(res, { rota: '/api', url: req.url }),
    }), 'lab: /api')
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (req, res) => responderJson(res, { rota: '/plugins', url: req.url }),
    }), 'lab: /plugins')
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/__dsh_invariant_probe__',
      handler: (req, res) => responderJson(res, { rota: 'probe' }),
    }), 'lab: probe')
  },
}

/** Plugin vitima: os dois WebSockets de telemetria. */
const rotasUpgrade = {
  name: 'lab-rotas-upgrade',
  inject: ['webServer'],
  apply(ctx) {
    for (const path of ['/api/events.mux', '/api/events.host']) {
      ctx.effect(() => ctx.webServer.registerUpgrade({
        path,
        handler: (req, socket) => {
          socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n'
              + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
              + `X-Lab-Route: ${path}\r\n\r\n`,
          )
        },
      }), `lab: upgrade ${path}`)
    }
  },
}

/** Plugin que grava uma marca via tapIndex — prova que applyIndexTaps continua a correr. */
const tapDeBoot = {
  name: 'lab-tap-index',
  inject: ['webServer'],
  apply(ctx) {
    ctx.effect(
      () => ctx.webServer.tapIndex((html) => html.replace('<div id="app"></div>', '<div id="app"></div><!--BOOT_MANIFEST-->')),
      'lab: tapIndex',
    )
  },
}

/**
 * Monta a composicao e devolve `{ ctx, webServer, port, dispose }`.
 *
 * @param {object} [options]
 * @param {boolean} [options.comFallback] - carregar o `frontend-static` real (default true).
 * @param {Plugin[]} [options.extra] - plugins adicionais carregados no fim.
 */
export async function montarComposicao(options = {}) {
  const comFallback = options.comFallback ?? true
  const ctx = new Context()
  ctx.on("internal/warning", () => {})
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(rotasNomeadas)
  await ctx.plugin(rotasUpgrade)
  await ctx.plugin(tapDeBoot)
  if (comFallback) await ctx.plugin(frontendStatic, { distIndex: DIST_INDEX })
  for (const extra of options.extra ?? []) await ctx.plugin(extra)
  const webServer = ctx.get('webServer')
  return {
    ctx,
    webServer,
    port: webServer.port,
    dispose: () => ctx.fiber.dispose(),
  }
}

/** Enumera as tabelas de rota do servico (campos `private` so no TypeScript). */
export function enumerarTabelas(webServer) {
  return {
    exact: [...webServer.exact.keys()],
    prefix: [...webServer.prefixes.keys()],
    upgrade: [...webServer.upgrades.keys()],
    indexTaps: webServer.indexTaps.length,
    fallbackClaimed: webServer.fallback !== undefined,
  }
}
