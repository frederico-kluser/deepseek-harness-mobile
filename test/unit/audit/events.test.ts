/**
 * O VOCABULARIO FECHADO de eventos (`src/audit/events.ts`, T5.4).
 *
 * O que este teste prende:
 *
 *   1. A parte congelada no COMMIT PREP 5 NAO mudou de forma: `SessaoNovaEvent`
 *      tem `evento: 'sessao_nova'`, `resultado: 'permitido'`, `sessao_id_hash`
 *      obrigatorio e `ip_normalizado` PROIBIDO no tipo (`never`) — a decisao de
 *      S2 e estrutural: sob tunel o IP nao e confiavel e nenhum consumidor pode
 *      vir a depender do campo. As verificacoes de tipo abaixo compilam OU a
 *      suite para (`@ts-expect-error` nao usado e erro de `tsc`).
 *   2. O vocabulario e FECHADO SOBRE A REALIDADE: os nomes sao constantes
 *      distintas, a uniao `AuditEventoNome` cobre todos, e o reconhecimento
 *      aceita as formas que os EMISSORES REAIS escrevem (com sufixo de TTL,
 *      exposicao restrita, probe e rajada anonima) e recusa as malformadas —
 *      inclusive `tunel_ligar:` (origem vazia, A5).
 *   3. PARIDADE COM OS EMISSORES (T2.4/T3.x, fechados): cada nome declarado
 *      aqui tem de continuar a ser o literal que o emissor real escreve. O
 *      teste le as CONSTANTES dos emissores (`ttl.ts`, `session-auth.ts`,
 *      `probe.ts`, `magic.ts`, `log.ts`) — nunca literais duplicados — para o
 *      dia em que um divergir o vocabulario mentir e o teste ficar vermelho.
 *   4. Todo evento do vocabulario atravessa a serializacao de T2.4
 *      (`formatAuditLine`) sem perder forma e sem arrastar campos de fora — a
 *      lista branca de `format.ts` e o que impede um campo inventado de chegar
 *      ao ficheiro.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { globSync, readFileSync } from 'node:fs'

import type { AuditEvent } from '../../../src/contracts/auth.ts'
import { formatAuditLine } from '../../../src/audit/format.ts'
import { EVENTO_LACUNA as LACUNA_DO_LOG } from '../../../src/audit/log.ts'
import { EVENTO_TTL_EXPIRADO as TTL_DO_EMISSOR } from '../../../src/tunnel/ttl.ts'
import { EVENTO_PROBE as PROBE_DO_EMISSOR, EVENTO_PROBE_DECISAO as PROBE_DECISAO_DO_EMISSOR } from '../../../src/tunnel/probe.ts'
import { AUTH_EVENTS } from '../../../src/http/session-auth.ts'
import { MAGIC_CRAWLER_EVENT } from '../../../src/panel/magic.ts'
import { CSRF_REJECTION_EVENT } from '../../../src/panel/routes.ts'
import { SECRET_REJECTION_EVENT } from '../../../src/panel/secret.ts'
import {
  comporEventoToggle,
  emitSessaoNova,
  eventoDoVocabulario,
  EVENTO_AUTH_CREDENCIAL,
  EVENTO_AUTH_FALHA_JANELA,
  EVENTO_AUTH_SEGREDO_INDISPONIVEL,
  EVENTO_AUTH_SESSAO,
  EVENTO_EXPOSICAO_RESTRITA,
  EVENTO_LACUNA,
  EVENTO_MAGIC_SUSPEITO,
  EVENTO_MODO_RESTRITO,
  EVENTO_PAINEL_CSRF_RECUSADO,
  EVENTO_PAINEL_LOGIN,
  EVENTO_PAINEL_MAGIC,
  EVENTO_PAINEL_MAGIC_SEM_SINAL,
  EVENTO_PAINEL_SEGREDO,
  EVENTO_PAINEL_SEGREDO_RECUSA_ANONIMA,
  EVENTO_PROBE,
  EVENTO_PROBE_DECISAO,
  EVENTO_RELATORIO,
  EVENTO_SESSAO_NOVA,
  EVENTO_TTL_EXPIRADO,
  EVENTO_TUNEL_DESLIGAR,
  EVENTO_TUNEL_LIGAR,
  registerSessaoNovaObserver,
  type AuditEventoNome,
  type AuthFalhaJanelaEvent,
  type MagicSuspeitoEvent,
  type ModoRestritoEvent,
  type RelatorioPeriodicoEvent,
  type SessaoNovaEvent,
  type TtlExpiradoEvent,
  type TunelToggleEvent,
} from '../../../src/audit/events.ts'

/** Logger mudo para o fan-out congelado. */
const LOG_MUDO = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
}

