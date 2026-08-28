/**
 * Vocabulario fechado de eventos de auditoria e de notificacao. DONO: T5.4.
 *
 * O COMMIT PREP 5 congela AQUI apenas o que o ponto de chamada em
 * `src/http/gate.ts` precisa para emitir sem depender de ninguem: a forma do
 * evento `sessao_nova`, o registo de observadores e o emit. O RESTO do
 * vocabulario (primeira falha de autenticacao por janela, toggle do tunel,
 * TTL, modo restrito, `magic.crawler-suspect`, relatorio periodico) e
 * preenchido por T5.4 nesta onda — sem tocar em gate.ts.
 *
 * A ORDEM E CONTRATO: o `audit.append` corre ANTES do fan-out (o ponto em
 * gate.ts chama `recordAudit` primeiro). "O log e a fonte da verdade; a
 * notificacao e best-effort" (03-ONDAS 10, T5.4).
 */

import type { AuditEvent } from '../contracts/auth.ts'
import type { GuardLogger } from '../logging/logger.ts'

/**
 * Evento: uma sessao autenticou com sucesso PELA PRIMEIRA VEZ.
 *
 * O que "primeira vez" significa exatamente: o portao ja viu (e autorizou)
 * pedidos com aquele `idHash`? O portao mantem a memoria por processo
 * (`src/http/gate.ts`, teto 1024 com eviccao da mais antiga); um reinicio do
 * DSH re-emite para a mesma sessao — aceite e deliberado: notificar duas
 * vezes e melhor do que nao notificar.
 *
 * NAO HA `ip_normalizado` neste evento, de proposito: sob tunel a identidade
 * de IP so e confiavel se `trustEdgeHeaders` estiver ligado (S2), e um
 * consumidor que dependa do campo decidiria por um dado que pode ser lixo.
 */
export interface SessaoNovaEvent extends AuditEvent {
  readonly evento: 'sessao_nova'
  readonly resultado: 'permitido'
  readonly sessao_id_hash: string
  readonly ip_normalizado?: never
}

/** Consumidor do evento. NUNCA lanca para o emit (ver `emitSessaoNova`). */
export type SessaoNovaObserver = (evento: SessaoNovaEvent) => void

const observadores: SessaoNovaObserver[] = []

/**
 * Regista um observador e devolve o desregisto. Idempotente: chamar o
 * desregisto duas vezes nao faz nada.
 */
export function registerSessaoNovaObserver(observador: SessaoNovaObserver): () => void {
  observadores.push(observador)
  let removido = false
  return () => {
    if (removido) return
    removido = true
    const indice = observadores.indexOf(observador)
    if (indice >= 0) observadores.splice(indice, 1)
  }
}

/**
 * Chamado pelo ponto congelado em `src/http/gate.ts`, DEPOIS do audit.
 * Best-effort: um observador que lance NAO derruba o pedido nem os
 * observadores seguintes — a notificacao nunca pode bloquear a requisicao do
 * utilizador (03-ONDAS 10, T5.4). O erro vai ao log do operador e segue
 * (05-QUALIDADE 6.3: o chamador nao pode fazer nada — propagar abortaria a
 * requisicao aprovada por causa de uma notificacao).
 */
