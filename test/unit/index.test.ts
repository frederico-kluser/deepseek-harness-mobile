/**
 * `src/index.ts` -- a RAIZ DE COMPOSICAO: manifesto, avisos de arranque e a
 * fiacao dos quatro efeitos.
 *
 * Aqui nao se testa regra nenhuma: cada regra tem o seu ficheiro sob
 * `test/unit/<caminho do fonte>/`. O que se prova e a COMPOSICAO.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PACKAGED_WORKER_ENTRYPOINT } from '../../src/config/schema.ts'
import { apply, inject, name } from '../../src/index.ts'
import { FakeContext } from '../support/ctx-double.ts'
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
  it('regista quatro efeitos, etiquetados, e todos devolvem disposers SINCRONOS', () => {
    const { ctx } = install()

    assert.equal(ctx.effects.length, 4, 'veto + auth-check + barreira + worker')
    assert.deepEqual(ctx.effectLabels, [
      'dsh-guard.veto-de-permissao',
      'dsh-guard.auth-check',
      'dsh-guard.barreira',
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

  it('a ordem dos efeitos poe o worker DEPOIS da barreira (LIFO ao descarregar)', () => {
    // Os disposers correm em ordem inversa: o worker morre primeiro, e so depois
    // a barreira e levantada. Ao contrario, haveria uma janela em que o plano de
    // controlo responde sem credencial com o worker ainda vivo.
    assert.equal(EFFECT.barreira < EFFECT.worker, true)
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