/** Exige um nome do vocabulario em tempo de compilacao (ver o teste que o usa). */
function exigeNome(_nome: AuditEventoNome): void {}

/* ========================================================================== */
/* 1. A PARTE CONGELADA — forma intacta                                        */
/* ========================================================================== */

describe('a parte congelada do PREP 5 mantem a forma', () => {
  it('SessaoNovaEvent: sessao_nova + permitido + sessao_id_hash, SEM ip_normalizado', () => {
    // O TIPO e a forma: se a forma congelada mudar, a atribuicao abaixo deixa
    // de compilar (sessao_id_hash obrigatorio, ip_normalizado proibido).
    const valida: SessaoNovaEvent = {
      evento: 'sessao_nova',
      resultado: 'permitido',
      sessao_id_hash: 'a'.repeat(64),
    }
    assert.equal(valida.evento, 'sessao_nova')

    // @ts-expect-error — a forma congelada proibe ip_normalizado (S2: nao ha IP confiavel sob tunel).
    const comIp: SessaoNovaEvent = { evento: 'sessao_nova', resultado: 'permitido', sessao_id_hash: 'a'.repeat(64), ip_normalizado: '203.0.113.7' }
    void comIp

    // @ts-expect-error — sessao nova e SEMPRE bem-sucedida; resultado fixo.
    const negado: SessaoNovaEvent = { evento: 'sessao_nova', resultado: 'negado', sessao_id_hash: 'a'.repeat(64) }
    void negado

    // @ts-expect-error — sem sessao_id_hash nao ha agente que correlacionar.
    const semHash: SessaoNovaEvent = { evento: 'sessao_nova', resultado: 'permitido' }
    void semHash
  })

  it('registar + emitir entrega o evento ao observador e o desregisto e idempotente', () => {
    const vistos: SessaoNovaEvent[] = []
    const desregista = registerSessaoNovaObserver((evento) => {
      vistos.push(evento)
    })
    const evento: SessaoNovaEvent = {
      evento: 'sessao_nova',
      resultado: 'permitido',
      sessao_id_hash: 'b'.repeat(64),
    }

    emitSessaoNova(evento, LOG_MUDO)
    desregista()
    desregista()
    emitSessaoNova(evento, LOG_MUDO)

    assert.equal(vistos.length, 1, 'o desregisto removeu o observador')
  })

  it('um observador que LANCA nao derruba o emit nem os seguintes (best-effort)', () => {
    const ordem: string[] = []
    const desregistaA = registerSessaoNovaObserver(() => {
      ordem.push('a')
      throw new Error('observador avariado')
    })
    const desregistaB = registerSessaoNovaObserver(() => {
      ordem.push('b')
    })
    const evento: SessaoNovaEvent = {
      evento: 'sessao_nova',
      resultado: 'permitido',
      sessao_id_hash: 'c'.repeat(64),
    }
    const avisos: string[] = []
    const log = { ...LOG_MUDO, warn: (mensagem: string): void => void avisos.push(mensagem) }

    assert.doesNotThrow(() => emitSessaoNova(evento, log))
    assert.deepEqual(ordem, ['a', 'b'], 'o observador seguinte correu')
    assert.equal(avisos.length, 1, 'o erro foi registado no log do operador')

    desregistaA()
    desregistaB()
  })
})

