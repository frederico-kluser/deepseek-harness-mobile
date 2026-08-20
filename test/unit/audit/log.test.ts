/**
 * `src/audit/log.ts` -- o COMO e o ONDE. Diretorio REAL (`test/support/state-dir.ts`,
 * prep-owned): `0600`, `O_APPEND` e a intercalacao entre processos provam-se com
 * `stat(2)` e com dois processos a escrever ao mesmo tempo, nunca com um dublê.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'

import { AUDIT_DIR_MODE, AUDIT_FILE_MODE, AUDIT_PATH_ENV, AuditOpenError, AuditWriteError, EVENTO_LACUNA, openAuditLog, resolveAuditLogPath } from '../../../src/audit/log.ts'
import type { AuditLog, AuditLogOptions } from '../../../src/audit/log.ts'
import { FakeClock } from '../../support/clock.ts'
import { makeTempStateDir } from '../../support/state-dir.ts'
import type { TempStateDir } from '../../support/state-dir.ts'

const MODULO_LOG = fileURLToPath(new URL('../../../src/audit/log.ts', import.meta.url))

interface Bancada {
  readonly dir: TempStateDir
  readonly path: string
  readonly log: AuditLog
  readonly clock: FakeClock
  linhas(): string[]
  fechar(): void
}

/** Log num diretorio descartavel; o relogio anda so quando o teste manda. */
function bancada(options: Omit<AuditLogOptions, 'path' | 'now'> = {}): Bancada {
  const dir = makeTempStateDir()
  const path = join(dir.path, 'estado', 'audit.log')
  const clock = new FakeClock(1_700_000_000_000)
  const log = openAuditLog({ ...options, path, now: () => clock.now() })
  const fechar = (): void => {
    log.dispose()
    dir.cleanup()
  }
  const linhas = (): string[] => readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
  return { dir, path, log, clock, linhas, fechar }
}
/** Um `write` que devolve `ENOSPC` -- o que `/dev/full` faria, sem encher o disco. */
function enospc(): never {
  throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
}
describe('openAuditLog -- onde e com que modo', () => {
  it('cria o ficheiro 0600 e o diretorio 0700', (t) => {
    const b = bancada()
    t.after(() => b.fechar())
    b.log.append({ evento: 'auth_ok', resultado: 'permitido' })
    assert.equal(statSync(b.path).mode & 0o777, AUDIT_FILE_MODE, 'ficheiro 0600')
    assert.equal(statSync(join(b.dir.path, 'estado')).mode & 0o777, AUDIT_DIR_MODE, 'dir 0700')
  })

  it('RECUSA um ficheiro pre-existente mais frouxo que 0600 (fail loud at load)', (t) => {
    const dir = makeTempStateDir()
    t.after(() => dir.cleanup())
    const path = join(dir.path, 'sub', 'audit.log')
    mkdirSync(join(dir.path, 'sub'), { mode: 0o700 })
    writeFileSync(path, '', { mode: 0o600 })
    chmodSync(path, 0o644)
    assert.throws(() => openAuditLog({ path }), AuditOpenError)
    assert.throws(() => openAuditLog({ path }), /chmod 600/u, 'mensagem acionavel')
  })

  it('RECUSA um diretorio aberto a grupo/outros -- quem manda no NOME e o dir', (t) => {
    // Com o dir 0777 qualquer processo renomeia o `audit.log`; o 0600 do
    // ficheiro nao defende disso.
    const dir = makeTempStateDir()
    t.after(() => dir.cleanup())
    const sub = join(dir.path, 'aberto')
    mkdirSync(sub, { mode: 0o777 })
    chmodSync(sub, 0o777)
    assert.throws(() => openAuditLog({ path: join(sub, 'audit.log') }), /chmod 700/u)
  })

  it('RECUSA um DIRETORIO que e symlink -- um redirecionamento nao e a nossa casa', (t) => {
    const dir = makeTempStateDir()
    t.after(() => dir.cleanup())
    mkdirSync(join(dir.path, 'real'), { mode: 0o700 })
    symlinkSync(join(dir.path, 'real'), join(dir.path, 'ligado'))
    assert.throws(() => openAuditLog({ path: join(dir.path, 'ligado', 'audit.log') }), /symlink/u)
  })

  it('RECUSA um SYMLINK no lugar do log -- e nao escreve no alvo', (t) => {
    // Sem `O_NOFOLLOW` isto acrescentava linhas ao ficheiro apontado (um
    // `authorized_keys`) e o `fstat` nao via nada: o modo era o do ALVO.
    const dir = makeTempStateDir()
    t.after(() => dir.cleanup())
    const sub = join(dir.path, 'sub')
    mkdirSync(sub, { mode: 0o700 })
    const vitima = join(dir.path, 'vitima')
    writeFileSync(vitima, 'ssh-ed25519 AAAA dono@maquina\n', { mode: 0o600 })
    symlinkSync(vitima, join(sub, 'audit.log'))
    assert.throws(() => openAuditLog({ path: join(sub, 'audit.log') }), /SYMLINK/u)
    assert.equal(readFileSync(vitima, 'utf8'), 'ssh-ed25519 AAAA dono@maquina\n', 'alvo intacto')
  })

  it('RECUSA o workspace (servido pela Web UI, versionado) e o caminho relativo', () => {
    assert.throws(
      () => openAuditLog({ path: join(process.cwd(), 'audit.log') }),
      (erro: unknown) => erro instanceof AuditOpenError && /workspace/u.test(erro.message),
    )
    assert.throws(() => openAuditLog({ path: 'audit.log' }), /absoluto/u)
  })
})

