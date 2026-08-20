/**
 * S12 — BATERIA DE FALSIFICACAO: mede cada opcao candidata do prompt (a)..(e)
 * e o comportamento real de `ctx.intercept`. Nenhum veredito aqui e deduzido:
 * cada um sai de uma requisicao HTTP real ou de uma excecao real capturada.
 *
 * Correr: node scripts/spike/intercept/falsificacao.mjs
 */
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as frontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { fileURLToPath } from 'node:url'
import { montarComposicao } from './composicao.mjs'
import { pedir } from './http-lab.mjs'

const DIST_INDEX = fileURLToPath(new URL('./fixtures/web-dist/index.html', import.meta.url))
const linha = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)

// ─────────────────────────────────────────────────────────────────────────────
linha('Q1 / OPCAO ZERO — `ctx.intercept(\'webServer\', ...)` faz alguma coisa?')
{
  const lab = await montarComposicao()
  // O servico lido de `ctx` e um Proxy "traceable" que devolve um NOVO wrapper a
  // cada leitura de metodo, por isso a comparacao de identidade tem de ser feita
  // sobre o alvo cru (`symbols.original`, cordis/src/utils.ts:54 e :175).
  const cru = lab.webServer[Symbol.for('cordis.original')]
  const antesRegister = cru.register
  let filho
  let lancou = null
  try {
    filho = lab.ctx.intercept('webServer', {
      register: () => { throw new Error('se isto correr, intercept envolve metodos') },
      authBarrier: 'valor-inventado',
    })
  } catch (err) { lancou = err.message; filho = lab.ctx }
  const depoisRegister = cru.register
  console.log('  `intercept` aceitou config arbitraria sem lancar:      ', lancou === null)
  console.log('  `register` do alvo cru mudou de identidade?            ', antesRegister !== depoisRegister)
  console.log('  o contexto devolvido e o mesmo objeto?                 ', filho === lab.ctx)
  const mapa = filho[Symbol.for('cordis.intercept')]
  console.log('  onde a config foi parar (Context[symbols.intercept]):  ', JSON.stringify(Object.keys(mapa.webServer ?? {})))
  const leAConfig = typeof cru[Symbol.for('cordis.resolveConfig')] === 'function'
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const fonteWebServer = readFileSync(
    fileURLToPath(new URL('./node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js', import.meta.url)), 'utf8')
  const ocorrencias = fonteWebServer.split('\n').filter((l) => l.includes('resolveConfig')).length
  console.log('  o WebServer chega a LER config de intercept?           ',
    `resolveConfig herdado=${leAConfig}, ocorrencias no lib/index.js publicado=${ocorrencias}`)
  // Um plugin carregado ABAIXO do contexto interceptado recebe o mesmo servico.
  let mesmoServico
  await filho.plugin({
    name: 'lab-abaixo-do-intercept',
    inject: ['webServer'],
    apply(c) { mesmoServico = c.webServer[Symbol.for('cordis.original')] === cru },
  })
  console.log('  plugin abaixo do intercept recebe o MESMO servico?     ', mesmoServico)
  const r = await pedir(lab.port, '/api/state')
  console.log('  GET /api/state depois do intercept ->', r.status, '(barreira NAO instalada)')
  await lab.dispose()
}

// ─────────────────────────────────────────────────────────────────────────────
linha('OPCAO (b) — rota `{kind:\'prefix\', path:\'/\'}` : o que ela captura mesmo?')
{
  let colisao = null
  const guardaPrefixo = {
    name: 'lab-guard-prefix-raiz',
    inject: ['webServer'],
    apply(ctx) {
      ctx.effect(() => {
        try {
          const d = ctx.webServer.register({
            kind: 'prefix',
            path: '/',
            handler: (req, res) => { res.writeHead(401); res.end('capturado pelo prefix /') },
          })
          colisao = false
          return d
        } catch (err) { colisao = err.message; return () => {} }
      }, 'lab: prefix /')
    },
  }
  const lab = await montarComposicao({ extra: [guardaPrefixo] })
  console.log(`  \`register({kind:"prefix", path:"/"})\` lancou? ${colisao === false ? 'NAO' : colisao}`)
  console.log(`  o assento de fallback continua do frontend-static? ${lab.webServer.fallback !== undefined}`)
  for (const p of ['/', '/rota-spa', '/api/state', '/plugins/x/client.js', '/__dsh_invariant_probe__']) {
    const r = await pedir(lab.port, p)
    console.log(`  GET ${p.padEnd(24)} -> ${r.status} ${r.status === 401 ? '(capturado)' : '(PASSOU AO LADO)'}`)
  }
  await lab.dispose()
  console.log('  causa medida — lib/index.js:198-200: `pathname !== prefix && !pathname.startsWith(`${prefix}/`)`')
  console.log('    para prefix "/" o teste vira startsWith("//"), logo so o proprio "/" casa.')
}

