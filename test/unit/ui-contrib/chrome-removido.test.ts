/**
 * =============================================================================
 * SUB-TAREFA 1.1 — GUARDAS DA REMOCAO DO CHROME/TAP DA HOME (onda 1).
 * =============================================================================
 *
 * Completa os GAPS que a suite de superficie (`surface.test.ts`) e a de rotas
 * (`routes.test.ts`) NAO cobrem. O contrato (fonte primaria): a superficie
 * deixa de tocar o index.html do DSH POR INTEIRO — sem div #dsh-guard-ui, sem
 * meta CSRF de fallback, sem script /__guard-ui/client.js — PRESERVANDO as 17
 * rotas API, o disposer LIFO/idempotente e o CSRF com fonte unica
 * `GET /__guard-ui/api/csrf`.
 *
 * As perguntas falsificaveis que ESTE ficheiro trava (as irmaos ja cobertas
 * ficam nos ficheiros existentes):
 *
 *  F3 (variantes do disposer):
 *   - a ordem do LIFO e OBSERVAVEL: as 17 rotas sao desmontadas na ordem
 *     EXATAMENTE inversa da registacao e o `unsub` corre DEPOIS de todas
 *     (a suite existente conta 17, mas nao olha a ordem);
 *   - o rollback parcial tambem e LIFO e chama o `unsub` antes do rethrow
 *     (a suite existente so conta `rotasDesmontadas === 2`);
 *   - o espinho de `tapIndex` continua NAO chamado no caminho de ERRO do
 *     registo (a variante "erro em tempo de init"; a suite existente so cobre
 *     init OK + dispose);
 *   - re-init APOS dispose: a nova montagem re-registra as rotas e a
 *     superficie nova funciona (GET /api/csrf emite), sem ressuscitar o tap.
 *
 *  F2 (o elo inteiro da corrente CSRF):
 *   - varredura sistematica: o token emitido por `GET /__guard-ui/api/csrf`
 *     (issue) e aceite em TODAS as rotas POST da superficie (verify, binding
 *     UI_CSRF) — nenhuma responde 403 `csrf-recusado` com ele — e SEM ele
 *     TODAS recusam 403; o token no campo `csrf` do CORPO vale tambem nas
 *     rotas que a suite de rotas nao cobriu por esse caminho (/telegram/click
 *     e o cancelamento de agentes); o token expira no TTL e uma emissao nova
 *     volta a valer.
 *
 *  F3-adjacente (handlers preservados): as 8 rotas GET continuam a responder
 *   as formas do contrato depois da remocao.
 *
 *  F4 (zero codigo morto):
 *   - `src/ui-contrib/html.ts` NAO existe mais em disco;
 *   - o modulo de rotas NAO exporta `UI_PATH_CLIENT` nem `createClientHandler`;
 *   - nenhuma chamada de tap (`deps.tapIndex(`, `.tapIndex(`, `createIndexTap`)
 *     sobrou em `src/ui-contrib/surface.ts` nem em `src/index.ts` (a costura
 *     `tapIndex: (transform) => ...` saiu).
 *
 * Sem socket, sem cloudflared: os handlers sao chamados com `req`/`res`
 * falsos; o relogio e o FakeClock. NENHUM duble complacente em caminho de
 * seguranca: o guard de CSRF e o REAL (`createCsrfGuard`, montado dentro de
 * `createNativeUiSurface`).
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ControlAction, ControlIntent, ControlResultado } from '../../../src/contracts/control.ts'
import type { BotEstado } from '../../../src/ui-contrib/bot-state.ts'
import { createNativeUiSurface, type UiContribDeps } from '../../../src/ui-contrib/surface.ts'
import { CSRF_FIELD_NAME, CSRF_HEADER_NAME } from '../../../src/ui-contrib/csrf.ts'
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
  type UiContribRoute,
} from '../../../src/ui-contrib/routes.ts'
import { FakeClock } from '../../support/clock.ts'

const RAIZ_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../../src')

/* ========================================================================== */
/* Bancada: regista a ORDEM de cada registro/desregistro (a prova do LIFO)     */
/* ========================================================================== */

