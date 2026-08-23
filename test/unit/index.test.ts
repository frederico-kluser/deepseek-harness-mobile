/**
 * `src/index.ts` -- a RAIZ DE COMPOSICAO: manifesto, avisos de arranque e a
 * fiacao dos quatro efeitos.
 *
 * Aqui nao se testa regra nenhuma: cada regra tem o seu ficheiro sob
 * `test/unit/<caminho do fonte>/`. O que se prova e a COMPOSICAO.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import type { IncomingMessage } from 'node:http'
import type { TunnelSnapshot } from '../../src/contracts/tunnel.ts'
import { PACKAGED_WORKER_ENTRYPOINT } from '../../src/config/schema.ts'
import { WORKER_PROVIDER_ENV_VAR } from '../../src/proc/env.ts'
import { apply, criarFanoutDeEstado, inject, name, type Config } from '../../src/index.ts'
import { UI_PATH_TELEGRAM } from '../../src/ui-contrib/routes.ts'
import {
  createFakeLogger,
  FakeContext,
  FakeResponse,
  makeRequest,
} from '../support/ctx-double.ts'
import { EFFECT, flush, install, makeConfig } from '../support/fixtures.ts'

describe('manifesto do plugin', () => {
  it('expoe o nome e as dependencias injetadas exigidas pelo contrato', () => {
    assert.equal(name, 'dsh-guarded-bot-orchestrator')
    // `webServer` (e nao `httpServer`): medido contra as 9 versoes publicadas --
    // `httpServer` so existiu na linha morta 0.0.1-rc.1/rc.2.
    assert.deepEqual(inject, ['webServer', 'subprocess'])
  })

  it('NAO injeta `logger`: injeta-lo deixa a Fiber PENDING e apply() nunca corre', () => {
    // `LoggerService` nao estende `Service` e nao entra no reflect store -- o
    // Context raiz cria-o como propriedade PROPRIA. Uma Fiber que o injecte fica
    // PENDING em silencio: sem erro, sem log, e o plano de controlo responde 200
    // sem credencial. Medido contra o cordis real.
    assert.equal(
      inject.includes('logger'),
      false,
      'so servicos que estendem Service sao injetaveis; ctx.logger e propriedade do Context',
    )
  })

  it('cada nome injetado corresponde a um servico que ESTENDE Service', () => {
    // O espelho verificado por CONTRACT-* diz quais sao: `WebServer extends
    // Service` e `SubprocessRuntime extends Service`. `LoggerService` nao.
    const declaracoes: Record<string, string> = {
      webServer: 'types/dsh-host-webserver/index.d.ts',
      subprocess: 'types/dsh-subprocess/index.d.ts',
    }
    for (const nome of inject) {
      assert.notEqual(declaracoes[nome], undefined, `'${nome}' nao e um servico injetavel conhecido`)
    }
  })
})

describe('ciclo de vida sob ctx.effect', () => {
  it('regista cinco efeitos, etiquetados, e todos devolvem disposers SINCRONOS', () => {
    const { ctx } = install()

    assert.equal(ctx.effects.length, 5, 'veto + auth-check + barreira + controlador + worker')
    assert.deepEqual(ctx.effectLabels, [
      'dsh-guard.veto-de-permissao',
      'dsh-guard.auth-check',
      'dsh-guard.barreira',
      'dsh-guard.controlador',
      'dsh-guard.worker',
    ])

    for (const disposer of ctx.effects) {
      assert.equal(typeof disposer, 'function')
      const result: unknown = disposer()
      assert.notEqual(
        typeof (result as { then?: unknown } | undefined)?.then,
        'function',
        'disposer nao pode devolver Promise (garantia LIFO)',
      )
    }
  })

  it('a ordem dos efeitos poe o worker DEPOIS do controlador e da barreira (LIFO ao descarregar)', () => {
    // Os disposers correm em ordem inversa: o worker morre primeiro, depois o
    // controlador (que derruba o tunel), e so depois a barreira e levantada.
    // Ao contrario, haveria uma janela em que o plano de controlo responde sem
    // credencial com o worker ainda vivo.
    assert.equal(EFFECT.barreira < EFFECT.controlador, true)
    assert.equal(EFFECT.controlador < EFFECT.worker, true)
  })

  it('em modo loopback o efeito do controlador e um disposer sincrono e inerte', () => {
    // A configuracao de fabrica nao declara `tunnel` (exposure.mode: 'loopback'):
    // nao ha supervisor, nao ha controlador — a superficie IPC recusa com
    // EXPOSURE_DISABLED. O efeito existe para a contabilidade LIFO.
    const { ctx } = install()

    const disposer = ctx.effects[EFFECT.controlador]
    assert.equal(typeof disposer, 'function')
    const result: unknown = disposer?.()
    assert.equal(result, undefined)
    assert.equal(ctx.logger.has('info', 'controlador sem supervisor'), true)
  })

  it('arranca o worker imediatamente no apply', () => {
    const { ctx } = install()

    assert.equal(ctx.subprocess.calls.length, 1)
    // `[command, entrypoint]`: o entrypoint e resolvido de `import.meta.url`,
    // nunca do manifesto nem do `cwd`.
    assert.deepEqual(ctx.subprocess.calls[0]?.argv, [
      process.execPath,
      PACKAGED_WORKER_ENTRYPOINT,
    ])
  })

  it('token vazio/ausente = telegram nao configurado: sem worker, mas o efeito existe', () => {
    // Contrato INSTALL.md Passo 2/4: o portao HTTP sobe sem o bot. A validacao
    // aceita o token vazio, o efeito do worker continua registado (5 efeitos /
    // ordem LIFO inalterados) mas NAO spawna supervisor nem subprocesso.
    const config = makeConfig()
    config.worker.token = ''
    const ctx = new FakeContext()
    apply(ctx.asContext(), config)

    assert.equal(ctx.effects.length, 5, 'o efeito do worker continua registado')
    assert.equal(
      ctx.subprocess.calls.length,
      0,
      'sem token nao ha supervisor nem subprocesso do worker',
    )
    assert.equal(
      ctx.logger.has('info', 'bot nao configurado (provedor telegram) — rode /parear <código> no bot'),
      true,
      'a linha de boot documentada tem de ser impressa',
    )

    const workerDisposer = ctx.effects[EFFECT.worker]
    assert.equal(typeof workerDisposer, 'function')
    assert.equal(workerDisposer?.(), undefined, 'disposer no-op sincrono')
  })

  /* ---------------------------------------------------------------------- */
  /* O token resolver (_config.worker.token_ OU _secrets.env_) e o botao     */
  /* Telegram: a MESMA fonte na UI e no spawn do worker.                     */
  /* ---------------------------------------------------------------------- */
  const CHAVE = 'TELEGRAM_BOT_TOKEN'

  /** Um `$DSH_HOME` temporario com `guarded-bot/secrets.env` opcional. */
  function comSecretsEnv(
    tokenDoSecrets: string,
    opcoes: { withPairing?: boolean } = {},
  ): { dir: string; limpar: () => void } {
    const casa = join(tmpdir(), 'dsh-guard-secrets-' + process.pid + '-' + Math.random().toString(36).slice(2))
    const dir = join(casa, 'guarded-bot')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
    writeFileSync(join(dir, 'secrets.env'), `${CHAVE}=${tokenDoSecrets}\n`, { mode: 0o600 })
    if (opcoes.withPairing === true) {
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({
          version: 1,
          desiredState: 'STOPPED',
          pairing: { ownerUserId: 42, ownerChatId: -1001234567890, pairedAt: 2_000 },
        }),
        { mode: 0o600 },
      )
    }
    process.env.DSH_HOME = casa
    return {
      dir,
      limpar: (): void => {
        delete process.env.DSH_HOME
        rmSync(casa, { recursive: true, force: true })
      },
    }
  }

  /** Invoca o handler da rota GET /__guard-ui/api/telegram do plugin montado. */
  function estadoTelegramaDoUi(ctx: FakeContext): { online: boolean; motivo?: string } {
    const rota = ctx.webServer.routes.find((r) => r.path === UI_PATH_TELEGRAM)
    assert.ok(rota !== undefined, `rota do Telegram nao registada: ${UI_PATH_TELEGRAM}`)
    const handler = rota.handler as (req: IncomingMessage, res: FakeResponse) => void
    const res = new FakeResponse()
    handler(makeRequest({ url: UI_PATH_TELEGRAM, method: 'GET' }), res)
    assert.equal(res.statusCode, 200)
    return JSON.parse(res.body) as { online: boolean; motivo?: string }
  }

  describe('o resolvedor do token (config OU secrets.env) ligou a UI ao spawn do worker', () => {
    it('(a) config.worker.token vazio + secrets.env com token -> o WORKER SPAWNA com o token resolvido e a UI mostra ONLINE', () => {
      const { limpar } = comSecretsEnv('123456789:AAsegredoDoSecretsEnv', { withPairing: true })
      let ctx: FakeContext | undefined
      try {
        const config = makeConfig()
        config.worker.token = ''
        config.tunnel = { mode: 'quick', ttlMinutes: 60 } // para o surface da UI montar
        ctx = new FakeContext()
        apply(ctx.asContext(), config)

        // O spawn usa o token RESOLVIDO (vindo do secrets.env), nao o vazio do config.
        assert.equal(ctx.subprocess.calls.length, 1, 'o worker tem de spawnar com o token do secrets.env')
        const spec = ctx.subprocess.calls[0]
        assert.equal(spec?.env?.['TELEGRAM_BOT_TOKEN'], '123456789:AAsegredoDoSecretsEnv')
        // O spawn rotula o provedor ativo (provedor-aware): default fechado telegram.
        assert.equal(spec?.env?.[WORKER_PROVIDER_ENV_VAR], 'telegram')

        // A UI reflete o MESMO resolvedor: token presente E dono pareado -> ONLINE.
        assert.deepEqual(estadoTelegramaDoUi(ctx), { online: true })
      } finally {
        for (const disposer of ctx?.effects ?? []) disposer()
        limpar()
      }
    })

    it('(b) config vazio E secrets.env ausente -> OFFLINE sem-chave e sem worker', () => {
      const { limpar } = comSecretsEnv('', { withPairing: true })
      let ctx: FakeContext | undefined
      try {
        const config = makeConfig()
        config.worker.token = ''
        config.tunnel = { mode: 'quick', ttlMinutes: 60 }
        ctx = new FakeContext()
        apply(ctx.asContext(), config)

        // Mesmo pareado, SEM token (config e secrets.env vazios) -> sem-chave.
        assert.equal(ctx.subprocess.calls.length, 0, 'sem token em lado nenhum nao ha worker')
        assert.deepEqual(estadoTelegramaDoUi(ctx), { online: false, motivo: 'sem-chave' })
      } finally {
        for (const disposer of ctx?.effects ?? []) disposer()
        limpar()
      }
    })

    it('(c) config.worker.token nao-vazio -> ONLINE (o config manda) e o spawn usa o token do config', () => {
      const { limpar } = comSecretsEnv('', { withPairing: true })
      let ctx: FakeContext | undefined
      try {
        // makeConfig() traz worker.token: 'token-de-teste'; o secrets.env esta vazio.
        const config = makeConfig()
        config.tunnel = { mode: 'quick', ttlMinutes: 60 }
        ctx = new FakeContext()
        apply(ctx.asContext(), config)
        assert.equal(ctx.subprocess.calls.length, 1)
        const spec = ctx.subprocess.calls[0]
        assert.equal(spec?.env?.['TELEGRAM_BOT_TOKEN'], 'token-de-teste')
        assert.equal(spec?.env?.[WORKER_PROVIDER_ENV_VAR], 'telegram')
        assert.deepEqual(estadoTelegramaDoUi(ctx), { online: true })
      } finally {
        for (const disposer of ctx?.effects ?? []) disposer()
        limpar()
      }
    })
  })

  it('em modo tunnel o controlador nasce com o supervisor e morre sem deixar handles', async () => {
    // A configuracao de tunel e o que faz o efeito do controlador criar o
    // supervisor (T3.1), o controlador (T5.1) e o alocador de porta de
    // metricas. Nada e spawnado no apply; o worker continua a ser o unico
    // subprocesso. O disposer fecha o servidor de reserva do alocador.
    const { ctx } = install({
      exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false },
      tunnel: { mode: 'quick', ttlMinutes: 60 },
    })

    assert.equal(ctx.subprocess.calls.length, 1, 'so o worker e spawnado no apply')
    assert.equal(ctx.effects.length, 5)

    // O listen da reserva e assincrono: o servidor nasce num tick posterior.
    await flush()
    const antes = process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length
    ctx.effects[EFFECT.controlador]?.()
    // Um listen em voo fecha-se sozinho quando o callback da reserva corre
    // (a guarda `fechado` do alocador); espera-se o tick para o contar.
    await flush()
    const depois = process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length
    assert.equal(depois < antes, true, 'o servidor de reserva da porta de metricas tem de fechar no disposer')

    ctx.effects[EFFECT.worker]?.()
  })

  it('nao deixa temporizadores reais pendurados apos o dispose do efeito', async () => {
    const { ctx } = install()

    // O worker cai; como este teste usa o agendador REAL do Node, o unico
    // temporizador possivel e o do reinicio. O disposer tem de o limpar.
    ctx.subprocess.lastChild().settle({ exitCode: 1, signal: null })
    await flush()
    const beforeDispose = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length

    ctx.effects[EFFECT.worker]?.()

    const afterDispose = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
    assert.equal(afterDispose < beforeDispose, true, 'clearTimeout tem de correr no disposer')
  })

  it('NUNCA chama ctx.intercept (o mecanismo que compila em silencio e nao faz nada)', () => {
    // O duble lanca se `intercept` for invocado; um `install()` sem excecao e a
    // prova. E a chamada direta documenta o porque.
    assert.doesNotThrow(() => install())
    assert.throws(() => new FakeContext().intercept(), /fusao de configuracao/u)
  })
})

