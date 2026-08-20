/**
 * Construcao de `ControlIntent` e projecao do resultado — o contrato do
 * controlador (`src/contracts/control.ts`, PREP 5) consumido pela terceira
 * superficie (03-ONDAS 2.1: "registra os mesmos dois botoes no ponto de
 * contribuicao do host CONSUMINDO o mesmo `ControlIntent` de T5.1 — nunca
 * chamando o supervisor direto").
 *
 * Este modulo e a traducao pura do gesto de UI para o intent: sem estado, sem
 * relogio (injetados de fora), testavel por tabela. A superficie nunca chama
 * `src/tunnel/**` nem `src/control/controller.ts`; a unica via e o
 * `ControlIntent` emitido para o controlador.
 *
 * NONCE OPACO (S5 de `src/contracts/ipc.ts`): quem emite o nonce e o HOST
 * (`ConfirmService.issue` de T5.1); a superficie transporta o valor entre o
 * passo 1 e o passo 2 sem o ler nem o validar — um nonce validado no processo
 * que fala com a internet nao e um controlo, e uma variavel.
 *
 * `exigeNonce` transcreve CTL-024: acoes que AUMENTAM exposicao (start/reset)
 * obrigam o transporte do nonce; as que a REDUZEM (stop) dispensam — em
 * panico, o botao tem de funcionar de primeira.
 */

import type {
  ControlAction,
  ControlIntent,
  ControlRecusa,
  ControlResultado,
} from '../contracts/control.ts'
import type { TunnelState } from '../contracts/tunnel.ts'

export interface IntentInput {
  readonly action: ControlAction
  /** Pre-formatado, ex. `ui:native` — o valor que o audit escreve. */
  readonly requestedBy: string
  /** ULID novo, gerado pela superficie — chave de idempotencia (D29). */
  readonly requestId: string
  /** Presente so quando a acao o EXIGE (CTL-024). */
  readonly nonce?: string | undefined
  /** Epoch ms do relogio INJETADO — nunca `Date.now` direto. */
  readonly at: number
}

export function buildControlIntent(input: IntentInput): ControlIntent {
  return {
    action: input.action,
    requestedBy: input.requestedBy,
    requestId: input.requestId,
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
    at: input.at,
  }
}

/**
 * CTL-024: o nonce de confirmacao e exigido nas acoes que AUMENTAM a
 * exposicao e dispensado nas que a reduzem.
 */
export function exigeNonce(action: ControlAction): boolean {
  return action === 'start' || action === 'reset'
}

/**
 * Os motivos de recusa, em portugues, para a UI. O vocabulario FECHADO vem do
 * contrato; o rotulo PT e texto de UI (D7) e vive na superficie — o bot tem o
 * dele em `worker/`, o painel tera o dele em `src/panel/**`.
 *
 * `TERMINAL_SEM_RESET` esta DELIBERADAMENTE AUSENTE deste mapa: em `FAILED` os
 * dois botoes da superficie desativam (nao ha rota de reset aqui — o reset nas
 * tres superficies e da COSTURA pos-onda, que acrescenta
 * `POST /__guard-ui/api/reset`). A recusa nunca chega por este caminho de UI;
 * um rotulo para ela seria codigo morto a mentir. Se chegar por um POST
 * forjado, a resposta traz `recusa` sem `motivo` e o cliente mostra a mensagem
 * generica — honesta, em vez de prometer uma rota que nao existe.
 */
export const RECUSA_MOTIVO: Readonly<Partial<Record<ControlRecusa, string>>> = Object.freeze({
  SHUTDOWN_IN_PROGRESS: 'O túnel já está a desligar. Espere e tente de novo.',
  MODO_RESTRITO: 'Modo restrito ativo: a exposição está bloqueada. Desarme-o antes de ligar.',
  SEM_SEGREDO_FORTE: 'Sem segredo forte configurado: defina a senha antes de ligar.',
  NONCE_AUSENTE: 'Confirmação em falta; toque em Ligar de novo.',
  NONCE_INVALIDO: 'Confirmação inválida; toque em Ligar de novo.',
  NONCE_EXPIRADO: 'A confirmação expirou; toque em Ligar de novo.',
})

export function motivoDaRecusa(recusa: ControlRecusa | undefined): string | undefined {
  return recusa === undefined ? undefined : RECUSA_MOTIVO[recusa]
}

/**
 * A UNICA recusa sem rotulo: `TERMINAL_SEM_RESET` nao tem caminho de UI nesta
 * superficie enquanto a rota de reset nao existir (ver o JSDoc de
 * {@link RECUSA_MOTIVO}). O teste que remove o rotulo aponta para aqui.
 */
export const RECUSA_SEM_ROTULO: readonly ControlRecusa[] = ['TERMINAL_SEM_RESET']

/** A resposta que a UI le. `url` so sai em READY — ver {@link projectResultado}. */
export interface ResultadoProjetado {
  readonly estado: TunnelState
  readonly idempotente: boolean
  readonly recusa?: ControlRecusa | undefined
  readonly motivo?: string | undefined
  readonly url?: string | undefined
}

/**
 * Projecao do `ControlResultado` para o corpo JSON das rotas POST.
 *
 * DEFESA EM PROFUNDIDADE, no espirito do `projectSnapshot` do painel: o
 * contrato ja diz "url presente quando a acao resultou num tunel pronto",
 * mas a fronteira nao confia no contrato — a URL so sai quando o estado E
 * `READY`, mesmo que o controlador a devolva noutro estado por defeito.
 */
export function projectResultado(resultado: ControlResultado): ResultadoProjetado {
  return {
    estado: resultado.estado,
    idempotente: resultado.idempotente,
    ...(resultado.recusa === undefined
      ? {}
      : { recusa: resultado.recusa, motivo: RECUSA_MOTIVO[resultado.recusa] }),
    ...(resultado.estado === 'READY' && resultado.url !== undefined ? { url: resultado.url } : {}),
  }
}
