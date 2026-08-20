/**
 * =============================================================================
 * A SUPERFICIE ISENTA DE CREDENCIAL -- suite adversarial de T3.4
 * =============================================================================
 *
 * `04-TESTES.md` 5.9 (PANEL-001..PANEL-010) e `03-ONDAS.md` T3.4.
 *
 * PORQUE ISTO E UM TESTE DE SEGURANCA E NAO DE UNIDADE. As rotas isentas do gate
 * sao A UNICA SUPERFICIE DO SISTEMA ALCANCAVEL DA INTERNET SEM CREDENCIAL. Com o
 * tunel de pe, e literalmente tudo o que um scanner anonimo enxerga. Um furo por
 * omissao aqui anula todas as outras camadas -- o gate, o limitador, o segredo,
 * a sessao -- porque nenhuma delas chega a ser consultada.
 *
 * AS QUATRO AFIRMACOES QUE ESTA SUITE FALSIFICA:
 *
 *  1. A isencao e ENUMERADA. Uma rota nova, acrescentada sem tocar na tabela,
 *     nasce GUARDADA. (PANEL-009)
 *  2. O 404 de `/__guard/secret` sem `ott` e BYTE A BYTE o de rota inexistente.
 *     Comparado no FIO, com socket cru, e nao pelo cliente do `node:http` --
 *     que normaliza a linha de estado, minuscula e reordena cabecalhos e esconde
 *     o enquadramento. (PANEL-003/PANEL-004)
 *  3. Nenhuma resposta isenta enumera versao, hostname, caminho de ficheiro ou
 *     servidor identificavel. (PANEL-010)
 *  4. A URL do tunel NAO sai antes do login. Procurada por SUBSTRING no corpo,
 *     porque um 401 com a URL la dentro passa num teste de codigo de estado.
 *
 * PORQUE A BANCADA VEM DE `test/unit/panel/harness.ts`: ela e o unico sitio que
 * poe `res.sendDate = false` e sobe o painel em porta efemera. Duplica-la aqui
 * criava duas bancadas que divergiriam -- e a que divergisse seria esta, que so
 * corre em `pnpm test:security`.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { AuditEvent } from '../../src/contracts/auth.ts'
import type { WriteSyscall } from '../../src/audit/log.ts'
import { openAuditLog } from '../../src/audit/log.ts'

import type { PanelRoute } from '../../src/panel/routes.ts'
import { CSRF_HEADER_NAME } from '../../src/panel/csrf.ts'
import {
  PANEL_PATH_LOGIN,
  PANEL_PATH_MAGIC,
  PANEL_PATH_ROOT,
  PANEL_PATH_SECRET,
  PANEL_PATH_STATE,
  panelPublicRouteKeys,
  panelRoutes,
  policyForRoute,
  routeKeyOf,
} from '../../src/panel/routes.ts'
import { AUDIT_BURST_QUIET_MS } from '../../src/panel/api.ts'
import {
  criarBancada,
  getCru,
  pedir,
  pedirCru,
  postCru,
  SNAPSHOT_ONLINE,
  URL_DO_TUNEL,
  type Bancada,
} from '../unit/panel/harness.ts'

const PANEL_DIR = fileURLToPath(new URL('../../src/panel/', import.meta.url))

/**
 * A LISTA ESCRITA A MAO.
 *
 * Ela existe para ser comparada com a tabela por IGUALDADE DE CONJUNTO. Nao e
 * duplicacao: e a segunda testemunha. Acrescentar uma isencao em
 * `src/panel/routes.ts` sem a acrescentar aqui deixa este caso VERMELHO, que e
 * exatamente o efeito pretendido -- abrir uma rota a internet passa a exigir
 * dois gestos deliberados, num ficheiro de codigo e num de seguranca.
 */
const ISENCOES_ESPERADAS: readonly string[] = [
  `POST ${PANEL_PATH_LOGIN}`,
  `GET ${PANEL_PATH_MAGIC}`,
  `POST ${PANEL_PATH_MAGIC}`,
  `GET ${PANEL_PATH_SECRET}`,
]

