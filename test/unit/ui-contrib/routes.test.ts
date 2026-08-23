/**
 * `src/ui-contrib/routes.ts` — os CANTOS dos handlers HTTP da superficie de UI
 * nativa que a suite de superficie (surface.test.ts) nao toca: leitura de corpo
 * (vazio, nao-objeto, excessivo, malformado), a recusa de CSRF nas rotas do
 * RESET, o token no campo `csrf` do corpo, e o script `client.js` (GET + 405).
 *
 * As perguntas falsificaveis desta suite:
 *  - Um POST SEM corpo (vazio) e tratado como `{}` e chega ao handler, ou
 *    rebenta? (o cliente envia `'{}'`; o caso vazio e a borda de protocolo)
 *  - Um corpo que e JSON valido mas NAO um objeto (`"texto"`, array) cai em
 *    `{}`, ou o handler decide com lixo? (139-141 de routes.ts)
 *  - Toda mutacao POST do RESET exige o token anti-CSRF da superficie (NIST
 *    SP 800-63B-4 5.1.1), como as do LIGAR/DESLIGAR?
 *  - O token aceite pelo CABECALHO e pelo campo do corpo e o mesmo?
 *  - `GET /__guard-ui/client.js` e a fonte do script, com `no-store` e sem
 *    vazar segredo; o metodo errado responde 405 com `allow`.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { describe, it } from 'node:test'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ControlIntent, ControlResultado } from '../../../src/contracts/control.ts'
import {
  createNativeUiSurface,
  type UiContribBroadcast,
  type UiContribDeps,
} from '../../../src/ui-contrib/surface.ts'
import {
  CSRF_FIELD_NAME,
  CSRF_HEADER_NAME,
} from '../../../src/ui-contrib/csrf.ts'
import {
  UI_PATH_CLIENT,
  UI_PATH_CONFIRM,
  UI_PATH_CSRF,
  UI_PATH_PAIR,
  UI_PATH_PAIR_STATE,
  UI_PATH_RESET,
  UI_PATH_RESET_CONFIRM,
  UI_PATH_START,
  UI_PATH_STOP,
} from '../../../src/ui-contrib/routes.ts'
import { UI_CSRF_BINDING } from '../../../src/ui-contrib/routes.ts'
import { FakeClock } from '../../support/clock.ts'

interface RespostaCapturada {
  readonly status: number
  readonly cabecalhos: Readonly<Record<string, string>>
  readonly corpo: Record<string, unknown>
  readonly texto: string
}

/** A mesma bancada da suite de superficie, mas com controlo do ENVELOPE do corpo. */
function criarBancada(overrides?: Partial<UiContribDeps>): {
  readonly clock: FakeClock
  readonly rotas: Map<string, { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }>
  readonly emitidos: ControlIntent[]
  readonly noncesPedidos: string[]
  token(): string
  enviar(
    caminho: string,
    opcoes: {
      metodo?: string
      cabecalhos?: Readonly<Record<string, string>>
      /** Se `undefined`, o teste emite os eventos de corpo manualmente. */
      pedacos?: readonly (string | Buffer)[]
    },
  ): Promise<RespostaCapturada>
} {
  const clock = new FakeClock(1_000_000)
  const rotas = new Map<string, { handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }>()
  const emitidos: ControlIntent[] = []
  const noncesPedidos: string[] = []
  const resultadoEmit: ControlResultado = { estado: 'STOPPED', idempotente: false }
  let tokenDoTap = ''

  const deps: UiContribDeps = {
    tapIndex: (transform) => {
      const html = transform('<html><head></head><body></body></html>')
      const m = /<meta name="dsh-guard-ui-csrf" content="([^"]+)">/u.exec(html)
      tokenDoTap = m?.[1] ?? ''
      return () => undefined
    },
    registerRoute: (rota) => {
      rotas.set(rota.path, { handler: rota.handler })
      return () => undefined
    },
    emit: async (intent) => {
      emitidos.push(intent)
      return resultadoEmit
    },
    issueNonce: (acao) => {
      noncesPedidos.push(acao)
      return { valor: 'nonce-do-host', expiresAt: clock.now() + 60_000 }
    },
    subscribe: (listener) => {
      listener({ seq: 1, snapshot: { state: 'STOPPED', attempts: 0 } } satisfies UiContribBroadcast)
      return () => undefined
    },
    now: () => clock.now(),
    botState: () => ({ online: false, motivo: 'sem-chave' }),
    tokenOps: {
      validarFormato: (bruto: string) => bruto.trim().includes(':'),
      fonte: () => 'secrets' as const,
      sondar: async (
        token: string,
      ): Promise<{ ok: true; handle: string } | { ok: false; erro: string }> =>
        token.trim().length > 0 ? { ok: true, handle: 'exemplo_bot' } : { ok: false, erro: 'token-invalido' },
      gravar: () => undefined,
      estado: () => ({ configurado: false, handle: null, fonte: 'nenhum' } as const),
      privacidade: async () => ({ ok: true, handle: null, fonte: 'nenhum' } as const),
    },
    pairOps: {
      estado: () => ({ pareado: false }),
      gerar: async () => ({ ok: true, codigo: '123456', expiraEm: clock.now() + 60_000 }),
    },
    acesso: () => ({
      conexoesAtivas: 0,
      totalSessoes: 0,
      sessoes: [],
      ipConfiavel: false,
    }),
    ...overrides,
  }
  void createNativeUiSurface(deps)

  const enviar = async (
    caminho: string,
    opcoes: { metodo?: string; cabecalhos?: Readonly<Record<string, string>>; pedacos?: readonly (string | Buffer)[] } = {},
  ): Promise<RespostaCapturada> => {
    const rota = rotas.get(caminho)
    assert.ok(rota !== undefined, `rota nao registada: ${caminho}`)
    const req = new EventEmitter() as unknown as IncomingMessage
    const bruto = req as unknown as { method: string; url: string; headers: Record<string, string>; destroy(): void }
    bruto.method = opcoes.metodo ?? 'GET'
    bruto.url = caminho
    bruto.headers = { ...opcoes.cabecalhos }
    bruto.destroy = () => undefined

    let status = 0
    let cabecalhos: Record<string, string> = {}
    let texto = ''
    const res = {
      writeHead: (s: number, h: Record<string, string>): void => {
        status = s
        cabecalhos = h
      },
      end: (corpo?: unknown): void => {
        texto = typeof corpo === 'string' ? corpo : String(corpo ?? '')
      },
    } as unknown as ServerResponse

    const pendente = rota.handler(req, res)
    for (const pedaco of opcoes.pedacos ?? []) {
      req.emit('data', typeof pedaco === 'string' ? Buffer.from(pedaco) : pedaco)
    }
    req.emit('end')
    await pendente

    let corpo: Record<string, unknown> = {}
    if (texto !== '') {
      try {
        corpo = JSON.parse(texto) as Record<string, unknown>
      } catch {
        corpo = {} // corpo nao-JSON (ex.: o script do cliente) — a raw text fica em `texto`
      }
    }
    return {
      status,
      cabecalhos,
      texto,
      corpo,
    }
  }

  return {
    clock,
    rotas,
    emitidos,
    noncesPedidos,
    token: () => {
      assert.ok(tokenDoTap.length > 0, 'o tap nao emitiu token')
      return tokenDoTap
    },
    enviar,
  }
}

