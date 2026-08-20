/**
 * S12 — EXPERIMENTO PRINCIPAL: a barreira reversivel, medida com HTTP real.
 *
 * Prova, por requisicao real e nao por deducao de tipos:
 *  1. sem barreira, as rotas de OUTROS plugins respondem 200;
 *  2. a barreira instalada DEPOIS de todos os registos guarda os TRES caminhos
 *     (`register` exact, `register` prefix, `registerFallback`, `registerUpgrade`);
 *  3. com credencial valida o trafego volta a passar e o `applyIndexTaps`
 *     do host continua a correr;
 *  4. o disposer sincrono devolve tudo ao comportamento original.
 *
 * Correr: node scripts/spike/intercept/experimento.mjs
 */
import { montarComposicao, enumerarTabelas } from './composicao.mjs'
import { instalarBarreira } from './barreira.mjs'
import { basic, pedir, pedirUpgrade } from './http-lab.mjs'

const CRED = { user: 'dono', pass: 'segredo-do-lab' }
const ESPERADO = `Basic ${Buffer.from(`${CRED.user}:${CRED.pass}`).toString('base64')}`

/** Predicado de autorizacao do laboratorio (Basic Auth de credencial fixa). */
function authorize(req) {
  return req.headers.authorization === ESPERADO
}

const CAMINHOS = [
  ['/api/state', 'register prefix  (/api — dsh-client-connection)'],
  ['/plugins/x/client.js', 'register prefix  (/plugins — dsh-client-modules)'],
  ['/__dsh_invariant_probe__', 'register exact   (sonda de invariante)'],
  ['/', 'registerFallback (frontend-static, index)'],
  ['/rota-spa', 'registerFallback (frontend-static, SPA)'],
]

const UPGRADES = [
  ['/api/events.mux', 'registerUpgrade  (WebSocket mux)'],
  ['/api/events.host', 'registerUpgrade  (WebSocket host)'],
]

const falhas = []
/** Regista uma asserção medida. */
function verificar(rotulo, obtido, esperado) {
  const ok = obtido === esperado
  if (!ok) falhas.push(`${rotulo}: obtido ${obtido}, esperado ${esperado}`)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${rotulo.padEnd(58)} -> ${obtido}`)
}

/** Corre a bateria HTTP + upgrade e devolve os resultados crus. */
async function bateria(port, headers) {
  const http = []
  for (const [path, rotulo] of CAMINHOS) http.push([path, rotulo, await pedir(port, path, { headers })])
  const up = []
  for (const [path, rotulo] of UPGRADES) up.push([path, rotulo, await pedirUpgrade(port, path, headers)])
  return { http, up }
}

const lab = await montarComposicao()
console.log(`servidor real em http://127.0.0.1:${lab.port}`)
console.log('tabelas de rota enumeradas (campos `private` so no TypeScript):')
console.log(`  ${JSON.stringify(enumerarTabelas(lab.webServer))}\n`)

console.log('FASE A — sem barreira (linha de base)')
{
  const { http, up } = await bateria(lab.port, {})
  for (const [, rotulo, r] of http) verificar(`A ${rotulo}`, r.status, 200)
  for (const [, rotulo, r] of up) verificar(`A ${rotulo}`, r.resultado, 'upgrade')
  const indice = http.find(([p]) => p === '/')[2]
  verificar('A applyIndexTaps aplicado ao index', indice.body.includes('<!--BOOT_MANIFEST-->'), true)
}

console.log('\nFASE B — barreira instalada DEPOIS de todos os registos, sem credencial')
const reverter = instalarBarreira(lab.webServer, { authorize, realm: 'dsh-lab' })
{
  const { http, up } = await bateria(lab.port, {})
  for (const [, rotulo, r] of http) verificar(`B ${rotulo}`, r.status, 401)
  const um = http[0][2]
  verificar('B cabecalho WWW-Authenticate presente', String(um.headers['www-authenticate']).startsWith('Basic realm="dsh-lab"'), true)
  for (const [, rotulo, r] of up) verificar(`B ${rotulo}`, `${r.resultado}:${r.status}`, 'resposta:401')
}

console.log('\nFASE B2 — rota registada DEPOIS da barreira ja instalada')
{
  await lab.ctx.plugin({
    name: 'lab-rota-tardia',
    inject: ['webServer'],
    apply(ctx) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: '/tardia',
        handler: (req, res) => { res.writeHead(200); res.end('tardia') },
      }), 'lab: /tardia')
      ctx.effect(() => ctx.webServer.registerUpgrade({
        path: '/tardia/ws',
        handler: (req, socket) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n') },
      }), 'lab: upgrade /tardia/ws')
    },
  })
  const r = await pedir(lab.port, '/tardia/x')
  verificar('B2 register prefix registado APOS a barreira', r.status, 401)
  const u = await pedirUpgrade(lab.port, '/tardia/ws')
  verificar('B2 registerUpgrade registado APOS a barreira', `${u.resultado}:${u.status}`, 'resposta:401')
  const ok = await pedir(lab.port, '/tardia/x', { headers: basic(CRED.user, CRED.pass) })
  verificar('B2 mesma rota com credencial valida', ok.status, 200)
}

console.log('\nFASE C — barreira instalada, COM credencial valida')
{
  const { http, up } = await bateria(lab.port, basic(CRED.user, CRED.pass))
  for (const [, rotulo, r] of http) verificar(`C ${rotulo}`, r.status, 200)
  for (const [, rotulo, r] of up) verificar(`C ${rotulo}`, r.resultado, 'upgrade')
  const indice = http.find(([p]) => p === '/')[2]
  verificar('C applyIndexTaps continua a correr sob a barreira', indice.body.includes('<!--BOOT_MANIFEST-->'), true)
}

console.log('\nFASE D — disposer sincrono executado; sem credencial de novo')
reverter()
{
  const { http, up } = await bateria(lab.port, {})
  for (const [, rotulo, r] of http) verificar(`D ${rotulo}`, r.status, 200)
  for (const [, rotulo, r] of up) verificar(`D ${rotulo}`, r.resultado, 'upgrade')
  const indice = http.find(([p]) => p === '/')[2]
  verificar('D applyIndexTaps intacto apos reversao', indice.body.includes('<!--BOOT_MANIFEST-->'), true)
}

await lab.dispose()
console.log(`\nRESULTADO: ${falhas.length === 0 ? 'TODAS AS ASSERCOES PASSARAM' : `${falhas.length} FALHA(S)`}`)
for (const f of falhas) console.log(`  - ${f}`)
process.exit(falhas.length === 0 ? 0 : 1)