describe('fail loud at load na raiz de composicao', () => {
  it('apply() rebenta quando o servidor esta ligado a 0.0.0.0', () => {
    const ctx = new FakeContext()
    ctx.webServer.host = '0.0.0.0'

    assert.throws(() => apply(ctx.asContext(), makeConfig()), /Bind inseguro/u)
    assert.equal(ctx.subprocess.calls.length, 0, 'nada e alocado se o arranque falha')
    assert.equal(ctx.effects.length, 0, 'nem a barreira e instalada')
  })
})

describe('avisos de arranque', () => {
  it('avisa quando trustedRemotes esta vazio (fail-closed)', () => {
    const { ctx } = install({ trustedRemotes: [] })
    assert.equal(
      ctx.logger.has('warn', 'fail-closed'),
      true,
      'a configuracao inoperante tem de ser sinalizada no arranque',
    )
  })

  it('avisa quando guardedPrefixes esta vazio', () => {
    const { ctx } = install({ guardedPrefixes: [] })
    assert.equal(ctx.logger.has('warn', 'guardedPrefixes esta VAZIO'), true)
  })

  it('avisa quando deniedPermissions esta vazio', () => {
    const { ctx } = install({ deniedPermissions: [] })
    assert.equal(ctx.logger.has('warn', 'deniedPermissions esta VAZIO'), true)
  })

  it('avisa quando encodedAuthString esta ausente (tudo responde 401)', () => {
    const config = makeConfig()
    delete config.encodedAuthString

    const ctx = new FakeContext()
    apply(ctx.asContext(), config)

    assert.equal(ctx.logger.has('warn', 'encodedAuthString AUSENTE'), true)

    for (const disposer of ctx.effects) disposer()
  })

  it('a linha de ORDEM DE CARREGAMENTO sobreviveu -- invertida, com o facto medido', () => {
    // Ate esta onda era um `warn` a exigir que a entrada do plugin fosse
    // resolvida ANTES das que registam /api e o fallback. O mecanismo medido nao
    // tem essa exigencia, e uma linha que simplesmente sumisse seria
    // indistinguivel de um log perdido no refactor.
    const { ctx } = install()
    assert.equal(ctx.logger.has('info', 'ORDEM DE CARREGAMENTO: sem exigencia'), true)
    assert.equal(
      ctx.logger.has('warn', 'REQUISITO DE ORDEM DE CARREGAMENTO'),
      false,
      'a exigencia foi refutada por medicao: manter o aviso seria mentir ao operador',
    )
  })
})

