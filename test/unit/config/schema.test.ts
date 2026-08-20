/**
 * `src/config/schema.ts` -- resolucao do `worker/` empacotado.
 *
 * O `worker/` esta FORA da arvore de fonte (`<repo>/worker/`) e DENTRO da arvore
 * emitida (`<pkg>/dist/worker/`). Uma so expressao relativa NAO serve os dois, e
 * foi exatamente essa suposicao que partiu toda a instalacao por npm assim que o
 * `worker.cwd` absoluto saiu do manifesto.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  PACKAGED_WORKER_DIR,
  PACKAGED_WORKER_ENTRYPOINT,
  resolvePackagedWorkerDir,
  resolveWorkerCwd,
  resolveWorkerEntrypoint,
} from '../../../src/config/schema.ts'
import { makeConfig } from '../../support/fixtures.ts'

describe('resolvePackagedWorkerDir', () => {
  it('LAYOUT DE FONTE (dev): sobe DOIS niveis, para o irmao da arvore de fonte', () => {
    assert.equal(
      resolvePackagedWorkerDir('file:///repo/src/config/schema.ts'),
      fileURLToPath('file:///repo/worker/'),
    )
  })

  it('LAYOUT EMITIDO (tarball): sobe UM nivel, para dentro de dist/', () => {
    // `<pkg>/dist/config/schema.js` -> `<pkg>/dist/worker/`. Com a expressao
    // antiga (`../../worker/`) dava `<pkg>/worker/`, que nao existe no tarball.
    assert.equal(
      resolvePackagedWorkerDir('file:///pkg/dist/config/schema.js'),
      fileURLToPath('file:///pkg/dist/worker/'),
    )
  })

  it('as duas expressoes sao DIFERENTES -- nenhuma serve os dois layouts', () => {
    // Anti-regressao do erro original: o comentario afirmava que "os dois
    // caminhos sobem exatamente dois niveis, logo a mesma expressao serve os
    // dois". Se alguem voltar a usar uma expressao unica, um destes dois testes
    // falha -- e este diz porque.
    const fonte = resolvePackagedWorkerDir('file:///x/src/config/schema.ts')
    const emitido = resolvePackagedWorkerDir('file:///x/dist/config/schema.js')

    assert.notEqual(fonte, emitido)
    assert.equal(emitido.includes(`${'dist'}`), true, 'o layout emitido vive DENTRO de dist/')
    assert.equal(fonte.includes(`${'src'}`), false, 'o layout de fonte vive FORA de src/')
  })

  it('reconhece as tres extensoes de modulo emitido', () => {
    for (const ficheiro of ['schema.js', 'schema.mjs', 'schema.cjs']) {
      assert.equal(
        resolvePackagedWorkerDir(`file:///pkg/dist/config/${ficheiro}`),
        fileURLToPath('file:///pkg/dist/worker/'),
        `'${ficheiro}' e arvore emitida`,
      )
    }
  })

  it('NAO sonda o sistema de ficheiros: decide pela extensao, nao pelo que existe', () => {
    // Um caminho que nao existe em lado nenhum continua a resolver de forma
    // deterministica. Escolher "o que existir" esconderia um layout errado em
    // vez de o expor no arranque (Q-3).
    const inventado = resolvePackagedWorkerDir('file:///nao/existe/dist/config/schema.js')
    assert.equal(inventado, fileURLToPath('file:///nao/existe/dist/worker/'))
    assert.equal(existsSync(inventado), false)
  })
})

describe('PACKAGED_WORKER_DIR desta instalacao', () => {
  it('aponta para um diretorio que EXISTE (e o que assertValidConfig exige)', () => {
    assert.equal(existsSync(PACKAGED_WORKER_DIR), true, PACKAGED_WORKER_DIR)
    assert.equal(statSync(PACKAGED_WORKER_DIR).isDirectory(), true)
  })

  it('e o default de worker.cwd quando o manifesto nao o declara', () => {
    const semCwd = makeConfig()
    delete semCwd.worker.cwd

    assert.equal(resolveWorkerCwd(semCwd), PACKAGED_WORKER_DIR)
  })

  it('nunca vem do process.cwd() -- o cwd do host e o workspace do utilizador', () => {
    assert.notEqual(PACKAGED_WORKER_DIR, process.cwd())
    assert.equal(PACKAGED_WORKER_DIR.startsWith(process.cwd()), true, 'mas esta dentro do pacote')
  })
})

describe('resolveWorkerEntrypoint', () => {
  it('LAYOUT DE FONTE (dev): worker/telegram-bot.ts, irmao da arvore de fonte', () => {
    assert.equal(
      resolveWorkerEntrypoint('file:///repo/src/config/schema.ts'),
      fileURLToPath('file:///repo/worker/telegram-bot.ts'),
    )
  })

  it('LAYOUT EMITIDO (tarball): dist/worker/telegram-bot.js, dentro de dist/', () => {
    // E a frase literal das tres decisoes canonicas: "o argv do spawn resolve
    // dist/worker/telegram-bot.js relativo a import.meta.url, nunca por cwd".
    assert.equal(
      resolveWorkerEntrypoint('file:///pkg/dist/config/schema.js'),
      fileURLToPath('file:///pkg/dist/worker/telegram-bot.js'),
    )
  })

  it('a EXTENSAO acompanha o layout, tal como a profundidade do diretorio', () => {
    assert.equal(resolveWorkerEntrypoint('file:///x/src/config/schema.ts').endsWith('.ts'), true)
    assert.equal(resolveWorkerEntrypoint('file:///x/dist/config/schema.js').endsWith('.js'), true)
  })

  it('vive sempre DENTRO do diretorio que resolvePackagedWorkerDir devolve', () => {
    for (const url of ['file:///x/src/config/schema.ts', 'file:///x/dist/config/schema.js']) {
      assert.equal(
        resolveWorkerEntrypoint(url).startsWith(resolvePackagedWorkerDir(url)),
        true,
        url,
      )
    }
  })

  it('o entrypoint desta instalacao EXISTE e e ficheiro', () => {
    assert.equal(existsSync(PACKAGED_WORKER_ENTRYPOINT), true, PACKAGED_WORKER_ENTRYPOINT)
    assert.equal(statSync(PACKAGED_WORKER_ENTRYPOINT).isFile(), true)
  })

  it('e absoluto e nao vem do process.cwd()', () => {
    assert.equal(PACKAGED_WORKER_ENTRYPOINT.startsWith(PACKAGED_WORKER_DIR), true)
    assert.notEqual(PACKAGED_WORKER_ENTRYPOINT, process.cwd())
  })
})

/* ========================================================================== */
/* Os eixos da Onda 3 -- composicao dos tipos congelados                      */
/* ========================================================================== */

