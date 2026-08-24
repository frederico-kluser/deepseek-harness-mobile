/**
 * COMANDOS NEUTROS DA SUPERFICIE — /ligar, /desligar, /confirmarDesligar,
 * /status, /acessar, /rotacionar e /emergencia, + a lista canonica publicada
 * (TG-080).
 *
 * DONO: onda 2 "desacoplar o bot de mensageria para arquitetura de provedores".
 * PORTE FIEL de `worker/commands/{onoff,access,status}.ts` contra o CONTRATO
 * `./contract.ts`: consomem {@link SurfaceCommandContext} e {@link SurfaceIdentity}
 * (strings), e produzem saidas {@link SurfaceSendOptions.actionRows} neutras no
 * lugar do `reply_markup`/`callback_data` do Telegram.
 *
 * ===========================================================================
 * O FUNIL DE INFORMACAO QUE ESTES COMANDOS USAM — e o que NAO portam
 * ===========================================================================
 * - {@link SurfaceCommandContext.dono}, `pendente` e `projecao` sao
 *   implementados pelo NUCLEO (onda 2.1, o colega em paralelo). Aqui so se
 *   CONSOME: o comando emite a intencao e regista o pendente; a resposta (ack)
 *   e renderizada pelo nucleo.
 * - O combinador `/rotacionar` e `/ligar` (nodem de confirmacao que AUMENTA
 *   exposicao) pede o nonce ao HOST por {@link SurfaceCommandContext.emitirNonce}
 *   e transporta-o OPACO no botao (S5). O `/desligar` usa um token LOCAL de uso
 *   unico (TTL 60 s, ligado ao emissor).
 *
 * ===========================================================================
 * A EMISSAO DA INTENCAO (S5 / CHAVE-NEUTRA) — A PEGADA QUE A ONDA 4 CORTA
 * ===========================================================================
 * O contrato congelou {@link SurfaceIpcBridge.send(intent: IpcIntentMessage)},
 * cujo corpo ainda carrega `from`/`chat` NUMERICOS (o envelope do host nao foi
 * neutralizado — `src/ipc/channel.ts` e alvo da fase 5). O comando neutro so
 * tem `userKey`/`chatKey` STRINGS. A ponte e QUEM guarda o mapeamento para o
 * id numerico do host (ou, no dia em que o envelope virar neutro, nao ha
 * mapeamento nenhum). Por isso {@link emitirIntent} constroi um
 * {@link SurfaceCommandIntentRequest} NEUTRO e entrega-o `ctx.ipc.send`; a
 * falsa atribuicao de tipo (o cast) marca EXACTAMENTE onde a Onda 4 tem de
 * reescrever a ponte para aceitar a chave neutra directamente. Nao ha `any`:
 * o `SurfaceIpcBridge` e a forma estavel do contrato.
 */

import type {
  ActionRow,
  ActionRowLayout,
  IntencaoNeutra,
  SurfaceCommandContext,
  SurfaceIdentity,
  SurfacePublishedCommand,
  SurfaceSendOptions,
} from './contract.ts'
import { gerarRequestId, gerarTokenOpaque } from './tokens.ts'

/* ========================================================================== */
/* 1. A LISTA CANONICA (TG-080 — D5)                                          */
/* ========================================================================== */

/**
 * A lista FECHADA, na ordem de D5. TG-080 compara o ARRAY INTEIRO, na ordem.
 * `/start` fica de fora (PAIR-006: boa-vindas inocuas, nunca publicado).
 *
 * ONDA-1-NOME-E-BOTOES (Tarefa 3): `status` e `emergencia` saem do menu
 * publicado — ficam SO como botões do cartão de controlo (`/menu`). Os comandos
 * digitados `/status` e `/emergencia` CONTINUAM validos (routing intacto); so
 * desaparecem da lista do BotFather para encurtar o menu. Menu privado final:
 * `/menu`, `/parear`, `/ajuda`.
 *
 * Exporta-se AQUI (o setMyCommands continua no adaptador da Onda 3, mas
 * `ProviderAdapter.publishCommands` recebe esta lista).
 */
