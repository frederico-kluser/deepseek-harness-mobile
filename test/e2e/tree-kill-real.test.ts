/**
 * =============================================================================
 * T6.4 -- TREE-KILL REAL: o kill do GRUPO sobre processos de verdade, e a
 * semantica ESRCH que o rodeia (04-TESTES.md E2E-012/013).
 * =============================================================================
 *
 * O QUE ESTE FICHEIRO E: a camada mais baixa do caos de processo, contra o
 * sistema operativo real. Nenhum duble modela o que aqui se mede -- setsid(2)
 * (detached), o alvo do sinal negativo, a reatribuicao de ppid pelo nucleo e o
 * ESRCH do kill(2). Tudo e verificado com `ps -o pid,ppid,pgid,sid`, que e a
 * fonte que o proprio nucleo publica, e nao com o que o codigo diz que fez.
 *
 * AS QUATRO PERGUNTAS FALSIFICAVEIS DE T6.4, RESPONDIDAS AQUI:
 *
 *   1. "o teste de orfao mede o NETO ou so o filho direto?" -- mede o neto. O
 *      kill do grupo so tem graca se levar a DESCENDENCIA; um kill que so mata
 *      o filho direto deixa o neto orfao vivo, que e exatamente o defeito que
 *      a guarda !child.killed causava (ver o cabecalho de
 *      `src/proc/tree-kill.ts`). Cada cenario assere a morte do neto, nao so
 *      a do filho.
 *
 *   2. "o SIGKILL no host e mesmo SIGKILL?" -- sim, e prova-se: o filho e
 *      morto com kill(pid, 'SIGKILL') literal e o evento 'exit' do
 *      ChildProcess reporta signal === 'SIGKILL' com exitCode === null. Um
 *      SIGTERM com handler daria exitCode: 0, signal: null.
 *
 *   3. "so roda em Linux?" -- o package.json declara os: [linux, darwin], e
 *      este ficheiro NAO tem caminho de Windows: o Windows nao tem grupos de
 *      processos POSIX (taskkill /T /F e do assento, nao nosso). Em win32 a
 *      suite salta com a razao escrita. Em darwin os grupos POSIX existem e o
 *      ps fala sid/pgid -- o teste corre; a unica diferenca e que o orfao e
 *      adotado pelo launchd (o subreaper do mac), nunca asserido aqui.
 *
 *   4. "o teste distingue ESRCH 'processo nao existe' de ESRCH 'nao e lider de
 *      grupo'?" -- distingue, com processos reais, no penultimo bloco: um
 *      filho NAO-detached da ESRCH em kill(-pid, 0) ENQUANTO ESTA VIVO, e
 *      sobrevive a um kill(-pid, 'SIGKILL') que devolve ESRCH. Um detached,
 *      pelo contrario, responde a kill(-pid, 0) enquanto o grupo existir e so
 *      da ESRCH depois de o grupo ter desaparecido. A conclusao e a regra de
 *      ouro: ESRCH nunca e prova de ausencia de processo -- e por isso que
 *      treeKill o engole e que o assento poe detached: true, porque e o
 *      setsid que torna o sinal negativo um alvo de grupo.
 *
 * CRITERIO DE ACEITE GLOBAL: depois da suite, pgrep -f
 * 'cloudflared|fake-cloudflared|telegram-bot' vazio (o after deste ficheiro
 * mata tudo o que restar e verifica).
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { after, describe, it } from 'node:test'

import { treeKill } from '../../src/proc/tree-kill.ts'

const POSIX_REASON =
  'tree-kill do GRUPO e POSIX: o Windows nao tem grupos de processos ' +
  '(o assento usa taskkill /T /F la) e o package.json declara os: [linux, darwin].'

/**
 * Processos que este ficheiro criou; o after global mata os sobreviventes.
 *
 * Processos de OUTRAS suites (worktrees irmas a correr em paralelo, o proprio
 * DSH da maquina) vivem ao lado dos nossos: um pgrep de maquina inteira nao e
 * asserivel, e os NUMEROS de pid sao reciclados entre suites. Por isso o
 * criterio de aceite assere sobre os handles ChildProcess (a saida e
 * evidencia autoritativa de fim de processo) e nunca sobre pids nus.
 */