describe('PANEL-009 · a tabela de isencao e enumerada, nunca inferida', () => {
  it('a tabela e a lista escrita a mao coincidem por IGUALDADE DE CONJUNTO', () => {
    assert.deepEqual(new Set(panelPublicRouteKeys()), new Set(ISENCOES_ESPERADAS))
    assert.equal(panelPublicRouteKeys().length, ISENCOES_ESPERADAS.length)
  })

  it('as rotas do plano de controlo NAO estao isentas', () => {
    for (const chave of [
      `GET ${PANEL_PATH_ROOT}`,
      `GET ${PANEL_PATH_STATE}`,
      'POST /__guard/api/tunnel/start',
      'POST /__guard/api/tunnel/stop',
    ]) {
      assert.equal(ISENCOES_ESPERADAS.includes(chave), false)
    }
  })

  it('ESTRUTURAL: so `routes.ts` conhece a palavra `publica`', () => {
    // Se outro ficheiro de `src/panel/**` decidir politica, a tabela deixa de
    // ser a UNICA fonte de excecao e o controlo evapora-se sem que nenhum teste
    // de comportamento acuse.
    const culpados = readdirSync(PANEL_DIR)
      .filter((nome) => nome.endsWith('.ts') && nome !== 'routes.ts')
      .filter((nome) => /'publica'/u.test(readFileSync(`${PANEL_DIR}${nome}`, 'utf8')))

    assert.deepEqual(culpados, [])
  })

  it('ESTRUTURAL: existe UM unico literal `status: 404` em todo o `src/panel/**`', () => {
    // Dois literais de 404 sao dois 404 que divergem na primeira melhoria de
    // redaccao -- e a divergencia e o oraculo que PANEL-004 proibe.
    const ocorrencias = readdirSync(PANEL_DIR)
      .filter((nome) => nome.endsWith('.ts'))
      .flatMap((nome) => readFileSync(`${PANEL_DIR}${nome}`, 'utf8').match(/status:\s*404/gu) ?? [])

    assert.equal(ocorrencias.length, 1)
  })
})

describe('PANEL-009 · uma rota nova sem entrada na tabela nasce GUARDADA', () => {
  let bancada: Bancada
  let port = 0

  /**
   * Uma rota qualquer. O ponto e ela nao ter NADA que a marque como guardada:
   * quem a escreve nao precisa de saber que existe uma tabela. Se ela nascesse
   * publica por omissao, a revisao adversarial rejeitava o desenho.
   */
  const ROTA_ESQUECIDA: PanelRoute = {
    method: 'GET',
    path: '/__guard/api/diagnostico',
    handler: async () => ({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ url: URL_DO_TUNEL }),
    }),
  }

  before(async () => {
    bancada = criarBancada({ estado: SNAPSHOT_ONLINE })
    port = await bancada.servir((d, g) => [...panelRoutes(d, g), ROTA_ESQUECIDA])
  })

  after(async () => {
    await bancada.fechar()
  })

  it('a politica dela e `exige-sessao` sem ninguem a ter declarado', () => {
    assert.equal(policyForRoute('GET', ROTA_ESQUECIDA.path), 'exige-sessao')
  })

  it('anonimamente ela responde 401 e nao entrega um byte do que serviria', async () => {
    const resposta = await pedir(port, ROTA_ESQUECIDA.path)

    assert.equal(resposta.status, 401)
    assert.equal(resposta.body.includes(URL_DO_TUNEL), false)
    assert.equal(resposta.body.includes('trycloudflare'), false)
  })
})

describe('PANEL-003/PANEL-004 · o 404 e byte a byte o de rota inexistente', () => {
  let bancada: Bancada
  let port = 0
  let referencia = ''

  before(async () => {
    bancada = criarBancada({ comSegredo: true })
    port = await bancada.servir()
    referencia = await pedirCru(port, getCru('/__guard/rota-que-nunca-existiu'))
  })

  after(async () => {
    await bancada.fechar()
  })

  it('a resposta de referencia e mesmo um 404 anodino', () => {
    assert.match(referencia, /^HTTP\/1\.1 404 Not Found\r\n/u)
  })

  it('`/__guard/secret` SEM `ott` e byte a byte a referencia', async () => {
    assert.equal(await pedirCru(port, getCru(PANEL_PATH_SECRET)), referencia)
  })

  it('`/__guard/secret` com `ott` invalido e byte a byte a referencia', async () => {
    assert.equal(
      await pedirCru(port, getCru(`${PANEL_PATH_SECRET}?ott=ABCDEFGHIJKLMNOPQRSTUVWXYZ234567`)),
      referencia,
    )
  })

  it('`/__guard/secret` com `ott` JA CONSUMIDO e byte a byte a referencia', async () => {
    const ott = bancada.ott.issue().token
    const servida = await pedirCru(port, getCru(`${PANEL_PATH_SECRET}?ott=${ott}`))
    assert.match(servida, /^HTTP\/1\.1 200 OK\r\n/u)

    assert.equal(await pedirCru(port, getCru(`${PANEL_PATH_SECRET}?ott=${ott}`)), referencia)
  })

  it('duas rotas inexistentes DIFERENTES dao a mesma resposta -- o caminho nao ecoa', async () => {
    const a = await pedirCru(port, getCru('/__guard/aaa'))
    const b = await pedirCru(port, getCru('/__guard/bbbbbbbbbbbbbbbbbbbbbbbb'))

    assert.equal(a, referencia)
    assert.equal(b, referencia)
  })

  it('o canario do probe, visto da BORDA, e o mesmo 404 (PANEL-008)', async () => {
    assert.equal(await pedirCru(port, getCru('/__guard/probe-canary-7f3a91')), referencia)
  })
})

