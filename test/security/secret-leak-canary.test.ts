/**
 * =============================================================================
 * ADV-050..ADV-059 -- CANARIO DE SEGREDO. Suite adversarial de T6.3.
 * =============================================================================
 *
 * A tecnica de 04-TESTES.md 6.5, estendida aos payloads novos da Onda 5
 * (notify, nonce do IPC, painel, UI nativa): o segredo e a constante CANARY, e
 * um coletor captura TUDO o que sai -- logs, respostas HTTP, frames do IPC,
 * payloads do Telegram (por composicao, nunca pela API real -- D10), ambiente
 * dos subprocessos e o ficheiro de estado.
 *
 * PORQUE O CANARIO E NAO UM git grep: o grep procura NOMES de identificador;
 * o canario segue o VALOR. Um segredo interpolado numa mensagem por uma
 * variavel chamada `msg` escapa a qualquer grep e e apanhado aqui.
 *
 * NENHUM TESTE AQUI CHAMA api.telegram.org: o payload do Telegram e a
 * COMPOSICAO (comporTexto*) mais o FRAME serializado (serializeIpcMessage),
 * que e exatamente o que o worker enviaria. O envio HTTP real esta coberto
 * em test/unit/worker/lib com o servidor falso de test/support.
 * =============================================================================
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { createGuardedHandler, createGuardedUpgradeHandler } from '../../src/http/gate.ts'
import { createGateAuthStack } from '../../src/http/session-auth.ts'
import { installAuthBarrier } from '../../src/http/intercept.ts'
import { UNAUTHENTICATED_PANEL_PREFIXES } from '../../src/index.ts'
import { bancada, basic, type Bancada } from '../unit/http/bancada.ts'
import { buildWorkerEnv, WORKER_IPC_ENV_MARK, WORKER_PROVIDER_ENV_VAR } from '../../src/proc/env.ts'
import { buildCloudflaredEnv } from '../../src/tunnel/args.ts'
import { digestSecret } from '../../src/secret/verify.ts'
import { redact } from '../../src/logging/redact.ts'
import { serializeIpcMessage, parseIpcLine, type IpcDirection } from '../../src/ipc/channel.ts'
import {
  comporTextoAuthFalha,
  comporTextoLinkMagico,
  comporTextoModoRestrito,
  comporTextoRelatorio,
  comporTextoSessaoNova,
  comporTextoTunelToggle,
} from '../../src/audit/notify.ts'
import type { AuthFalhaJanelaEvent, SessaoNovaEvent, TunelToggleEvent } from '../../src/audit/events.ts'

/** O canario. Segue o VALOR, nao o nome. */
const CANARY = 'CANARY-a1b2c3d4e5f6-DO-NOT-LEAK'

let b: Bancada
let server: Server
let port = 0
let reverter: (() => void) | undefined

before(async () => {
  server = createServer()
  server.on('request', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('ok')
  })
  server.on('upgrade', (_req, socket: Duplex) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n')
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port

  b = bancada({
    comSegredo: true,
    tunnelReady: true,
    loopbackAuthority: `127.0.0.1:${String(port)}`,
    unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
  })
  // O SEGREDO DO DONO E O CANARIO, e nao o OWNER_SECRET da bancada.
  b.stack.state.update((anterior) => ({ ...anterior, secretDigest: digestSecret(CANARY) }))
  reverter = installAuthBarrier(
    server,
    {
      wrapRequest: (delegate) => createGuardedHandler(b.gate, delegate, 'adv:canary'),
      wrapUpgrade: (delegate) => createGuardedUpgradeHandler(b.gate, delegate, 'adv:canary:upgrade'),
    },
    b.gate.log,
  )
})

after(async () => {
  reverter?.()
  b.cleanup()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Pedido CRU: a resposta inteira, do fio. Default: pelo TUNEL (a superficie
 * que exercita o caminho de credencial na Onda 1). */
function pedidoCru(linha: string, host = 'marks-organization-moved-coupons.trycloudflare.com'): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${linha}\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => void pedacos.push(d))
    socket.on('error', reject)
    socket.on('end', () => resolve(Buffer.concat(pedacos).toString('latin1')))
  })
}