export const COMANDOS_PUBLICADOS: readonly SurfacePublishedCommand[] = Object.freeze([
  { command: 'menu', description: 'Abrir o painel de controlo' },
  { command: 'parear', description: 'Parear com um código' },
  { command: 'ajuda', description: 'Ver como usar' },
])

/** A lista canonica, como um array mutavel para o adaptador espalhar. */
export function comandoPublicado(): SurfacePublishedCommand[] {
  return [...COMANDOS_PUBLICADOS]
}

/* ========================================================================== */
/* 2. REQUEST ID (ULID) E TOKENS OPACOS                                        */
/* ========================================================================== */

/* `gerarRequestId` e `gerarTokenOpaque` vivem em `./tokens.ts` (dono unico,
   onda 5a) — importados no topo. Sem duplicacao. */

/* ========================================================================== */
/* 3. A EMISSAO NEUTRA DA INTENCAO                                             */
/* ========================================================================== */

/**
 * A intencao que o comando NEUTRO emite para o host e a propria
 * {@link IntencaoNeutra} do contrato (dono unico, onda 5a): chaves STRING e o
 * requestId. O envelope numerico (`from`/`chat` do `IpcIntentMessage` V1) e
 * responsabilidade da PONTE (`criarSurfaceIpcBridge`, `worker/providers/
 * registry.ts`), nunca do comando.
 */

/**
 * Envia a intencao neutra e regista o ponto pendente PARA o ack.
 *
 * Devolve `false` quando o canal recusa (host indisponivel/fila cheia). O
 * `messageTarget` e o id da mensagem a editar in-place com a resposta do ack.
 *
 * NAO ha falsa atribuicao: `SurfaceIpcBridge.send` aceita a {@link IntencaoNeutra}
 * directamente (a pegada `as unknown as IpcIntentMessage` da Onda 2 morreu na
 * onda 5a).
 */
function emitirIntent(
  ctx: SurfaceCommandContext,
  identidade: SurfaceIdentity,
  pedido: Omit<IntencaoNeutra, 'userKey' | 'chatKey'> & { readonly messageTarget?: string | undefined },
): boolean {
  const pedidoNeutro: IntencaoNeutra = {
    intent: pedido.intent,
    requestId: pedido.requestId,
    userKey: identidade.userKey,
    chatKey: identidade.chatKey,
    ...(pedido.nonce === undefined ? {} : { nonce: pedido.nonce }),
  }
  const aceite = ctx.ipc.send(pedidoNeutro)
  if (aceite) {
    ctx.pendente.registar(pedido.requestId, identidade.chatKey, pedidoNeutro.intent, pedido.messageTarget)
  } else {
    ctx.log.error('intent recusada pelo canal (host indisponivel ou fila cheia)', {
      intent: pedidoNeutro.intent,
      chat: identidade.chatKey,
    })
  }
  return aceite
}

/* ========================================================================== */
/* 4. OS COMANDOS ON/OFF — /ligar, /desligar, /confirmarDesligar              */
/* ========================================================================== */

/** TTL do token local de /desligar — o mesmo espirito dos 60 s do host. */
export const TTL_TOKEN_DESLIGAR_MS = 60_000

/** Teto defensivo do mapa de tokens (o dono e um; 16 e folga de sobra). */
const MAX_TOKENS_DESLIGAR = 16

/** `/ligar` OU `/rotacionar` sem nonce do host — a face worker de CTL-023. */
const SEM_NONCE = 'Não foi possível obter a confirmação do host. Tente de novo em alguns segundos.'

/**
 * CONTRATO §4 Regra 4 (Onda 5): a linha de CANCELAMENTO das telas de confirmacao
 * destrutiva — `[✕ Não]` ao lado do botao positivo `[✅ …]`. E uma NAVEGACAO
 * LOCAL (`cancel`): o nucleo resolve-a sem intent nem nonce, respondendo ao clique
 * e editando a mensagem da confirmacao para o texto de cancelado (teclado destruido).
 */
function linhaDeCancelar(): ActionRow {
  return { label: '✕ Não', action: 'cancel', token: gerarTokenOpaque(), kind: 'confirm' }
}