/* ========================================================================== */
/* 2. NOMES DISTINTOS, FECHADOS E ALINHADOS AOS EMISSORES                     */
/* ========================================================================== */

describe('o vocabulario fechado', () => {
  it('os nomes sao constantes distintas', () => {
    const nomes = [
      EVENTO_SESSAO_NOVA,
      EVENTO_AUTH_SESSAO,
      EVENTO_AUTH_CREDENCIAL,
      EVENTO_AUTH_SEGREDO_INDISPONIVEL,
      EVENTO_AUTH_FALHA_JANELA,
      EVENTO_TUNEL_LIGAR,
      EVENTO_TUNEL_DESLIGAR,
      EVENTO_TTL_EXPIRADO,
      EVENTO_MODO_RESTRITO,
      EVENTO_EXPOSICAO_RESTRITA,
      EVENTO_PROBE,
      EVENTO_PROBE_DECISAO,
      EVENTO_MAGIC_SUSPEITO,
      EVENTO_PAINEL_MAGIC,
      EVENTO_PAINEL_MAGIC_SEM_SINAL,
      EVENTO_PAINEL_LOGIN,
      EVENTO_PAINEL_SEGREDO,
      EVENTO_PAINEL_SEGREDO_RECUSA_ANONIMA,
      EVENTO_PAINEL_CSRF_RECUSADO,
      EVENTO_RELATORIO,
      EVENTO_LACUNA,
    ]
    assert.equal(new Set(nomes).size, nomes.length, 'nenhum nome se repete')
  })

  it('cada constante pertence a uniao fechada (verificacao em tempo de compilacao)', () => {
    // Se um nome sair da uniao `AuditEventoNome`, esta chamada deixa de
    // compilar — e o vocabulario "fechado" passa a ser literatura.
    exigeNome(EVENTO_SESSAO_NOVA)
    exigeNome(EVENTO_AUTH_SESSAO)
    exigeNome(EVENTO_AUTH_CREDENCIAL)
    exigeNome(EVENTO_AUTH_SEGREDO_INDISPONIVEL)
    exigeNome(EVENTO_AUTH_FALHA_JANELA)
    exigeNome(EVENTO_TTL_EXPIRADO)
    exigeNome(EVENTO_MODO_RESTRITO)
    exigeNome(EVENTO_EXPOSICAO_RESTRITA)
    exigeNome(EVENTO_PROBE)
    exigeNome(EVENTO_PROBE_DECISAO)
    exigeNome(EVENTO_MAGIC_SUSPEITO)
    exigeNome(EVENTO_PAINEL_MAGIC)
    exigeNome(EVENTO_PAINEL_MAGIC_SEM_SINAL)
    exigeNome(EVENTO_PAINEL_LOGIN)
    exigeNome(EVENTO_PAINEL_SEGREDO)
    exigeNome(EVENTO_PAINEL_SEGREDO_RECUSA_ANONIMA)
    exigeNome(EVENTO_PAINEL_CSRF_RECUSADO)
    exigeNome(EVENTO_RELATORIO)
    exigeNome(EVENTO_LACUNA)
    // As formas com sufixo que os emissores reais escrevem:
    exigeNome('tunel_ligar:telegram:123')
    exigeNome('tunel_desligar:painel:a1b2c3d4')
    exigeNome('tunel_ttl_expirado:60min:timer')
    exigeNome('tunel_ttl_expirado:480min:boot')
    exigeNome('exposicao_restrita:100')
    exigeNome('tunel_probe:spa-fallback:401')
    exigeNome('tunel_probe:unguarded-canary:sem-resposta')
    exigeNome('magic.crawler-suspect_x7')
    exigeNome('painel_segredo_recusa_anonima_x3')
    exigeNome('painel_csrf_recusado_x1')
    exigeNome('auditoria_lacuna:3')
  })

  it('PARIDADE com os emissores reais — lidas as CONSTANTES, nunca literais', () => {
    assert.equal(EVENTO_LACUNA, LACUNA_DO_LOG, 'lacuna: log.ts')
    assert.equal(EVENTO_TTL_EXPIRADO, TTL_DO_EMISSOR, 'TTL: ttl.ts')
    assert.equal(EVENTO_PROBE, PROBE_DO_EMISSOR, 'probe: probe.ts')
    assert.equal(EVENTO_PROBE_DECISAO, PROBE_DECISAO_DO_EMISSOR, 'probe decisao: probe.ts')
    assert.equal(EVENTO_MAGIC_SUSPEITO, MAGIC_CRAWLER_EVENT, 'crawler-suspect: magic.ts')
    assert.equal(EVENTO_AUTH_SESSAO, AUTH_EVENTS.sessao, 'auth_sessao: session-auth.ts')
    assert.equal(EVENTO_AUTH_CREDENCIAL, AUTH_EVENTS.credencial, 'auth_credencial: session-auth.ts')
    assert.equal(EVENTO_AUTH_SEGREDO_INDISPONIVEL, AUTH_EVENTS.segredoIndisponivel, 'auth_segredo_indisponivel: session-auth.ts')
    assert.equal(EVENTO_MODO_RESTRITO, AUTH_EVENTS.modoRestrito, 'auth_modo_restrito: session-auth.ts')
    assert.equal(EVENTO_EXPOSICAO_RESTRITA, AUTH_EVENTS.exposicaoRestrita, 'exposicao_restrita: session-auth.ts')
    assert.equal(EVENTO_PAINEL_SEGREDO_RECUSA_ANONIMA, SECRET_REJECTION_EVENT, 'segredo recusa anonima: secret.ts')
    assert.equal(EVENTO_PAINEL_CSRF_RECUSADO, CSRF_REJECTION_EVENT, 'csrf recusado: routes.ts')
  })

  it('PARIDADE com os emissores de LITERAIS — cada nome real emitido e reconhecido (file:line no comentario)', () => {
    // Onde cada literal e escrito no AuditSink hoje. Se um emissor mudar o
    // nome, o reconhecedor deixa de o aceitar e este teste fica vermelho —
    // o vocabulario nao pode mentir sobre o que o codigo regista.
    const reais: ReadonlyArray<readonly [nome: string, emissor: string]> = [
      // src/http/gate.ts:421 (ponto congelado L3.1, PREP 5)
      ['sessao_nova', 'gate.ts:421'],
      // src/http/session-auth.ts:448 (estado ilegivel, fail-closed)
      ['auth_segredo_indisponivel', 'session-auth.ts:448'],
      // src/http/session-auth.ts:545 (sessao valida)
      ['auth_sessao', 'session-auth.ts:545'],
      // src/http/session-auth.ts:605 (credencial permitido/negado)
      ['auth_credencial', 'session-auth.ts:605'],
      // src/http/session-auth.ts:536 e 605 (sessao OU credencial barradas)
      ['auth_modo_restrito', 'session-auth.ts:536/605'],
      // src/http/session-auth.ts:808 (transicao para modo restrito, teto alcancado)
      ['exposicao_restrita:100', 'session-auth.ts:808'],
      // src/tunnel/ttl.ts:222 (familia <n>min:<timer|boot>)
      ['tunel_ttl_expirado:60min:timer', 'ttl.ts:222'],
      ['tunel_ttl_expirado:480min:boot', 'ttl.ts:222'],
      // src/tunnel/probe.ts:256 (familia <sonda>:<status|sem-resposta>)
      ['tunel_probe:spa-fallback:401', 'probe.ts:256'],
      ['tunel_probe:websocket-upgrade:sem-resposta', 'probe.ts:256'],
      // src/tunnel/probe.ts:260 (veredito agregado)
      ['tunel_probe_decisao', 'probe.ts:260'],
      // src/panel/magic.ts:213 -> recordAnonymousRejection (api.ts:428) com _x<n>
      ['magic.crawler-suspect_x7', 'magic.ts:213 -> api.ts:428'],
      // src/panel/magic.ts:226 (magic negado) e 247 (magic permitido)
      ['painel_magic', 'magic.ts:226/247'],
      // src/panel/magic.ts:247 (sinal de clique ausente)
      ['painel_magic_sem_sinal_de_clique', 'magic.ts:247'],
      // src/panel/routes.ts:474 -> recordAnonymousRejection (api.ts:428)
      ['painel_csrf_recusado_x1', 'routes.ts:474 -> api.ts:428'],
      // src/panel/routes.ts:476 (com sessao valida, sem rajada)
      ['painel_csrf_recusado', 'routes.ts:476'],
      // src/panel/secret.ts:139 -> recordAnonymousRejection (api.ts:428)
      ['painel_segredo_recusa_anonima_x3', 'secret.ts:139 -> api.ts:428'],
      // src/panel/secret.ts:156
      ['painel_segredo', 'secret.ts:156'],
      // src/panel/api.ts:620 e 636
      ['painel_login', 'api.ts:620/636'],
      // src/audit/log.ts:301 (familia :<n>)
      ['auditoria_lacuna:3', 'log.ts:301'],
      // src/audit/notify.ts:431 (relatorio periodico: escreve e depois notifica)
      ['relatorio_periodico', 'notify.ts:431'],
    ]
    for (const [nome, emissor] of reais) {
      assert.equal(eventoDoVocabulario(nome), true, `${nome} e emitido em ${emissor} e tem de ser reconhecido`)
    }
  })

  it('HONESTIDADE (costura): os nomes marcados PENDENTE NAO tem emissor em src/ nem worker/', () => {
    // Os nomes PENDENTE so podem aparecer no proprio vocabulario (declaracao,
    // comentario) e no consumidor notify.ts (checagem de prefixo do texto).
    // A COSTURA pos-onda cria os emissores (o controlador de T5.1 para os
    // toggles; o caminho de autenticacao + limitador para a primeira falha da
    // janela) — e ela, e so ela, tira o nome desta lista e o poe na lista de
    // emitidos acima. Se um emissor chegar antes, este teste fica vermelho.
    const excecoes = new Set(['audit/events.ts', 'audit/notify.ts'])
    const pendentes: ReadonlyArray<readonly [nome: string, costura: string]> = [
      ['auth_falha_primeira_janela', 'caminho de autenticacao + limitador (por janela de 10 min)'],
      ['EVENTO_AUTH_FALHA_JANELA', 'caminho de autenticacao + limitador (por janela de 10 min)'],
      ['tunel_ligar', 'controlador de T5.1 (toggle ligar, origem no sufixo)'],
      ['EVENTO_TUNEL_LIGAR', 'controlador de T5.1 (toggle ligar, origem no sufixo)'],
      ['tunel_desligar', 'controlador de T5.1 (toggle desligar, origem no sufixo)'],
      ['EVENTO_TUNEL_DESLIGAR', 'controlador de T5.1 (toggle desligar, origem no sufixo)'],
    ]
    const achados: string[] = []
    for (const raiz of ['../../../src', '../../../worker']) {
      for (const arquivo of globSync('**/*.ts', { cwd: new URL(raiz, import.meta.url) })) {
        if (excecoes.has(arquivo)) continue
        const texto = readFileSync(new URL(`${raiz}/${arquivo}`, import.meta.url), 'utf8')
        for (const [nome, costura] of pendentes) {
          if (texto.includes(nome)) {
            achados.push(`${raiz}/${arquivo} menciona ${nome} (costura: ${costura})`)
          }
        }
      }
    }
    assert.deepEqual(
      achados,
      [],
      'nenhum emissor escreve os nomes PENDENTE hoje — quando a costura os emitir, este teste obriga a atualizar a lista',
    )
  })

  it('comporEventoToggle produz o nome completo com a origem no sufixo', () => {
    assert.equal(comporEventoToggle('ligar', 'telegram:123456'), 'tunel_ligar:telegram:123456')
    assert.equal(comporEventoToggle('desligar', 'painel:a1b2c3d4'), 'tunel_desligar:painel:a1b2c3d4')
  })

  it('A5: comporEventoToggle RECUSA origem vazia — `tunel_ligar:` nao entra no log', () => {
    assert.throws(() => comporEventoToggle('ligar', ''), /EVENTO_TOGGLE_SEM_ORIGEM/u)
    assert.throws(() => comporEventoToggle('desligar', ''), /EVENTO_TOGGLE_SEM_ORIGEM/u)
  })

  it('eventoDoVocabulario reconhece as formas REAIS e recusa as malformadas', () => {
    // Os nomes base, incluindo os dos emissores fechados. Os PREFIXOS de
    // toggle ficam de fora de proposito: o nome sem sufixo nao designa ninguem.
    for (const nome of [
      EVENTO_SESSAO_NOVA,
      EVENTO_AUTH_SESSAO,
      EVENTO_AUTH_CREDENCIAL,
      EVENTO_AUTH_SEGREDO_INDISPONIVEL,
      EVENTO_AUTH_FALHA_JANELA,
      EVENTO_TTL_EXPIRADO,
      EVENTO_MODO_RESTRITO,
      EVENTO_EXPOSICAO_RESTRITA,
      EVENTO_PROBE,
      EVENTO_PROBE_DECISAO,
      EVENTO_MAGIC_SUSPEITO,
      EVENTO_PAINEL_MAGIC,
      EVENTO_PAINEL_MAGIC_SEM_SINAL,
      EVENTO_PAINEL_LOGIN,
      EVENTO_PAINEL_SEGREDO,
      EVENTO_PAINEL_SEGREDO_RECUSA_ANONIMA,
      EVENTO_PAINEL_CSRF_RECUSADO,
      EVENTO_RELATORIO,
      EVENTO_LACUNA,
    ]) {
      assert.equal(eventoDoVocabulario(nome), true, `${nome} pertence ao vocabulario`)
    }
    // As familias com sufixo, na forma que os emissores REALMENTE escrevem:
    for (const nome of [
      'tunel_ttl_expirado:60min:timer',
      'tunel_ttl_expirado:480min:boot',
      'exposicao_restrita:100',
      'tunel_probe:spa-fallback:401',
      'tunel_probe:api-rpc:401',
      'tunel_probe:websocket-upgrade:sem-resposta',
      'tunel_probe:unguarded-canary:404',
      'magic.crawler-suspect_x7',
      'painel_segredo_recusa_anonima_x3',
      'painel_csrf_recusado_x1',
      'auditoria_lacuna:7',
      'tunel_ligar:telegram:123',
      'tunel_desligar:painel:a1b2c3d4',
    ]) {
      assert.equal(eventoDoVocabulario(nome), true, `${nome} pertence ao vocabulario`)
    }
    // As formas que NAO designam ninguem:
    for (const nome of [
      '',
      'sessao_nova_extra',
      'tunel_ligar', // o prefixo SEM sufixo nao designa ninguem (a uniao so tem a forma com sufixo)
      'tunel_desligar',
      'tunel_ligar:', // origem vazia (A5): nao designa ninguem
      'tunel_desligar:',
      'auth_falha', // nome incompleto do vocabulario
      'login_ok',
      'auditoria_lacuna_extra:1',
      'auditoria_lacuna:', // contagem vazia
      'tunel_ttl_expirado:60min:', // detetor vazio
      'tunel_ttl_expirado:60min:foo', // detetor impossivel
      'tunel_ttl_expirado:abcmin:timer', // minutos nao numericos
      'exposicao_restrita:', // contagem vazia
      'exposicao_restrita:abc',
      'tunel_probe:', // sem sonda
      'tunel_probe:spa-fallback:', // sem status
      'tunel_probe:inventada:401', // sonda fora do vocabulario fechado
      'tunel_probe_decisao:xx',
      'magic.crawler-suspect_x', // rajada sem contagem
      'magic.crawler-suspect_xabc',
      'painel_csrf_recusado_x1x',
    ]) {
      assert.equal(eventoDoVocabulario(nome), false, `${JSON.stringify(nome)} nao pertence`)
    }
  })
})