import {
  CONFIRMATION_REQUIRED_CONTROL,
  LOOPBACK_ONLY_EXPOSURE,
  mayTrustEdgeClientIp,
  resolveControl,
  resolveExposure,
  shouldAutoStartTunnel,
} from '../../../src/config/schema.ts'

describe('resolveExposure -- a ausencia le-se na direccao FECHADA', () => {
  it('sem `exposure`, nada pode subir e nenhum cabecalho e acreditado', () => {
    assert.deepEqual(resolveExposure(makeConfig()), LOOPBACK_ONLY_EXPOSURE)
    assert.deepEqual(LOOPBACK_ONLY_EXPOSURE, {
      mode: 'loopback',
      autoStart: false,
      trustEdgeHeaders: false,
    })
  })

  it('nenhum valor por omissao pode abrir mais do que um valor declarado', () => {
    // A propriedade que interessa: o resolvido da ausencia e um MINIMO.
    const resolvido = resolveExposure(makeConfig())
    assert.equal(resolvido.mode, 'loopback')
    assert.equal(resolvido.autoStart, false)
    assert.equal(resolvido.trustEdgeHeaders, false)
  })

  it('respeita o eixo declarado', () => {
    const exposure = { mode: 'tunnel', autoStart: true, trustEdgeHeaders: true } as const
    assert.deepEqual(resolveExposure(makeConfig({ exposure })), exposure)
  })
})

describe('resolveControl', () => {
  it('sem `control`, a confirmacao de duas etapas fica LIGADA', () => {
    assert.deepEqual(resolveControl(makeConfig()), CONFIRMATION_REQUIRED_CONTROL)
    assert.equal(CONFIRMATION_REQUIRED_CONTROL.requireConfirmation, true)
  })
})