interface TokenDeDesligar {
  readonly token: string
  readonly userKey: string
  readonly chatKey: string
  readonly expiresAt: number
}

export interface ComandosOnOff {
  ligar(identidade: SurfaceIdentity, alvoDeEdicao?: string): Promise<void>
  desligar(identidade: SurfaceIdentity, alvoDeEdicao?: string): Promise<void>
  /** O clique no botao de confirmacao. Responde SEMPRE ao alvo de resposta. */
  confirmarDesligar(
    identidade: SurfaceIdentity,
    token: string,
    answerTarget: string,
    messageTarget: string | undefined,
  ): Promise<void>
}

/**
 * Mostra a confirmacao de UM fluxo com 2 etapas reutilizando o `messageTarget`
 * quando vem do CARTAO (`alvoDeEdicao`), ou numa mensagem NOVA destacada quando
 * o comando foi DIGITADO. Devolve o `messageTarget` efectivo (para o operador
 * registrar o pendente). Uma falha de edicao in-place `chained`/`failed` (ex.
 * isNotModified) nunca derruba o fluxo (S4): registra e segue, devolvendo o alvo.
 */
async function mostrarConfirmacao(
  ctx: SurfaceCommandContext,
  chat: string,
  alvoDeEdicao: string | undefined,
  texto: string,
  actionRows: ActionRowLayout,
): Promise<string | undefined> {
  const opcoes: SurfaceSendOptions = { actionRows }
  if (alvoDeEdicao !== undefined) {
    await ctx.editar(chat, alvoDeEdicao, texto, opcoes)
    return alvoDeEdicao
  }
  return ctx.enviar(chat, texto, opcoes)
}

export function criarOnOff(ctx: SurfaceCommandContext): ComandosOnOff {
  const tokens = new Map<string, TokenDeDesligar>()

  function emitirTokenDeDesligar(userKey: string, chatKey: string): string {
    const token = gerarTokenOpaque()
    if (tokens.size >= MAX_TOKENS_DESLIGAR) {
      const maisAntigo = tokens.keys().next().value
      if (maisAntigo !== undefined) tokens.delete(maisAntigo)
    }
    tokens.set(token, { token, userKey, chatKey, expiresAt: ctx.time.now() + TTL_TOKEN_DESLIGAR_MS })
    return token
  }

  return {
    async ligar(identidade, alvoDeEdicao): Promise<void> {
      // 1a etapa: pedir o nonce ao HOST (S5). Opaco — o worker nao o le.
      const nonce = await ctx.emitirNonce('tunnel.up')
      if (nonce === undefined) {
        // Fail-closed (CTL-023): sem nonce nao ha confirmacao possivel. Quando
        // o fluxo veio DO CARTAO, edita-o in-place com o aviso (a mensagem de
        // confirmacao reutiliza o MESMO messageTarget); digitar `/ligar` envia
        // uma mensagem propria destacada.
        await (alvoDeEdicao !== undefined
          ? ctx.editar(identidade.chatKey, alvoDeEdicao, SEM_NONCE)
          : ctx.enviar(identidade.chatKey, SEM_NONCE))
        return
      }
      // 2a etapa: o teclado com o nonce opaco no botao + o cancelamento (§4 Regra 4).
      const acao: ActionRow = {
        label: '✅ Sim, ligar',
        action: 'tunnel.up',
        token: nonce,
        kind: 'confirm',
      }
      await mostrarConfirmacao(
        ctx,
        identidade.chatKey,
        alvoDeEdicao,
        '🟢 Ligar o túnel agora? Quando abrir, o link de acesso chega aqui por si só.',
        [[acao, linhaDeCancelar()]],
      )
    },

    async desligar(identidade, alvoDeEdicao): Promise<void> {
      // Confirmacao em 2 etapas com token LOCAL — sem nonce (CTL-024): o intent
      // de confirmacao nao carrega campo `nonce`. O cancelamento (§4 Regra 4) e
      // UMA actionRow ao lado do botao positivo — voltar sem efeito.
      const token = emitirTokenDeDesligar(identidade.userKey, identidade.chatKey)
      const acao: ActionRow = {
        label: '✅ Sim, desligar',
        action: 'tunnel.down',
        token,
        kind: 'emergency',
      }
      await mostrarConfirmacao(
        ctx,
        identidade.chatKey,
        alvoDeEdicao,
        '🔴 Desligar o túnel derruba o acesso remoto. Continuar?',
        [[acao, linhaDeCancelar()]],
      )
    },

    async confirmarDesligar(identidade, token, answerTarget, messageTarget): Promise<void> {
      // TG-027: responder em TODOS os caminhos — inclusive no de recusa.
      const registado = tokens.get(token)
      if (registado === undefined) {
        // Token desconhecido: teclado forjado (TG-025) ou de fluxo ja evictado.
        await ctx.responder(answerTarget)
        return
      }
      const agora = ctx.time.now()
      if (
        agora >= registado.expiresAt ||
        registado.userKey !== identidade.userKey ||
        registado.chatKey !== identidade.chatKey
      ) {
        // Expirado (TG-023) ou apresentado por outro emissor (TG-024).
        tokens.delete(token)
        await ctx.responder(answerTarget, {
          text: 'Confirmação expirada ou inválida. Mande /desligar de novo.',
        })
        return
      }
      // Uso unico: consumido antes de qualquer efeito.
      tokens.delete(token)
      await ctx.responder(answerTarget)
      // O intent REDUZ exposicao e NAO carrega nonce (CTL-024).
      const requestId = gerarRequestId(ctx.time.now())
      emitirIntent(ctx, identidade, { intent: 'tunnel.down', requestId, messageTarget })
    },
  }
}

