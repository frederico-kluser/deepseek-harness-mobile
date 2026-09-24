/**
 * GUARDIAO ESTRUTURAL PERMANENTE — UM SO PROVEDOR, coerente em TODAS as
 * copias do contrato (onda 1, FOCO 1b/1c + FOCO 2 «paridade tokenVar»).
 *
 * A onda 1 removeu o segundo provedor e hoje o repo vive a um provedor so
 * (`telegram`) com o mecanismo multi-provedor INTACTO e fail-closed. O risco
 * concreto daqui em diante nao e o regresso do codigo apagado (isso e o golden
 * master de `golden-master.test.ts`): e uma edicao PARCIAL — uma entrada nova
 * numa tabela sem a outra, um rename de `tokenVar` que o worker nao seguiu,
 * um `cordis.patch.yml` a ler a env de outro canal. Cada divergencia e um bot
 * a nascer com o token de outro provedor ou a falhar em silencio.
 *
 * Daí as DUAS direcoes de membership EXATA (entrada nova ou rename falha) e a
 * paridade por CONSTANTES REAIS (nunca literais repetidos): as tres copias do
 * nome da variavel do token — host (`PROVIDER_ENV`), worker (`TOKEN_ENV_VAR`)
 * e onboarding (`CHAVE_DO_TOKEN`) — e as duas da raiz da API (registry
 * `apiRootVar`, worker `API_ROOT_ENV_VAR`, lida pela sonda) sao comparadas
 * como valores, nao como texto repetido em teste.
 *
 * SEM a palavra do provedor removido em lado nenhum deste ficheiro (o golden
 * master varre `test/**` tambem — ver `golden-master.test.ts`).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

import {
  DEFAULT_PROVIDER,
  PROVIDER_ENV,
  resolverProvedorDoAmbiente,
  buildWorkerEnv,
  WORKER_PROVIDER_ENV_VAR as VAR_DO_HOST,
  type ProviderId,
} from '../../../src/proc/env.ts'
import {
  DEFAULT_PROVIDER_ID,
  PROVIDERS,
  resolverProvedor,
  WORKER_PROVIDER_ENV_VAR as VAR_DO_WORKER,
} from '../../../worker/providers/registry.ts'
import {
  API_ROOT_ENV_VAR,
  TOKEN_ENV_VAR,
} from '../../../worker/providers/telegram/token.ts'
import { CHAVE_DO_TOKEN } from '../../../src/telegram/onboarding.ts'
import { apiRootDe } from '../../../src/onboarding/sonda.ts'

const UNICO: ProviderId = 'telegram'
const RAIZ = fileURLToPath(new URL('../../../', import.meta.url))
const PATCH = readFileSync(`${RAIZ}cordis.patch.yml`, 'utf8')
const SCHEMA = readFileSync(`${RAIZ}src/config/schema.ts`, 'utf8')
// A 5.ª copia do literal `provider` (PersistedState, `src/contracts/state.ts`):
// o enum tambem e FECHADO do lado do estado persistido — ver o caso do enum.
const STATE = readFileSync(`${RAIZ}src/contracts/state.ts`, 'utf8')

/** O desconhecido generico dos testes de fail-closed (sem nomear removidos). */
const DESCONHECIDO = 'whatsapp'

describe('membership EXATA das tabelas de provedor (entrada nova ou rename falha)', () => {
  it('PROVIDERS (worker) e exatamente { telegram } — nada mais, nada a mais', () => {
    assert.deepEqual(Object.keys(PROVIDERS).toSorted(), [UNICO])
    assert.equal(Object.keys(PROVIDERS).length, 1, 'membership exata: uma entrada, e so uma')
  })

  it('PROVIDER_ENV (host) e exatamente { telegram } — o espelho do worker', () => {
    assert.deepEqual(Object.keys(PROVIDER_ENV).toSorted(), [UNICO])
  })

  it('cada entrada responde pelo SEU id (a chave da tabela e o id do provedor)', () => {
    for (const [chave, descricao] of Object.entries(PROVIDERS)) {
      assert.equal(descricao.id, chave, `a entrada '${chave}' declara id '${String(descricao.id)}'`)
    }
  })

  it('a tabela do registry esta congelada (nada ganha linhas em runtime)', () => {
    // O `PROVIDERS` do worker e `Object.freeze`d; o `PROVIDER_ENV` do host e
    // congelado so em TIPO (`Readonly<Record<...>>`) — e isso e o contrato.
    assert.ok(Object.isFrozen(PROVIDERS))
  })

  it('as duas tabelas tem EXATAMENTE as mesmas chaves (host<->worker em lockstep)', () => {
    assert.deepEqual(Object.keys(PROVIDERS).toSorted(), Object.keys(PROVIDER_ENV).toSorted())
  })
})