interface RespostaCapturada {
  readonly status: number
  readonly corpo: Record<string, unknown>
}

interface Bancada {
  /** A cronologia completa: `assina`, `rota-N`, `desfaz-rota-N`, `unsub`. */
  readonly ordem: string[]
  /** As rotas EXACT vivas (o disposer do duble REMOVE da tabela). */
  readonly rotas: Map<string, UiContribRoute>
  /** As rotas PREFIXO vivas. */
  readonly prefixos: UiContribRoute[]
  readonly emitidos: ControlIntent[]
  readonly noncesPedidos: ControlAction[]
  readonly clock: FakeClock
  /** Monta a superficie (de novo, se preciso) e devolve o disposer. */
  montar(): () => void
  /** O token emitido pela rota GET /api/csrf — a UNICA fonte (HIGH-2). */
  tokenDoCsrf(): string
  enviar(
    caminho: string,
    opcoes?: { metodo?: string; token?: string; corpo?: unknown; tokenNoCorpo?: string },
  ): Promise<RespostaCapturada>
}

function criarBancada(opcoes: { registerRouteLancaNo?: number } = {}): Bancada {
  const clock = new FakeClock(1_000_000)
  const ordem: string[] = []
  const rotas = new Map<string, UiContribRoute>()
  const prefixos: UiContribRoute[] = []
  const emitidos: ControlIntent[] = []
  const noncesPedidos: ControlAction[] = []
  let totalRegistradas = 0
  let nonceSeq = 0

  const deps: UiContribDeps = {
    registerRoute: (rota) => {
      totalRegistradas += 1
      const rotulo = `rota-${totalRegistradas}`
      if (opcoes.registerRouteLancaNo === totalRegistradas) {
        // O cenario de colisao (ex.: rota duplicada no host): a N-esima
        // registacao NAO entra — lanca ANTES de marcar o rotulo (nao houve
        // registro) e as N-1 anteriores tem de ser desfeitas em LIFO.
        throw new Error('rota duplicada')
      }
      ordem.push(rotulo)
      if (rota.kind === 'exact') rotas.set(rota.path, rota)
      else prefixos.push(rota)
      return (): void => {
        // O espelho do desregistro real: a rota SAI da tabela viva.
        if (rota.kind === 'exact') rotas.delete(rota.path)
        else {
          const indice = prefixos.indexOf(rota)
          if (indice !== -1) prefixos.splice(indice, 1)
        }
        ordem.push(`desfaz-${rotulo}`)
      }
    },
    emit: async (intent) => {
      emitidos.push(intent)
      return { estado: 'STOPPED', idempotente: false } satisfies ControlResultado
    },
    issueNonce: (action) => {
      noncesPedidos.push(action)
      nonceSeq += 1
      return { valor: `nonce-opaco-${nonceSeq}`, expiresAt: clock.now() + 60_000 }
    },
    subscribe: () => {
      ordem.push('assina')
      return (): void => {
        ordem.push('unsub')
      }
    },
    now: () => clock.now(),
    botState: (): BotEstado => ({ online: false, motivo: 'sem-chave' }),
    provider: 'telegram',
    tokenOps: {
      validarFormato: (bruto: string) => bruto.trim().includes(':'),
      fonte: () => 'secrets' as const,
      sondar: async (token: string) =>
        token.trim().length > 0
          ? { ok: true as const, handle: 'exemplo_bot' }
          : { ok: false as const, erro: 'token-invalido' },
      gravar: () => undefined,
      estado: () => ({ configurado: false, handle: null, fonte: 'nenhum' } as const),
      privacidade: async () => ({ ok: true as const, handle: null, fonte: 'nenhum' as const }),
    },
    pairOps: {
      estado: () => ({ pareado: false }),
      gerar: async () => ({ ok: true as const, codigo: '123456', expiraEm: clock.now() + 60_000 }),
    },
    acesso: () => ({ conexoesAtivas: 0, totalSessoes: 0, sessoes: [], ipConfiavel: false }),
    agentsOps: {
      listar: () => [],
      cancelar: () => false,
    },
  }

  const enviar = async (
    caminho: string,
    opcoesEnvio: { metodo?: string; token?: string; corpo?: unknown; tokenNoCorpo?: string } = {},
  ): Promise<RespostaCapturada> => {
    // Espelho do despacho do host: tabela exact primeiro; a falha cai nos
    // prefixos (o MAIS LONGO ganha).
    const rota =
      rotas.get(caminho) ??
      prefixos
        .filter((p) => caminho.startsWith(p.path))
        .toSorted((a, b) => b.path.length - a.path.length)[0]
    assert.ok(rota !== undefined, `rota nao registada: ${caminho}`)
    const req = new EventEmitter() as unknown as IncomingMessage
    const bruto = req as unknown as { method: string; url: string; headers: Record<string, string>; destroy(): void }
    bruto.method = opcoesEnvio.metodo ?? 'GET'
    bruto.url = caminho
    bruto.headers = opcoesEnvio.token === undefined ? {} : { [CSRF_HEADER_NAME]: opcoesEnvio.token }
    bruto.destroy = () => undefined

    let status = 0
    let corpoTexto = ''
    const res = {
      writeHead: (s: number): void => {
        status = s
      },
      end: (corpo?: unknown): void => {
        corpoTexto = typeof corpo === 'string' ? corpo : String(corpo ?? '')
      },
    } as unknown as ServerResponse

    const pendente = rota.handler(req, res)
    if (opcoesEnvio.tokenNoCorpo !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify({ [CSRF_FIELD_NAME]: opcoesEnvio.tokenNoCorpo })))
    } else if (opcoesEnvio.corpo !== undefined) {
      req.emit('data', Buffer.from(JSON.stringify(opcoesEnvio.corpo)))
    }
    req.emit('end')
    await pendente
    return { status, corpo: corpoTexto === '' ? {} : (JSON.parse(corpoTexto) as Record<string, unknown>) }
  }

  const tokenDoCsrf = (): string => {
    const rota = rotas.get(UI_PATH_CSRF)
    assert.ok(rota !== undefined, 'a rota /csrf deveria estar registada')
    const req = new EventEmitter() as unknown as IncomingMessage
    const bruto = req as unknown as { method: string; url: string; headers: Record<string, string>; destroy(): void }
    bruto.method = 'GET'
    bruto.url = UI_PATH_CSRF
    bruto.headers = {}
    bruto.destroy = () => undefined
    let corpoTexto = ''
    const res = {
      writeHead: (): void => undefined,
      end: (corpo?: unknown): void => {
        corpoTexto = typeof corpo === 'string' ? corpo : String(corpo ?? '')
      },
    } as unknown as ServerResponse
    void rota.handler(req, res)
    req.emit('end')
    const corpo = JSON.parse(corpoTexto) as { token?: unknown }
    assert.equal(typeof corpo.token, 'string', 'o /csrf deveria devolver um token')
    return corpo.token as string
  }

  return {
    ordem,
    rotas,
    prefixos,
    emitidos,
    noncesPedidos,
    clock,
    montar: (): (() => void) => createNativeUiSurface(deps),
    tokenDoCsrf,
    enviar,
  }
}

