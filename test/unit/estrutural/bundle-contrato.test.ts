/**
 * CONTRATO DO BUNDLE (FOCO 2) + CANARIO CONTRACT-008 INTACTO (tarefa C).
 *
 * Duas promessas que vivem em ficheiros de manifesto e que ninguem verifica em
 * runtime — se se partirem, o sintoma aparece instalacoes depois, na maquina
 * de outro utilizador:
 *
 *  1. O CONTRATO DO BUNDLE: `dsh.bundle.patch` aponta para `cordis.patch.yml`
 *     (sem ele `dsh plugin add` NAO ATIVA NADA — medido contra o produto, ver
 *     o `//dsh` do package.json), o tarball leva o essencial (D13), os
 *     `exports`/`bin` apontam para os artefactos EMITIDOS, e a unica
 *     dependencia de runtime continua a ser o grammY (so o adaptador o carrega).
 *
 *  2. AS REGEXES DO CANARIO (CONTRACT-008) INTACTAS: a faixa
 *     `@deepseek-ai/dsh 0.1.0-rc.7 .. 0.1.1-rc.1` foi REVISTA em 2026-09-24 e
 *     MANTIDA (0.1.5-rc.x e incompativel — `SubprocessHandle.pid` desapareceu
 *     desde 0.1.5-rc.1); o canario fica VERMELHO POR DECISAO. A regra e dura:
 *     «NAO alargues a regex para o esverdear». Este teste pina as regexes do
 *     canario BYTE A BYTE, prova que continuam a REJEITAR as linhas
 *     incompativeis medidas, e que a decisao esta documentada em
 *     `docs/plano/06-REPO-E-CI.md` §11.2. Enfraquecer o canario reprova aqui.
 *
 * Sem a palavra do provedor removido em lado nenhum (o golden master varre
 * `test/**` tambem — ver `golden-master.test.ts`).
 */

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const RAIZ = fileURLToPath(new URL('../../../', import.meta.url))

interface Manifesto {
  readonly files?: readonly string[] | undefined
  readonly bin?: Readonly<Record<string, string>> | undefined
  readonly exports?: Readonly<Record<string, unknown>> | undefined
  readonly dependencies?: Readonly<Record<string, string>> | undefined
  readonly devDependencies?: Readonly<Record<string, string>> | undefined
  readonly peerDependencies?: Readonly<Record<string, string>> | undefined
  readonly dsh?: { readonly bundle?: { readonly patch?: string | undefined } | undefined } | undefined
}

const PKG = JSON.parse(readFileSync(`${RAIZ}package.json`, 'utf8')) as Manifesto
const FONTE_CANARIO = readFileSync(`${RAIZ}test/contract/dsh-types.test.ts`, 'utf8')
const FONTE_FETCH = readFileSync(`${RAIZ}scripts/fetch-dsh-types.mjs`, 'utf8')
const DECISAO = readFileSync(`${RAIZ}docs/plano/06-REPO-E-CI.md`, 'utf8')

/* ========================================================================== */
/* 1. O CONTRATO DO BUNDLE                                                     */
/* ========================================================================== */

describe('contrato do bundle — o pacote declara e leva o que o produto precisa', () => {
  it('dsh.bundle.patch aponta para o patch do bundle, e o ficheiro existe', () => {
    // Sem esta chave o `dsh plugin add` nao ativa camada nenhuma (a ativacao
    // do produto decide por `dsh?.bundle?.patch !== void 0`).
    assert.equal(PKG.dsh?.bundle?.patch, './cordis.patch.yml')
    assert.ok(statSync(`${RAIZ}cordis.patch.yml`).size > 0, 'cordis.patch.yml vazio/ausente')
  })

  it('o tarball leva o essencial (files, D13): dist, lib, patch, README, LICENSE, CHANGELOG', () => {
    assert.deepEqual(PKG.files, [
      'dist',
      'lib',
      'logo.png',
      'cordis.patch.yml',
      'README.md',
      'LICENSE',
      'CHANGELOG.md',
    ])
  })

  it('exports e bin apontam para os artefactos EMITIDOS (nunca para fonte .ts)', () => {
    assert.deepEqual(PKG.exports, {
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './client': { types: './lib/client.d.ts', default: './lib/client.js' },
      './package.json': './package.json',
    })
    assert.deepEqual(PKG.bin, { 'dsh-guard-setup': './dist/bin/dsh-guard-setup.js' })
  })

  it('a unica dependencia de runtime e o grammY, a pino EXATO (sem intervalos)', () => {
    // O grammY e carregado SO pelo adaptador telegram; qualquer dependencia
    // nova aqui mudaria o contrato do pacote.
    assert.deepEqual(Object.keys(PKG.dependencies ?? {}).toSorted(), ['grammy'])
    assert.match(PKG.dependencies?.['grammy'] ?? '', /^\d+\.\d+\.\d+$/u, 'o pino do grammY deixou de ser exato')
  })
})

/* ========================================================================== */
/* 2. CONTRACT-008 — as regexes do canario INTACTAS (vermelho por DECISAO)     */
/* ========================================================================== */

/* COPIAS byte a byte das regexes do canario (`test/contract/dsh-types.test.ts`).
 * Os casos abaixo asseguram que a FONTE do canario contem EXATAMENTE estas —
 * e depois exercitam o comportamento que o canario promete. */