describe('resolveAuditLogPath -- a MESMA raiz do estado', () => {
  const FALLBACK = '/h/.dsh/guarded-bot/audit.log'

  it('precedencia do host: configurada > $DSH_HOME > ~/.dsh, e `~` expande', () => {
    assert.equal(resolveAuditLogPath({}, '/h'), FALLBACK)
    assert.equal(resolveAuditLogPath({ DSH_HOME: '/s' }, '/h'), '/s/guarded-bot/audit.log')
    assert.equal(resolveAuditLogPath({ DSH_HOME: '/s' }, '/h', '/c'), '/c/guarded-bot/audit.log')
    assert.equal(resolveAuditLogPath({ DSH_HOME: '~/x' }, '/h'), '/h/x/guarded-bot/audit.log')
  })

  it('`$DSH_HOME` em branco e AUSENTE; relativo e RECUSADO, nunca resolvido', () => {
    assert.equal(resolveAuditLogPath({ DSH_HOME: '   ' }, '/h'), FALLBACK)
    assert.throws(() => resolveAuditLogPath({ DSH_HOME: 'rel' }, '/h'), /DSH_HOME/u)
  })

  it('a valvula de escape ganha a tudo -- e a mitigacao do fail-closed', () => {
    const env = { [AUDIT_PATH_ENV]: '/var/log/x.log', DSH_HOME: '/s' }
    assert.equal(resolveAuditLogPath(env, '/h'), '/var/log/x.log')
  })
})