describe('ProviderId coerente em todos os pontos de decisao (host, worker, patch, schema, state)', () => {
  it('os dois defaults fechados sao o MESMO valor', () => {
    assert.equal(DEFAULT_PROVIDER_ID, UNICO)
    assert.equal(DEFAULT_PROVIDER, UNICO)
    assert.equal(DEFAULT_PROVIDER, DEFAULT_PROVIDER_ID)
  })

  it('a variavel que rotula o provedor tem o MESMO nome no host e no worker', () => {
    // Os dois modulos nao se importam por construcao (o worker so pode importar
    // tipos de `src/contracts`); o nome e duplicado e a paridade e ESTE teste.
    assert.equal(VAR_DO_HOST, VAR_DO_WORKER)
    assert.equal(VAR_DO_HOST, 'DSH_GUARD_PROVIDER')
  })

  it('os resolvedores host e worker aceitam EXATAMENTE o mesmo conjunto (lockstep fail-closed)', () => {
    // Ambos resolvem o unico provedor nos quatro grafismos legitimos...
    for (const valor of [undefined, '', '   ', UNICO]) {
      const env = valor === undefined ? {} : { [VAR_DO_HOST]: valor }
      assert.equal(resolverProvedor(env).id, UNICO, `worker: ${String(valor)}`)
      assert.equal(resolverProvedorDoAmbiente(env), UNICO, `host: ${String(valor)}`)
    }
    // ...e ambos RECUAM (nunca degradam para o default) para qualquer outro.
    for (const valor of [DESCONHECIDO, 'TELEGRAM', 'Telegram', `${UNICO}x`]) {
      const env = { [VAR_DO_HOST]: valor }
      assert.throws(() => resolverProvedor(env), `worker aceitou '${valor}'`)
      assert.throws(() => resolverProvedorDoAmbiente(env), `host aceitou '${valor}'`)
    }
  })

  it('o enum `provider` continua FECHADO a uma linha so nos DOIS contratos congelados (schema e PersistedState)', () => {
    // O contrato congelado do lado do CONFIG (`Config.worker.provider`) E o do
    // lado do ESTADO PERSISTIDO (`PersistedState.provider` — a 5.ª copia do
    // literal, `src/contracts/state.ts`): os dois tem de continuar a uma linha
    // so. Alargar a union em QUALQUER um dos dois reprova aqui.
    assert.match(SCHEMA, /^ {4}provider\?: 'telegram'$/mu)
    assert.match(STATE, /^ {2}provider\?: 'telegram' \| undefined$/mu)
  })
})

describe('paridade tokenVar — tres copias do nome, UM valor (FOCO 2)', () => {
  it('PROVIDER_ENV.tokenVar === TOKEN_ENV_VAR (worker) === CHAVE_DO_TOKEN (onboarding)', () => {
    assert.equal(PROVIDER_ENV[UNICO].tokenVar, TOKEN_ENV_VAR)
    assert.equal(PROVIDER_ENV[UNICO].tokenVar, CHAVE_DO_TOKEN)
    assert.equal(TOKEN_ENV_VAR, 'TELEGRAM_BOT_TOKEN')
  })

  it('buildWorkerEnv escreve o token MESMO na variavel que o worker le', () => {
    const env = buildWorkerEnv({ PATH: '/usr/bin' }, 'token-sintetico', UNICO)
    assert.equal(env[TOKEN_ENV_VAR], 'token-sintetico')
  })
})

describe('paridade apiRootVar — registry, worker e sonda falam da MESMA variavel (FOCO 2)', () => {
  it('PROVIDERS.apiRootVar === API_ROOT_ENV_VAR (worker)', () => {
    assert.equal(PROVIDERS[UNICO].apiRootVar, API_ROOT_ENV_VAR)
    assert.equal(API_ROOT_ENV_VAR, 'TELEGRAM_API_ROOT')
  })

  it('a sonda LE a variavel que o registry declara (comportamento, nao literal)', () => {
    // Se a sonda lesse a env de outro canal, este teste cai: a agulha e a
    // constante REAL do worker, nao uma copia do nome no teste.
    const ambiente = { [API_ROOT_ENV_VAR]: 'http://duplo.invalid' }
    assert.equal(apiRootDe(UNICO, ambiente), 'http://duplo.invalid')
    assert.equal(apiRootDe(UNICO, {}), undefined, 'ausente = raiz publica (undefined)')
  })
})