// ─────────────────────────────────────────────────────────────────────────────
linha('OPCAO (c) — tomar o assento de fallback')
{
  console.log('  c.1 — assento JA tomado pelo frontend-static, guarda tenta reclamar:')
  const lab = await montarComposicao()
  try {
    lab.webServer.registerFallback(() => {})
    console.log('    NAO lancou (inesperado)')
  } catch (err) {
    console.log(`    lancou: ${err.constructor.name}: ${err.message}`)
  }
  await lab.dispose()

  console.log('  c.2 — guarda toma o assento PRIMEIRO; o frontend-static entra depois:')
  const ctx = new Context()
  ctx.on('internal/warning', () => {})
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  ctx.plugin({
    name: 'lab-guarda-fallback',
    inject: ['webServer'],
    apply(c) {
      c.effect(() => c.webServer.registerFallback((req, res) => { res.writeHead(401); res.end('guarda') }), 'lab: assento')
    },
  })
  const fiber = ctx.plugin(frontendStatic, { distIndex: DIST_INDEX })
  let erroBoot
  try {
    await fiber
  } catch (err) {
    erroBoot = err
  }
  console.log(`    fiber do frontend-static: state=${fiber.state} erro=${erroBoot ? `${erroBoot.message}` : 'nenhum'}`)
  const porta = ctx.get('webServer').port
  const r = await pedir(porta, '/')
  console.log(`    GET / -> ${r.status} "${r.body}"  (a SPA morreu; so a guarda responde)`)
  await ctx.fiber.dispose()
}