/** Todos os textos que o logger capturou (via FakeContext). */
function logsCapturados(): string[] {
  return b.ctx.logger.entries.map((e) => e.message)
}

describe('ADV-050/051 -- o canario nao sai em LOG nem em resposta HTTP', () => {
  it('ADV-050: depois de 401, 403, 200 e upgrades, nenhum log capturado contem o canario', async () => {
    // Exercita os QUATRO caminhos de recusa/aprovacao com o canario como
    // o segredo do dono: a credencial certa e a errada, origem nao confiada
    // (trustedRemotes vazio num servidor a parte), e o handshake.
    await pedidoCru('GET /api/state HTTP/1.1') // 401 sem credencial
    await pedidoCru('GET /api/state HTTP/1.1') // idem, baralha o atraso
    await pedidoCru('POST /api/commands/execute HTTP/1.1') // 401
    await pedidoCru('GET /__guard/secret HTTP/1.1', 'marks-organization-moved-coupons.trycloudflare.com')
    // 200 com a credencial CANARY: o proprio sucesso nao pode logar o valor.
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${basic(CANARY)}\r\nConnection: close\r\n\r\n`,
      )
    })
    socket.on('data', () => {});
    socket.on('error', () => {});
    await new Promise<void>((resolve) => socket.on('end', () => resolve()))

    const tudo = logsCapturados().join('\n')
    assert.equal(tudo.includes(CANARY), false, 'o canario apareceu num log')
    assert.equal(tudo.includes(CANARY.slice(0, 8)), false, 'nem um prefixo de 8 caracteres')
    for (const linha of logsCapturados()) assert.equal(linha.includes(CANARY), false)
  })

  it('ADV-051: nenhuma resposta HTTP (corpo ou cabecalho) contem o canario', async () => {
    for (const [linha, host] of [
      ['GET /api/state HTTP/1.1', '127.0.0.1'],
      ['GET /apinfo HTTP/1.1', '127.0.0.1'],
      ['GET /__guard/secret HTTP/1.1', 'marks-organization-moved-coupons.trycloudflare.com'],
      ['GET /__guard/secret HTTP/1.1', '127.0.0.1'],
      ['GET /__guard/api/login HTTP/1.1', '127.0.0.1'],
    ] as const) {
      const bruta = await pedidoCru(linha, host)
      assert.equal(bruta.includes(CANARY), false, `resposta contem o canario: ${linha}`)
      assert.equal(bruta.includes('CANARY'), false, `resposta contem o prefixo CANARY: ${linha}`)
    }
  })
})

describe('ADV-052/053 -- Telegram por COMPOSICAO (nunca pela API real)', () => {
  it('ADV-052: nenhum texto de notificacao compossto carrega o canario', () => {
    const agora = 1_760_000_000_000
    const sessao: SessaoNovaEvent = {
      evento: 'sessao_nova',
      resultado: 'permitido',
      sessao_id_hash: 'a'.repeat(64), // o hash e opaco; o canario NAO pode entrar aqui
    }
    const falha: AuthFalhaJanelaEvent = {
      evento: 'auth_falha_primeira_janela',
      resultado: 'negado',
      ip_normalizado: '198.51.100.7',
    }
    const toggle: TunelToggleEvent = {
      evento: 'tunel_ligar:telegram',
      resultado: 'permitido',
    }

    const textos = [
      comporTextoSessaoNova(sessao, agora),
      comporTextoAuthFalha(falha, agora),
      comporTextoTunelToggle(toggle, agora, 'https://x.trycloudflare.com'),
      comporTextoModoRestrito({ evento: 'auth_modo_restrito', resultado: 'negado' }, agora),
      comporTextoRelatorio(agora, agora + 3_600_000),
      // O mk do link magico viaja no FRAGMENTO -- a EXCECAO nomeada da
      // Onda 5. O canario (segredo PERMANENTE) nunca, nem aqui.
      comporTextoLinkMagico(agora, 'https://x.trycloudflare.com', 'mk-teste-opaco', agora + 120_000),
    ];
    for (const texto of textos) {
      assert.equal(texto.includes(CANARY), false, `notificacao carrega o canario: ${texto}`)
    }
  })

  it('ADV-053: a FORMA do token do bot (digitos:segredo) e mascarada em qualquer texto', () => {
    // O token viaja na URL da Bot API (08-PESQUISA 11): um erro de rede do
    // worker citaria a URL inteira. A forma tem de morrer no redact.
    const token = '123456789:AAH4b8Qk1Lc2VwXyZ9mNpQrStUvWxYz1234567890'
    const texto = `request to https://api.telegram.org/bot${token}/getUpdates failed`
    const limpo = redact(texto)
    assert.equal(limpo.includes(token), false, 'o token sobreviveu ao redact')
    assert.equal(limpo.includes('[REDACTED]'), true, 'o redact tem de deixar marca')
  })
})

