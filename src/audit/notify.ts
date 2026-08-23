/**
 * Composicao da notificacao proativa (best-effort, sempre DEPOIS do log).
 * DONO: T5.4.
 *
 * O COMMIT PREP 5 congela aqui apenas a ASSINATURA de fabrica que T5.1 fia em
 * `src/index.ts`. O corpo e o resto do modulo sao de T5.4.
 *
 * ===========================================================================
 * A REGRA DE OURO (03-ONDAS 10): LOG ANTES DE NOTIFICAR
 * ===========================================================================
 * O AuditSink e a fonte da verdade; o Telegram e entrega best-effort e nunca
 * bloqueia o request do utilizador. Para o evento `sessao_nova` a ordem e
 * garantida pelo ponto congelado em `src/http/gate.ts` (o audit corre antes do
 * fan-out). Para os RESTANTES eventos do vocabulario, quem emite escreve o
 * audit primeiro e chama as composicoes deste ficheiro depois — nenhuma funcao
 * aqui escreve o log, e nenhuma lanca para o chamador: envio falho vira
 * `log.warn` (ou silencio, onde a assinatura congelada nao tem logger) e o
 * registo ja esta no ficheiro.
 *
 * ===========================================================================
 * O FORMATO DO TEXTO: UMA PRIMEIRA LINHA SEMANTICA, E O CORPO
 * ===========================================================================
 * `IpcNotifyMessage.texto` e o que o dono ve no Telegram, e o mapeamento
 * texto -> botoes inline NAO viaja como dado (contrato de `src/contracts/ipc.ts`):
 * e decisao do WORKER (T5.2), que usa a gramatica `g1:<accao>:<token>` de
 * `worker/lib/keyboard.ts` para construir o `callback_data` — este ficheiro
 * NUNCA monta `callback_data`.
 *
 * Para o worker saber qual botao anexar, a primeira linha do texto e um
 * MARCADOR SEMANTICO fechado (`alerta:<tipo>`, constantes abaixo); o resto e
 * o corpo legivel. O renderizador pode ocultar a linha do marcador. Os tipos
 * fechados e os botoes que cada um exige:
 *
 *   - `alerta:sessao-nova`    -> botao "Nao fui eu" (executa o kill switch)
 *   - `alerta:auth-falha`     -> botao "Derrubar tunel agora"
 *   - `alerta:tunel-ligado`   -> sem botao exigido (pode oferecer Desligar)
 *   - `alerta:tunel-desligado`-> sem botao exigido (pode oferecer Ligar)
 *   - `alerta:ttl-expirado`   -> botao "Encerrar"
 *   - `alerta:modo-restrito`  -> sem botao (o tunel ja caiu; saida e local)
 *   - `alerta:magic-suspeito` -> sem botao exigido
 *   - `alerta:relatorio`      -> botao "Encerrar"
 *   - `alerta:link-magico`    -> envio com `disable_web_page_preview: true`
 *                               (o link do bot carrega a chave `?key=`)
 *
 * DISCIPLINA DE CONTEUDO (S3, a mesma de `IpcErrorMessage.message`): sem
 * segredo, sem token, sem caminho absoluto de ficheiro. A URL do tunel PODE
 * viajar (nao e segredo — `02-SEGURANCA.md` 2.2). No modelo expose-port da
 * Onda 1, o LINK do bot viaja com a CHAVE NO LINK (`?key=<token>`), composto
 * em `surface-ipc.ts` a partir de `LinkTokenSurface.emitir()` — e o token de
 * link (reutilizavel ate a rotacao do segredo) e a excecao EXPLICITA ao
 * invariante SEC-14 para ESTE payload, e so para ele: o segredo PERMANENTE,
 * nunca — em codificacao nenhuma (teste comportamental). A URL COMPOSTA com a
 * chave nunca vai a log.
 * `\n` e legitimo; caracteres de controlo, nao (o serializador do canal recusa).
 *
 * COALESCENCIA: `criarCoalescedor` agrupa alertas por categoria numa janela de
 * 30 s — o primeiro da janela sai, o resto e descartado — para a rajada de
 * falhas nao virar inundacao do chat (02-SEGURANCA 6.2). O `retry_after` do
 * 429 do Telegram e tratado no WORKER (grammY, `worker/lib/auto-retry.ts`):
 * aqui nunca ha retry cego — um envio falho nao se repete, o proximo evento
 * viaja.
 *
 * ===========================================================================
 * PENDENTES DE FIACAO (declaradas — a mesma honestidade de
 * `auth_falha_primeira_janela` em `src/audit/events.ts`)
 * ===========================================================================
 * `comporTextoTTLExpirado`, `comporTextoModoRestrito` e `comporTextoMagicSuspeito`
 * estao prontas e testadas, mas NENHUM chamador as fia hoje. O TTL notifica
 * pelo caminho antigo `ownerExpiryMessage` (`src/tunnel/ttl.ts`); o
 * `session-auth` (modo restrito) e o `magic.ts` (magic suspeito) nao tem
 * canal de notificacao fiado. O emissor/ligacao e divida registada da costura,
 * e nenhuma documentacao deste modulo afirma o contrario. A UNICA composicao
 * fiada e o toggle: o controlador de T5.1 (`src/control/controller.ts`,
 * Frente 2 da Onda 6) notifica todo toggle PERMITIDO com
 * `comporTextoTunelToggle`, sempre DEPOIS do append (a regra de ouro).
 */