/* ========================================================================== */
/* 5. OS COMANDOS DE ACESSO — /acessar e /rotacionar                         */
/* ========================================================================== */

export interface ComandosAccess {
  acessar(identidade: SurfaceIdentity): Promise<void>
  rotacionar(identidade: SurfaceIdentity, alvoDeEdicao?: string): Promise<void>
}

export function criarAccess(ctx: SurfaceCommandContext): ComandosAccess {
  return {
    async acessar(identidade): Promise<void> {
      // CONTRA TO TG-085 (Onda 3 — CONTRATO §5): o aceite DEIXA de ser invisível.
      // Acusa o pedido para o botão não parecer morto; o link real chega por
      // notify, como hoje (TG-085 preservado). Sem nonce: session.issue nao esta
      // na lista de CTL-023. O pendente existe para a RECUSA renderizar como
      // mensagem própria.
      const requestId = gerarRequestId(ctx.time.now())
      emitirIntent(ctx, identidade, { intent: 'session.issue', requestId })
      await ctx.enviar(identidade.chatKey, '🔗 A enviar-te o link de acesso por aqui…')
    },

    async rotacionar(identidade, alvoDeEdicao): Promise<void> {
      // 1a etapa: o nonce do host, opaco (S5) — 2 etapas porque AUMENTA exposicao.
      const nonce = await ctx.emitirNonce('secret.rotate')
      if (nonce === undefined) {
        await (alvoDeEdicao !== undefined
          ? ctx.editar(identidade.chatKey, alvoDeEdicao, SEM_NONCE)
          : ctx.enviar(identidade.chatKey, SEM_NONCE))
        return
      }
      // 2a etapa: o teclado. O clique envia secret.rotate com o nonce opaco. O
      // cancelamento (§4 Regra 4) volta sem efeito, ao lado do botao positivo.
      const acao: ActionRow = {
        label: '✅ Sim, gerar',
        action: 'secret.rotate',
        token: nonce,
        kind: 'confirm',
      }
      await mostrarConfirmacao(
        ctx,
        identidade.chatKey,
        alvoDeEdicao,
        '⇄ Gerar chave nova invalida a atual e as sessões abertas. Continuar?',
        [[acao, linhaDeCancelar()]],
      )
    },
  }
}

/* ========================================================================== */
/* 6. OS COMANDOS DE ESTADO — /status e /emergencia (TG-084/087)              */
/* ========================================================================== */

