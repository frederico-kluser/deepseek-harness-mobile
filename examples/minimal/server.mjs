// examples/minimal/server.mjs — servidor guardado MÍNIMO usando o portão REAL
// Importa os módulos COMPILADOS do plugin (dist/) e monta a barreira sobre um
// node:http.Server. Demonstra o contrato central: sem credencial → 401; com a
// credencial do dono → 200; e nenhum processo sobrante ao desligar (pgrep vazio).
// Rodar:  node server.mjs   (ou ./run.sh, que executa o critério de aceite)

import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../dist/http/gate.js'
import { installAuthBarrier } from '../../dist/http/intercept.js'
import { createGateAuthStack, createTunnelOriginRegistry } from '../../dist/http/session-auth.js'
import { createGuardLogger } from '../../dist/logging/logger.js'
import { digestSecret } from '../../dist/secret/verify.js'
import { LOOPBACK_ONLY_PREFIXES, UNAUTHENTICATED_PANEL_PREFIXES } from '../../dist/index.js'
import { makeConfig } from './config.mjs'

// Senha do dono para a demo — VALOR DESCARTÁVEL, nunca a senha real do teu DSH.
export const DEMO_SECRET = 'K7QF-2M9X-4TZP-9WQ2-8BND-3XKR-7MPV'

/** Converte a forma printf ('%s', msg) usado por `createGuardLogger` na mensagem. */
function fmt(args) {
  if (args.length === 2 && args[0] === '%s') return String(args[1])
  return args.map(String).join(' ')
}

/** ctx duck-type mínimo: logger nomeado + waterfall de auth = next() (sem ouvintes). */
function minimalCtx() {
  const tick = (level, msg) => console.error('[guarded-bot] ' + level + ' ' + msg)
  return {
    logger() {
      return { info: (...a) => tick('info', fmt(a)), warn: (...a) => tick('warn', fmt(a)), error: (...a) => tick('error', fmt(a)), debug: (...a) => tick('debug', fmt(a)) }
    },
    waterfall(event, _data, next) {
      // Sem ouvintes externos: o 'next' terminal devolve a decisão do portão.
      return next();
    },
  };
}

export async function startDemo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-minimal-'))
  const ctx = minimalCtx()
  const log = createGuardLogger(ctx)
  const config = makeConfig()
  const tunnelOrigin = createTunnelOriginRegistry()

  const stack = createGateAuthStack({
    log,
    tunnelOrigin,
    clock: { now: () => Date.now() },
    stateDir: dir,
    auditPath: join(dir, 'audit.log'),
    wait: () => Promise.resolve(),
  });

  // Credencial do dono: provisionada como DIGEST (nunca em claro), como o produto
  // faz com a senha gerada por CSPRNG.
  stack.state.update((prev) => ({ ...prev, secretDigest: digestSecret(DEMO_SECRET) }));

  const server = createServer()
  // O 'resto do DSH' debaixo da barreira (nunca alcançado sem credencial).
  server.on('request', (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') })
  server.on('upgrade', (_req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n') })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const bound = server.address()
  const port = bound.port;
  const auth = () => stack.auth;

  const deps = {
    ctx,
    log,
    config,
    auth,
    tunnelOrigin,
    bindHost: '127.0.0.1',
    loopbackAuthority: '127.0.0.1:' + String(port),
    loopbackOnlyPrefixes: LOOPBACK_ONLY_PREFIXES,
    unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
  };

  const reverter = installAuthBarrier(server, {
    wrapRequest: (delegate) => createGuardedHandler(deps, delegate, 'minimal'),
    wrapUpgrade: (delegate) => createGuardedUpgradeHandler(deps, delegate, 'minimal:upgrade'),
  }, log);

  async function close() {
    reverter();
    await new Promise((resolve) => server.close(resolve));
    stack.dispose();
    rmSync(dir, { recursive: true, force: true });
  }

  return { port, close, deps, stack }
}

// CLI direta: sobe, imprime instruções, espera por Ctrl-C.
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const d = await startDemo();
  console.log('GUARD_MINIMAL_LISTENING http://127.0.0.1:' + d.port);
  console.log('');
  console.log('Sem credencial (401):        curl -s -o /dev/null -w %{http_code} http://127.0.0.1:' + d.port + '/api/state');
  console.log('Com credencial do dono (200): curl -s -o /dev/null -w %{http_code} -u dsh:' + DEMO_SECRET + ' http://127.0.0.1:' + d.port + '/api/state');
  console.log('');
  console.log('Ctrl-C para desligar.');
  const onSig = async () => { await d.close(); process.exit(0) };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
}
