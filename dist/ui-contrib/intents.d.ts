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
import type { ControlAction, ControlIntent, ControlRecusa, ControlResultado } from '../contracts/control.ts';
import type { TunnelState } from '../contracts/tunnel.ts';
export interface IntentInput {
    readonly action: ControlAction;
    /** Pre-formatado, ex. `ui:native` — o valor que o audit escreve. */
    readonly requestedBy: string;
    /** ULID novo, gerado pela superficie — chave de idempotencia (D29). */
    readonly requestId: string;
    /** Presente so quando a acao o EXIGE (CTL-024). */
    readonly nonce?: string | undefined;
    /** Epoch ms do relogio INJETADO — nunca `Date.now` direto. */
    readonly at: number;
}
export declare function buildControlIntent(input: IntentInput): ControlIntent;
/**
 * CTL-024: o nonce de confirmacao e exigido nas acoes que AUMENTAM a
 * exposicao e dispensado nas que a reduzem.
 */
export declare function exigeNonce(action: ControlAction): boolean;
/**
 * Os motivos de recusa, em portugues, para a UI. O vocabulario FECHADO vem do
 * contrato; o rotulo PT e texto de UI (D7) e vive na superficie — o bot tem o
 * dele em `worker/`, o painel tera o dele em `src/panel/**`.
 *
 * A COSTURA da Onda 5 (W3) acrescentou a rota de reset (`POST
 * /__guard-ui/api/reset` + confirm): FAILED so sai por reset humano (CTL-012)
 * e o rotulo de `TERMINAL_SEM_RESET` deixa de ser codigo morto — chega a UI
 * quando um reset forjado (sem o fluxo de 2 etapas) e recusado.
 */
export declare const RECUSA_MOTIVO: Readonly<Partial<Record<ControlRecusa, string>>>;
export declare function motivoDaRecusa(recusa: ControlRecusa | undefined): string | undefined;
/**
 * Nenhuma recusa fica sem rotulo desde que a costura (W3) acrescentou a rota
 * de reset. A lista vazia e a garantia literal: se um dia entrar um motivo
 * novo AQUI sem rotulo, o teste de `RECUSA_MOTIVO` fica vermelho.
 */
export declare const RECUSA_SEM_ROTULO: readonly ControlRecusa[];
/** A resposta que a UI le. `url` so sai em READY — ver {@link projectResultado}. */
export interface ResultadoProjetado {
    readonly estado: TunnelState;
    readonly idempotente: boolean;
    readonly recusa?: ControlRecusa | undefined;
    readonly motivo?: string | undefined;
    readonly url?: string | undefined;
}
/**
 * Projecao do `ControlResultado` para o corpo JSON das rotas POST.
 *
 * DEFESA EM PROFUNDIDADE, no espirito do `projectSnapshot` do painel: o
 * contrato ja diz "url presente quando a acao resultou num tunel pronto",
 * mas a fronteira nao confia no contrato — a URL so sai quando o estado E
 * `READY`, mesmo que o controlador a devolva noutro estado por defeito.
 */
export declare function projectResultado(resultado: ControlResultado): ResultadoProjetado;
//# sourceMappingURL=intents.d.ts.map