/** Espera ATIVA e curta por uma condicao: o probe do boot e I/O real contra
 * a porta do duble, e uma unica microtask nao o deixa concluir. */
async function esperarAte(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(predicate(), true, 'a condicao nunca foi atingida dentro do prazo')
}

describe('boot: a intencao persistida decide o arranque (CTL-033/034)', () => {
  /**
   * Escreve um `state.json` numa casa DSH temporaria e devolve a limpeza.
   * O `apply()` resolve `$DSH_HOME` do ambiente (src/state/paths.ts).
   */
  function comEstado(desejado: 'READY' | 'STOPPED', restrito: boolean): () => void {
    const casa = join(tmpdir(), `dsh-guard-boot-${process.pid}`)
    const dir = join(casa, 'guarded-bot')
    mkdirSync(dir, { recursive: true })
    // O diretorio de estado exige 0700 (o estado recusa-se a ler de um
    // diretorio aberto a grupo/outros). O `mode` do mkdir e mascarado pelo
    // umask; o chmod nao — a mesma ordem que `src/state/paths.ts` usa.
    chmodSync(dir, 0o700)
    // O secretDigest e o de um estado REAL apos o onboarding (T2.1):
    // hex minusculo de 64 chars, o formato que o schema valida. Sem ele o
    // start de boot seria recusado por SEM_SEGREDO_FORTE (CTL-009) antes de
    // o probe correr — e o que este bloco quer observar e o probe a correr.
    const estado = restrito
      ? {
          version: 1,
          desiredState: desejado,
          secretDigest: 'ab'.repeat(32),
          restricted: { since: 1, reason: 'brute-force-ceiling' },
        }
      : { version: 1, desiredState: desejado, secretDigest: 'ab'.repeat(32) }
    writeFileSync(join(dir, 'state.json'), JSON.stringify(estado), { mode: 0o600 })
    process.env.DSH_HOME = casa
    return (): void => {
      delete process.env.DSH_HOME
      rmSync(casa, { recursive: true, force: true })
    }
  }

  function configTunel(autoStart: boolean): Partial<Config> {
    return {
      exposure: { mode: 'tunnel', autoStart, trustEdgeHeaders: false },
      tunnel: { mode: 'quick', ttlMinutes: 60 },
    }
  }

  it('CTL-033: autoStart desligado + intencao READY -> nenhum tunel sobe no boot', () => {
    const limpar = comEstado('READY', false)
    let ctx: FakeContext | undefined
    try {
      ctx = install(configTunel(false)).ctx
      assert.equal(ctx.logger.has('info', 'boot em STOPPED: exposure.autoStart esta desligado'), true)
      assert.equal(ctx.subprocess.calls.length, 1, 'so o worker e spawnado')
    } finally {
      // O disposer fecha o servidor de reserva do alocador de metricas.
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })

  it('intencao STOPPED + autoStart ligado -> nenhum tunel sobe no boot', () => {
    const limpar = comEstado('STOPPED', false)
    let ctx: FakeContext | undefined
    try {
      ctx = install(configTunel(true)).ctx
      assert.equal(ctx.logger.has('info', 'boot em STOPPED: a intencao persistida e STOPPED'), true)
      assert.equal(ctx.subprocess.calls.length, 1)
    } finally {
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })

  it('modo restrito ativo no state.json -> o boot NAO sobe o tunel (reinicar nao e o bypass)', () => {
    const limpar = comEstado('READY', true)
    let ctx: FakeContext | undefined
    try {
      ctx = install(configTunel(true)).ctx
      assert.equal(ctx.logger.has('info', 'boot em STOPPED: o modo restrito esta ativo no state.json'), true)
      assert.equal(ctx.subprocess.calls.length, 1)
    } finally {
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })

  it('intencao READY + autoStart ligado -> o boot despacha o start SEM nonce e o probe CORRE (CTL-034)', async () => {
    const limpar = comEstado('READY', false)
    let ctx: FakeContext | undefined
    try {
      ctx = install(configTunel(true)).ctx
      // Snapshot const para o closure: o TS perde o estreitamento de `let`
      // dentro de funcao anonima.
      const ativo = ctx
      assert.equal(
        ativo.logger.has('info', 'boot: intencao persistida e READY com autoStart ativo; a subir o tunel.'),
        true,
      )
      // A PROVA comportamental (a antiga so afirmava a linha de log e um
      // comentario a descrever um probe que nao corria): o start de boot —
      // SEM nonce, com requireConfirmation: true no default — chega ao
      // supervisor e o probe fail-closed CORRE contra a porta do duble,
      // reprova, e e o supervisor quem o grita. Se o controlador exigisse
      // nonce da origem boot (CTL-023), a intent seria recusada ANTES do
      // probe e esta linha nao existiria; se a chamada que honra o
      // desiredState fosse removida, o despacho nem aconteceria. As duas
      // mutacoes morrem neste teste.
      await esperarAte(() => ativo.logger.has('error', 'Probe fail-closed reprovou'))
      assert.equal(ctx.subprocess.calls.length, 1, 'o probe reprovado nao spawna: so o worker')
    } finally {
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })
})

describe('veto de danger-full-access', () => {
  it('curto-circuita a cascata sem invocar next()', async () => {
    const { ctx } = install()
    let nextCalled = false

    const result = await ctx
      .asContext()
      .waterfall('security/permission-elevate', '/permission danger-full-access', async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, false, 'o pedido de elevacao tem de ser vetado')
    assert.equal(nextCalled, false, 'next() NAO pode ser invocado num veto')
    assert.equal(ctx.logger.has('error', 'VETO de elevacao de permissao'), true)
  })

  it('deixa passar permissoes que nao constam de deniedPermissions', async () => {
    const { ctx } = install()
    let nextCalled = false

    const result = await ctx
      .asContext()
      .waterfall('security/permission-elevate', '/permission workspace-write', async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, true)
    assert.equal(nextCalled, true)
  })

  it('o veto continua a curto-circuitar a cascata para as grafias evasivas', async () => {
    const { ctx } = install()
    let nextCalled = false

    const result = await ctx
      .asContext()
      .waterfall('security/permission-elevate', '/permission danger%2Dfull%2Daccess', async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, false)
    assert.equal(nextCalled, false)
  })

  it('o veto desaparece quando o disposer do efeito corre (reversibilidade)', async () => {
    const { ctx } = install()
    const vetoDisposer = ctx.effects[EFFECT.veto]
    assert.equal(typeof vetoDisposer, 'function')

    vetoDisposer?.()

    let nextCalled = false
    const result = await ctx
      .asContext()
      .waterfall('security/permission-elevate', '/permission danger-full-access', async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, true)
    assert.equal(nextCalled, true, 'sem o ouvinte, a cascata chega ao next terminal')
  })
})
describe('W2 (revisao T5.5): o replay imediato do fan-out de estado e CONTRATO', () => {
  it('assinar entrega o estado corrente JA, depois cada difusao; desassinar e idempotente', () => {
    // O fan-out e o que a fiacao usa para `subscribe` da UI nativa: a
    // assinatura SEM difusao nenhuma ja recebeu o estado corrente — e o
    // que torna a rota de estado respondivel imediatamente apos o apply.
    let corrente: { seq: number; snapshot: TunnelSnapshot } = {
      seq: 0,
      snapshot: { state: 'STOPPED', attempts: 0 },
    }
    const log = createFakeLogger()('fanout')
    const fanout = criarFanoutDeEstado(() => corrente, log)
    const vistos: number[] = []
    const desassinar = fanout.assinar((b) => void vistos.push(b.seq))

    assert.deepEqual(vistos, [0], 'o replay imediato entregou o estado corrente sem difusao')

    corrente = { seq: 1, snapshot: { state: 'STARTING', attempts: 0 } }
    fanout.emitir()
    assert.deepEqual(vistos, [0, 1], 'cada difusao chega a seguir')

    desassinar()
    desassinar()
    corrente = { seq: 2, snapshot: { state: 'READY', attempts: 0 } }
    fanout.emitir()
    assert.deepEqual(vistos, [0, 1], 'desassinado nao recebe mais nada')
  })

  it('um observador que LANCA nao derruba o fan-out (best-effort registado)', () => {
    let corrente: { seq: number; snapshot: TunnelSnapshot } = {
      seq: 0,
      snapshot: { state: 'STOPPED', attempts: 0 },
    }
    const servico = createFakeLogger()
    const fanout = criarFanoutDeEstado(() => corrente, servico('fanout'))
    const ordem: string[] = []
    // O replay imediato de CADA assinatura ja chama o observador: a
    // sequencia tem os DOIS pares (replay de 'a' e 'b', depois a difusao).
    fanout.assinar(() => {
      ordem.push('a')
      throw new Error('observador avariado')
    })
    fanout.assinar(() => void ordem.push('b'))
    corrente = { seq: 1, snapshot: { state: 'STARTING', attempts: 0 } }
    fanout.emitir()
    assert.deepEqual(ordem, ['a', 'b', 'a', 'b'], 'o observador seguinte correu sempre (replay e difusao)')
    assert.equal(servico.has('warn', 'observador de estado falhou'), true)
  })
})
describe('8(b): o /emergencia NAO reinicia o worker — o supervisor e disposto', () => {
  it('o intent emergency mata o worker e o processo que morre nao volta a spawnar', async () => {
    // O pareamento persistido no state.json: o HOST revalida a identidade
    // (S6) antes de aceitar o intent de emergencia.
    const casa = join(tmpdir(), `dsh-guard-8b-${process.pid}`)
    const dir = join(casa, 'guarded-bot')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        desiredState: 'STOPPED',
        pairing: { ownerUserId: 123, ownerChatId: 456, pairedAt: 1_000 },
      }),
      { mode: 0o600 },
    )
    process.env.DSH_HOME = casa
    try {
      const { ctx } = install({
        exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false },
        tunnel: { mode: 'quick', ttlMinutes: 60 },
      })
      const filho = ctx.subprocess.lastChild()

      // O dono manda /emergencia: o intent atravessa o canal host <- worker.
      filho.stdout.write(
        JSON.stringify({ v: 1, type: 'intent', intent: 'emergency', requestId: 'emerg-1', from: 123, chat: 456 }) + '\n',
      )
      await flush()
      await flush()

      // O worker morre (bot.stop): o supervisor foi DISPOSTO pelo aposEmergencia
      // — a terminacao e tratada como intencional, SEM reinicio.
      filho.settle({ exitCode: 0, signal: null })
      await flush()
      await flush()

      assert.equal(
        ctx.subprocess.children.length,
        1,
        'nenhum segundo spawn: o emergency mata o worker e o supervisor NAO o reinicia (8b)',
      )

      // Desmonta os efeitos (o relatorio usa o agendador REAL — sem o disposer,
      // o timer de 30 min seguraria o event loop do processo de teste).
      for (const disposer of ctx.effects) disposer()
    } finally {
      delete process.env.DSH_HOME
      rmSync(casa, { recursive: true, force: true })
    }
  })
})
describe('T5.4 fiada (Frente 2): o toggle do tunel notifica o worker pelo canal notify', () => {
  it('o /emergencia em STOPPED (noop permitido) entrega o notify de "tunel desligado" ao worker', async () => {
    // A fiacao da Onda 6 liga o canal de notificacao do controlador ao IPC
    // host -> worker: todo toggle PERMITIDO notifica DEPOIS do append (T5.4).
    // Este teste prova a COSTURA na composicao: o texto composto pelo
    // controlador chega ao worker como mensagem `notify`.
    const casa = join(tmpdir(), `dsh-guard-f2-${process.pid}`)
    const dir = join(casa, 'guarded-bot')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        desiredState: 'STOPPED',
        pairing: { ownerUserId: 123, ownerChatId: 456, pairedAt: 1_000 },
      }),
      { mode: 0o600 },
    )
    process.env.DSH_HOME = casa
    try {
      const { ctx } = install({
        exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false },
        tunnel: { mode: 'quick', ttlMinutes: 60 },
      })
      const filho = ctx.subprocess.lastChild()

      // O dono manda /emergencia: o stop em STOPPED e um noop PERMITIDO e
      // o controlador notifica "Tunel desligado" (origem telegram:123).
      filho.stdout.write(
        JSON.stringify({ v: 1, type: 'intent', intent: 'emergency', requestId: 'emerg-f2', from: 123, chat: 456 }) + '\n',
      )
      await flush()
      await flush()

      const notificacoes = filho.stdinLines
        .map((linha) => JSON.parse(linha) as Record<string, unknown>)
        .filter((mensagem) => mensagem['type'] === 'notify')
      const toggle = notificacoes.find((n) => (n['texto'] as string).startsWith('alerta:tunel-desligado'))
      assert.ok(toggle !== undefined, 'o toggle permitido notificou o dono (T5.4 fiada na Onda 6)')
      assert.ok((toggle['texto'] as string).includes('origem: telegram:123'), 'a origem viaja no texto')

      for (const disposer of ctx.effects) disposer()
    } finally {
      delete process.env.DSH_HOME
      rmSync(casa, { recursive: true, force: true })
    }
  })
})
describe('8(c): no boot com dono persistido, o HOST envia pairing.owner ao worker', () => {
  it('state.json com pairing -> a primeira mensagem do canal e o dono reaprendido', async () => {
    const casa = join(tmpdir(), `dsh-guard-8c-${process.pid}`)
    const dir = join(casa, 'guarded-bot')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o700)
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        desiredState: 'STOPPED',
        pairing: { ownerUserId: 42, ownerChatId: -1001234567890, pairedAt: 2_000 },
      }),
      { mode: 0o600 },
    )
    process.env.DSH_HOME = casa
    try {
      const { ctx } = install({
        exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: false },
        tunnel: { mode: 'quick', ttlMinutes: 60 },
      })
      const filho = ctx.subprocess.lastChild()
      await flush()

      const dono = filho.stdinLines.map((linha) => JSON.parse(linha) as Record<string, unknown>).find(
        (mensagem) => mensagem['type'] === 'pairing.owner',
      )
      assert.ok(dono !== undefined, 'o pairing.owner saiu no boot')
      assert.equal(dono['from'], 42)
      assert.equal(dono['chat'], -1001234567890, 'o chat de GRUPO viaja como eixo (8d)')
      assert.equal(dono['pairedAt'], 2_000)

      for (const disposer of ctx.effects) disposer()
    } finally {
      delete process.env.DSH_HOME
      rmSync(casa, { recursive: true, force: true })
    }
  })
})