/* ========================================================================== */
/* cordis.patch.yml — o manifesto coerente com UM provedor (FOCO 1c)          */
/* ========================================================================== */

/** As chaves de um bloco YAML/TS `chave:`/`chave?:` com a indentacao dada. */
function chavesDoBloco(yaml: string, indentacao: number): string[] {
  const alvo = new RegExp(`^ {${String(indentacao)}}([a-zA-Z][\\w]*)\\??:`, 'gu')
  const chaves: string[] = []
  for (const linha of yaml.split('\n')) {
    const m = alvo.exec(linha)
    if (m?.[1] !== undefined) chaves.push(m[1])
    alvo.lastIndex = 0
  }
  return chaves
}

describe('cordis.patch.yml coerente com um unico provedor telegram', () => {
  it('o token vem da variavel DO telegram, e e a UNICA referencia a process.env do ficheiro', () => {
    // Nenhuma entrada de outro canal pode entrar pela porta das env: o patch
    // inteiro referencia `process.env` UMA vez, e e a do token do telegram.
    assert.ok(PATCH.includes(`token: !!js "process.env.${TOKEN_ENV_VAR} ?? ''"`))
    const referencias = [...PATCH.matchAll(/process\.env\.([A-Z_]+)/gu)].map((m) => m[1])
    assert.deepEqual(referencias, [TOKEN_ENV_VAR])
  })

  it('o worker e Node do proprio processo (process.execPath) — nunca um runtime morto', () => {
    assert.ok(PATCH.includes('command: !!js process.execPath'))
    assert.ok(!/^\s*command:\s*['"]?python3/gmu.test(PATCH), 'o runtime morto regressou ao patch')
  })

  it('o patch e INSERT PURO: UMA linha de registo, a do proprio plugin', () => {
    const ids = [...PATCH.matchAll(/^ {4}- id: ([\w-]+)$/gm)].map((m) => m[1])
    assert.deepEqual(ids, ['guard-messenger'])
  })

  it('as chaves de config casam com o contrato CONGELADO do Config (subset, omissao legitima)', () => {
    // `cordis.patch.yml` diz: «as chaves de `config` casam uma a uma com a
    // `interface Config`... Chave OMITIDA aqui nao e erro; acrescentar chaves
    // FORA do contrato e que e.» — logo: patch ⊆ interface.
    const doPatch = chavesDoBloco(PATCH.slice(PATCH.indexOf('      config:')), 8)
    const daInterface = chavesDoBloco(SCHEMA.slice(SCHEMA.indexOf('export interface Config {')), 2)
    assert.ok(doPatch.length >= 8, `extracao vazia do patch: ${doPatch.join(',')}`)
    assert.ok(daInterface.length >= 8, `extracao vazia do Config: ${daInterface.join(',')}`)
    for (const chave of doPatch) {
      assert.ok(daInterface.includes(chave), `a chave '${chave}' do patch NAO esta no interface Config`)
    }
    for (const esperado of ['allowedHosts', 'trustedRemotes', 'guardedPrefixes', 'deniedPermissions', 'worker']) {
      assert.ok(doPatch.includes(esperado), `falta ${esperado} no patch`)
    }
  })

  it('o bloco worker do patch casam com Config.worker (e traz command/args/token/graceMs/backoff)', () => {
    const blocoPatch = PATCH.slice(PATCH.indexOf('        worker:'))
    const doPatch = chavesDoBloco(blocoPatch, 10)
    const blocoSchema = SCHEMA.slice(SCHEMA.indexOf('  worker: {'))
    const daInterface = chavesDoBloco(blocoSchema, 4)
    for (const chave of doPatch) {
      assert.ok(daInterface.includes(chave), `a chave 'worker.${chave}' do patch NAO esta no Config.worker`)
    }
    for (const esperado of ['command', 'args', 'token', 'graceMs', 'backoff']) {
      assert.ok(doPatch.includes(esperado), `falta worker.${esperado} no patch`)
    }
  })
})