/* ========================================================================== */
/* O corpo                                                                    */
/* ========================================================================== */

describe('leitura do corpo (lerCorpo)', () => {
  it('POST SEM corpo (nenhum byte) e tratado como {} e o handler corre', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_START, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
      pedacos: [],
    })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.passo, 'confirmar')
    assert.deepEqual(bancada.noncesPedidos, ['start'])
  })

  it('corpo JSON valido mas NAO objeto (string ou array) cai em {} — nao decide com lixo', async () => {
    for (const bruto of ['"apenas-uma-string"', '[1,2,3]', 'null']) {
      const bancada = criarBancada()
      const resposta = await bancada.enviar(UI_PATH_START, {
        metodo: 'POST',
        cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
        pedacos: [bruto],
      })
      assert.equal(resposta.status, 200, `corpo ${bruto} deveria ser tratado como {}`)
      assert.equal(resposta.corpo.passo, 'confirmar')
    }
  })

  it('corpo acima do teto (4096 bytes) responde 400 corpo-grande, sem emitir', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_START, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
      pedacos: ['x'.repeat(5_000)],
    })
    assert.equal(resposta.status, 400)
    assert.equal(resposta.corpo.erro, 'corpo-grande')
    assert.equal(bancada.emitidos.length, 0)
    assert.equal(bancada.noncesPedidos.length, 0)
  })

  it('corpo malformado responde 400 corpo-invalido em TODAS as rotas POST de mutacao', async () => {
    const caminhos = [UI_PATH_START, UI_PATH_CONFIRM, UI_PATH_STOP, UI_PATH_RESET, UI_PATH_RESET_CONFIRM]
    for (const caminho of caminhos) {
      const bancada = criarBancada()
      const resposta = await bancada.enviar(caminho, {
        metodo: 'POST',
        cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
        pedacos: ['{nao-e-json'],
      })
      assert.equal(resposta.status, 400, caminho)
      assert.equal(resposta.corpo.erro, 'corpo-invalido', caminho)
      assert.equal(bancada.emitidos.length, 0, caminho)
      assert.equal(bancada.noncesPedidos.length, 0, caminho)
    }
  })
})