/* ========================================================================== */
/* F3 — A ORDEM do disposer (LIFO observavel) e variantes                      */
/* ========================================================================== */

describe('F3: o disposer reverte as 17 rotas em LIFO OBSERVAVEL e o unsub corre por ultimo', () => {
  it('a ordem de desmontagem e EXATAMENTE a inversa da registacao; o unsub vem DEPOIS das rotas', () => {
    const bancada = criarBancada()
    const dispor = bancada.montar()
    assert.equal(bancada.rotas.size, 16, 'as 16 rotas EXACT estao vivas')
    assert.equal(bancada.prefixos.length, 1, 'o prefixo de cancelamento de agentes completa as 17 rotas')
    assert.deepEqual(bancada.ordem[0], 'assina', 'a assinatura do broadcast nasce ANTES das rotas (LIFO: sai por ultimo)')

    dispor()
    const desfazimentos = bancada.ordem.filter((e) => e.startsWith('desfaz-'))
    const esperado = Array.from({ length: 17 }, (_, i) => `desfaz-rota-${17 - i}`)
    assert.deepEqual(desfazimentos, esperado, 'as rotas saem na ordem INVERSA da registacao')
    assert.deepEqual(bancada.ordem.slice(-1), ['unsub'], 'o unsub e o ULTIMO ato do disposer')
    assert.equal(bancada.ordem.filter((e) => e === 'unsub').length, 1)
    assert.equal(bancada.rotas.size, 0, 'nenhuma rota sobra viva no host')
    assert.equal(bancada.prefixos.length, 0, 'o prefixo de cancelamento de agentes tambem sai')
  })

  it('o disposer idempotente NAO repete a ordem nem o unsub (LIFE-003)', () => {
    const bancada = criarBancada()
    const dispor = bancada.montar()
    dispor()
    const depoisDoPrimeiro = [...bancada.ordem]
    dispor()
    dispor()
    assert.deepEqual(bancada.ordem, depoisDoPrimeiro, 'o segundo dispose e um no-op completo')
  })

  it('o rollback parcial tambem e LIFO e chama o unsub ANTES de propagar o erro', () => {
    // A 4.a registacao nao entra (colisao): as tres primeiras saem em LIFO e o
    // broadcast e desassinado — nunca uma meia contribuicao nem uma assinatura
    // orfa no host.
    const bancada = criarBancada({ registerRouteLancaNo: 4 })
    assert.throws(() => bancada.montar(), /rota duplicada/u)
    assert.deepEqual(
      bancada.ordem,
      ['assina', 'rota-1', 'rota-2', 'rota-3', 'desfaz-rota-3', 'desfaz-rota-2', 'desfaz-rota-1', 'unsub'],
      'rollback parcial: LIFO estrito e unsub ANTES do rethrow',
    )
    assert.equal(bancada.rotas.size, 0, 'nenhuma rota parcial sobra')
    assert.equal(bancada.prefixos.length, 0)
  })

  it('o espinho de tapIndex continua NAO chamado no caminho de ERRO do registo (variante init-falho)', () => {
    // A guarda do espinho em surface.test.ts cobre init OK + dispose; o
    // caminho de ERRO (o registo que lanca a meio) e a variante que o chrome
    // antigo ocupava no try: se o tap voltasse DENTRO do try, ele teria de ser
    // desfeito no catch. O espinho tem de continuar a ZERO chamadas.
    const espinho = { chamadas: 0 }
    const clockLocal = new FakeClock(5_000)
    const depsBrutos = {
      registerRoute: (): (() => void) => {
        throw new Error('rota duplicada')
      },
      emit: async (): Promise<ControlResultado> => ({ estado: 'STOPPED', idempotente: false }),
      issueNonce: () => ({ valor: 'n', expiresAt: clockLocal.now() + 60_000 }),
      subscribe: (): (() => void) => () => undefined,
      now: (): number => clockLocal.now(),
      botState: (): BotEstado => ({ online: false, motivo: 'sem-chave' }),
      provider: 'telegram' as const,
      tokenOps: {
        validarFormato: (bruto: string): boolean => bruto.trim().includes(':'),
        fonte: (): 'secrets' => 'secrets',
        sondar: async (): Promise<{ ok: true; handle: string }> => ({ ok: true, handle: 'exemplo_bot' }),
        gravar: (): void => undefined,
        estado: (): { configurado: boolean; handle: string | null; fonte: string } => ({
          configurado: false,
          handle: null,
          fonte: 'nenhum',
        }),
        privacidade: async (): Promise<{ ok: boolean; handle: string | null; fonte: string }> => ({
          ok: true,
          handle: null,
          fonte: 'nenhum',
        }),
      },
      pairOps: {
        estado: (): { pareado: boolean } => ({ pareado: false }),
        gerar: async (): Promise<{ ok: boolean; codigo: string; expiraEm: number }> => ({
          ok: true,
          codigo: '123456',
          expiraEm: clockLocal.now() + 60_000,
        }),
      },
      acesso: () => ({ conexoesAtivas: 0, totalSessoes: 0, sessoes: [], ipConfiavel: false }),
      agentsOps: { listar: (): [] => [], cancelar: (): boolean => false },
      // O ESPINHO: a forma antiga do campo, como propriedade EXTRA nos deps
      // (a forma como o host real espelharia a API). Se a superficie voltar a
      // chama-lo — no try OU no catch — `chamadas` sobe e o assert falha.
      tapIndex: (transform: (html: string) => string): (() => void) => {
        void transform
        espinho.chamadas += 1
        return () => undefined
      },
    }
    const deps = depsBrutos as unknown as UiContribDeps
    assert.throws(() => createNativeUiSurface(deps), /rota duplicada/u)
    assert.equal(espinho.chamadas, 0, 'o tap do indice voltou no caminho de erro (regresso do chrome)')
  })

  it('re-init APOS dispose: a nova montagem re-registra as 17 rotas e funciona (GET /api/csrf emite)', () => {
    const bancada = criarBancada()
    const primeiro = bancada.montar()
    primeiro()
    assert.equal(bancada.rotas.size, 0, 'apos o dispose nenhuma rota vive')

    const segundo = bancada.montar()
    assert.equal(bancada.rotas.size, 16, 'a segunda montagem re-registra as 16 rotas exact')
    assert.equal(bancada.prefixos.length, 1, 'o prefixo de cancelamento de agentes volta (17 rotas no total)')
    const token = bancada.tokenDoCsrf()
    assert.ok(token.length > 0, 'a superficie re-init emite CSRF pela rota GET /api/csrf')
    assert.equal(bancada.ordem.filter((e) => e === 'assina').length, 2, 'cada montagem assina o broadcast UMA vez')

    // E o disposer da nova montagem reverte so o que ELA registou.
    segundo()
    assert.equal(bancada.rotas.size, 0)
    assert.equal(bancada.ordem.filter((e) => e.startsWith('desfaz-')).length, 34, '17 do primeiro descarrego + 17 do segundo')
    assert.equal(bancada.ordem.filter((e) => e === 'unsub').length, 2, 'um unsub por montagem')
  })
})