import { IPC_PROTOCOL_VERSION } from '../contracts/ipc.ts'
import type { AuditSink } from '../contracts/auth.ts'
import type { Scheduler, TimerHandle } from '../proc/scheduler.ts'
import type { GuardLogger } from '../logging/logger.ts'
import type { HostIpcChannel } from '../telegram/ipc.ts'
import { redact } from '../logging/redact.ts'
import {
  EVENTO_RELATORIO,
  type AuthFalhaJanelaEvent,
  type MagicSuspeitoEvent,
  type ModoRestritoEvent,
  type SessaoNovaObserver,
  type SessaoNovaEvent,
  type TtlExpiradoEvent,
  type TunelToggleEvent,
} from './events.ts'

/* ========================================================================== */
/* Marcadores semanticos — vocabulario FECHADO de tipos de alerta             */
/* ========================================================================== */

export const ALERTA_SESSAO_NOVA = 'alerta:sessao-nova'
export const ALERTA_AUTH_FALHA = 'alerta:auth-falha'
export const ALERTA_TUNEL_LIGADO = 'alerta:tunel-ligado'
export const ALERTA_TUNEL_DESLIGADO = 'alerta:tunel-desligado'
export const ALERTA_TTL_EXPIRADO = 'alerta:ttl-expirado'
export const ALERTA_MODO_RESTRITO = 'alerta:modo-restrito'
export const ALERTA_MAGIC_SUSPEITO = 'alerta:magic-suspeito'
export const ALERTA_RELATORIO = 'alerta:relatorio'
export const ALERTA_LINK_MAGICO = 'alerta:link-magico'

/** A uniao fechada dos marcadores — quem renderiza decide por esta lista. */
export type MarcadorAlerta =
  | typeof ALERTA_SESSAO_NOVA
  | typeof ALERTA_AUTH_FALHA
  | typeof ALERTA_TUNEL_LIGADO
  | typeof ALERTA_TUNEL_DESLIGADO
  | typeof ALERTA_TTL_EXPIRADO
  | typeof ALERTA_MODO_RESTRITO
  | typeof ALERTA_MAGIC_SUSPEITO
  | typeof ALERTA_RELATORIO
  | typeof ALERTA_LINK_MAGICO

/** Janela de coalescencia de alertas da MESMA categoria (02-SEGURANCA 6.2). */
export const COALESCENCIA_MS = 30_000

/** Intervalo do relatorio periodico (02-SEGURANCA L8: 30 min de tunel aberto). */
export const RELATORIO_INTERVALO_MS = 30 * 60_000