export interface ComandosStatus {
  status(identidade: SurfaceIdentity): Promise<void>
  emergencia(identidade: SurfaceIdentity): Promise<void>
}

export function criarStatus(ctx: SurfaceCommandContext): ComandosStatus {
  let emergenciaDisparada = false

  return {
    async status(identidade): Promise<void> {
      // Leitura pura; o ack traz o estado autoritativo.
      const requestId = gerarRequestId(ctx.time.now())
      emitirIntent(ctx, identidade, { intent: 'tunnel.status', requestId })
    },

    async emergencia(identidade): Promise<void> {
      if (emergenciaDisparada) {
        // Idempotente: ja esta a cair — nada de novo, nem resposta, nem intent.
        return
      }
      emergenciaDisparada = true
      emitirIntent(ctx, identidade, { intent: 'emergency', requestId: gerarRequestId(ctx.time.now()) })
      await ctx.enviar(identidade.chatKey, '🚨 Emergência disparada. Túnel a desligar e este bot vai encerrar.')
      await ctx.parar()
    },
  }
}

/* ========================================================================== */
/* 7. O OBJETO QUE AGRUPA OS COMANDOS (para o nucleo montar o roteador)       */
/* ========================================================================== */

export interface ComandosDaSuperficie {
  readonly ligar: ComandosOnOff
  readonly access: ComandosAccess
  readonly status: ComandosStatus
}

export function criarComandosDaSuperficie(ctx: SurfaceCommandContext): ComandosDaSuperficie {
  return {
    ligar: criarOnOff(ctx),
    access: criarAccess(ctx),
    status: criarStatus(ctx),
  }
}

/* ========================================================================== */
/* 8. A FACTORY PLANA `criarComandosDeSuperficie` (o que o CORE consome)       */
/* ========================================================================== */

/**
 * O despacho PLANA que o NUCLEO chama de {@link SurfaceComandos}:
 * `comandos.ligar(...)/desligar(...)/confirmarDesligar(...)/status(...)/
 * acessar(...)/rotacionar(...)/emergencia(...)` directo, sem o aninhamento
 * `ligar/access/status` do `criarComandosDaSuperficie`.
 *
 * O CORE constroi o contexto e passa-o aqui (`(ctx) => criarComandosDeSuperficie(ctx)`
 * como `SurfaceComandosFactory`). Ambas as factories coexistem por ora; a Onda 4
 * escolhe UMA como canonica (ver handoff).
 */
export interface SurfaceComandosPlano {
  ligar(identidade: SurfaceIdentity, alvoDeEdicao?: string): Promise<void>
  desligar(identidade: SurfaceIdentity, alvoDeEdicao?: string): Promise<void>
  confirmarDesligar(
    identidade: SurfaceIdentity,
    token: string,
    answerTarget: string,
    messageTarget: string | undefined,
  ): Promise<void>
  status(identidade: SurfaceIdentity): Promise<void>
  acessar(identidade: SurfaceIdentity): Promise<void>
  rotacionar(identidade: SurfaceIdentity, alvoDeEdicao?: string): Promise<void>
  emergencia(identidade: SurfaceIdentity): Promise<void>
}

export function criarComandosDeSuperficie(ctx: SurfaceCommandContext): SurfaceComandosPlano {
  const onoff = criarOnOff(ctx)
  const access = criarAccess(ctx)
  const status = criarStatus(ctx)
  return {
    ligar: (identidade, alvoDeEdicao) => onoff.ligar(identidade, alvoDeEdicao),
    desligar: (identidade, alvoDeEdicao) => onoff.desligar(identidade, alvoDeEdicao),
    confirmarDesligar: (identidade, token, answerTarget, messageTarget) =>
      onoff.confirmarDesligar(identidade, token, answerTarget, messageTarget),
    status: (identidade) => status.status(identidade),
    acessar: (identidade) => access.acessar(identidade),
    rotacionar: (identidade, alvoDeEdicao) => access.rotacionar(identidade, alvoDeEdicao),
    emergencia: (identidade) => status.emergencia(identidade),
  }
}