describe('PANEL-010 · a superficie isenta nao enumera nada', () => {
  let bancada: Bancada
  let port = 0
  /**
   * `doPainel` distingue o que ESTE ficheiro escreve do desafio 401, que vem de
   * `src/http/responses.ts` e e reutilizado de proposito para que o 401 do
   * painel seja byte a byte o 401 do gate.
   *
   * ELE JA NAO E UMA ISENCAO. A versao anterior desta suite excluia o 401 da
   * asercao de `Referrer-Policy` porque a funcao partilhada nao o emitia, e
   * acrescenta-lo do lado do painel teria QUEBRADO a igualdade byte a byte --
   * que e uma propriedade de seguranca, nao arrumacao. A costura da Onda 3
   * acrescentou o cabecalho na propria `challengeBasicAuth`, ou seja nos DOIS
   * lados ao mesmo tempo, e a exclusao caiu. O campo fica porque a distincao
   * "quem escreveu esta resposta" continua a ser util a leitura.
   */
  const respostas: Array<{ readonly nome: string; readonly bruta: string; readonly doPainel: boolean }> = []

  before(async () => {
    bancada = criarBancada({ comSegredo: true, estado: SNAPSHOT_ONLINE })
    port = await bancada.servir()

    const recolher = async (nome: string, bruto: string, doPainel: boolean): Promise<void> => {
      respostas.push({ nome, bruta: await pedirCru(port, bruto), doPainel })
    }

    await recolher('404 de rota inexistente', getCru('/__guard/rota-que-nunca-existiu'), true)
    await recolher('404 do segredo sem ott', getCru(PANEL_PATH_SECRET), true)
    await recolher('pagina inerte do magic', getCru(PANEL_PATH_MAGIC), true)
    await recolher('401 do painel', getCru(PANEL_PATH_ROOT), false)
    await recolher('401 do estado', getCru(PANEL_PATH_STATE), false)
    await recolher('403 do login sem csrf', postCru(PANEL_PATH_LOGIN, 'segredo=ERRADA'), true)
  })

  after(async () => {
    await bancada.fechar()
  })

  it('nenhuma resposta traz `Server`, versao, hostname ou caminho de ficheiro', () => {
    for (const { nome, bruta } of respostas) {
      assert.equal(/^server:/imu.test(bruta), false, `${nome}: cabecalho Server identificavel`)
      assert.equal(/^x-powered-by:/imu.test(bruta), false, nome)
      assert.equal(bruta.includes('dsh-guarded-bot-orchestrator'), false, `${nome}: nome do plugin`)
      assert.equal(/\bv?\d+\.\d+\.\d+\b/u.test(bruta), false, `${nome}: numero de versao`)
      assert.equal(bruta.includes('/home/'), false, `${nome}: caminho absoluto`)
      assert.equal(bruta.includes('node_modules'), false, nome)
      assert.equal(/at [A-Za-z]+ \(/u.test(bruta), false, `${nome}: rasto de pilha`)
    }
  })

  it('nenhuma resposta anonima traz a URL do tunel nem o segredo', () => {
    for (const { nome, bruta } of respostas) {
      assert.equal(bruta.includes(URL_DO_TUNEL), false, nome)
      assert.equal(bruta.includes('trycloudflare'), false, nome)
      assert.equal(bruta.includes(String(bancada.segredo)), false, nome)
    }
  })

  it('toda resposta anonima e `Cache-Control: no-store` -- nada disto fica em cache', () => {
    for (const { nome, bruta } of respostas) {
      assert.match(bruta, /^cache-control: no-store\r$/imu, nome)
    }
  })

  it('TODA resposta -- incluindo o 401 partilhado -- e `Referrer-Policy: no-referrer`', () => {
    // Sem isto, um clique a partir da pagina do segredo ou do link magico
    // levava a URL do quick tunnel -- o endereco publico da maquina do dono --
    // para dentro do log do servidor de destino. O 401 conta duplamente: ele e
    // servido a TODA a superficie interceptada, incluindo o fallback da SPA do
    // DSH, que nao e nosso e nao tem a CSP `default-src 'none'` do painel.
    for (const { nome, bruta } of respostas) {
      assert.match(bruta, /^referrer-policy: no-referrer\r$/imu, nome)
    }
  })

  it('e o 401 do painel continua a NAO ter nada que o distinga do 401 do gate', () => {
    // A igualdade byte a byte propriamente dita esta em
    // `test/security/desafio-401.test.ts`, com os DOIS servidores. Aqui fica o
    // fio de alarme local: os dois 401 desta suite tem de ser iguais entre si.
    const desafios = respostas.filter(({ doPainel }) => !doPainel).map(({ bruta }) => bruta)
    assert.equal(desafios.length, 2)
    assert.equal(desafios[0], desafios[1], 'dois 401 do mesmo painel ja divergiram')
  })
})

describe('a URL do tunel nao existe antes do login', () => {
  let bancada: Bancada
  let port = 0

  before(async () => {
    bancada = criarBancada({ estado: SNAPSHOT_ONLINE })
    port = await bancada.servir()
  })

  after(async () => {
    await bancada.fechar()
  })

  it('`GET /__guard/api/state` anonimo nao contem a substring da URL', async () => {
    const bruta = await pedirCru(port, getCru(PANEL_PATH_STATE))

    assert.match(bruta, /^HTTP\/1\.1 401 /u)
    assert.equal(bruta.includes(URL_DO_TUNEL), false)
    assert.equal(bruta.includes('trycloudflare'), false)
    assert.equal(bruta.includes('READY'), false)
  })

  it('a mesma rota COM sessao entrega a URL -- o teste anterior mede algo', async () => {
    const id = bancada.sessions.create()
    const resposta = await pedir(port, PANEL_PATH_STATE, { cookie: `__Host-dsh_sid=${id}` })

    assert.equal(resposta.status, 200)
    assert.ok(resposta.body.includes(URL_DO_TUNEL))
  })
})

describe('o login nao e um oraculo, medido no FIO', () => {
  it('senha errada e senha certa sem conta provisionada sao bytes iguais', async () => {
    const comConta = criarBancada({ comSegredo: true })
    const portaComConta = await comConta.servir()
    const tokenComConta = comConta.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))

    const semConta = criarBancada()
    const portaSemConta = await semConta.servir()
    const tokenSemConta = semConta.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))

    const errada = await pedirCru(
      portaComConta,
      postCru(PANEL_PATH_LOGIN, 'segredo=ERRADAERRADAERRADA', [
        `${CSRF_HEADER_NAME}: ${tokenComConta}`,
      ]),
    )
    const certaSemConta = await pedirCru(
      portaSemConta,
      postCru(PANEL_PATH_LOGIN, `segredo=${String(comConta.segredo)}`, [
        `${CSRF_HEADER_NAME}: ${tokenSemConta}`,
      ]),
    )

    await comConta.fechar()
    await semConta.fechar()

    assert.match(errada, /^HTTP\/1\.1 401 /u)
    assert.equal(certaSemConta, errada)
    assert.equal(/^retry-after:/imu.test(errada), false)
    assert.equal(/^set-cookie:/imu.test(errada), false)
  })
})