/* ========================================================================= */
/* Onda 5, lacunas de cobertura da raiz: ouvinte auth-check, reemitirEstado, */
/* pareado com leitura a falhar, persistencia da intencao a falhar, orfao    */
/* derrubado no boot em loopback, aviso de trustEdgeHeaders                  */
/* ========================================================================= */

describe('ouvinte http/auth-check: veto estrutural de quem nao apresenta credencial', () => {
  it('sem Authorization e sem cookie de sessao: false, sem next()', async () => {
    const { ctx } = install()
    let nextCalled = false

    const semCredencial = { headers: {} } as unknown as IncomingMessage
    const result = await ctx
      .asContext()
      .waterfall('http/auth-check', semCredencial, async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, false, 'sem credencial nenhuma a cascata curto-circuita')
    assert.equal(nextCalled, false)
  })

  it('com Authorization: delega em next()', async () => {
    const { ctx } = install()
    let nextCalled = false

    const comAutorizacao = { headers: { authorization: 'Basic abc' } } as unknown as IncomingMessage
    const result = await ctx
      .asContext()
      .waterfall('http/auth-check', comAutorizacao, async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, true)
    assert.equal(nextCalled, true)
  })

  it('com cookie de sessao valido: delega em next() (a sessao e credencial)', async () => {
    const { ctx } = install()
    let nextCalled = false
    // 22-256 chars de base64url: o formato que readSessionCookie aceita.
    const cookie = 'A'.repeat(32)

    const comCookie = { headers: { cookie: '__Host-dsh_sid=' + cookie } } as unknown as IncomingMessage
    const result = await ctx
      .asContext()
      .waterfall('http/auth-check', comCookie, async () => {
        nextCalled = true
        return true
      })

    assert.equal(result, true)
    assert.equal(nextCalled, true)
  })
})