/* ========================================================================== */
/* CSRF                                                                       */
/* ========================================================================== */

describe('csrf nas rotas POST', () => {
  it('o RESET (passo 1 e passo 2) exige o token da superficie — sem token, 403 e nada corre', async () => {
    for (const caminho of [UI_PATH_RESET, UI_PATH_RESET_CONFIRM]) {
      const bancada = criarBancada()
      const resposta = await bancada.enviar(caminho, { metodo: 'POST', pedacos: ['{}'] })
      assert.equal(resposta.status, 403, caminho)
      assert.equal(resposta.corpo.erro, 'csrf-recusado', caminho)
      assert.equal(bancada.emitidos.length, 0)
      assert.equal(bancada.noncesPedidos.length, 0)
    }
  })

  it('o token aceite no campo `csrf` do CORPO vale tanto quanto no cabecalho', async () => {
    const bancada = criarBancada()
    const token = bancada.token()
    const noCorpo = await bancada.enviar(UI_PATH_START, {
      metodo: 'POST',
      pedacos: [JSON.stringify({ [CSRF_FIELD_NAME]: token })],
    })
    assert.equal(noCorpo.status, 200, 'token no campo do corpo deveria valer')

    const noCabecalho = await bancada.enviar(UI_PATH_STOP, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: token },
      pedacos: ['{}'],
    })
    assert.equal(noCabecalho.status, 200, 'token no cabecalho deveria valer')
    // O passo 1 do LIGAR nao emite (so pede o nonce); o DESLIGAR emite o stop.
    assert.deepEqual(bancada.emitidos.map((i) => i.action), ['stop'])
    assert.deepEqual(bancada.noncesPedidos, ['start'])
  })
})

/* ========================================================================== */
/* O script da superficie                                                     */
/* ========================================================================== */

describe('GET /__guard-ui/client.js', () => {
  it('GET devolve a fonte do script com content-type javascript e no-store', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_CLIENT, { metodo: 'GET', pedacos: [] })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.cabecalhos['content-type'], 'text/javascript; charset=utf-8')
    assert.equal(resposta.cabecalhos['cache-control'], 'no-store')
    assert.ok(resposta.texto.includes('/__guard-ui/api'), 'o script conhece a BASE')
    assert.ok(resposta.texto.includes('dsh-guard-ui-estado'), 'o script desenha o estado')
    assert.ok(!resposta.texto.includes('CANARY-a1b2c3d4e5f6-DO-NOT-LEAK'))
  })

  it('metodo errado responde 405 com allow: GET', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_CLIENT, { metodo: 'POST', pedacos: ['{}'] })
    assert.equal(resposta.status, 405)
    assert.equal(resposta.cabecalhos.allow, 'GET')
  })
})

