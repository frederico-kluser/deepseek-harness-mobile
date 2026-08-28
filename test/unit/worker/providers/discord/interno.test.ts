/**
 * `worker/providers/discord/interno.ts` — os auxiliares estruturais do
 * adaptador (relogio, logger de memoria, mascaramento) e o RE-EXPORT do
 * contrato de erro canonico (`ProviderError`/`WORKER_EXIT`/`isWorkerExitCode`
 * de `worker/lib/errors.ts`).
 *
 * Nao existia ficheiro proprio antes desta onda de testes: o mascaramento
 * (S3 — o token do Discord viaja no header, mas a causa do transporte pode
 * citar a URL) e a espera com abort ficavam sem prova directa.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  criarLoggerMemoria,
  describeForLog,
  isWorkerExitCode,
  REDACTED,
  redact,
  systemTime,
  WORKER_EXIT,
} from '../../../../../worker/providers/discord/interno.ts'
import { ProviderError } from '../../../../../worker/providers/discord/interno.ts'
import { TOKEN_DE_TESTE } from './apoio.ts'

describe('provider/discord/interno — systemTime.sleep', () => {
  it('ms <= 0 resolve imediatamente (sem timer)', async () => {
    const inicio = Date.now()
    await systemTime.sleep(0)
    await systemTime.sleep(-5)
    assert.ok(Date.now() - inicio < 200, 'nao esperou nada')
  })

  it('um sinal JA abortado resolve imediatamente', async () => {
    const inicio = Date.now()
    const sinalJaAbortado = {
      aborted: true,
      addEventListener: (_t: 'abort', _fn: () => void): void => undefined,
      removeEventListener: (_t: 'abort', _fn: () => void): void => undefined,
    }
    await systemTime.sleep(500, sinalJaAbortado)
    assert.ok(Date.now() - inicio < 200)
  })

  it('abortar no meio da espera resolve antes do prazo e remove o listener', async () => {
    const inicio = Date.now()
    const listeners: Array<() => void> = []
    let removidos = 0
    const sinal = {
      aborted: false,
      addEventListener: (_t: 'abort', fn: () => void): void => {
        listeners.push(fn)
      },
      removeEventListener: (_t: 'abort', _fn: () => void): void => {
        removidos += 1
      },
    }
    const espera = systemTime.sleep(10_000, sinal)
    assert.equal(listeners.length, 1, 'o listener de abort instala-se')
    // Simula o abort: o listener resolve a promessa.
    for (const fn of listeners) fn()
    await espera
    assert.ok(Date.now() - inicio < 200, 'abortou bem antes do prazo')
    assert.equal(removidos, 1, 'o listener foi removido apos o abort')
  })
})

describe('provider/discord/interno — criarLoggerMemoria', () => {
  it('formata uma linha por chamada, com os campos definidos', () => {
    const linhas: string[] = []
    const logger = criarLoggerMemoria((l) => linhas.push(l))
    logger.info('pronto')
    logger.warn('risco', { a: 1, b: undefined })
    logger.error('falhou', { causa: 'x' })
    logger.debug('detalhe')
    assert.deepEqual(linhas, [
      'INFO pronto',
      'WARN risco a=1',
      'ERROR falhou causa=x',
      'DEBUG detalhe',
    ])
  })
})

describe('provider/discord/interno — redact (S3: o log nunca leva o token)', () => {
  it('o token literal (>= 8 chars) e substituido, em todas as ocorrencias', () => {
    const texto = `Bearer ${TOKEN_DE_TESTE} e outra vez ${TOKEN_DE_TESTE}`
    const saida = redact(texto, [TOKEN_DE_TESTE])
    assert.equal(saida.includes(TOKEN_DE_TESTE), false)
    assert.equal(saida.split(REDACTED).length - 1, 2)
  })

  it('um "segredo" curto (< 8 chars) e IGNORADO (mascarar tudo e ruido)', () => {
    assert.equal(redact('o x marca o sitio', ['x']), 'o x marca o sitio')
    assert.equal(redact('seis6sete', ['seis6']), 'seis6sete')
  })

  it('a forma do token do bot (id:token longo) sai; o id numerico fica', () => {
    const saida = redact('GET /bot123456789:AAEEsegredo-de-outro-bot-qualquer/getMe')
    assert.equal(saida.includes('AAEEsegredo-de-outro-bot-qualquer'), false)
    assert.match(saida, /123456789:/u)
  })

  it('o valor de Authorization/Cookie sai; o nome fica', () => {
    assert.equal(redact('Authorization: Bot abcdefghij1234567890').includes('abcdefghij1234567890'), false)
    assert.match(redact('authorization=Bearer xyz1234567890'), /authorization=/u)
    assert.equal(redact('Cookie: sessao=um-valor-secreto-long').includes('um-valor-secreto-long'), false)
  })

  it('o $HOME sai do texto; /usr/lib fica', () => {
    const saida = redact('procurei em /home/fulano/.dsh e tambem em /usr/lib')
    assert.equal(saida.includes('/home/fulano'), false)
    assert.match(saida, /\/usr\/lib/u)
  })
})

describe('provider/discord/interno — describeForLog (seguro para qualquer valor)', () => {
  it('Error: nome + mensagem mascarada; a causa entra na cadeia', () => {
    const erro = new Error(`rede ao chamar com ${TOKEN_DE_TESTE}`)
    const comCausa = new Error('falhou', { cause: erro })
    const desc = describeForLog(comCausa, [TOKEN_DE_TESTE])
    assert.equal(desc.includes(TOKEN_DE_TESTE), false)
    assert.match(desc, /^Error: falhou <- Error: rede ao chamar com \[REDACTED\]$/u)
  })

  it('string e primitivos passam pelo mascaramento', () => {
    assert.equal(describeForLog('seguro'), 'seguro')
    assert.equal(describeForLog(42), '42')
    assert.equal(describeForLog(null), 'null')
    assert.equal(describeForLog(undefined), 'undefined')
    assert.equal(describeForLog(TOKEN_DE_TESTE, [TOKEN_DE_TESTE]).includes(TOKEN_DE_TESTE), false)
  })

  it('objecto: JSON; objecto nao serializavel: marcado sem rebentar', () => {
    assert.equal(describeForLog({ a: 1 }), '{"a":1}')
    const circular: Record<string, unknown> = { nome: 'x' }
    circular['self'] = circular
    assert.match(describeForLog(circular), /nao serializavel/u)
  })
})

describe('provider/discord/interno — o re-export do contrato comum (Onda 3-fix)', () => {
  it('ProviderError/WORKER_EXIT/isWorkerExitCode sao os CANONICOS de worker/lib/errors.ts', () => {
    // O adaptador NAO tem classe propria: o contrato partilhado com o telegram
    // e o boot generico vive em worker/lib/errors.ts e re-exporta-se aqui.
    const erro = new ProviderError(WORKER_EXIT.UNAUTHORIZED, 'GATEWAY_UNAUTHORIZED', 'x')
    assert.equal(erro.code, 12)
    assert.equal(isWorkerExitCode(erro.code), true)
    assert.equal(WORKER_EXIT.BOOT_TIMEOUT, 14)
    assert.equal(erro.name, 'ProviderError')
  })
})