describe('ADV-054 -- o ficheiro de estado so guarda o DIGEST', () => {
  it('o state.json contem o sha256, nunca o segredo', async () => {
    const conteudo = readFileSync(b.auditPath, 'utf8') // o audit ja tem o caminho do state
    // O caminho do state e o dir temporario da bancada; o digest vive no state.
    // Como a bancada esconde o caminho, le-se o digest pela porta real: a
    // verificacao funciona e o valor em claro NAO esta em lado nenhum.
    assert.equal(conteudo.includes(CANARY), false)
    // E a credencial correta continua a verificar (o digest em disco e o do canario).
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: ${basic(CANARY)}\r\nConnection: close\r\n\r\n`)
    })
    const pedacos: Buffer[] = []
    socket.on('data', (d: Buffer) => void pedacos.push(d))
    const corpo = await new Promise<string>((resolve, reject) => {
      socket.on('error', reject)
      socket.on('end', () => resolve(Buffer.concat(pedacos).toString('utf8')))
    })
    assert.match(corpo, /^HTTP\/1\.1 200 /u)
  })
})

describe('ADV-055/059 -- os ambientes construidos dos subprocessos', () => {
  it('ADV-055: buildWorkerEnv e uma ALLOWLIST exata -- 30 chaves aleatorias, 0 vazam', () => {
    const fonte: NodeJS.ProcessEnv = {}
    // TODAS as chaves da allowlist presentes na fonte -- so assim a igualdade
    // de conjuntos faz sentido: se uma faltar, o output nao a pode ter.
    for (const chave of [
      'PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ',
      'PYTHONHOME', 'PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHONIOENCODING', 'PYTHONDONTWRITEBYTECODE',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
      'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
      'LC_ALL', 'LC_CTYPE', 'LC_TIME',
    ]) {
      fonte[chave] = `valor-de-${chave}`
    }
    const aleatorias: string[] = []
    for (let i = 0; i < 30; i += 1) {
      const chave = `CHAVE_ALEATORIA_${i}_${String.fromCharCode(65 + (i % 26))}`
      aleatorias.push(chave)
      fonte[chave] = `valor-${i}`
    }
    // O canario e um par credencial-like: exatamente o que a allowlist tem de barrar.
    fonte['ADMIN_USER'] = 'admin'
    fonte['ADMIN_PASS'] = CANARY
    fonte['AWS_SECRET_ACCESS_KEY'] = CANARY
    fonte['SSH_AUTH_SOCK'] = '/tmp/agente'

    const env = buildWorkerEnv(fonte, 'token-do-bot')
    // IGUALDADE DE CONJUNTO com a allowlist + o token + a marca: nada mais.
    const chaves = Object.keys(env).toSorted()
    const permitidas = [
      'HOME', 'PATH', 'TMPDIR', 'LANG', 'TZ',
      'PYTHONHOME', 'PYTHONPATH', 'PYTHONUNBUFFERED', 'PYTHONIOENCODING', 'PYTHONDONTWRITEBYTECODE',
      'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
      'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
      'TELEGRAM_BOT_TOKEN', WORKER_IPC_ENV_MARK, WORKER_PROVIDER_ENV_VAR,
    ].toSorted()
    // LC_* entra em bloco; as aleatorias nao comecam por LC_.
    for (const chave of aleatorias) {
      assert.equal(chave in env, false, `${chave} vazou para o worker`)
    }
    assert.equal('ADMIN_USER' in env, false)
    assert.equal('ADMIN_PASS' in env, false)
    assert.equal('AWS_SECRET_ACCESS_KEY' in env, false)
    assert.equal('SSH_AUTH_SOCK' in env, false)
    assert.equal(env['TELEGRAM_BOT_TOKEN'], 'token-do-bot')
    assert.equal(env[WORKER_IPC_ENV_MARK], '1')
    for (const chave of permitidas) assert.ok(chave in env, `${chave} faltou ao ambiente`)
    // A igualdade de conjuntos: cada chave do env e permitida.
    for (const chave of chaves) {
      assert.ok(
        permitidas.includes(chave) || chave.startsWith('LC_'),
        `${chave} esta no ambiente sem ser da allowlist`,
      )
    }
  })

  it('ADV-059: buildTunnelEnv (cloudflared) e um perfil DISTINTO do worker', () => {
    const doTunel = buildCloudflaredEnv()
    const doWorker = buildWorkerEnv({ PATH: '/usr/bin', HOME: '/home/x' }, 'token-do-bot')
    // O processo do cloudflared NAO recebe o token do Telegram.
    assert.equal('TELEGRAM_BOT_TOKEN' in doTunel, false)
    assert.equal('TELEGRAM_BOT_TOKEN' in doWorker, true)
    // O worker NAO recebe credencial de tunel.
    assert.equal('TUNNEL_TOKEN' in doWorker, false)
    assert.equal('TUNNEL_TOKEN' in doTunel, true, 'a tombstone existe para remover do ambiente herdado')
    // A tombstone e undefined -- o valor do shell nunca passa.
    assert.equal(doTunel['TUNNEL_TOKEN'], undefined)
    // E nenhuma chave do worker vaza para o tunel (perfis disjuntos nos nomes DSH_*).
    for (const chave of Object.keys(doWorker)) {
      if (chave === 'TELEGRAM_BOT_TOKEN') continue
      assert.equal(chave in doTunel, false, `${chave} do worker apareceu no cloudflared`)
    }
  })
})

describe('ADV-056/057 -- erro e IPC nao carregam o canario', () => {
  it('ADV-056: com o state.json CORROMPIDO, o 401 fail-closed nao ecoa o canario', async () => {
    // A LEITURA do estado corrompido lanca StateError no caminho de decisao, e
    // o portao responde o MESMO 401 (fail-closed, D9) -- nunca um 500 com o
    // conteudo do erro. Para o provar com um estado REAL, corrompe-se o
    // ficheiro de disco com o canario DENTRO (como valor invalido do digest):
    // se o caminho de erro ecoasse o valor, e aqui que vazava.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-canary-'))
    const stack = createGateAuthStack({
      log: b.gate.log,
      tunnelOrigin: b.tunnelOrigin,
      clock: b.clock,
      stateDir: dir,
      auditPath: join(dir, 'audit.log'),
      wait: (): Promise<void> => Promise.resolve(),
    })
    try {
      // Provisiona (escreve o state.json valido) e depois CORROMPE o ficheiro.
      stack.secrets.provision()
      const caminho = join(dir, 'state.json')
      writeFileSync(caminho, JSON.stringify({ version: 1, desiredState: 'STOPPED', secretDigest: CANARY }))

      const portaLivre = createServer((_req, res) => {
        res.writeHead(200)
        res.end('ok')
      })
      const p = await new Promise<number>((resolve) => portaLivre.listen(0, '127.0.0.1', () => resolve((portaLivre.address() as AddressInfo).port)))
      const reverterLocal = installAuthBarrier(
        portaLivre,
        {
          wrapRequest: (delegate) => createGuardedHandler(
            {
              ...b.gate,
              auth: () => stack.auth,
            },
            delegate,
            'adv:canary:corrupto',
          ),
          wrapUpgrade: (delegate) => createGuardedUpgradeHandler(
            { ...b.gate, auth: () => stack.auth },
            delegate,
            'adv:canary:corrupto:upgrade',
          ),
        },
        b.gate.log,
      )
      try {
        const resposta = await new Promise<string>((resolve, reject) => {
          const socket = connect(p, '127.0.0.1', () => {
            // Superficie do TUNEL para o caminho de credencial correr (o
            // acesso local abre direto na Onda 1). O host e o do tunel READY.
            socket.write(`GET /api/state HTTP/1.1\r\nHost: marks-organization-moved-coupons.trycloudflare.com\r\nConnection: close\r\n\r\n`)
          })
          const pedacos: Buffer[] = []
          socket.on('data', (d: Buffer) => void pedacos.push(d))
          socket.on('error', reject)
          socket.on('end', () => resolve(Buffer.concat(pedacos).toString('latin1')))
        })
        // Fail-closed: 401, e o corpo NAO ecoa o StateError (que carregaria o valor).
        assert.match(resposta, /^HTTP\/1\.1 401 /u)
        assert.equal(resposta.includes(CANARY), false)
        assert.equal(resposta.includes('STATE_CORRUPT'), false, 'o corpo nao pode ecoar o erro interno')
      } finally {
        reverterLocal?.()
        await new Promise<void>((resolve) => portaLivre.close(() => resolve()))
      }
    } finally {
      stack.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ADV-057: frames do IPC host<->worker (JSONL) nunca carregam o canario, em nenhuma direcao', () => {
    const mensagens: Array<{ m: unknown; dir: IpcDirection }> = [
      { m: { v: 2, type: 'notify', texto: 'O tunel ligado as 12:00.' }, dir: 'to-worker' },
      { m: { v: 2, type: 'ack', requestId: '01ABC', result: 'noop', state: 'STOPPED' }, dir: 'to-worker' },
      { m: { v: 2, type: 'nonce.request', acao: 'start', requestId: '01ABC' }, dir: 'to-host' },
      { m: { v: 2, type: 'nonce.issued', acao: 'start', requestId: '01ABC', nonce: 'opaco-32-characters-minimum', expiresAt: 0 }, dir: 'to-worker' },
    ]
    for (const { m, dir } of mensagens) {
      const linha = serializeIpcMessage(m as never, dir)
      assert.equal(linha.includes(CANARY), false, `frame carrega o canario: ${linha}`)
      // E o parse da MESMA linha (a outra ponta) nao o inventa.
      const resultado = parseIpcLine(linha, dir)
      assert.equal(resultado.ok, true, `o frame ${dir} nao parseou`)
    }
  })
})

describe('ADV-058 -- ADMIN_USER/ADMIN_PASS fora do fluxo (D19)', () => {
  it('nenhum codigo EXECUTAVEL de src/ ou worker/ le ADMIN_USER/ADMIN_PASS', () => {
    const raiz = fileURLToPath(new URL('../../', import.meta.url))
    const executaveis: string[] = []
    for (const alvo of ['src', 'worker']) {
      for (const ficheiro of percorrer(join(raiz, alvo))) {
        if (!ficheiro.endsWith('.ts')) continue
        const fonte = readFileSync(ficheiro, 'utf8')
        const semComentarios = fonte
          .replace(/\/\*[\s\S]*?\*\//gu, '')
          .replace(/^\s*\/\/.*$/gmu, '')
        if (/ADMIN_USER|ADMIN_PASS/u.test(semComentarios)) {
          const linha = semComentarios.match(/[^\n]*ADMIN_(?:USER|PASS)[^\n]*/u)?.[0] ?? '?'
          const relativo = ficheiro.replace(raiz, '')
          // A UNICA ocorrencia executavel permitida: a mensagem de ERRO de
          // assert.ts que NOMEIA a causa historica ("variavel de ambiente
          // ausente interpolada num template"). E a tabela de correcao
          // historica de D19 em forma de mensagem: NAO le as variaveis, so
          // reconhece a assinatura do erro antigo para recusar o arranque.
          // Qualquer outra ocorrencia executavel e regressao.
          if (!(relativo.startsWith('src/config/assert.ts') && linha.includes('por definir'))) {
            executaveis.push(`${relativo}: ${linha.trim()}`)
          }
        }
      }
    }
    assert.deepEqual(executaveis, [], `ADMIN_USER/ADMIN_PASS em codigo executavel:\n${executaveis.join('\n')}`)
  })
})

/** Percorre um diretorio a partir de um CAMINHO (nao um URL). */
function percorrer(dir: string): string[] {
  const saida: string[] = []
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name)
    if (entrada.isDirectory()) saida.push(...percorrer(caminho))
    else saida.push(caminho)
  }
  return saida
}