/* ========================================================================== */
/* Handlers preservados — as 8 rotas GET respondem as formas do contrato       */
/* ========================================================================== */

describe('preservadas: as rotas GET respondem as formas do contrato (sem o chrome)', () => {
  it('as 8 rotas GET respondem: 503 sem-estado (state) e 200 nas demais leituras', async () => {
    const bancada = criarBancada()
    bancada.montar()

    // O GET /state sem nenhuma difusao responde 503 explicito — nunca um
    // estado inventado.
    const estado = await bancada.enviar(UI_PATH_STATE)
    assert.equal(estado.status, 503)
    assert.equal(estado.corpo.erro, 'sem-estado')

    // As demais leituras preservadas respondem 200 com as suas formas.
    const telegrama = await bancada.enviar(UI_PATH_TELEGRAM)
    assert.equal(telegrama.status, 200)
    assert.deepEqual(telegrama.corpo, { online: false, provider: 'telegram', motivo: 'sem-chave' })

    const tokenEstado = await bancada.enviar(UI_PATH_TOKEN_STATE)
    assert.equal(tokenEstado.status, 200)
    assert.deepEqual(tokenEstado.corpo, { configurado: false, fonte: 'nenhum' })

    const privacidade = await bancada.enviar(UI_PATH_PRIVACIDADE)
    assert.equal(privacidade.status, 200)
    assert.deepEqual(privacidade.corpo, { ok: true, handle: null, fonte: 'nenhum' })

    const pareamento = await bancada.enviar(UI_PATH_PAIR_STATE)
    assert.equal(pareamento.status, 200)
    assert.deepEqual(pareamento.corpo, { pareado: false })

    const acesso = await bancada.enviar(UI_PATH_ACCESS)
    assert.equal(acesso.status, 200)
    assert.deepEqual(acesso.corpo, {
      totalConexoes: 0,
      totalSessoes: 0,
      conexoesAtivas: 0,
      ipConfiavel: false,
      sessoes: [],
    })

    const agentes = await bancada.enviar(UI_PATH_AGENTS)
    assert.equal(agentes.status, 200)
    assert.deepEqual(agentes.corpo, { runs: [] })

    const csrf = await bancada.enviar(UI_PATH_CSRF)
    assert.equal(csrf.status, 200)
    assert.equal(typeof csrf.corpo.token, 'string')
  })
})