/* ========================================================================== */
/* 3. SERIALIZACAO DE T2.4 — a lista branca e o formato                        */
/* ========================================================================== */

describe('os eventos do vocabulario atravessam a serializacao de T2.4', () => {
  const TS = 1_700_000_000_000
  const HASH = 'd'.repeat(64)

  /** Serializa e devolve o registo parseado, com a lista branca aplicada. */
  function registo(evento: AuditEvent): Record<string, unknown> {
    return JSON.parse(formatAuditLine(evento, TS)) as Record<string, unknown>
  }

  it('o registo tem EXATAMENTE as cinco chaves da lista branca, sempre', () => {
    const linha = registo({ evento: 'auth_falha_primeira_janela', resultado: 'negado' })
    assert.deepEqual(
      Object.keys(linha).toSorted(),
      ['evento', 'ip_normalizado', 'resultado', 'sessao_id_hash', 'ts'],
    )
  })

  it('um campo inventado e DESCARTADO pela lista branca (nao ha caminho ate ao ficheiro)', () => {
    const inventado = registo({
      evento: 'tunel_ligar:telegram:1',
      resultado: 'permitido',
      // Campo de codigo futuro, ou de um JSON.parse alheio: cai fora da lista.
      origem: 'telegram:1',
      senha_tentada: 'qualquer-coisa',
    } as AuditEvent)
    assert.equal('origem' in inventado, false)
    assert.equal('senha_tentada' in inventado, false)
    assert.equal(inventado['evento'], 'tunel_ligar:telegram:1')
  })

  it('sessao_nova preserva o hash e o resultado no registo', () => {
    const evento: SessaoNovaEvent = {
      evento: 'sessao_nova',
      resultado: 'permitido',
      sessao_id_hash: HASH,
    }
    const registado = registo(evento)
    assert.equal(registado['evento'], 'sessao_nova')
    assert.equal(registado['resultado'], 'permitido')
    assert.equal(registado['sessao_id_hash'], HASH)
  })

  it('toggle com origem completa: o sufixo e parte do nome, nao um campo', () => {
    const evento: TunelToggleEvent = {
      evento: comporEventoToggle('desligar', 'painel:a1b2c3d4'),
      resultado: 'permitido',
    }
    const registado = registo(evento)
    assert.equal(registado['evento'], 'tunel_desligar:painel:a1b2c3d4')
  })

  it('os demais eventos do vocabulario serializam com o resultado correto', () => {
    const casos: ReadonlyArray<{ evento: AuditEvent; resultado: string }> = [
      { evento: { evento: 'auth_falha_primeira_janela', resultado: 'negado', ip_normalizado: '203.0.113.7' } satisfies AuthFalhaJanelaEvent, resultado: 'negado' },
      { evento: { evento: 'tunel_ttl_expirado:60min:timer', resultado: 'permitido' } satisfies TtlExpiradoEvent, resultado: 'permitido' },
      { evento: { evento: 'auth_modo_restrito', resultado: 'negado' } satisfies ModoRestritoEvent, resultado: 'negado' },
      { evento: { evento: 'magic.crawler-suspect', resultado: 'negado' } satisfies MagicSuspeitoEvent, resultado: 'negado' },
      { evento: { evento: 'relatorio_periodico', resultado: 'permitido' } satisfies RelatorioPeriodicoEvent, resultado: 'permitido' },
    ]
    for (const { evento, resultado } of casos) {
      const registado = registo(evento)
      assert.equal(registado['evento'], evento.evento)
      assert.equal(registado['resultado'], resultado)
    }
  })

  it('o ip_normalizado da primeira falha chega ao registo normalizado', () => {
    const evento: AuthFalhaJanelaEvent = {
      evento: 'auth_falha_primeira_janela',
      resultado: 'negado',
      ip_normalizado: '203.0.113.7',
    }
    assert.equal(registo(evento)['ip_normalizado'], '203.0.113.7')
  })
})