describe('append-only a serio (pergunta 2)', () => {
  it('nao trunca: reabrir e escrever preserva o que ja la estava', (t) => {
    const b = bancada()
    t.after(() => b.fechar())
    try {
      b.log.append({ evento: 'primeiro', resultado: 'permitido' })
      b.log.dispose()
      const outro = openAuditLog({ path: b.path, now: () => b.clock.now() })
      outro.append({ evento: 'segundo', resultado: 'negado' })
      outro.dispose()
      const linhas = b.linhas()
      assert.equal(linhas.length, 2, 'um `writeFile` teria deixado 1 -- O_TRUNC apaga')
      assert.match(linhas[0] ?? '', /"evento":"primeiro"/u)
    } finally {
      b.fechar()
    }
  })
  it('escreve sempre no FIM, mesmo com outro escritor a crescer o ficheiro', () => {
    // O caso que distingue O_APPEND de um descritor com offset proprio: com
    // offset proprio o segundo `append` ia para o offset guardado e ESMAGAVA os
    // bytes que o outro escritor acabou de acrescentar.
    const b = bancada()
    b.log.append({ evento: 'nosso_primeiro', resultado: 'permitido' })
    const intruso = 'X'.repeat(500)
    appendFileSync(b.path, `${intruso}\n`)

    b.log.append({ evento: 'nosso_segundo', resultado: 'negado' })

    const linhas = b.linhas()
    assert.equal(linhas.length, 3)
    assert.equal(linhas[1], intruso, 'os bytes do outro escritor ficam INTACTOS')
    assert.match(linhas[2] ?? '', /"evento":"nosso_segundo"/u)
  })

  it('o timestamp vem do relogio injetado, nao de `Date.now`', (t) => {
    const b = bancada()
    t.after(() => b.fechar())
    try {
      b.log.append({ evento: 'a', resultado: 'permitido' })
      b.clock.advance(60_000)
      b.log.append({ evento: 'b', resultado: 'permitido' })
      const ts = b.linhas().map((l) => (JSON.parse(l) as { ts: string }).ts)
      assert.deepEqual(ts, ['2023-11-14T22:13:20.000Z', '2023-11-14T22:14:20.000Z'])
    } finally {
      b.fechar()
    }
  })
  it('mascara com os segredos VIVOS, relidos a cada escrita (o tunel muda)', () => {
    let url = 'https://primeiro.exemplo.net'
    const b = bancada({ secrets: () => [url] })
    b.log.append({ evento: `tunel ${url}`, resultado: 'permitido' })
    url = 'https://segundo.exemplo.net'
    b.log.append({ evento: `tunel ${url}`, resultado: 'permitido' })

    const conteudo = readFileSync(b.path, 'utf8')
    assert.equal(conteudo.includes('primeiro.exemplo'), false)
    assert.equal(conteudo.includes('segundo.exemplo'), false, 'uma lista fixa falharia aqui')
  })

  it('com `fsyncEachWrite` a linha continua a ser a mesma', (t) => {
    const b = bancada({ fsyncEachWrite: true })
    t.after(() => b.fechar())
    try {
      b.log.append({ evento: 'duravel', resultado: 'permitido' })
      assert.equal(b.linhas().length, 1)
    } finally {
      b.fechar()
    }
  })
})
describe('disco cheio: FECHA (pergunta 3)', () => {
  it('`append` LANCA em vez de servir um pedido que nao consegue registar', (t) => {
    const b = bancada({ write: enospc })
    t.after(() => b.fechar())
    assert.throws(
      () => b.log.append({ evento: 'auth_ok', resultado: 'permitido' }),
      (erro: unknown) =>
        erro instanceof AuditWriteError &&
        /fail-closed/u.test(erro.message) &&
        (erro.cause as NodeJS.ErrnoException).code === 'ENOSPC',
    )
    assert.equal(b.log.perdidos(), 1)
  })

  it('a mensagem NAO leva o caminho do ficheiro -- ela pode acabar num corpo HTTP', (t) => {
    const b = bancada({ write: enospc })
    t.after(() => b.fechar())
    try {
      assert.throws(
        () => b.log.append({ evento: 'x', resultado: 'negado' }),
        (erro: unknown) => {
          assert.ok(erro instanceof AuditWriteError)
          assert.equal(erro.message.includes(b.path), false, 'topologia de disco fora da message')
          assert.equal(erro.path, b.path, 'mas continua disponivel para o log do operador')
          return true
        },
      )
    } finally {
      b.fechar()
    }
  })
  it('nao e latch permanente: quando o disco liberta, volta a registar', () => {
    let cheio = true
    const b = bancada({ write: (fd, data) => (cheio ? enospc() : writeSync(fd, data)) })
    assert.throws(() => b.log.append({ evento: 'perdido_1', resultado: 'negado' }), AuditWriteError)
    assert.throws(() => b.log.append({ evento: 'perdido_2', resultado: 'negado' }), AuditWriteError)
    cheio = false
    b.log.append({ evento: 'voltou', resultado: 'permitido' })

    // A LACUNA vem primeiro e diz quantos registos faltam: sem ela, quem le
    // nao distingue "ninguem tentou" de "nao deu para registar".
    const linhas = b.linhas()
    assert.equal(linhas.length, 2, 'nenhuma linha VAZIA das duas falhas limpas')
    assert.match(linhas[0] ?? '', new RegExp(`"${EVENTO_LACUNA}:2"`, 'u'))
    assert.match(linhas[1] ?? '', /"evento":"voltou"/u)
    assert.equal(b.log.perdidos(), 0)
  })

  it('uma linha partida ao meio e fechada, para a seguinte nao se colar a ela', () => {
    // Escrita curta a valer (o `write` DEVOLVE 10) e so depois o disco acaba.
    let chamadas = 0
    const b = bancada({
      write: (fd, data) => {
        chamadas += 1
        if (chamadas === 1) return writeSync(fd, data.subarray(0, 10))
        if (chamadas === 2) return enospc()
        return writeSync(fd, data)
      },
    })
    try {
      assert.throws(() => b.log.append({ evento: 'partido', resultado: 'negado' }), AuditWriteError)
      b.log.append({ evento: 'inteiro', resultado: 'permitido' })

      const linhas = b.linhas()
      assert.equal(linhas[0], '{"ts":"202', 'o fragmento fica isolado na sua linha')
      assert.match(linhas.at(-1) ?? '', /"evento":"inteiro"/u)
      assert.equal(linhas.filter((l) => l.startsWith('{"ts"') && l.endsWith('}')).length, 2)
    } finally {
      b.fechar()
    }
  })

  it('trata a escrita curta sem erro: escreve o resto, nao meia linha', (t) => {
    const b = bancada({ write: (fd, data) => writeSync(fd, data.subarray(0, 1)) })
    t.after(() => b.dir.cleanup())
    try {
      b.log.append({ evento: 'byte_a_byte', resultado: 'permitido' })
      assert.equal(b.linhas().length, 1)
      assert.match(b.linhas()[0] ?? '', /"evento":"byte_a_byte"/u)
    } finally {
      b.fechar()
    }
  })
})
describe('disposer sincrono (Q-2)', () => {
  it('fecha, e depois RECUSA escrever em vez de fingir que escreveu', (t) => {
    const b = bancada()
    t.after(() => b.fechar())
    b.log.append({ evento: 'antes', resultado: 'permitido' })
    assert.equal(b.log.dispose(), undefined, 'sincrono: nao devolve promessa')
    assert.throws(() => b.log.append({ evento: 'depois', resultado: 'permitido' }), AuditWriteError)
    assert.equal(b.linhas().length, 1)
  })

  it('e idempotente: o segundo dispose nao fecha o descritor de outra pessoa', (t) => {
    const b = bancada()
    t.after(() => b.dir.cleanup())
    b.log.dispose()
    assert.doesNotThrow(() => b.log.dispose())
  })
})
describe('dois PROCESSOS a escrever ao mesmo tempo (pergunta 5)', () => {
  const N = 400
  it('com O_APPEND: 2 x 400 registos, 800 linhas inteiras, zero bytes soltos', async () => {
    // O host e o worker sao processos separados POR DESENHO. A barreira e
    // essencial: sem ela o primeiro podia acabar antes de o segundo abrir.
    const dir = makeTempStateDir()
    const path = join(dir.path, 'audit.log')
    await correr(path, 'append')

    const bytes = readFileSync(path, 'utf8')
    const linhas = bytes.split('\n').filter((l) => l.length > 0)
    assert.equal(linhas.length, 2 * N, 'nenhuma linha se perdeu nem foi esmagada')
    const uteis = linhas.reduce((acc, l) => acc + l.length + 1, 0)
    assert.equal(bytes.length, uteis, 'nao ha bytes soltos: nenhuma escrita ficou a meio')

    // Uma linha partida por outra escrita nao seria JSON valido.
    const eventos = linhas.map((linha) => {
      const rec = JSON.parse(linha) as Record<string, unknown>
      assert.deepEqual(Object.keys(rec), ['ts', 'evento', 'resultado', 'ip_normalizado', 'sessao_id_hash'])
      return String(rec['evento'])
    })
    assert.equal(new Set(eventos).size, 2 * N, 'todos os registos dos dois processos la estao')

    // Uma troca de autor entre linhas consecutivas prova que escreveram na mesma
    // janela. Quantas e do escalonador (mediram-se 97 a 681), logo a assercao
    // exige UMA: o numero nao e reprodutivel, a existencia do cruzamento e.
    const trocas = eventos.filter((e, i) => i > 0 && e[0] !== eventos[i - 1]?.[0]).length
    assert.ok(trocas >= 1, `os dois processos tem de se ter cruzado (trocas=${String(trocas)})`)
  })

  it('CONTROLO NEGATIVO -- sem O_APPEND o mesmo cenario DESTROI metade', async (t) => {
    // Sem este caso o teste de cima passaria com `O_APPEND` decorativo.
    const dir = makeTempStateDir()
    t.after(() => dir.cleanup())
    const path = join(dir.path, 'audit.log')
    writeFileSync(path, '', { mode: 0o600 })
    await correr(path, 'sem-append')

    const linhas = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
    assert.ok(linhas.length < 2 * N, `destruidos: sobraram ${String(linhas.length)} de ${String(2 * N)}`)
  })
})