export function emitSessaoNova(evento: SessaoNovaEvent, log: GuardLogger): void {
  // `slice()` e deliberado: um observador que se desregiste DURANTE o proprio
  // disparo nao pode fazer o seguinte saltar (splice a meio de for-of vivo).
  for (const observador of observadores.slice()) {
    try {
      observador(evento)
    } catch (error) {
      log.warn(
        'notificacao de sessao nova falhou (best-effort; o audit ja foi escrito): ' +
          `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

/* ========================================================================== */
/* 2. O VOCABULARIO FECHADO — preenchido por T5.4                              */
/* ========================================================================== */

/*
 * IMPORTS DESTA SECAO (fora da regiao congelada do PREP 5, que vive acima):
 * o ESM hoista-os para o topo do modulo, e mante-los aqui preserva as 80
 * primeiras linhas byte-a-byte.
 */
import type { ProbeId } from '../contracts/tunnel.ts'
import { PLUGIN_NAME } from '../errors.ts'
/*
 * A parte congelada acima (PREP 5) declara o evento `sessao_nova` e o fan-out.
 * Este bloco declara o RESTO do vocabulario: os nomes, as formas alinhadas a
 * `AuditEvent` (`src/contracts/auth.ts`) e a uniao fechada `AuditEventoNome`.
 *
 * O VOCABULARIO FECHA SOBRE A REALIDADE, nao sobre o desenho: todo nome que o
 * plugin regista HOJE no AuditSink esta declarado aqui, com o seu emissor. Os
 * nomes que ainda nao tem emissor estao marcados `PENDENTE (costura)` — a
 * composicao esta pronta, o caminho de escrita ainda nao existe, e nenhuma
 * documentacao deste modulo afirma o contrario.
 *
 * QUEM EMITE CADA EVENTO, e a ordem:
 *
 *   - `sessao_nova`               — ponto congelado em `src/http/gate.ts` (L3.1),
 *                                    que ja escreve no AuditSink ANTES do fan-out.
 *   - `auth_sessao`               — `src/http/session-auth.ts` (sessao valida).
 *   - `auth_credencial`           — `src/http/session-auth.ts` (credencial
 *                                    apresentada; permitido/negado).
 *   - `auth_segredo_indisponivel` — `src/http/session-auth.ts` (estado ilegivel).
 *   - `auth_modo_restrito`        — `src/http/session-auth.ts` (sessao OU
 *                                    credencial barrada pelo modo restrito).
 *   - `exposicao_restrita:<n>`    — `src/http/session-auth.ts` (transicao para o
 *                                    modo restrito; sufixo = contador que
 *                                    disparou o teto, reconhecido por prefixo).
 *   - `tunel_ttl_expirado:<n>min:<timer|boot>` — `src/tunnel/ttl.ts` (o TTL
 *                                    agiu). Familia com sufixo, reconhecida por
 *                                    prefixo — a mesma regra que `log.ts` pediu
 *                                    para a lacuna.
 *   - `tunel_probe:<sonda>:<status>` e `tunel_probe_decisao` — `src/tunnel/probe.ts`
 *                                    (o probe fail-closed de L1).
 *   - `auditoria_lacuna:<n>`      — `src/audit/log.ts` (lacuna de registos
 *                                    perdidos; sufixo, reconhecida por prefixo).
 *   - `painel_login`              — `src/panel/api.ts`.
 *   - `painel_magic` / `painel_magic_sem_sinal_de_clique` — `src/panel/magic.ts`.
 *   - `magic.crawler-suspect`     — `src/panel/magic.ts` (consumo sem clique
 *                                    detectavel; nao queima o `mk`).
 *   - `painel_segredo`            — `src/panel/secret.ts`.
 *   - `painel_segredo_recusa_anonima` / `painel_csrf_recusado` — rejeicoes
 *                                    ANONIMAS de painel, com sufixo de rajada
 *                                    `_x<n>` (`src/panel/api.ts`).
 *   - `relatorio_periodico`       — `src/audit/notify.ts` (criarRelatorioPeriodico):
 *                                    este modulo ESCREVE e DEPOIS notifica.
 *   - `auth_falha_primeira_janela` — PENDENTE (costura): a PRIMEIRA falha de
 *                                    autenticacao de cada janela de 10 min.
 *                                    Definicao POR JANELA, nunca por IP: sob
 *                                    tunel `CF-Connecting-IP` so e confiavel com
 *                                    `trustEdgeHeaders` (S2), e `X-Forwarded-For`
 *                                    e forjavel. O emissor (o caminho de
 *                                    autenticacao, junto do limitador) ainda nao
 *                                    existe; a composicao esta pronta.
 *   - `tunel_ligar:<origem>` / `tunel_desligar:<origem>` — EMITIDOS: o
 *                                    controlador de T5.1 (`src/control/controller.ts`,
 *                                    costura da Onda 5) escreve todo toggle do
 *                                    tunel com a ORIGEM no sufixo
 *                                    (`tunel_ligar:telegram:123` /
 *                                    `tunel_desligar:painel:<idHash>`), via
 *                                    `comporEventoToggle` (que RECUSA origem
 *                                    vazia — A5). O contrato `AuditEvent` nao
 *                                    tem campo de origem e a lista branca de
 *                                    `format.ts` descarta campos a mais — o
 *                                    sufixo e o unico sitio onde ela viaja.
 *   - `tunel_reset:<origem>`         — EMITIDO: o mesmo controlador de T5.1
 *                                    escreve o reset do estado terminal com a
 *                                    MESMA regra de origem no sufixo
 *                                    (`src/control/controller.ts`, via
 *                                    `comporEventoReset`).
 *   - `tunel_emergencia:<origem>`    — EMITIDO: `src/index.ts` (aposEmergencia,
 *                                    o kill switch /emergencia de 8(b)); origem
 *                                    `telegram:<id>` no sufixo.
 *   - `tunel_intent_nao_pareado:<origem>` — EMITIDO: `src/control/surface-ipc.ts`
 *                                    (a recusa S6 de identidade, CTL-029);
 *                                    origem `telegram:<id>` no sufixo.
 *   - `tunel_orfao_derrubado`        — EMITIDO: o boot de `src/index.ts` via
 *                                    `EVENTO_ORFAO` de `src/tunnel/pidfile.ts`
 *                                    (varredura de orfao, 02-SEGURANCA 9).
 *
 * ORDEM E CONTRATO (03-ONDAS 10): todo evento deste vocabulario e escrito no
 * AuditSink ANTES de virar notificacao. O consumidor em `src/audit/notify.ts`
 * (T5.4) nunca escreve o log — escrever e do emissor; notificar e best-effort.
 */

/** `sessao_nova` — emissor: `src/http/gate.ts` (ponto congelado do PREP 5). */
export const EVENTO_SESSAO_NOVA = 'sessao_nova'

/** Sessao valida apresentada. Emissor: `src/http/session-auth.ts`. */
export const EVENTO_AUTH_SESSAO = 'auth_sessao'

/** Credencial apresentada (permitido/negado). Emissor: `src/http/session-auth.ts`. */
export const EVENTO_AUTH_CREDENCIAL = 'auth_credencial'

/** Estado ilegivel (fail-closed: a tentativa e NEGADA). Emissor: `session-auth.ts`. */
export const EVENTO_AUTH_SEGREDO_INDISPONIVEL = 'auth_segredo_indisponivel'

/**
 * Primeira falha de autenticacao de uma JANELA DE 10 MIN.
 *
 * >>> PENDENTE (costura pos-onda): NENHUM emissor escreve este nome hoje. <<<
 * O gate escreve `auth_credencial` por tentativa e o limitador nao emite. A
 * composicao esta pronta; o emissor (o caminho de autenticacao, junto do
 * limitador) e a costura. Nao ha caminho de escrita para afirmar o contrario.
 *
 * POR QUE "PRIMEIRA DA JANELA" E NAO "PRIMEIRA NUNCA MAIS": o alerta e o
 * detector de forca bruta. Notificar so a primeira de sempre deixaria a rajada
 * seguinte em silencio; notificar todas inundaria o chat. A janela diz: houve
 * uma nova onda de tentativas — e a coalescencia de 30 s de `notify.ts`
 * protege o Telegram de a rajada inteira virar mensagens.
 */
export const EVENTO_AUTH_FALHA_JANELA = 'auth_falha_primeira_janela'

/** Prefixos dos toggles. EMITIDOS: o controlador de T5.1 (costura da Onda 5). */
export const EVENTO_TUNEL_LIGAR = 'tunel_ligar'
export const EVENTO_TUNEL_DESLIGAR = 'tunel_desligar'

/** Prefixo do reset do estado terminal. EMITIDO: o controlador de T5.1 (costura da Onda 5). */
export const EVENTO_TUNEL_RESET = 'tunel_reset'

/**
 * O kill switch `/emergencia` agiu (8(b)). EMITIDO: `src/index.ts`
 * (aposEmergencia), familia `<origem>` no sufixo — a MESMA regra dos toggles.
 */
export const EVENTO_TUNEL_EMERGENCIA = 'tunel_emergencia'

/**
 * Intent de identidade nao pareada recusada (S6, CTL-029). EMITIDO:
 * `src/control/surface-ipc.ts` (a constante `EVENTO_NAO_PAREADO` do emissor),
 * familia `<origem>` no sufixo.
 */
export const EVENTO_INTENT_NAO_PAREADO = 'tunel_intent_nao_pareado'

/**
 * Tunel orfao de uma execucao anterior derrubado no boot (02-SEGURANCA 9).
 * EMITIDO: `src/index.ts` via `EVENTO_ORFAO` de `src/tunnel/pidfile.ts` — a
 * paridade entre os dois e presa por teste, como a do TTL.
 */
export const EVENTO_ORFAO = 'tunel_orfao_derrubado'

/**
 * O DISPATCHER DE AGENTES (EMENDA ONDA-4-AGENTS-HOST) — tres familias novas,
 * com a MESMA regra dos toggles: sufixo OBRIGATORIO e nao vazio, e o sufixo e
 * o unico sitio onde viajam a origem (`telegram:<id>`), a skill e o id do run
 * (o `AuditEvent` nao tem campos para eles e a lista branca de `format.ts`
 * descarta campos a mais). EMITIDO: `src/agents/registry.ts`.
 */
export const EVENTO_AGENTE_DESPACHO = 'agente_despacho'
export const EVENTO_AGENTE_CANCELAR = 'agente_cancelar'
export const EVENTO_AGENTE_FIM = 'agente_fim'

/**
 * O TTL expirou e o tunel foi derrubado (controlo a agir, nao erro).
 *
 * Familia com sufixo, reconhecida por PREFIXO (a regra que `log.ts` pede para
 * a lacuna): `tunel_ttl_expirado:<n>min:<timer|boot>`. Emissor:
 * `src/tunnel/ttl.ts` (que declara o MESMO nome na constante propria — a
 * paridade entre os dois e presa por teste). O TTL ja tem notificacao propria
 * (`ownerExpiryMessage`); a migracao desse caminho e da costura, nao deste
 * modulo.
 */
export const EVENTO_TTL_EXPIRADO = 'tunel_ttl_expirado'

/** Sessao ou credencial barrada pelo modo restrito. Emissor: `session-auth.ts`. */
export const EVENTO_MODO_RESTRITO = 'auth_modo_restrito'

/**
 * Transicao para o modo restrito, com sufixo `:<n>` (o contador que disparou
 * o teto) — reconhecida por prefixo, mesma convencao de `auditoria_lacuna`.
 * Emissor: `src/http/session-auth.ts`.
 */
export const EVENTO_EXPOSICAO_RESTRITA = 'exposicao_restrita'

/** O probe fail-closed de L1, por sonda. Familia `:<sonda>:<status>`. Emissor: `src/tunnel/probe.ts`. */
export const EVENTO_PROBE = 'tunel_probe'

/** O veredito agregado do probe. Emissor: `src/tunnel/probe.ts`. */
export const EVENTO_PROBE_DECISAO = 'tunel_probe_decisao'

/** Consumo do link magico sem clique detectavel. Emissor: `src/panel/magic.ts`. */
export const EVENTO_MAGIC_SUSPEITO = 'magic.crawler-suspect'

/** `POST /__guard/magic` com sucesso. Emissor: `src/panel/magic.ts`. */
export const EVENTO_PAINEL_MAGIC = 'painel_magic'

/** Sucesso do magic SEM sinal de clique. Emissor: `src/panel/magic.ts`. */
export const EVENTO_PAINEL_MAGIC_SEM_SINAL = 'painel_magic_sem_sinal_de_clique'

/** Login do painel. Emissor: `src/panel/api.ts`. */
export const EVENTO_PAINEL_LOGIN = 'painel_login'

/** `GET /__guard/secret` consumido. Emissor: `src/panel/secret.ts`. */
export const EVENTO_PAINEL_SEGREDO = 'painel_segredo'

/** Rejeicao ANONIMA de painel, com sufixo de rajada `_x<n>`. Emissor: `src/panel/secret.ts`. */
export const EVENTO_PAINEL_SEGREDO_RECUSA_ANONIMA = 'painel_segredo_recusa_anonima'

/** Rejeicao ANONIMA de CSRF, com sufixo de rajada `_x<n>`. Emissor: `src/panel/routes.ts`. */
export const EVENTO_PAINEL_CSRF_RECUSADO = 'painel_csrf_recusado'

/** Lembrete periodico de tunel aberto. Emissor: `src/audit/notify.ts` (relatorio periodico). */
export const EVENTO_RELATORIO = 'relatorio_periodico'

/**
 * Lacuna de registos perdidos. O literal espelha `EVENTO_LACUNA` de
 * `./log.ts` (T2.4, fechado): a paridade entre os dois e presa por teste
 * (`test/unit/audit/events.test.ts`), para o dia em que um divergir.
 */
export const EVENTO_LACUNA = 'auditoria_lacuna'

/** Acoes de toggle do tunel. */
export type TunelToggleAcao = 'ligar' | 'desligar'

/** Como a expiracao do TTL foi detetada (`src/tunnel/ttl.ts`). */
export type TtlDetectedBy = 'timer' | 'boot'

/**
 * Compoe o NOME do evento de toggle com a origem identificada.
 *
 * A origem e o valor pre-formatado do `ControlIntent.requestedBy`
 * (`telegram:<id>` / `panel:<idHash>`); o sufixo e o que torna o registo
 * correlacionavel com o intent (aceite da Onda 5, item 7).
 *
 * RECUSA ORIGEM VAZIA: `tunel_ligar:` nao designa ninguem — e um defeito de
 * fiacao, e falha alto em vez de entrar no log e no texto da notificacao.
 */
export function comporEventoToggle(acao: TunelToggleAcao, origem: string): TunelToggleEvent['evento'] {
  if (origem.length === 0) {
    throw new Error(
      `[${PLUGIN_NAME}] EVENTO_TOGGLE_SEM_ORIGEM: a origem do toggle nao pode ser vazia ` +
        '(esperado `telegram:<id>` ou `panel:<idHash>`).',
    )
  }
  const prefixo = acao === 'ligar' ? EVENTO_TUNEL_LIGAR : EVENTO_TUNEL_DESLIGAR
  return `${prefixo}:${origem}`
}

/**
 * Evento de toggle do tunel. EMITIDO: o controlador de T5.1
 * (`src/control/controller.ts`, costura da Onda 5). O sufixo de origem e
 * OBRIGATORIO na forma da familia; a forma NAO consegue excluir o sufixo vazio
 * (o `${{string}}` do template aceita `''`) — quem exclui o vazio e
 * `comporEventoToggle` e o reconhecedor `eventoDoVocabulario`.
 */
export interface TunelToggleEvent extends AuditEvent {
  readonly evento: `tunel_ligar:${string}` | `tunel_desligar:${string}`
  readonly resultado: 'permitido'
}

/**
 * Evento de reset do estado terminal (FAILED -> STOPPED, CTL-012). EMITIDO: o
 * controlador de T5.1 (`src/control/controller.ts`, costura da Onda 5), com a
 * MESMA regra de origem do toggle — sufixo OBRIGATORIO e nao vazio.
 */
export interface TunelResetEvent extends AuditEvent {
  readonly evento: `tunel_reset:${string}`
  readonly resultado: 'permitido' | 'negado'
}

/**
 * Compoe o NOME do evento de reset com a origem identificada — o mesmo
 * contrato de `comporEventoToggle` para a terceira acao do controlador
 * (CTL-012: reset em FAILED). RECUSA ORIGEM VAZIA: `tunel_reset:` nao designa
 * ninguem.
 */
export function comporEventoReset(origem: string): TunelResetEvent['evento'] {
  if (origem.length === 0) {
    throw new Error(
      `[${PLUGIN_NAME}] EVENTO_TOGGLE_SEM_ORIGEM: a origem do reset nao pode ser vazia ` +
      '(esperado `telegram:<id>` ou `panel:<idHash>`).',
    )
  }
  return `${EVENTO_TUNEL_RESET}:${origem}`
}

/**
 * EMENDA ONDA-4-AGENTS-HOST: composicao do nome de despacho de agente com
 * origem e skill no sufixo — a MESMA disciplina A5 dos toggles. A skill NAO
 * pode ser vazia (a allowlist so aceita nomes kebab-case nao vazios) e a
 * origem NAO pode ser vazia (defeito de fiacao, falha alto).
 */
export function comporEventoAgenteDespacho(origem: string, skill: string): `agente_despacho:${string}` {
  if (origem.length === 0 || skill.length === 0) {
    throw new Error(
      `[${PLUGIN_NAME}] EVENTO_AGENTE_SEM_ORIGEM: origem e skill do despacho nao podem ser vazias ` +
      '(esperado `telegram:<id>` e uma skill kebab-case).',
    )
  }
  return `${EVENTO_AGENTE_DESPACHO}:${origem}:${skill}`
}

/**
 * EMENDA ONDA-4-AGENTS-HOST: o nome de cancelamento com o id CURTO do run no
 * sufixo — `agente_cancelar:<origem>:<agentId>`. Mesma disciplina A5.
 */
export function comporEventoAgenteCancelar(origem: string, agentId: string): `agente_cancelar:${string}` {
  if (origem.length === 0 || agentId.length === 0) {
    throw new Error(
      `[${PLUGIN_NAME}] EVENTO_AGENTE_SEM_ORIGEM: origem e agentId do cancelamento nao podem ser vazios.`,
    )
  }
  return `${EVENTO_AGENTE_CANCELAR}:${origem}:${agentId}`
}

/**
 * EMENDA ONDA-4-AGENTS-HOST: o nome do fim de um run com origem, skill e
 * status terminal no sufixo — `agente_fim:<origem>:<skill>:<status>`.
 */
export function comporEventoAgenteFim(
  origem: string,
  skill: string,
  status: 'done' | 'failed' | 'cancelled',
): `agente_fim:${string}` {
  if (origem.length === 0 || skill.length === 0) {
    throw new Error(
      `[${PLUGIN_NAME}] EVENTO_AGENTE_SEM_ORIGEM: origem e skill do fim de run nao podem ser vazias.`,
    )
  }
  return `${EVENTO_AGENTE_FIM}:${origem}:${skill}:${status}`
}

/**
 * Primeira falha de autenticacao da janela de 10 min.
 * >>> PENDENTE (costura): sem emissor hoje — ver `EVENTO_AUTH_FALHA_JANELA`. <<<
 */
export interface AuthFalhaJanelaEvent extends AuditEvent {
  readonly evento: typeof EVENTO_AUTH_FALHA_JANELA
  readonly resultado: 'negado'
  readonly ip_normalizado?: string | undefined
}

/**
 * O TTL expirou: o controlo agiu. A FORMA e a do emissor real
 * (`src/tunnel/ttl.ts`): familia `tunel_ttl_expirado:<n>min:<timer|boot>`.
 */
export interface TtlExpiradoEvent extends AuditEvent {
  readonly evento: `tunel_ttl_expirado:${number}min:${TtlDetectedBy}`
  readonly resultado: 'permitido'
}

/** Entrada em modo restrito: o teto de falhas foi alcancado (nome real do gate). */
export interface ModoRestritoEvent extends AuditEvent {
  readonly evento: typeof EVENTO_MODO_RESTRITO
  readonly resultado: 'negado'
}

/** Consumo do link magico sem clique detectavel — recusado sem queimar o `mk`. */
export interface MagicSuspeitoEvent extends AuditEvent {
  readonly evento: typeof EVENTO_MAGIC_SUSPEITO
  readonly resultado: 'negado'
}

/** Lembrete periodico de tunel aberto (emissor: o relatorio periodico de notify.ts). */
export interface RelatorioPeriodicoEvent extends AuditEvent {
  readonly evento: typeof EVENTO_RELATORIO
  readonly resultado: 'permitido'
}

/**
 * A UNIAO FECHADA: todo nome que este plugin PODE registar — os que regista
 * hoje (emissor real em cada constante) e os que a costura pos-onda vai emitir
 * (marcados PENDENTE). Nomes com sufixo entram como template literals: o
 * sufixo e parte da forma, nao um detalhe de quem emite.
 */
export type AuditEventoNome =
  | typeof EVENTO_SESSAO_NOVA
  | typeof EVENTO_AUTH_SESSAO
  | typeof EVENTO_AUTH_CREDENCIAL
  | typeof EVENTO_AUTH_SEGREDO_INDISPONIVEL
  | typeof EVENTO_AUTH_FALHA_JANELA
  | `tunel_ligar:${string}`
  | `tunel_desligar:${string}`
  | `tunel_reset:${string}`
  | `tunel_emergencia:${string}`
  | `tunel_intent_nao_pareado:${string}`
  | `agente_despacho:${string}`
  | `agente_cancelar:${string}`
  | `agente_fim:${string}`
  | typeof EVENTO_ORFAO
  | typeof EVENTO_TTL_EXPIRADO
  | `tunel_ttl_expirado:${number}min:${TtlDetectedBy}`
  | typeof EVENTO_MODO_RESTRITO
  | typeof EVENTO_EXPOSICAO_RESTRITA
  | `exposicao_restrita:${number}`
  | typeof EVENTO_PROBE
  | `tunel_probe:${ProbeId}:${string}`
  | typeof EVENTO_PROBE_DECISAO
  | typeof EVENTO_MAGIC_SUSPEITO
  | `magic.crawler-suspect_x${number}`
  | typeof EVENTO_PAINEL_MAGIC
  | typeof EVENTO_PAINEL_MAGIC_SEM_SINAL
  | typeof EVENTO_PAINEL_LOGIN
  | typeof EVENTO_PAINEL_SEGREDO
  | typeof EVENTO_PAINEL_SEGREDO_RECUSA_ANONIMA
  | `painel_segredo_recusa_anonima_x${number}`
  | typeof EVENTO_PAINEL_CSRF_RECUSADO
  | `painel_csrf_recusado_x${number}`
  | typeof EVENTO_RELATORIO
  | typeof EVENTO_LACUNA
  | `auditoria_lacuna:${number}`

/** Formas de sufixo das familias reconhecidas por prefixo (ver o reconhecedor). */
const SUFIXO_NUMERO = /^:[0-9]+$/u
const SUFIXO_TTL = /^:[0-9]+min:(timer|boot)$/u
const SUFIXO_PROBE = /^:(spa-fallback|api-rpc|websocket-upgrade|unguarded-canary):(sem-resposta|[0-9]+)$/u
const SUFIXO_RAJADA = /^_x[0-9]+$/u

/**
 * Os nomes BASE (sem sufixo). A lacuna entra aqui E na familia com sufixo.
 *
 * Os PREFIXOS de toggle (`EVENTO_TUNEL_LIGAR` / `EVENTO_TUNEL_DESLIGAR` / o
 * reset `EVENTO_TUNEL_RESET`) NAO entram: a uniao `AuditEventoNome` so aceita
 * `tunel_ligar:<origem>` (a forma com sufixo). O nome sem sufixo nao designa
 * ninguem — e o mesmo defeito que `comporEventoToggle`/`comporEventoReset` e
 * `eventoDoVocabulario` recusam no sufixo vazio.
 */
const NOMES_BASE: ReadonlySet<string> = new Set([
  EVENTO_SESSAO_NOVA,
  EVENTO_AUTH_SESSAO,
  EVENTO_AUTH_CREDENCIAL,
  EVENTO_AUTH_SEGREDO_INDISPONIVEL,
  EVENTO_AUTH_FALHA_JANELA,
  EVENTO_ORFAO,
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
])

/**
 * Reconhece um nome do vocabulario. Regras, pela ordem:
 *
 *   1. o nome BASE (o conjunto acima);
 *   2. as familias com sufixo RECONHECIDAS POR PREFIXO — a regra que
 *      `src/audit/log.ts` pediu por escrito para a lacuna, estendida a TTL,
 *      exposicao restrita e probe: o sufixo varia com o facto (minutos,
 *      contador, sonda) e nao pode entrar como literal;
 *   3. a familia de RAJADA anonima (`<base>_x<n>`) — o contador da rajada
 *      tambem varia;
 *   4. a familia de TOGGLE (`tunel_ligar:<origem>`) — sufixo NAO vazio.
 *
 * Um sufixo malformado (vazio, com valor impossivel) NAO pertence: `tunel_ligar:`
 * ou `tunel_ttl_expirado:60min:` nao designam ninguem.
 */
export function eventoDoVocabulario(nome: string): boolean {
  if (NOMES_BASE.has(nome)) return true

  const sufixoTtl = sufixoDe(nome, EVENTO_TTL_EXPIRADO)
  if (sufixoTtl !== undefined) return SUFIXO_TTL.test(sufixoTtl)

  const sufixoExposicao = sufixoDe(nome, EVENTO_EXPOSICAO_RESTRITA)
  if (sufixoExposicao !== undefined) return SUFIXO_NUMERO.test(sufixoExposicao)

  const sufixoLacuna = sufixoDe(nome, EVENTO_LACUNA)
  if (sufixoLacuna !== undefined) return SUFIXO_NUMERO.test(sufixoLacuna)

  const sufixoProbe = sufixoDe(nome, EVENTO_PROBE)
  if (sufixoProbe !== undefined) return SUFIXO_PROBE.test(sufixoProbe)

  const sufixoLigar = sufixoDe(nome, EVENTO_TUNEL_LIGAR)
  // O sufixo tem de ter pelo menos UM caracter depois dos dois pontos:
  // `tunel_ligar:` (origem vazia) nao designa ninguem e NAO pertence.
  if (sufixoLigar !== undefined) return nome.length > EVENTO_TUNEL_LIGAR.length + 1

  const sufixoDesligar = sufixoDe(nome, EVENTO_TUNEL_DESLIGAR)
  if (sufixoDesligar !== undefined) return nome.length > EVENTO_TUNEL_DESLIGAR.length + 1

  const sufixoReset = sufixoDe(nome, EVENTO_TUNEL_RESET)
  // A mesma regra dos toggles: `tunel_reset:` (origem vazia) nao designa ninguem.
  if (sufixoReset !== undefined) return nome.length > EVENTO_TUNEL_RESET.length + 1

  // O kill switch e a recusa de identidade seguem a MESMA convencao dos
  // toggles: origem no sufixo, e `<prefixo>:` (vazio) nao designa ninguem.
  const sufixoEmergencia = sufixoDe(nome, EVENTO_TUNEL_EMERGENCIA)
  if (sufixoEmergencia !== undefined) return nome.length > EVENTO_TUNEL_EMERGENCIA.length + 1

  const sufixoNaoPareado = sufixoDe(nome, EVENTO_INTENT_NAO_PAREADO)
  if (sufixoNaoPareado !== undefined) return nome.length > EVENTO_INTENT_NAO_PAREADO.length + 1

  // EMENDA ONDA-4-AGENTS-HOST: as tres familias do dispatcher de agentes
  // seguem a MESMA convencao — `<prefixo>:` (sufixo vazio) nao designa ninguem.
  for (const prefixo of [EVENTO_AGENTE_DESPACHO, EVENTO_AGENTE_CANCELAR, EVENTO_AGENTE_FIM]) {
    const sufixoAgente = sufixoDe(nome, prefixo)
    if (sufixoAgente !== undefined) return nome.length > prefixo.length + 1
  }

  for (const base of [EVENTO_MAGIC_SUSPEITO, EVENTO_PAINEL_SEGREDO_RECUSA_ANONIMA, EVENTO_PAINEL_CSRF_RECUSADO]) {
    const sufixoRajada = sufixoDe(nome, base)
    if (sufixoRajada !== undefined) return SUFIXO_RAJADA.test(sufixoRajada)
  }

  return false
}

/** O que sobra de `nome` depois do prefixo, ou `undefined` se nao comeca por ele. */
function sufixoDe(nome: string, prefixo: string): string | undefined {
  return nome.startsWith(prefixo) ? nome.slice(prefixo.length) : undefined
}