/* ========================================================================== */
/* ALTA-1 e ALTA-2 -- achados da revisao adversarial, com o sink REAL          */
/* ========================================================================== */

/**
 * Abre um `audit.log` de verdade, fora do workspace, com a chamada ao sistema
 * de escrita INSTRUMENTADA.
 *
 * PORQUE O SINK REAL E NAO UM DUBLE: a versao anterior desta suite media tudo
 * contra `(e) => eventos.push(e)`. Esse duble nao escreve, nao falha e nao
 * demora -- ou seja, remove exatamente as tres propriedades em causa. Um teste
 * de seguranca que apaga a variavel que estuda atesta o que nao mede.
 *
 * `openAuditLog` expoe `write` como costura declarada ("para o teste simular
 * ENOSPC sem encher o disco"), portanto contar chamadas e usar a porta da
 * frente, nao espreitar pelo lado.
 */
function abrirLogInstrumentado(): {
  readonly log: ReturnType<typeof openAuditLog>
  readonly caminho: string
  chamadas: number
  cheio: boolean
} {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-guard-auditoria-'))
  const caminho = join(dir, 'guarded-bot', 'audit.log')

  const estado = { log: undefined as unknown as ReturnType<typeof openAuditLog>, caminho, chamadas: 0, cheio: false }

  const write: WriteSyscall = (fd, data) => {
    if (estado.cheio) {
      const erro: NodeJS.ErrnoException = new Error('no space left on device')
      erro.code = 'ENOSPC'
      throw erro
    }
    estado.chamadas += 1
    return writeSync(fd, data)
  }

  estado.log = openAuditLog({ path: caminho, write })
  return estado
}

