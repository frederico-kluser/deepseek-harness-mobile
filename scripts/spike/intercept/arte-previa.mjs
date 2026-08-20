/**
 * S12 — ARTE PRÉVIA: medições sobre `dsh-webui-auth@0.3.0` (pacote NÃO escopado,
 * publicado no npm, MIT, autor yuuz12) e sobre a opção (b) na forma que ele usa.
 *
 * Correr: node scripts/spike/intercept/arte-previa.mjs
 */
import { montarComposicao } from './composicao.mjs'
import { carregarCercaReal } from './cerca-real.mjs'
import { pedir, pedirUpgrade } from './http-lab.mjs'

const linha = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)

// ─────────────────────────────────────────────────────────────────────────────
linha('B1 — `{kind:"prefix", path:""}` : o catch-all público que eu tinha descartado')
{
  let colidiu = null
  const porta = { name: 'lab-gate-vazio', inject: ['webServer'], apply(ctx) {
    ctx.effect(() => {
      try {
        const d = ctx.webServer.register({
          kind: 'prefix',
          path: '',
          handler: (req, res) => { res.writeHead(401); res.end('gate vazio') },
        })
        colidiu = false
        return d
      } catch (err) { colidiu = err.message; return () => {} }
    }, 'lab: prefix ""')
  } }
  const lab = await montarComposicao({ extra: [porta] })
  console.log(`  register({kind:"prefix", path:""}) lançou? ${colidiu === false ? 'NAO' : colidiu}`)
  console.log(`  o assento de fallback continua do frontend-static? ${lab.webServer.fallback !== undefined}`)
  for (const p of ['/', '/rota-spa', '/assets/app.js', '/api/state', '/plugins/x/client.js', '/__dsh_invariant_probe__']) {
    const r = await pedir(lab.port, p)
    console.log(`  GET ${p.padEnd(26)} -> ${r.status} ${r.status === 401 ? '(CAPTURADO)' : '(passou ao lado)'}`)
  }
  const u = await pedirUpgrade(lab.port, '/api/events.mux')
  console.log(`  UPGRADE /api/events.mux            -> ${u.resultado} (o prefix "" nao ve upgrades)`)
  await lab.dispose()
}

// ─────────────────────────────────────────────────────────────────────────────
linha('B2 — o preço escondido do `prefix ""`: delegar ao dono do fallback')
{
  // O `prefix ""` rouba o trafego que ia para o assento de fallback. Para a SPA
  // sobreviver e preciso chamar o dono do assento — e a unica forma e ler
  // `ws.fallback`, campo `private` (dsh-webui-auth index.js:1261).
  const porta = { name: 'lab-gate-delegando', inject: ['webServer'], apply(ctx) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '',
      handler: async (req, res) => {
        if (req.headers['x-lab-auth'] !== 'ok') { res.writeHead(302, { location: '/login' }); res.end(); return }
        const fallback = ctx.webServer.fallback
        if (fallback === undefined) { res.writeHead(404); res.end(); return }
        await fallback(req, res)
      },
    }), 'lab: prefix "" delegando')
  } }
  const lab = await montarComposicao({ extra: [porta] })
  const negado = await pedir(lab.port, '/')
  console.log(`  GET / sem credencial -> ${negado.status} location=${negado.headers.location}`)
  const ok = await pedir(lab.port, '/', { headers: { 'x-lab-auth': 'ok' } })
  console.log(`  GET / com credencial -> ${ok.status}, applyIndexTaps preservado? ${ok.body.includes('<!--BOOT_MANIFEST-->')}`)
  console.log('  => a delegacao exigiu ler `ws.fallback` (campo `private`): a opcao (b) NAO e 100% API publica.')
  await lab.dispose()
}

