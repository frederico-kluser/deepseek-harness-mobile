/**
 * T0.4 — sonda SOMENTE-LEITURA de uma instancia viva do DeepSeek Harness.
 *
 * Guarda explicita: o script recusa qualquer metodo que nao seja GET/HEAD e
 * recusa qualquer caminho da lista de mutacao conhecida. A instancia do
 * operador nunca e desligada, reconfigurada nem escrita — se este script
 * conseguisse mutar alguma coisa, seria um defeito dele.
 *
 * Uso: node scripts/spike/ui/probe-live-instance.mjs [http://127.0.0.1:3080]
 */
const base = process.argv[2] ?? 'http://127.0.0.1:3080'

/** Metodos que a sonda aceita emitir. Qualquer outro e recusado antes do socket. */
const METODOS_SEGUROS = new Set(['GET', 'HEAD'])
/** Caminhos que mutam estado no harness e que a sonda nunca toca. */
const CAMINHOS_PROIBIDOS = [/\/api\/.*\b(create|delete|update|write|send|stop|start|abort|kill|shutdown)\b/i]

/** Recusa antes de abrir o socket qualquer requisicao que possa mutar estado. */
function assertNaoMutante(method, url) {
  if (!METODOS_SEGUROS.has(method)) throw new Error(`sonda recusada: metodo ${method} pode mutar estado`)
  const proibido = CAMINHOS_PROIBIDOS.find((re) => re.test(url))
  if (proibido !== undefined) throw new Error(`sonda recusada: ${url} casa com o padrao de mutacao ${proibido}`)
}

/** Uma sonda: metodo, caminho, headers, e o que a resposta revelou. */
async function probe(method, path, headers = {}) {
  const url = `${base}${path}`
  assertNaoMutante(method, url)
  try {
    const res = await fetch(url, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const body = method === 'GET' ? (await res.text()).slice(0, 200) : ''
    return { method, path, headers, status: res.status, headersDaResposta: Object.fromEntries(res.headers), amostraDoCorpo: body }
  } catch (error) {
    return { method, path, headers, erro: `${error.name}: ${error.message}` }
  }
}

const alcancavel = await probe('HEAD', '/')
if (alcancavel.erro !== undefined) {
  console.log(JSON.stringify({
    base,
    alcancavel: false,
    detalhe: alcancavel.erro,
    conclusao: 'AUSENCIA DE EVIDENCIA: nao ha instancia viva nesta origem; nada foi enumerado a partir dela.',
  }, null, 2))
  process.exit(0)
}

const sondas = [
  await probe('GET', '/'),
  await probe('GET', '/api'),
  await probe('GET', '/api/state'),
  await probe('GET', '/plugins'),
  await probe('GET', '/__dsh_invariant_probe__'),
  await probe('GET', '/__guard'),
  await probe('GET', '/__guard/api/state'),
  await probe('GET', '/nao-existe-mesmo-nada-aqui'),
  // Insumo de L2.5: o harness responde a um `Host` que nao e o dele?
  await probe('GET', '/api/state', { host: 'attacker.example.com' }),
  // Insumo de CWE-1385: o handshake de WebSocket valida `Origin`?
  await probe('GET', '/api/events.mux', { origin: 'http://evil.example.com', connection: 'Upgrade', upgrade: 'websocket' }),
]
console.log(JSON.stringify({ base, alcancavel: true, sondas }, null, 2))