/* ========================================================================== */
/* O token anti-CSRF fresco (GET /api/csrf — HIGH-2)                          */
/* ========================================================================== */

describe('GET /__guard-ui/api/csrf', () => {
  it('GET devolve um token 200, NO-SEM exigir CSRF, e o mesmo guard o valida no POST', async () => {
    const bancada = criarBancada()
    // A GET de leitura nao exige token CSRF nenhum — devolve um token novo.
    const resposta = await bancada.enviar(UI_PATH_CSRF, { metodo: 'GET', pedacos: [] })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.cabecalhos['cache-control'], 'no-store')
    assert.equal(typeof resposta.corpo.token, 'string')
    const token = resposta.corpo.token as string
    assert.ok(token.length > 0, 'o token emitido nao deve vir vazio')

    // O token emitido é verificavel contra o MESMO vinculo da superficie: usado
    // num POST de mutacao tem de passar (200), nao ser recusado (403).
    const noCorpo = await bancada.enviar(UI_PATH_START, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: token },
      pedacos: ['{}'],
    })
    assert.equal(noCorpo.status, 200, 'o token do /csrf deve valer num POST como o do tap')
    assert.equal(noCorpo.corpo.passo, 'confirmar')
  })

  it('metodo errado responde 405 com allow: GET', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_CSRF, { metodo: 'POST', pedacos: ['{}'] })
    assert.equal(resposta.status, 405)
    assert.equal(resposta.cabecalhos.allow, 'GET')
  })

  it('token antigo expira no TTL; uma GET nova re-eme o token e volta a valer', async () => {
    const bancada = criarBancada()
    const antes = await bancada.enviar(UI_PATH_CSRF, { metodo: 'GET', pedacos: [] })
    const tokenAntigo = antes.corpo.token as string

    // Um POST com o token ANTIGO passa agora...
    const okAgora = await bancada.enviar(UI_PATH_START, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: tokenAntigo },
      pedacos: ['{}'],
    })
    assert.equal(okAgora.status, 200)

    // ...mas passa a expirar em 30min: adianta o relogio past o TTL e o MESMO
    // token e recusado (403), enquanto uma GET nova devolve um token que vale.
    bancada.clock.advance(31 * 60 * 1000)
    const recusado = await bancada.enviar(UI_PATH_START, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: tokenAntigo },
      pedacos: ['{}'],
    })
    assert.equal(recusado.status, 403, 'o token emitido expira no TTL e o POST recusa')

    const novo = await bancada.enviar(UI_PATH_CSRF, { metodo: 'GET', pedacos: [] })
    const tokenNovo = novo.corpo.token as string
    assert.notEqual(tokenNovo, tokenAntigo, 'a GET nova re-eme (expira em outro instante)')
    const revalidado = await bancada.enviar(UI_PATH_STOP, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: tokenNovo },
      pedacos: ['{}'],
    })
    assert.equal(revalidado.status, 200, 'a GET nova restabelece o CSRF')
  })

  it('o token do /csrf usa o MESMO vinculo (UI_CSRF_BINDING) do CSRF da superficie', () => {
    assert.equal(UI_CSRF_BINDING, 'ui-contrib')
  })
})

/* ========================================================================== */
/* EMENDA ONDA-1: o pareamento VIA PAINEL (POST /pair + GET /pair-state)       */
/* ========================================================================== */