describe('aviso de arranque: trustEdgeHeaders=true com borda (modo tunnel)', () => {
  it('a decisao mais perigosa do ficheiro e dita em voz alta', () => {
    const { ctx } = install({
      exposure: { mode: 'tunnel', autoStart: false, trustEdgeHeaders: true },
      tunnel: { mode: 'quick', ttlMinutes: 60 },
    })
    assert.equal(ctx.logger.has('warn', 'config.exposure.trustEdgeHeaders=true'), true)
    for (const disposer of ctx.effects) disposer()
  })
})

/* ========================================================================= */
/* Boot e canal: reemitirEstado nos dois ramos (CTL-027)                     */
/* ========================================================================= */

function comEstadoComCaminho(
  desejado: 'READY' | 'STOPPED',
  restrito: boolean,
  pairing?: { ownerUserId: number; ownerChatId: number; pairedAt: number },
  tunnelRecord?: { pid: number; startedAt: number; mode: 'quick' | 'named' },
): { dir: string; limpar: () => void } {
  const casa = join(tmpdir(), 'dsh-guard-falha-' + process.pid + '-' + Math.random().toString(36).slice(2))
  const dir = join(casa, 'guarded-bot')
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o700)
  const estado: Record<string, unknown> = { version: 1, desiredState: desejado, secretDigest: 'ab'.repeat(32) }
  if (restrito) estado['restricted'] = { since: 1, reason: 'brute-force-ceiling' }
  if (pairing !== undefined) estado['pairing'] = pairing
  if (tunnelRecord !== undefined) estado['tunnel'] = tunnelRecord
  writeFileSync(join(dir, 'state.json'), JSON.stringify(estado), { mode: 0o600 })
  process.env.DSH_HOME = casa
  return {
    dir,
    limpar: (): void => {
      delete process.env.DSH_HOME
      rmSync(casa, { recursive: true, force: true })
    },
  }
}