describe('ALTA-1 · uma recusa anonima nao e uma torneira para o disco do dono', () => {
  const PEDIDOS = 300

  it('300 `ott` invalidos escrevem 9 linhas; os 300 SEGUINTES escrevem UMA', async () => {
    const sink = abrirLogInstrumentado()
    const bancada = criarBancada({ comSegredo: true, deps: { audit: sink.log } })
    const port = await bancada.servir()

    const sondar = async (de: number, ate: number): Promise<void> => {
      for (let i = de; i < ate; i += 1) await pedir(port, `${PANEL_PATH_SECRET}?ott=lixo-numero-${i}`)
    }

    await sondar(0, PEDIDOS)
    const aposPrimeiros = sink.chamadas
    const tamanhoAposPrimeiros = statSync(sink.caminho).size

    await sondar(PEDIDOS, PEDIDOS * 2)
    const aposSegundos = sink.chamadas

    sink.log.dispose()
    await bancada.fechar()

    // Limiares exponenciais: 1, 2, 4, 8, 16, 32, 64, 128, 256 => NOVE linhas
    // para os primeiros 300. Deterministico, sem cronometro e sem flake -- e
    // este e o guarda de regressao que substitui a afirmacao de tempo que a
    // revisao derrubou.
    assert.equal(aposPrimeiros, 9)

    // E AQUI ESTA O LIMITE, dito da forma que nao depende de nenhuma constante
    // arrancada do ar: DOBRAR o numero de pedidos acrescenta UMA linha, nao
    // mais 300. Antes desta correcao, 600 pedidos escreviam 600 linhas.
    assert.equal(aposSegundos, 10)

    // Ordem de grandeza, para o registo: ~1 KiB por 300 pedidos, contra os
    // ~43 KiB que a versao anterior escrevia -- e a revisao mediu 1405 KiB/s.
    assert.ok(tamanhoAposPrimeiros < 4096, `${tamanhoAposPrimeiros} B para ${PEDIDOS} pedidos`)
  })

  it('300 recusas de CSRF anonimas tambem, e a magnitude fica no registo', async () => {
    const eventos: AuditEvent[] = []
    const bancada = criarBancada({ deps: { audit: { append: (e) => void eventos.push(e) } } })
    const port = await bancada.servir()

    for (let i = 0; i < PEDIDOS; i += 1) {
      await pedir(port, PANEL_PATH_LOGIN, { method: 'POST', body: `segredo=x${i}` })
    }
    await bancada.fechar()

    assert.equal(eventos.length, 9)
    // A contagem sobrevive sem um campo novo: `AuditEvent` e contrato congelado.
    assert.equal(eventos.at(-1)?.evento, 'painel_csrf_recusado_x256')
    assert.ok(eventos.every((e) => e.resultado === 'negado'))
  })

  it('uma sonda ISOLADA continua a produzir a sua linha, na hora', async () => {
    const eventos: AuditEvent[] = []
    const bancada = criarBancada({ comSegredo: true, deps: { audit: { append: (e) => void eventos.push(e) } } })
    const port = await bancada.servir()

    await pedir(port, `${PANEL_PATH_SECRET}?ott=uma-sonda-so`)
    await bancada.fechar()

    // Agregar nao pode virar silenciar: a primeira recusa da rajada e sempre
    // escrita, senao um scanner discreto passava sem deixar rasto nenhum.
    assert.equal(eventos.length, 1)
    assert.match(String(eventos[0]?.evento), /_x1$/u)
  })

  it('um intervalo de silencio abre rajada NOVA -- a agregacao nao cega o log', async () => {
    const eventos: AuditEvent[] = []
    const bancada = criarBancada({ comSegredo: true, deps: { audit: { append: (e) => void eventos.push(e) } } })
    const port = await bancada.servir()

    await pedir(port, `${PANEL_PATH_SECRET}?ott=a`)
    await pedir(port, `${PANEL_PATH_SECRET}?ott=b`)
    bancada.clock.advance(AUDIT_BURST_QUIET_MS)
    await pedir(port, `${PANEL_PATH_SECRET}?ott=c`)
    await bancada.fechar()

    // 1, 2 (limiares da primeira rajada) e 1 outra vez (rajada nova).
    assert.deepEqual(
      eventos.map((e) => e.evento.slice(e.evento.lastIndexOf('_x'))),
      ['_x1', '_x2', '_x1'],
    )
  })

  it('e o 404 de rota inexistente continua a nao escrever UMA linha', async () => {
    const sink = abrirLogInstrumentado()
    const bancada = criarBancada({ deps: { audit: sink.log } })
    const port = await bancada.servir()

    for (let i = 0; i < 50; i += 1) await pedir(port, `/__guard/nada-${i}`)

    const tamanho = statSync(sink.caminho).size
    sink.log.dispose()
    await bancada.fechar()

    assert.equal(sink.chamadas, 0)
    assert.equal(tamanho, 0)
  })
})