/* ========================================================================== */
/* F2 — A corrente CSRF completa: issue (GET /api/csrf) -> verify (POSTs)      */
/* ========================================================================== */

/** As NOVE rotas POST da superficie — TODAS as escritas do contrato. */
const ROTAS_POST: readonly string[] = [
  UI_PATH_START,
  UI_PATH_CONFIRM,
  UI_PATH_STOP,
  UI_PATH_RESET,
  UI_PATH_RESET_CONFIRM,
  UI_PATH_TELEGRAM_CLICK,
  UI_PATH_TOKEN,
  UI_PATH_PAIR,
  `${UI_PATH_AGENTS}/ABCDEF12/cancel`,
]

describe('F2: o token do GET /api/csrf vale em TODAS as rotas POST (e sem ele TODAS recusam)', () => {
  it('varredura: SEM token, todas as 9 rotas POST respondem 403 csrf-recusado e NADA emite', async () => {
    const bancada = criarBancada()
    bancada.montar()
    for (const caminho of ROTAS_POST) {
      const resposta = await bancada.enviar(caminho, { metodo: 'POST', corpo: {} })
      assert.equal(resposta.status, 403, `rota deveria recusar sem CSRF: ${caminho}`)
      assert.equal(resposta.corpo.erro, 'csrf-recusado', caminho)
    }
    assert.equal(bancada.emitidos.length, 0, 'nenhum intent saiu sem CSRF')
    assert.equal(bancada.noncesPedidos.length, 0, 'nenhum nonce foi pedido sem CSRF')
  })

  it('varredura: COM o token do GET /api/csrf no cabecalho, NENHUMA das 9 responde 403', async () => {
    const bancada = criarBancada()
    bancada.montar()
    const token = bancada.tokenDoCsrf()
    // O POST /token com corpo vazio passa o CSRF e cai no 400 token-vazio
    // (a recusa e de PAYLOAD, nao de CSRF — a corrente chegou inteira).
    const esperados: Readonly<Record<string, number>> = {
      [UI_PATH_START]: 200,
      [UI_PATH_CONFIRM]: 200,
      [UI_PATH_STOP]: 200,
      [UI_PATH_RESET]: 200,
      [UI_PATH_RESET_CONFIRM]: 200,
      [UI_PATH_TELEGRAM_CLICK]: 200,
      [UI_PATH_TOKEN]: 400,
      [UI_PATH_PAIR]: 200,
      [`${UI_PATH_AGENTS}/ABCDEF12/cancel`]: 200,
    }
    for (const caminho of ROTAS_POST) {
      const resposta = await bancada.enviar(caminho, { metodo: 'POST', token, corpo: {} })
      assert.equal(resposta.status, esperados[caminho], `rota com CSRF fresco: ${caminho}`)
      assert.notEqual(resposta.corpo.erro, 'csrf-recusado', caminho)
    }
    // Os intents de verdade sairam nas rotas de um passo (stop dispensa nonce;
    // os confirms transportam o nonce opaco — aqui o duble nao o valida).
    assert.deepEqual(
      bancada.emitidos.map((i) => i.action).toSorted(),
      ['reset', 'start', 'stop'].toSorted(),
    )
    // Os passos 1 (start e reset) pediram os nonces ao HOST.
    assert.deepEqual(bancada.noncesPedidos.toSorted(), ['reset', 'start'].toSorted())
  })

  it('o token no CAMPO `csrf` do corpo vale nas rotas que o cabecalho nao cobriu (/telegram/click e /agents/:id/cancel)', async () => {
    const bancada = criarBancada()
    bancada.montar()
    const token = bancada.tokenDoCsrf()
    for (const caminho of [UI_PATH_TELEGRAM_CLICK, `${UI_PATH_AGENTS}/ABCDEF12/cancel`]) {
      const resposta = await bancada.enviar(caminho, { metodo: 'POST', tokenNoCorpo: token, corpo: {} })
      assert.equal(resposta.status, 200, `token no campo do corpo deveria valer: ${caminho}`)
    }
  })

  it('o token da rota /csrf expira no TTL; uma emissao nova volta a valer (relogio injetado)', async () => {
    const bancada = criarBancada()
    bancada.montar()
    const tokenAntigo = bancada.tokenDoCsrf()

    bancada.clock.advance(31 * 60 * 1000) // alem do TTL de 30 minutos
    const recusado = await bancada.enviar(UI_PATH_STOP, { metodo: 'POST', token: tokenAntigo, corpo: {} })
    assert.equal(recusado.status, 403, 'o token emitido expira no TTL e o POST recusa')

    const novo = await bancada.enviar(UI_PATH_CSRF)
    const brutoNovo = novo.corpo.token
    assert.equal(typeof brutoNovo, 'string')
    const tokenNovo = brutoNovo as string
    assert.notEqual(tokenNovo, tokenAntigo, 'a emissao nova traz um prazo diferente')
    const revalidado = await bancada.enviar(UI_PATH_STOP, { metodo: 'POST', token: tokenNovo, corpo: {} })
    assert.equal(revalidado.status, 200, 'a emissao nova restabelece o CSRF')
  })
})