// ─────────────────────────────────────────────────────────────────────────────
linha('OPCAO (a) — monkey-patch de register/registerFallback/registerUpgrade')
{
  /** Envolve os tres metodos na INSTANCIA; devolve disposer sincrono. */
  function envolverMetodos(svc, authorize) {
    const originais = {
      register: svc.register,
      registerFallback: svc.registerFallback,
      registerUpgrade: svc.registerUpgrade,
    }
    const guardaHttp = (h) => (req, res) => {
      if (!authorize(req)) { res.writeHead(401); res.end('guarda'); return undefined }
      return h(req, res)
    }
    svc.register = function (route) { return originais.register.call(this, { ...route, handler: guardaHttp(route.handler) }) }
    svc.registerFallback = function (h) { return originais.registerFallback.call(this, guardaHttp(h)) }
    svc.registerUpgrade = function (route) {
      return originais.registerUpgrade.call(this, {
        ...route,
        handler: (req, socket, head) => {
          if (!authorize(req)) { socket.destroy(); return undefined }
          return route.handler(req, socket, head)
        },
      })
    }
    return () => {
      svc.register = originais.register
      svc.registerFallback = originais.registerFallback
      svc.registerUpgrade = originais.registerUpgrade
    }
  }

  console.log('  a.1 — guarda carregada ANTES de quem regista (ordem respeitada):')
  {
    const ctx = new Context()
    ctx.on('internal/warning', () => {})
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const svc = ctx.get('webServer')
    const reverter = envolverMetodos(svc, () => false)
    await ctx.plugin({
      name: 'lab-vitima-tardia',
      inject: ['webServer'],
      apply(c) {
        c.effect(() => c.webServer.register({ kind: 'prefix', path: '/api', handler: (q, s) => { s.writeHead(200); s.end('api') } }), 'lab: /api')
      },
    })
    const r = await pedir(svc.port, '/api/state')
    console.log(`    GET /api/state -> ${r.status} ${r.status === 401 ? '(guardado)' : '(PASSOU AO LADO)'}`)
    reverter()
    const r2 = await pedir(svc.port, '/api/state')
    console.log(`    apos disposer  -> ${r2.status} (rota JA registada continua envolvida? ${r2.status === 401 ? 'SIM — reversao INCOMPLETA' : 'nao'})`)
    await ctx.fiber.dispose()
  }

  console.log('  a.2 — guarda carregada DEPOIS de quem regista (ordem violada):')
  {
    const lab = await montarComposicao()
    const reverter = envolverMetodos(lab.webServer, () => false)
    for (const p of ['/api/state', '/', '/__dsh_invariant_probe__']) {
      const r = await pedir(lab.port, p)
      console.log(`    GET ${p.padEnd(24)} -> ${r.status} ${r.status === 401 ? '(guardado)' : '(PASSOU AO LADO — rota registada antes da guarda)'}`)
    }
    reverter()
    await lab.dispose()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
linha('OPCAO (e2) — reescrever as TABELAS de rota (acoplamento a 5 campos `private`)')
{
  /** Envolve os handlers ja presentes nas tabelas; devolve disposer sincrono. */
  function envolverTabelas(svc, authorize) {
    const nega = (res) => { res.writeHead(401); res.end('guarda') }
    const originais = { exact: new Map(svc.exact), prefixes: new Map(svc.prefixes), upgrades: new Map(svc.upgrades), fallback: svc.fallback }
    for (const tabela of [svc.exact, svc.prefixes]) {
      for (const [path, route] of tabela) {
        tabela.set(path, { ...route, handler: (req, res) => (authorize(req) ? route.handler(req, res) : nega(res)) })
      }
    }
    for (const [path, route] of svc.upgrades) {
      svc.upgrades.set(path, { ...route, handler: (req, socket, head) => (authorize(req) ? route.handler(req, socket, head) : socket.destroy()) })
    }
    const original = svc.fallback
    if (original !== undefined) svc.fallback = (req, res) => (authorize(req) ? original(req, res) : nega(res))
    return () => {
      svc.exact.clear(); for (const [k, v] of originais.exact) svc.exact.set(k, v)
      svc.prefixes.clear(); for (const [k, v] of originais.prefixes) svc.prefixes.set(k, v)
      svc.upgrades.clear(); for (const [k, v] of originais.upgrades) svc.upgrades.set(k, v)
      svc.fallback = originais.fallback
    }
  }
  const lab = await montarComposicao()
  const reverter = envolverTabelas(lab.webServer, () => false)
  for (const p of ['/api/state', '/', '/__dsh_invariant_probe__']) {
    const r = await pedir(lab.port, p)
    console.log(`  GET ${p.padEnd(24)} -> ${r.status} ${r.status === 401 ? '(guardado)' : '(PASSOU AO LADO)'}`)
  }
  // Rota registada DEPOIS da instalacao: a tabela ja foi reescrita, a nova entrada nao.
  await lab.ctx.plugin({
    name: 'lab-rota-tardia',
    inject: ['webServer'],
    apply(c) {
      c.effect(() => c.webServer.register({ kind: 'prefix', path: '/tardia', handler: (q, s) => { s.writeHead(200); s.end('tardia') } }), 'lab: /tardia')
    },
  })
  const tardia = await pedir(lab.port, '/tardia/x')
  console.log(`  GET /tardia/x (registada APOS a instalacao) -> ${tardia.status} ${tardia.status === 401 ? '(guardado)' : '(PASSOU AO LADO — buraco de janela)'}`)
  reverter()
  const revertido = await pedir(lab.port, '/api/state')
  console.log(`  apos disposer: GET /api/state -> ${revertido.status}`)
  console.log('  campos `private` tocados: exact, prefixes, upgrades, fallback (4) + leitura de indexTaps')
  await lab.dispose()
}

// ─────────────────────────────────────────────────────────────────────────────
linha('Q4 — ordem de activacao entre plugins irmaos que injectam o mesmo servico')
{
  const ordem = []
  const marcar = (id) => ({ name: `lab-ordem-${id}`, inject: ['webServer'], apply() { ordem.push(id) } })
  const ctx = new Context()
  ctx.on('internal/warning', () => {})
  ctx.plugin(marcar('A'))
  ctx.plugin(marcar('B'))
  ctx.plugin(marcar('C'))
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await new Promise((r) => setImmediate(r))
  console.log('  linhas registadas A,B,C ANTES do webServer; activacao observada:', ordem.join(','))
  await ctx.fiber.dispose()

  const ordem2 = []
  const marcar2 = (id) => ({ name: `lab-ordem2-${id}`, inject: ['webServer'], apply() { ordem2.push(id) } })
  const ctx2 = new Context()
  ctx2.on('internal/warning', () => {})
  await ctx2.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx2.plugin(marcar2('X'))
  await ctx2.plugin(marcar2('Y'))
  console.log('  linhas registadas DEPOIS do webServer; activacao observada:  ', ordem2.join(','))
  console.log('  => a ordem segue a ordem de registo no registry, que e a ordem das linhas do patch.')
  console.log('  => MAS dsh-base/cordis.patch.yml:12-13 declara: "Row order carries no load semantics"')
  console.log('     (activation is service-availability driven) — logo isto e comportamento observado,')
  console.log('     NAO contrato. Nenhum campo de prioridade/insert-before existe nas linhas do patch.')
  await ctx2.fiber.dispose()
}

// ─────────────────────────────────────────────────────────────────────────────
linha('Q3 — precondicao unica do mecanismo recomendado: `server` ja existe quando injectamos?')
{
  const observado = []
  const ctx = new Context()
  ctx.on('internal/warning', () => {})
  ctx.plugin({
    name: 'lab-precondicao',
    inject: ['webServer'],
    apply(c) {
      const svc = c.webServer
      observado.push({
        temServer: svc.server !== undefined,
        ehHttpServer: svc.server?.constructor?.name,
        aEscutar: svc.server?.listening,
        listenersRequest: svc.server?.listenerCount('request'),
        listenersUpgrade: svc.server?.listenerCount('upgrade'),
        propsVisiveisNoProxy: Object.getOwnPropertyNames(svc).length,
      })
    },
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await new Promise((r) => setImmediate(r))
  console.log('  no momento em que `inject:["webServer"]` activa:')
  console.log(`    ${JSON.stringify(observado[0])}`)

  console.log('  falha-alto quando o servidor ainda nao existe (servico fabricado sem `server`):')
  const { instalarBarreira, BarreiraIndisponivel } = await import('./barreira.mjs')
  try {
    instalarBarreira({ nada: 1 }, { authorize: () => true })
  } catch (err) {
    console.log(`    ${err instanceof BarreiraIndisponivel ? 'BarreiraIndisponivel' : err.name}: ${err.message}`)
  }
  await ctx.fiber.dispose()
}