describe('ALTA-2 · disco cheio nao vira oraculo, e D9 aguenta', () => {
  it('com o disco cheio, `/__guard/secret` continua a devolver o 404 IDENTICO', async () => {
    const sink = abrirLogInstrumentado()
    const bancada = criarBancada({ comSegredo: true, deps: { audit: sink.log } })
    const port = await bancada.servir()

    const referencia = await pedirCru(port, getCru('/__guard/rota-que-nunca-existiu'))
    sink.cheio = true

    const semOtt = await pedirCru(port, getCru(PANEL_PATH_SECRET))
    const comLixo = await pedirCru(port, getCru(`${PANEL_PATH_SECRET}?ott=lixo`))
    const desconhecidaComDiscoCheio = await pedirCru(port, getCru('/__guard/rota-que-nunca-existiu'))

    sink.log.dispose()
    await bancada.fechar()

    // Antes desta correcao: 500 Internal Server Error, que ANUNCIA que a rota
    // existe a quem varre quick tunnels -- e o que ela devolve destrancada e a
    // senha permanente.
    assert.equal(semOtt, referencia)
    assert.equal(comLixo, referencia)
    assert.equal(desconhecidaComDiscoCheio, referencia)
  })

  it('com o disco cheio, o login continua a devolver o 401 de D9 e nao um 500', async () => {
    const sink = abrirLogInstrumentado()
    const bancada = criarBancada({ comSegredo: true, deps: { audit: sink.log } })
    const port = await bancada.servir()
    const token = bancada.csrf.issue(routeKeyOf('POST', PANEL_PATH_LOGIN))

    const saudavel = await pedirCru(
      port,
      postCru(PANEL_PATH_LOGIN, 'segredo=ERRADA', [`${CSRF_HEADER_NAME}: ${token}`]),
    )
    sink.cheio = true
    const comDiscoCheio = await pedirCru(
      port,
      postCru(PANEL_PATH_LOGIN, 'segredo=ERRADA', [`${CSRF_HEADER_NAME}: ${token}`]),
    )

    sink.log.dispose()
    await bancada.fechar()

    assert.match(saudavel, /^HTTP\/1\.1 401 /u)
    assert.equal(comDiscoCheio, saudavel)
    // O operador fica a saber; o cliente nao.
    assert.ok(bancada.logs.some((l) => l.includes('falha ao registar auditoria')))
  })

  it('a topologia de disco nao sai no fio NEM no log do operador', async () => {
    const sink = abrirLogInstrumentado()
    const bancada = criarBancada({ comSegredo: true, deps: { audit: sink.log } })
    const port = await bancada.servir()
    sink.cheio = true

    const resposta = await pedirCru(port, getCru(`${PANEL_PATH_SECRET}?ott=lixo`))
    sink.log.dispose()
    await bancada.fechar()

    // `AuditWriteError.path` esta marcado NAO APRESENTAVEL pelo proprio modulo.
    assert.equal(resposta.includes(sink.caminho), false)
    assert.equal(bancada.logs.join('\n').includes(sink.caminho), false)
    assert.equal(resposta.includes(tmpdir()), false)
  })
})