/* ========================================================================== */
/* F4 — Zero codigo morto (varredura estatica + superficie do modulo)          */
/* ========================================================================== */

describe('F4: zero codigo morto do chrome removido', () => {
  it('o ficheiro src/ui-contrib/html.ts NAO existe mais', () => {
    assert.equal(
      existsSync(join(RAIZ_SRC, 'ui-contrib', 'html.ts')),
      false,
      'o html.ts (o chrome injetado) foi apagado — nao pode voltar nem ficar orfao',
    )
  })

  it('o modulo de rotas NAO exporta UI_PATH_CLIENT nem createClientHandler', async () => {
    const rotas = (await import('../../../src/ui-contrib/routes.ts')) as Record<string, unknown>
    assert.equal('UI_PATH_CLIENT' in rotas, false, 'a constante da rota do script antigo saiu')
    assert.equal('createClientHandler' in rotas, false, 'o handler do script antigo saiu')
  })

  it('surface.ts nao tem chamada de tap nem importador do chrome (so o relato historico em comentario)', () => {
    const fonte = readFileSync(join(RAIZ_SRC, 'ui-contrib', 'surface.ts'), 'utf8')
    // Tokens de CODIGO (nao de comentario): a menina historica "`tapIndex`" no
    // cabecalho documenta a remocao e nao e chamada nenhuma.
    for (const token of ['deps.tapIndex', '.tapIndex(', 'createIndexTap', 'createClientHandler', 'UI_PATH_CLIENT', "from './html.ts'"]) {
      assert.equal(fonte.includes(token), false, `surface.ts contem "${token}"`)
    }
  })

  it('src/index.ts nao costura tapIndex nenhum (a linha tapIndex: (transform) => ... saiu)', () => {
    const fonte = readFileSync(join(RAIZ_SRC, 'index.ts'), 'utf8')
    for (const token of ['tapIndex', 'createIndexTap', 'createClientHandler', 'UI_PATH_CLIENT']) {
      assert.equal(fonte.includes(token), false, `src/index.ts contem "${token}"`)
    }
  })
})