describe('o pareamento VIA PAINEL (POST /pair)', () => {
  it('403 SEM CSRF: o POST /pair e uma escrita como qualquer outra', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_PAIR, { metodo: 'POST', pedacos: ['{}'] })
    assert.equal(resposta.status, 403)
    assert.equal(resposta.corpo.erro, 'csrf-recusado')
  })

  it('gera um codigo de 6 digitos com expiraEm e devolve-o (200)', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_PAIR, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
      pedacos: ['{}'],
    })
    assert.equal(resposta.status, 200)
    assert.match(String(resposta.corpo.codigo), /^\d{6}$/u)
    assert.equal(resposta.corpo.expiraEm, 1_000_000 + 60_000)
  })

  it('409 ja-pareado: mensagem PT-BR amigavel, sem vazar o codigo', async () => {
    const bancada = criarBancada({
      pairOps: { estado: () => ({ pareado: true }), gerar: async () => ({ ok: false as const, erro: 'ja-pareado' as const }) },
    })
    const resposta = await bancada.enviar(UI_PATH_PAIR, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
      pedacos: ['{}'],
    })
    assert.equal(resposta.status, 409)
    assert.equal(resposta.corpo.erro, 'ja-pareado')
    assert.match(String(resposta.corpo.mensagem), /já tem um dono/u)
  })

  it('409 sem-token: mensagem PT-BR acionavel, sem vazar a chave', async () => {
    const bancada = criarBancada({
      pairOps: { estado: () => ({ pareado: false }), gerar: async () => ({ ok: false as const, erro: 'sem-token' as const }) },
    })
    const resposta = await bancada.enviar(UI_PATH_PAIR, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
      pedacos: ['{}'],
    })
    assert.equal(resposta.status, 409)
    assert.equal(resposta.corpo.erro, 'sem-token')
    assert.match(String(resposta.corpo.mensagem), /Configure a chave do bot/u)
  })

  it('409 worker-indisponivel: mensagem PT-BR, sem vazar detalhe de topologia', async () => {
    const bancada = criarBancada({
      pairOps: { estado: () => ({ pareado: false }), gerar: async () => ({ ok: false as const, erro: 'worker-indisponivel' as const }) },
    })
    const resposta = await bancada.enviar(UI_PATH_PAIR, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
      pedacos: ['{}'],
    })
    assert.equal(resposta.status, 409)
    assert.equal(resposta.corpo.erro, 'worker-indisponivel')
    assert.match(String(resposta.corpo.mensagem), /não está a correr/u)
  })

  it('corpo excessivo responde 400 antes de chegar ao gerar', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_PAIR, {
      metodo: 'POST',
      cabecalhos: { [CSRF_HEADER_NAME]: bancada.token() },
      pedacos: ['x'.repeat(5000)],
    })
    assert.equal(resposta.status, 400)
    assert.equal(resposta.corpo.erro, 'corpo-grande')
  })
})

describe('o estado do pareamento (GET /pair-state)', () => {
  it('devolve pareado+handle+codigo ativo quando a costura os tem', async () => {
    const bancada = criarBancada({
      pairOps: {
        estado: () => ({ pareado: false, handle: 'exemplo_bot', codigo: '123456', expiraEm: 1_000_000_000 + 60_000 }),
        gerar: async () => ({ ok: true, codigo: '123456', expiraEm: 1_000_000_000 + 60_000 }),
      },
    })
    const resposta = await bancada.enviar(UI_PATH_PAIR_STATE, { metodo: 'GET' })
    assert.equal(resposta.status, 200)
    assert.equal(resposta.corpo.pareado, false)
    assert.equal(resposta.corpo.handle, 'exemplo_bot')
    assert.equal(resposta.corpo.codigo, '123456')
    assert.equal(resposta.corpo.expiraEm, 1_000_000_000 + 60_000)
  })

  it('devolve pareado quando a costura afirma o dono; o codigo nao sai nesse caso', async () => {
    const bancada = criarBancada({
      pairOps: { estado: () => ({ pareado: true, handle: 'exemplo_bot' }), gerar: async () => ({ ok: true, codigo: '123456', expiraEm: 1 }) },
    })
    const resposta = await bancada.enviar(UI_PATH_PAIR_STATE, { metodo: 'GET' })
    assert.equal(resposta.corpo.pareado, true)
    assert.equal(Object.hasOwn(resposta.corpo, 'codigo'), false, 'pareado nao deixa sessao viva por a mostrar')
  })

  it('metodo errado responde 405 com allow: GET', async () => {
    const bancada = criarBancada()
    const resposta = await bancada.enviar(UI_PATH_PAIR_STATE, { metodo: 'POST', pedacos: ['{}'] })
    assert.equal(resposta.status, 405)
    assert.equal(resposta.cabecalhos.allow, 'GET')
  })
})