describe('shouldAutoStartTunnel -- o modo restrito e o veto do arranque', () => {
  const tunelAutomatico = {
    exposure: { mode: 'tunnel', autoStart: true, trustEdgeHeaders: false } as const,
    tunnel: { mode: 'quick', ttlMinutes: 60 } as const,
  }

  it('sobe so com modo tunel E autoStart', () => {
    assert.equal(shouldAutoStartTunnel(makeConfig(tunelAutomatico), false), true)
    assert.equal(
      shouldAutoStartTunnel(
        makeConfig({ ...tunelAutomatico, exposure: { ...tunelAutomatico.exposure, autoStart: false } }),
        false,
      ),
      false,
    )
    assert.equal(shouldAutoStartTunnel(makeConfig(), false), false, 'sem `exposure` nao sobe nada')
  })

  it('>>> COM MODO RESTRITO ATIVO, o boot NAO sobe o tunel <<<', () => {
    // Reiniciar o DSH nao pode ser o bypass do modo restrito: se fosse, o
    // controlo que o teto NIST aciona duraria ate ao proximo Ctrl-C.
    assert.equal(shouldAutoStartTunnel(makeConfig(tunelAutomatico), true), false)
  })
})

describe('mayTrustEdgeClientIp -- a garantia e da BORDA, nao do host', () => {
  const comChave = { mode: 'tunnel', autoStart: false, trustEdgeHeaders: true } as const

  it('exige as tres condicoes: a chave, o modo tunel, e ter chegado pela borda', () => {
    assert.equal(mayTrustEdgeClientIp(comChave, true), true)
    assert.equal(mayTrustEdgeClientIp(comChave, false), false, 'ligacao local direta nao passou pela borda')
    assert.equal(
      mayTrustEdgeClientIp({ ...comChave, mode: 'loopback' }, true),
      false,
      'sem borda a frente o cabecalho e escrito por um processo local',
    )
    assert.equal(mayTrustEdgeClientIp({ ...comChave, trustEdgeHeaders: false }, true), false)
    assert.equal(mayTrustEdgeClientIp(LOOPBACK_ONLY_EXPOSURE, true), false)
  })
})

describe('o manifesto de BUNDLE entrega os eixos como LITERAIS', () => {
  const manifesto = readFileSync(
    fileURLToPath(new URL('../../../cordis.patch.yml', import.meta.url)),
    'utf8',
  )

  /** As linhas de `config:`, sem os comentarios. */
  const linhas = manifesto
    .split('\n')
    .map((linha) => linha.replace(/#.*$/u, '').trimEnd())
    .filter((linha) => linha.trim().length > 0)

  it('>>> `ttlMinutes: 60` esta NO MANIFESTO, que e onde o default vive <<<', () => {
    // E a outra metade de TUN-019: o codigo recusa a ausencia, e o valor de
    // referencia e entregue aqui, a vista e editavel -- logo nao e silencioso.
    assert.equal(
      linhas.some((linha) => /^\s+ttlMinutes:\s*60$/u.test(linha)),
      true,
      'sem esta linha o plugin recusa arrancar, e com razao',
    )
  })

  it('nenhum eixo novo usa `!!js` -- uma expressao que lance quebra o boot de todos', () => {
    // REGRA DE OURO do cabecalho do ficheiro: este patch e aplicado
    // automaticamente a quem instala o pacote. Uma expressao que lance nao
    // produz "configuracao invalida", produz um `dsh` que NAO ARRANCA.
    const chavesNovas = [
      'exposure:',
      'mode:',
      'autoStart:',
      'trustEdgeHeaders:',
      'tunnel:',
      'ttlMinutes:',
      'control:',
      'requireConfirmation:',
    ]
    for (const linha of linhas) {
      if (!chavesNovas.some((chave) => linha.trim().startsWith(chave))) continue
      assert.equal(linha.includes('!!js'), false, `expressao proibida num eixo da Onda 3: ${linha}`)
    }
  })

  it('os defaults entregues sao os SEGUROS', () => {
    for (const esperado of [
      /^\s+mode:\s*'loopback'$/u,
      /^\s+autoStart:\s*false$/u,
      /^\s+trustEdgeHeaders:\s*false$/u,
      /^\s+mode:\s*'quick'$/u,
      /^\s+requireConfirmation:\s*true$/u,
    ]) {
      assert.equal(
        linhas.some((linha) => esperado.test(linha)),
        true,
        `o manifesto nao entrega ${esperado.source}`,
      )
    }
  })
})