// ─────────────────────────────────────────────────────────────────────────────
linha('B3 — o modelo de cobertura do dsh-webui-auth replicado: o que fica de fora')
{
  // PROTECTED_PREFIXES = ['/api', '/plugins'] (index.js:740). `ws.exact` NUNCA e
  // varrido. Replicamos o modelo e medimos o buraco.
  const lab = await montarComposicao()
  const ws = lab.webServer
  const nega = (res) => { res.writeHead(401); res.end('gate') }
  for (const pfx of ['/api', '/plugins']) {
    const route = ws.prefixes.get(pfx)
    const original = route.handler
    route.handler = (req, res) => (req.headers['x-lab-auth'] === 'ok' ? original(req, res) : nega(res))
  }
  for (const path of ['/api/events.mux', '/api/events.host']) {
    const r = ws.upgrades.get(path)
    const original = r.handler
    r.handler = (req, socket, head) => (req.headers['x-lab-auth'] === 'ok' ? original(req, socket, head) : socket.destroy())
  }
  console.log('  tabela `exact` foi varrida pelo modelo? NAO — PROTECTED_PREFIXES so tem prefixos')
  for (const p of ['/api/state', '/plugins/x/client.js', '/__dsh_invariant_probe__']) {
    const r = await pedir(lab.port, p)
    console.log(`  GET ${p.padEnd(26)} -> ${r.status} ${r.status === 401 ? '(guardado)' : '(DESCOBERTO — rota exact fora do modelo)'}`)
  }
  await lab.dispose()
}

// ─────────────────────────────────────────────────────────────────────────────
linha('B4 — `loopbackDeputy`: medido contra o `isTrustedApiRequest` REAL, executado verbatim')
{
  const { isTrustedApiRequest, meta } = await carregarCercaReal()
  console.log(`  fonte: ${meta.origem.split('/node_modules/')[1]} linhas ${meta.linhas} (sha256[0:16]=${meta.sha256Recorte})`)
  console.log('  corpo executado, colado do pacote publicado:')
  for (const l of meta.corpoDaFuncao.split('\n')) console.log(`    | ${l}`)

  const casos = [
    ['tunel cru: Host publico + Origin publico', { host: 'exemplo.trycloudflare.com', origin: 'https://exemplo.trycloudflare.com' }],
    ['so Host reescrito para loopback, Origin mantido', { host: '127.0.0.1:3080', origin: 'https://exemplo.trycloudflare.com' }],
    ['Host loopback COM porta + Origin reescrito SEM porta', { host: '127.0.0.1:3080', origin: 'https://127.0.0.1' }],
    ['loopbackDeputy: Host loopback + Origin/sec-fetch APAGADOS', { host: '127.0.0.1:3080' }],
    ['sec-fetch-site: cross-site, resto loopback', { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }],
  ]
  for (const [rotulo, headers] of casos) {
    const passa = isTrustedApiRequest({ headers }, [])
    console.log(`  ${rotulo.padEnd(54)} -> ${passa ? 'PASSA (a rota responderia)' : 'RECUSADO (403)'}`)
  }
  console.log('  => confirma o comentario de dsh-webui-auth index.js:713-719: reescrever so o Origin nao basta,')
  console.log('     porque `new URL(origin).host` ("127.0.0.1") nao iguala `hostUrl.host` ("127.0.0.1:3080").')
}

// -----------------------------------------------------------------------------
linha('B5 — a janela que o rescan mitiga mas NAO fecha (o proprio README admite: "≤10s")')
{
  const lab = await montarComposicao()
  const ws = lab.webServer
  const nega = (res) => { res.writeHead(401); res.end('gate') }
  const envolver = () => {
    const route = ws.prefixes.get('/api')
    const original = route.handler
    route.handler = (req, res) => (req.headers['x-lab-auth'] === 'ok' ? original(req, res) : nega(res))
  }
  envolver()
  console.log(`  apos o scan inicial: GET /api/state -> ${(await pedir(lab.port, '/api/state')).status}`)
  // O objeto de rota e substituido (o que acontece quando um fiber remonta).
  ws.prefixes.set('/api', { kind: 'prefix', path: '/api', handler: (q, s) => { s.writeHead(200); s.end('nova rota') } })
  console.log(`  objeto de rota substituido (remonta de fiber), ANTES do proximo rescan:`)
  console.log(`    GET /api/state -> ${(await pedir(lab.port, '/api/state')).status} (janela aberta ate ao proximo scan)`)
  envolver()
  console.log(`  depois do rescan: GET /api/state -> ${(await pedir(lab.port, '/api/state')).status}`)
  await lab.dispose()
}