const vivos = new Set<number>()
/** Handles diretos que este ficheiro criou; a saida deles e a evidencia. */
const filhos: ChildProcess[] = []

function matarSePreciso(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    // ESRCH: ja nao existe. Nada a fazer.
    void error
  }
}

after(async () => {
  // Rede de seguranca: nenhum teste pode deixar processo atras de si.
  for (const pid of vivos) {
    if (isAlive(pid)) matarSePreciso(pid)
  }

  // Espera curta pelo reap (filhos diretos sao nossos para reap; os netos
  // reparentados sao reapados pelo subreaper em milissegundos).
  await new Promise<void>((resolve) => setTimeout(resolve, 200))

  // Criterio de aceite (T6.4): zero processos remanescentes da SUITE. A
  // evidencia e o handle: exitCode ou signalCode preenchidos = o processo
  // saiu. Pids nus nao sao evidencia (reciclagem entre suites concorrentes).
  const pendentes = filhos.filter((filho) => filho.exitCode === null && filho.signalCode === null)
  assert.deepEqual(
    pendentes.map((filho) => filho.pid),
    [],
    'handles ChildProcess deste ficheiro sem saida observada apos a suite',
  )
  const vivosAinda = [...vivos].filter((pid) => isAlive(pid))
  vivos.clear()
  filhos.length = 0
  assert.deepEqual(
    vivosAinda,
    [],
    `pids deste ficheiro ainda vivos apos a suite: ${vivosAinda.join(', ') || '(nenhum esperado)'}`,
  )
})

/** true enquanto o pid existir. kill(pid, 0) nao entrega sinal nenhum. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Espera ativa e curta por uma condicao. Nenhum teste espera tempo fixo. */
async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 8000, stepMs = 10 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, stepMs))
  }
  return predicate()
}

interface PsFacts {
  pid: number
  ppid: number
  pgid: number
  sid: number
}

/**
 * ps de um pid, ou undefined quando ele ja nao existe.
 *
 * -o pid=,ppid=,pgid=,sid= e a forma pedida por T6.4: ps fala a lingua do
 * nucleo e sid e o nome que o proprio T6.4 usa. Um processo que nao existe
 * devolve saida vazia (exit 1), que se le como undefined.
 */