const SUPPORTED_DSH = /^0\.1\.(?:0-rc\.(?:[7-9]|[1-9][0-9]+)|1-rc\.[0-9]+)/
const ULTIMA_TAG = /^0\.1\.(0|1)-rc\./

/**
 * A faixa em ANCORA CHEIA para PINS (D18: «pinos EXATOS»): a versao declarada
 * tem de ser UMA versao unica dentro da faixa. Um `SUPPORTED_DSH.test()` sem
 * ancora final aceitava ranges tipo `'0.1.0-rc.7 || 0.1.5-rc.3'` como "dentro
 * da faixa" (revisao LOW-2) — aqui um range, intervalo (`^x`) ou multi-versao
 * reprova.
 */
const PINO_EXATO = new RegExp(`^(?:${SUPPORTED_DSH.source})$`, 'u')

describe('CONTRACT-008: canario da faixa @deepseek-ai/dsh — regexes intactas, sem esverdear', () => {
  it('as regexes do canario estao no fonte, byte a byte (alargar = reprovar aqui)', () => {
    assert.ok(
      FONTE_CANARIO.includes(`const SUPPORTED_DSH = /${SUPPORTED_DSH.source}/`),
      'a regex SUPPORTED_DSH do canario mudou — ver 06-REPO-E-CI.md §11.2 ANTES de a tocar',
    )
    assert.ok(
      FONTE_CANARIO.includes(`/${ULTIMA_TAG.source}/`),
      'a regex do `latest` do canario mudou — ver 06-REPO-E-CI.md §11.2 ANTES de a tocar',
    )
    assert.ok(
      FONTE_FETCH.includes("const SUPPORTED_RANGE = '@deepseek-ai/dsh 0.1.0-rc.7 .. 0.1.1-rc.1'"),
      'a faixa documentada em scripts/fetch-dsh-types.mjs mudou em conjunto?',
    )
  })

  it('a faixa continua a ACEITAR N-1/N com piso rc.7 e a REJEITAR as linhas incompativeis medidas', () => {
    for (const aceite of ['0.1.0-rc.7', '0.1.0-rc.9', '0.1.1-rc.1', '0.1.1-rc.2']) {
      assert.ok(SUPPORTED_DSH.test(aceite), `a faixa devia ACEITAR ${aceite}`)
    }
    // 0.1.2-rc.1 perde lib/types/invariant.d.ts; 0.1.5-rc.x e 0.1.7-rc.1 perdem
    // tambem SubprocessHandle.pid (todas MEDIDAS). 0.1.0-rc.1 e abaixo do piso.
    for (const recusado of ['0.1.0-rc.1', '0.1.0-rc.6', '0.1.2-rc.1', '0.1.5-rc.1', '0.1.5-rc.3', '0.1.7-rc.1', '0.2.0-rc.1']) {
      assert.ok(!SUPPORTED_DSH.test(recusado), `a faixa NAO devia aceitar ${recusado}`)
    }
  })

  // DISPENSA FORMAL (respondida na revisao): o VERMELHO do canario em
  // `pnpm test:contract` e a UNICA dispensa formal da regra "nunca vermelho
  // commitado" nesta execucao. Decisao documentada: commit e8ba0f8 +
  // docs/plano/06-REPO-E-CI.md §11.2 + reclassificacao do gate (`test:contract`
  // fica FORA do gate por-merge). E DELIBERADO e UNICO: qualquer outro vermelho
  // commitado continua proibido — e alargar a regex para esverdear nao e cumprir
  // a promessa, e apagar o canario.
  it('o canario do `latest` continua a reprovar a linha incompativel (vermelho por decisao)', () => {
    assert.ok(ULTIMA_TAG.test('0.1.0-rc.7'))
    assert.ok(ULTIMA_TAG.test('0.1.1-rc.1'))
    assert.ok(!ULTIMA_TAG.test('0.1.5-rc.3'), 'o canario foi alargado para esverdear')
    assert.ok(!ULTIMA_TAG.test('0.1.7-rc.1'))
  })

  it('os PINOS continuam dentro da faixa (D18) e a decisao esta documentada (§11.2)', () => {
    const dev = PKG.devDependencies ?? {}
    for (const pacote of [
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-host-frontend-static',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-subprocess',
    ]) {
      assert.match(
        dev[pacote] ?? '',
        PINO_EXATO,
        `${pacote} tem de estar a pino EXATO (uma versao unica dentro da faixa, D18): ${String(dev[pacote])}`,
      )
    }
    assert.equal(dev['@deepseek-ai/cordis'], '4.0.1')
    assert.equal(PKG.peerDependencies?.['@deepseek-ai/cordis'], '>=4.0.0 <5')

    // «vermelho por decisao DOCUMENTADA»: o registo da decisao tem de existir.
    assert.ok(DECISAO.includes('11.2'), 'falta a seccao 11.2 em docs/plano/06-REPO-E-CI.md')
    assert.ok(DECISAO.includes('SubprocessHandle.pid'), 'a decisao nao cita a incompatibilidade medida')
    assert.ok(DECISAO.includes('0.1.5-rc'), 'a decisao nao nomeia a linha recusada')
  })
})