function configTunelCom(autoStart: boolean): Partial<Config> {
  return {
    exposure: { mode: 'tunnel', autoStart, trustEdgeHeaders: false },
    tunnel: { mode: 'quick', ttlMinutes: 60 },
  }
}

describe('reemitirEstado: o estado COMPLETO ao worker (CTL-027)', () => {
  it('sem controlador (loopback) e INERTE: nao ha estado a reemitir, nenhum crash', async () => {
    const { limpar } = comEstadoComCaminho('STOPPED', false, { ownerUserId: 42, ownerChatId: -1001234567890, pairedAt: 2_000 })
    let ctx: FakeContext | undefined
    try {
      ctx = install().ctx
      const filho = ctx.subprocess.lastChild()
      filho.stdout.write(
        JSON.stringify({ v: 1, type: 'intent', intent: 'tunnel.status', requestId: 'st-loopback', from: 42, chat: -1001234567890 }) + '\n',
      )
      await flush()
      const linhas = filho.stdinLines.map((linha) => JSON.parse(linha) as Record<string, unknown>)
      const ack = linhas.find((mensagem) => mensagem['type'] === 'ack')
      assert.equal(ack?.['result'], 'noop')
      assert.equal(ack?.['state'], 'STOPPED')
      // Sem controlador nao ha estado para difundir — nenhuma mensagem 'state'.
      assert.equal(linhas.some((mensagem) => mensagem['type'] === 'state'), false)
    } finally {
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })

  it('com controlador (tunnel): reenvia o estado corrente com seq pelo canal', async () => {
    const { limpar } = comEstadoComCaminho('STOPPED', false, { ownerUserId: 42, ownerChatId: -1001234567890, pairedAt: 2_000 })
    let ctx: FakeContext | undefined
    try {
      ctx = install(configTunelCom(false)).ctx
      const filho = ctx.subprocess.lastChild()
      filho.stdout.write(
        JSON.stringify({ v: 1, type: 'intent', intent: 'tunnel.status', requestId: 'st-tunel', from: 42, chat: -1001234567890 }) + '\n',
      )
      await flush()
      const linhas = filho.stdinLines.map((linha) => JSON.parse(linha) as Record<string, unknown>)
      const estado = linhas.find((mensagem) => mensagem['type'] === 'state')
      assert.ok(estado !== undefined, 'o estado COMPLETO saiu pelo canal')
      assert.equal(estado['state'], 'STOPPED')
      assert.equal(typeof estado['seq'], 'number')
    } finally {
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })
})

describe('S6: o pareamento ilegivel fecha a intencao (fail-closed, CTL-029)', () => {
  it('state.json ilegivel no momento da decisao: NOT_PAIRED e o erro vai ao log', async () => {
    const { dir, limpar } = comEstadoComCaminho('STOPPED', false, { ownerUserId: 42, ownerChatId: -1001234567890, pairedAt: 2_000 })
    let ctx: FakeContext | undefined
    try {
      ctx = install(configTunelCom(false)).ctx
      // A pilha de autenticacao e LAZY: nasce no primeiro pedido que decide.
      // Tornar o ficheiro ilegivel ANTES desse pedido simula o disco a falhar
      // na hora H — a leitura lanca e a intencao fecha.
      chmodSync(join(dir, 'state.json'), 0o000)
      const filho = ctx.subprocess.lastChild()
      filho.stdout.write(
        JSON.stringify({ v: 1, type: 'intent', intent: 'tunnel.down', requestId: 'par-ilegivel', from: 42, chat: -1001234567890 }) + '\n',
      )
      await flush()
      const linhas = filho.stdinLines.map((linha) => JSON.parse(linha) as Record<string, unknown>)
      const erro = linhas.find((mensagem) => mensagem['type'] === 'error')
      assert.equal(erro?.['code'], 'NOT_PAIRED')
      assert.equal(erro?.['requestId'], 'par-ilegivel')
      assert.equal(ctx.logger.has('error', 'nao foi possivel ler o pareamento persistido'), true)
    } finally {
      chmodSync(join(dir, 'state.json'), 0o600)
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })
})

describe('CTL-009 fail-closed: o segredo ilegivel no instante do start fecha a intencao', () => {
  it('a pilha de autenticacao nasceu legivel, o ficheiro fica ilegivel, e o start de boot e recusado', async () => {
    const { dir, limpar } = comEstadoComCaminho('READY', false)
    let ctx: FakeContext | undefined
    try {
      ctx = install(configTunelCom(true)).ctx
      // A avaliacao do start de boot corre em duas camadas: a primeira (na
      // chegada, dentro do apply) le a pilha que acaba de nascer — legivel; a
      // segunda (na fila, em microtask) re-avalia com a pilha MEMOIZADA. Entre
      // as duas, o ficheiro fica ilegivel: o segredo nao se le e a intencao
      // fecha (fail-closed) — o spawn nunca acontece.
      chmodSync(join(dir, 'state.json'), 0o000)
      await esperarAte(() => ctx!.logger.has('error', 'segredo ilegivel; start recusado (fail-closed)'))
      assert.equal(ctx.subprocess.calls.length, 1, 'so o worker: o start de boot nao spawna')
      assert.equal(ctx.logger.has('info', 'boot: intencao persistida e READY com autoStart ativo; a subir o tunel.'), true)
    } finally {
      chmodSync(join(dir, 'state.json'), 0o600)
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })
})

describe('boot em loopback: um orfao VIVO e derrubado antes de qualquer inicializacao (02-SEGURANCA 9)', () => {
  it('outcome killed: sessoes revogadas, EVENTO_ORFAO no audit, aviso ao dono, processo morto', async () => {
    // Um filho REAL cujo argv[0] (via `argv0` do spawn, deterministico no
    // /proc/<pid>/cmdline — sem corrida com o exec da shell) e 'cloudflared':
    // a varredura reconhece-o como o nosso tunel e derruba a arvore. Sem
    // /proc (macOS), a identificacao e null e a politica matou na mesma — a
    // URL publica pesa mais que a ignorancia. `detached: true` faz o filho
    // lider do seu proprio GRUPO: o tree-kill alveja `-pid`, e sem grupo
    // proprio o `kill(-pid, SIGKILL)` devolveria ESRCH e o orfao sobreviveria.
    const filhoOrfao = spawn('/bin/sh', ['-c', 'sleep 60'], { argv0: 'cloudflared', detached: true })
    filhoOrfao.unref()
    const pid = filhoOrfao.pid
    assert.ok(pid !== undefined)
    const { dir, limpar } = comEstadoComCaminho('STOPPED', false, undefined, { pid, startedAt: Date.now(), mode: 'quick' })
    let ctx: FakeContext | undefined
    try {
      ctx = install().ctx
      assert.equal(ctx.logger.has('warn', 'tunel orfao de uma execucao anterior encontrado VIVO'), true)

      // O orfao morreu (SIGTERM+SIGKILL ao grupo/arvore).
      const deadline = Date.now() + 2000
      let morto = false
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          morto = true
          break
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
      assert.equal(morto, true, 'o cloudflared orfao foi derrubado no boot')

      // A auditoria do orfao foi escrita (EVENTO_ORFAO, resultado permitido).
      const auditText = readFileSync(join(dir, 'audit.log'), 'utf8')
      assert.ok(auditText.includes('tunel_orfao_derrubado'), 'o evento do orfao entrou no audit')
    } finally {
      try {
        process.kill(pid, 0)
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        // Ja morto: o objetivo ja esta cumprido (o mesmo rito do tree-kill).
        void error
      }
      if (ctx !== undefined) for (const disposer of ctx.effects) disposer()
      limpar()
    }
  })
})