function ps(pid: number): PsFacts | undefined {
  try {
    const linha = execFileSync('ps', ['-o', 'pid=,ppid=,pgid=,sid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    if (linha === '') return undefined
    const [p, pp, pg, s] = linha.split(/\s+/u).map(Number)
    if (p === undefined || pp === undefined || pg === undefined || s === undefined) return undefined
    return { pid: p, ppid: pp, pgid: pg, sid: s }
  } catch {
    return undefined
  }
}

/**
 * Filho REAL, detached, que cria um NETO (neto esse que NAO e detached: fica
 * no grupo do pai -- e esse o ponto).
 *
 * Devolve os dois pids. O neto e descoberto por ps --ppid, nao por parsing de
 * stdout: o ps e a fonte de verdade e o teste nao depende do formato do eco.
 */
async function arrancarArvore(): Promise<{ filho: ChildProcess; filhoPid: number; netoPid: number }> {
  const filho = spawn(
    process.execPath,
    [
      '-e',
      [
        "import { spawn } from 'node:child_process'",
        "const neto = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
        "console.log('NETO=' + neto.pid)",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  if (filho.pid === undefined) throw new Error('filho sem pid')
  vivos.add(filho.pid)
  filhos.push(filho)

  let eco = ''
  const netoPid = await new Promise<number>((resolve, reject) => {
    const prazo = setTimeout(() => reject(new Error('o filho nunca publicou o neto')), 8000)
    filho.stdout.on('data', (chunk: Buffer): void => {
      eco += chunk.toString()
      const match = /NETO=(\d+)/u.exec(eco)
      if (match?.[1] !== undefined) {
        clearTimeout(prazo)
        resolve(Number(match[1]))
      }
    })
  })
  vivos.add(netoPid)
  await waitFor(() => isAlive(netoPid))
  return { filho, filhoPid: filho.pid as number, netoPid }
}

describe('tree-kill real: o kill do GRUPO e a sua semantica', { skip: process.platform === 'win32' ? POSIX_REASON : false }, () => {
  it('um filho detached e lider do GRUPO e da SESSAO, e o neto partilha o grupo (ps)', async () => {
    const { filhoPid, netoPid } = await arrancarArvore()

    const doFilho = ps(filhoPid)
    const doNeto = ps(netoPid)
    assert.notEqual(doFilho, undefined)
    assert.notEqual(doNeto, undefined)

    // detached: true == setsid(2): sem isto o -pid nao designa grupo nenhum e
    // o tree-kill nao existe.
    assert.equal(doFilho?.pgid, filhoPid, 'o filho tem de ser lider do seu grupo')
    assert.equal(doFilho?.sid, filhoPid, 'e da sua sessao')
    assert.equal(doFilho?.ppid, process.pid, 'e filho do processo de teste')

    // O neto NAO e detached: herda o grupo e a sessao do pai.
    assert.equal(doNeto?.ppid, filhoPid, 'o neto tem de ser filho direto do filho')
    assert.equal(doNeto?.pgid, filhoPid, 'o neto tem de partilhar o grupo do filho')
    assert.equal(doNeto?.sid, filhoPid, 'e a sessao do filho')
  })

  it('kill(-pid, SIGKILL) mata a ARVORE: o neto morre com o grupo (nao fica orfao)', async () => {
    const { filhoPid, netoPid } = await arrancarArvore()
    assert.equal(isAlive(filhoPid), true)
    assert.equal(isAlive(netoPid), true)

    // O MESMO primitivo de src/proc/tree-kill.ts: sinal negativo ao grupo.
    process.kill(-filhoPid, 'SIGKILL')

    const filhoMorreu = await waitFor(() => !isAlive(filhoPid))
    const netoMorreu = await waitFor(() => !isAlive(netoPid))

    assert.equal(filhoMorreu, true, 'o filho tem de morrer com o kill do grupo')
    assert.equal(
      netoMorreu,
      true,
      'o NETO tem de morrer com o kill do grupo: um tree-kill que so mata o filho ' +
        'direto deixa o neto orfao vivo -- o defeito que a guarda !child.killed causava',
    )
  })

  it('matar SO o filho deixa o neto vivo e reparentado (o orfao que o kill do grupo impede)', async (t) => {
    const { filhoPid, netoPid } = await arrancarArvore()

    // Sinal POSITIVO: so o filho. E o cenario do orfao -- o neto perde o pai e
    // e adotado pelo SUBREAPER mais proximo (systemd --user numa sessao de
    // utilizador), NAO necessariamente o PID 1. Mede-se o reparenting, nao se
    // assere um pai fixo: um teste que exigisse ppid === 1 mediria a topologia
    // da maquina (falha num contentor) e nao o comportamento do codigo.
    process.kill(filhoPid, 'SIGKILL')
    await waitFor(() => !isAlive(filhoPid))

    const reparentado = await waitFor(() => {
      const factos = ps(netoPid)
      return factos !== undefined && factos.ppid !== filhoPid
    })
    assert.equal(reparentado, true, 'o neto tem de continuar vivo, reparentado')

    const factos = ps(netoPid)
    assert.notEqual(factos, undefined)
    assert.equal(isAlive(netoPid), true, 'o neto SOBREVIVE ao kill do pai: e isto que o tree-kill evita')
    assert.notEqual(factos?.ppid, filhoPid, 'o neto tem de ter sido reparentado')
    assert.notEqual(factos?.ppid, process.pid, 'e NAO para o processo de teste (nao e subreaper)')

    // A MEDICAO e reportada, nao presumida: quem adotou o orfao nesta maquina?
    let nomeNovoPai = '?'
    const novoPai = factos?.ppid ?? 0
    try {
      nomeNovoPai = execFileSync('ps', ['-o', 'comm=', '-p', String(novoPai)], { encoding: 'utf8' }).trim()
    } catch (error) {
      void error
    }
    t.diagnostic(
      `sem kill do grupo, o neto ficou orfao e foi adotado por pid ${String(novoPai)} (${nomeNovoPai})` +
        ' -- o subreaper mais proximo, nao necessariamente o PID 1',
    )

    // Limpeza: sem grupo para matar (o neto nao e lider), mata-se o neto direto.
    matarSePreciso(netoPid)
    await waitFor(() => !isAlive(netoPid))
  })

  it('ESRCH de kill(-pid,0) num filho NAO-detached NAO prova ausencia: o processo esta vivo', async () => {
    // Filho SEM detached: nao e lider de grupo. kill(-pid, 0) devolve ESRCH
    // porque -pid nao designa grupo nenhum -- NAO porque o processo tenha
    // desaparecido. E a pergunta falsificavel 4 de T6.4.
    const filho = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    })
    if (filho.pid === undefined) throw new Error('filho sem pid')
    vivos.add(filho.pid)
    filhos.push(filho)
    await waitFor(() => isAlive(filho.pid as number))

    const pid = filho.pid as number
    const factos = ps(pid)
    assert.equal(isAlive(pid), true, 'o processo esta VIVO')

    // O sinal negativo falha com ESRCH apesar de o processo existir...
    assert.throws(
      () => process.kill(-pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
      'kill(-pid, 0) num nao-lider de grupo tem de dar ESRCH',
    )

    // ...e o kill do GRUPO tambem da ESRCH: nada foi entregue, o processo vive.
    assert.throws(() => process.kill(-pid, 'SIGKILL'))
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
    assert.equal(isAlive(pid), true, 'ESRCH em -pid NAO matou nada: o processo continua vivo')

    // A prova do outro lado da moeda: o kill POSITIVO funciona e o ps confirma
    // que o processo NAO era lider do grupo (pgid != pid).
    assert.notEqual(factos?.pgid, pid, 'sem setsid o pgid NAO e o proprio pid')
    process.kill(pid, 'SIGKILL')
    await waitFor(() => !isAlive(pid))
    assert.equal(ps(pid), undefined, 'so o kill positivo o removeu da tabela')
  })

  it('ESRCH de kill(-pid,0) num detached so aparece quando o grupo desaparece', async () => {
    const { filhoPid } = await arrancarArvore()

    // Enquanto o grupo existe, o sinal negativo RESOLVE (nada e entregue, e so
    // uma pergunta ao nucleo -- mas o nucleo sabe quem e o grupo).
    assert.doesNotThrow(() => process.kill(-filhoPid, 0), 'grupo vivo: -pid responde')

    process.kill(-filhoPid, 'SIGKILL')
    await waitFor(() => !isAlive(filhoPid))

    // Grupo morto: agora sim, ESRCH significa "nao existe".
    assert.throws(
      () => process.kill(-filhoPid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
      'grupo morto: -pid tem de dar ESRCH',
    )
  })

  it('o primitivo treeKill de src/proc/tree-kill.ts mata a arvore REAL (neto incluido)', async () => {
    const { filhoPid, netoPid } = await arrancarArvore()

    // O MESMO codigo que o supervisor corre no disposer, com dependencias reais.
    treeKill({ pid: filhoPid }, { platform: process.platform, kill: (pid, sinal) => process.kill(pid, sinal) })

    const filhoMorreu = await waitFor(() => !isAlive(filhoPid))
    const netoMorreu = await waitFor(() => !isAlive(netoPid))
    assert.equal(filhoMorreu, true)
    assert.equal(netoMorreu, true, 'o primitivo de producao tem de levar o neto junto')
  })
})