/** Quantos caracteres do hash de sessao vao para a mensagem (hash CURTO). */
export const HASH_CURTO_LEN = 8

/* ========================================================================== */
/* Primitivas de formato                                                      */
/* ========================================================================== */

/** Horario local HH:MM para o corpo das mensagens. */
function horario(agoraMs: number): string {
  return new Date(agoraMs).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Formata o tempo restante de forma legivel: `23 min`, `1 h 05 min`,
 * `menos de 1 min`. Arredonda para CIMA: 23 min e 4 s sao "24 min" — dizer
 * menos do que o real numa janela de exposicao e o erro errado.
 */
export function formatarTempoRestante(ms: number): string {
  const totalMin = Math.ceil(ms / 60_000)
  if (totalMin <= 0) return 'menos de 1 min'
  if (totalMin < 60) return `${String(totalMin)} min`
  const horas = Math.floor(totalMin / 60)
  const minutos = totalMin % 60
  if (minutos === 0) return `${String(horas)} h`
  return `${String(horas)} h ${String(minutos).padStart(2, '0')} min`
}

/** Primeira linha: o marcador. O renderizador pode oculta-lo. */
function comMarcador(marcador: MarcadorAlerta, corpo: string): string {
  return `${marcador}\n${corpo}`
}

/* ========================================================================== */
/* Composicoes — PISTAS de eventos ja registados no AuditSink                 */
/* ========================================================================== */

/**
 * Sessao nova autenticada: horario + hash curto de agente (os primeiros
 * caracteres de `sessao_id_hash` — o suficiente para correlacionar com o log
 * de auditoria sem exportar o digest inteiro). E o unico detector do atacante
 * que TEM a credencial (03-ONDAS 10): notifica em TODA sessao nova.
 */
export function comporTextoSessaoNova(evento: SessaoNovaEvent, agoraMs: number): string {
  const curto = evento.sessao_id_hash.slice(0, HASH_CURTO_LEN)
  return comMarcador(
    ALERTA_SESSAO_NOVA,
    `Sessao nova autenticada as ${horario(agoraMs)} — agente ${curto}`,
  )
}

/**
 * Primeira falha de autenticacao da janela de 10 min. O IP entra SO quando
 * `ip_normalizado` existe — sob tunel ele e `null` (S2), e o texto nao inventa
 * uma origem que nao existe.
 */
export function comporTextoAuthFalha(evento: AuthFalhaJanelaEvent, agoraMs: number): string {
  const origem = evento.ip_normalizado === undefined ? '' : ` — de ${evento.ip_normalizado}`
  return comMarcador(
    ALERTA_AUTH_FALHA,
    `Primeira falha de autenticacao na janela de 10 min as ${horario(agoraMs)}${origem}`,
  )
}

/**
 * Todo toggle do tunel, com a origem identificada (sufixo do nome do evento:
 * `telegram:<id>` ou `painel:<idHash>`). `url` e opcional e so entra no ramo
 * de LIGAR — a URL do tunel nao e segredo (02-SEGURANCA 2.2), e e o que o dono
 * precisa para chegar ao painel.
 */
export function comporTextoTunelToggle(
  evento: TunelToggleEvent,
  agoraMs: number,
  url?: string,
): string {
  const ligado = evento.evento.startsWith('tunel_ligar:')
  const origem = evento.evento.slice(evento.evento.indexOf(':') + 1)
  if (origem.length === 0) {
    // Um evento `tunel_ligar:` (sufixo vazio) nao designa ninguem: a forma
    // aceita-o no tipo, o texto nao. Falha alto — o emissor tem um defeito.
    throw new Error(
      '[guarded-bot] EVENTO_TOGGLE_SEM_ORIGEM: o evento de toggle chegou sem origem ' +
        '(esperado `tunel_ligar:<origem>` ou `tunel_desligar:<origem>`).',
    )
  }
  const marcador = ligado ? ALERTA_TUNEL_LIGADO : ALERTA_TUNEL_DESLIGADO
  const verbo = ligado ? 'ligado' : 'desligado'
  const linhaUrl = ligado && url !== undefined ? `\nURL: ${url}` : ''
  return comMarcador(
    marcador,
    `Tunel ${verbo} as ${horario(agoraMs)} (origem: ${origem})${linhaUrl}`,
  )
}

/** O TTL expirou: o tunel foi derrubado e as sessoes invalidadas. */
export function comporTextoTTLExpirado(_evento: TtlExpiradoEvent, agoraMs: number): string {
  return comMarcador(
    ALERTA_TTL_EXPIRADO,
    `TTL expirado as ${horario(agoraMs)} — o tunel foi derrubado e as sessoes invalidadas.`,
  )
}

/** Entrada em modo restrito: o teto de falhas foi alcancado e o tunel caiu. */
export function comporTextoModoRestrito(_evento: ModoRestritoEvent, agoraMs: number): string {
  return comMarcador(
    ALERTA_MODO_RESTRITO,
    `Modo restrito ativado as ${horario(agoraMs)} — o tunel foi derrubado. A recuperacao e na maquina.`,
  )
}

/**
 * Consumo do link magico sem clique detectavel. O registo ja existe no fluxo
 * de `src/panel/magic.ts`; esta composicao apenas o consome. O `mk` NAO e
 * queimado — o texto diz isso ao dono.
 */
export function comporTextoMagicSuspeito(_evento: MagicSuspeitoEvent, agoraMs: number): string {
  return comMarcador(
    ALERTA_MAGIC_SUSPEITO,
    `Consumo do link magico sem clique detectavel as ${horario(agoraMs)} — o token nao foi usado.`,
  )
}

/**
 * Relatorio periodico: tunel aberto, com o tempo restante do TTL. Combate T10
 * (operador cansado) — o lembrete chega mesmo quando o dono ja esqueceu o
 * tunel aberto.
 */
export function comporTextoRelatorio(agoraMs: number, expiraEm: number | undefined): string {
  if (expiraEm === undefined) {
    return comMarcador(ALERTA_RELATORIO, 'O tunel continua aberto — tempo restante indisponivel.')
  }
  const restante = formatarTempoRestante(expiraEm - agoraMs)
  return comMarcador(
    ALERTA_RELATORIO,
    `O tunel continua aberto — expira as ${horario(expiraEm)} (tempo restante: ${restante}). ` +
      'Encerre quando terminar o trabalho.',
  )
}

/**
 * Link com a CHAVE DE ACESSO para o celular (modelo expose-port da Onda 1).
 * O token viaja na QUERY (`?key=<token>`), composto a partir de
 * `LinkTokenSurface.emitir()` (`src/contracts/link-token.ts`), e e a portao
 * pelo tunel que abre sem senha e sem prompt — quem recebe o link entra.
 *
 * >>> O token de link NAO e o segredo PERMANENTE (a senha nunca sai, em
 * codificacao nenhuma — SEC-14). E uma chave reutilizavel ate `revogar()`
 * (rotacao do segredo / queda do tunel), e o `expiraEm` e `number | undefined`
 * (esta implementacao nao impoe TTL). D3 adaptado: em vez do fragmento `#mk=`,
 * o token vai na query `?key=` — o que a rota do portao (`src/http/gate.ts`)
 * valida. NUNCA logar a URL composta com a chave. <<<
 */
export function comporTextoLinkMagico(
  agoraMs: number,
  urlDoTunel: string,
  chave: string,
  expiraEm: number | undefined,
): string {
  const link = `${urlDoTunel}?key=${chave}`
  const validade =
    expiraEm === undefined
      ? 'válido até você rotacionar'
      : `válido até ${formatarTempoRestante(expiraEm - agoraMs)}`
  return comMarcador(
    ALERTA_LINK_MAGICO,
    `Seu link com a chave de acesso (abre e entra, sem senha):\n${link}\n` +
      `É um link com a sua chave embutida — ${validade}; quem o abrir entra direto. ` +
      'Nada de senha para digitar. Prefira apagá-lo do chat depois de usar.',
  )
}

/* ========================================================================== */
/* Envio best-effort                                                          */
/* ========================================================================== */

/**
 * Envia a mensagem `notify` pelo canal, SEM nunca lanca para o chamador.
 *
 * `canal.send` ja devolve `false` em vez de lanca (canal morto, inviavel ou
 * mensagem recusada pelo contrato); o `try` cobre um canal hostil. Um envio
 * falho NAO se repete (nunca retry cego): a notificacao e best-effort e o
 * registo ja esta no AuditSink. `false` significa "nao foi entregue".
 */
export function enviarNotificacao(
  canal: Pick<HostIpcChannel, 'send'>,
  log: GuardLogger,
  texto: string,
): boolean {
  let entregue = false
  try {
    entregue = canal.send({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto })
  } catch (error) {
    log.warn(
      'notificacao proativa nao entregue (o canal lancou; o audit ja foi escrito): ' +
        redact(error instanceof Error ? error.message : String(error)),
    )
    return false
  }
  if (!entregue) {
    log.warn('notificacao proativa nao entregue (canal indisponivel); o audit ja foi escrito')
  }
  return entregue
}

/**
 * Coalescedor de alertas por CATEGORIA. O primeiro alerta da categoria dentro
 * da janela sai; os seguintes sao descartados ate a janela fechar.
 *
 * POR CATEGORIA E NAO GLOBAL: uma sessao nova nao deve engolir uma rajada de
 * falhas — sao detetores de coisas diferentes, e os dois tem de chegar ao
 * dono. A janela protege o Telegram (1 msg/s por chat) sem o host depender
 * disso: o que sobra aqui nao chega a nascer.
 */
export interface Coalescedor {
  /** `true` se o alerta da categoria pode sair agora (primeiro da janela). */
  tentar(categoria: string): boolean
}

export function criarCoalescedor(now: () => number, janelaMs: number = COALESCENCIA_MS): Coalescedor {
  const ultimos = new Map<string, number>()
  return {
    tentar(categoria: string): boolean {
      const agora = now()
      const anterior = ultimos.get(categoria)
      if (anterior !== undefined && agora - anterior < janelaMs) return false
      ultimos.set(categoria, agora)
      return true
    },
  }
}

/* ========================================================================== */
/* O observador de sessao nova — ASSINATURA CONGELADA NO COMMIT PREP 5        */
/* ========================================================================== */

/**
 * Fabrica do observador de "sessao nova". A notificacao viaja pelo IPC
 * host -> worker (mensagem `notify` de `src/contracts/ipc.ts`) e e renderizada
 * por T5.2. `canal` e o canal que T5.1 cria na fiacao (`src/index.ts`) e
 * entrega AQUI — um observador com zero argumentos obrigaria T5.4 a um
 * singleton de modulo, que a regra "nada de estado global" (05-QUALIDADE 4.2)
 * proibe.
 *
 * O observador COMPOE e ENVIA, e nunca lanca: a assinatura congelada nao tem
 * logger nem relogio, logo o envio falho e silencioso por construcao — o
 * canal ja registou as proprias falhas, e o audit (escrito ANTES, pelo ponto
 * congelado do gate) e a fonte da verdade. Coalescencia NESTE observador:
 * nao, de proposito — quem fia pode envolve-lo com `criarCoalescedor` sem
 * mudar nada aqui.
 */
export function criarObservadorSessaoNova(canal: Pick<HostIpcChannel, 'send'>): SessaoNovaObserver {
  return (evento: SessaoNovaEvent): void => {
    const texto = comporTextoSessaoNova(evento, Date.now())
    try {
      canal.send({ v: IPC_PROTOCOL_VERSION, type: 'notify', texto })
    } catch {
      // Sem logger na assinatura congelada: o canal ja registou a falha dele;
      // o audit ja tem a linha. Silencio deliberado — ver o cabecalho.
      void canal
    }
  }
}

/* ========================================================================== */
/* O relatorio periodico — timer com relogio injetado e disposer limpo        */
/* ========================================================================== */

export interface RelatorioPeriodicoEstado {
  /** `true` sse o tunel esta aberto (`READY`). */
  readonly aberto: boolean
  /** Epoch ms em que o TTL expira. Presente sse `aberto`. */
  readonly expiraEm: number | undefined
}

export interface RelatorioPeriodicoDeps {
  readonly canal: Pick<HostIpcChannel, 'send'>
  readonly log: GuardLogger
  /** O AuditSink — o relatorio regista-se ANTES de notificar (a regra de ouro). */
  readonly audit: Pick<AuditSink, 'append'>
  /** Relogio injetado (04-TESTES 8.1): o host nao tem loop de relogio global. */
  readonly now: () => number
  /** Agendador injetado — nos testes, o `FakeScheduler` de `test/support`. */
  readonly scheduler: Scheduler
  /** Projecao do estado do tunel, fornecida por quem fia (T5.1). */
  readonly estado: () => RelatorioPeriodicoEstado
  /** Intervalo entre relatorios. Omitido: 30 min (L8). */
  readonly intervaloMs?: number | undefined
}

export interface RelatorioPeriodico {
  /** Liga o ciclo. Idempotente; no-op depois do disposer. */
  iniciar(): void
  /**
   * Desliga o ciclo e limpa o temporizador pendente. IDEMPOTENTE — a
   * garantia de que nenhum timer orfao sobrevive a desmontagem do plugin.
   */
  disposer(): void
}

/**
 * Lembrete periodico de tunel aberto, contra T10. A cada `intervaloMs` com o
 * tunel aberto: escreve `relatorio_periodico` no AuditSink e SO DEPOIS
 * notifica. O padrao e o do supervisor de T3.1 — re-verificar `disposed`
 * imediatamente antes de reagendar, para um disposer a meio do disparo nao
 * deixar o ciclo vivo.
 */
export function criarRelatorioPeriodico(deps: RelatorioPeriodicoDeps): RelatorioPeriodico {
  const intervaloMs = deps.intervaloMs ?? RELATORIO_INTERVALO_MS
  let agendado: TimerHandle | undefined
  let disposed = false

  const reagendar = (): void => {
    if (disposed) return
    agendado = deps.scheduler.setTimeout(bater, intervaloMs)
  }

  const bater = (): void => {
    if (disposed) return
    try {
      // A doutrina fail-closed cobre a PROJECAO e o relogio tambem, nao so o
      // append: uma excecao vinda do estado injetado (ou do relogio) NAO pode
      // escapar do callback do timer — `uncaughtException` mataria o processo
      // inteiro por causa de um lembrete. Salta-se o ciclo, o timer continua.
      // 05-QUALIDADE 6.3: o chamador (o timer) nao pode fazer nada alem de
      // logar e seguir — nao ha chamador superior a quem relancar.
      const estado = deps.estado()
      if (estado.aberto) {
        const texto = comporTextoRelatorio(deps.now(), estado.expiraEm)
        // A REGRA DE OURO: append primeiro. Se o append falhar (disco cheio,
        // fail-closed), a notificacao NAO sai — sem log, sem notificacao.
        deps.audit.append({ evento: EVENTO_RELATORIO, resultado: 'permitido' })
        enviarNotificacao(deps.canal, deps.log, texto)
      }
    } catch (error) {
      deps.log.warn(
        'relatorio periodico NAO emitido neste ciclo (projecao do tunel, relogio ou ' +
          'AuditSink falhou); o ciclo continua: ' +
          redact(error instanceof Error ? error.message : String(error)),
      )
    }
    reagendar()
  }

  return {
    iniciar(): void {
      if (disposed || agendado !== undefined) return
      reagendar()
    },
    disposer(): void {
      if (disposed) return
      disposed = true
      if (agendado !== undefined) deps.scheduler.clearTimeout(agendado)
      agendado = undefined
    },
  }
}