interface Escritor {
  /** Resolve quando o filho abriu o log e espera no `readFileSync(0)`. */
  readonly pronto: Promise<void>
  soltar(): void
  readonly terminou: Promise<void>
}

/** Barreira partilhada: os dois so arrancam quando os dois estao prontos. */
async function correr(path: string, modo: 'append' | 'sem-append'): Promise<void> {
  const filhos = [escritorFilho(path, 'a', modo), escritorFilho(path, 'b', modo)]
  await Promise.all(filhos.map((f) => f.pronto))
  for (const f of filhos) f.soltar()
  await Promise.all(filhos.map((f) => f.terminou))
}

/** Filho REAL: outro processo, outro descritor, o mesmo ficheiro. */
function escritorFilho(path: string, marca: string, modo: 'append' | 'sem-append'): Escritor {
  const fonte = JSON.stringify(pathToFileURL(MODULO_LOG).href)
  const escrita =
    modo === 'append'
      ? `const { openAuditLog } = await import(${fonte})
         const log = openAuditLog({ path: process.argv[1] })
         const escrever = (i) => log.append({ evento: '${marca}_' + i, resultado: 'permitido' })
         const fechar = () => log.dispose()`
      : `const fd = openSync(process.argv[1], 'r+', 0o600)
         const escrever = (i) => writeSync(fd, Buffer.from(
           JSON.stringify({ evento: '${marca}_' + i }) + String.fromCharCode(10)))
         const fechar = () => closeSync(fd)`
  const codigo = `
    import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
    ${escrita}
    process.stdout.write('pronto')
    readFileSync(0)
    for (let i = 0; i < 400; i += 1) escrever(i)
    fechar()
  `
  const filho = spawn(process.execPath, ['--input-type=module', '-e', codigo, path], { stdio: 'pipe' })
  let erro = ''
  filho.stderr.on('data', (chunk: Buffer) => {
    erro += chunk.toString('utf8')
  })
  return {
    pronto: new Promise<void>((ok) => filho.stdout.once('data', () => ok())),
    soltar: (): void => {
      filho.stdin.end()
    },
    terminou: new Promise<void>((ok, nok) => {
      filho.on('exit', (code) => {
        if (code === 0) ok()
        else nok(new Error(`filho ${marca} saiu com ${String(code)}: ${erro}`))
      })
    }),
  }
}
