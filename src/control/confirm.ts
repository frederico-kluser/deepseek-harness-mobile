/**
 * Nonce de confirmacao de duas etapas — SERVER-SIDE NO HOST.
 *
 * Contrato congelado no COMMIT PREP 5 (`src/contracts/control.ts`, secao 3);
 * T5.1 implementa aqui. DONO: T5.1.
 *
 * PORQUE O NONCE VIVE NO HOST, E SO NO HOST (S5 de `src/contracts/ipc.ts`):
 * um nonce validado no processo que fala com a internet nao e um controlo, e
 * uma variavel. O worker apenas transporta o valor opaco dentro do
 * `callback_data`; quem emite e quem consome e este modulo. Por isso
 * `issue`/`consume` nao conhecem o Telegram nem o painel: a superficie pede,
 * o host autoriza.
 *
 * PROPRIEDADES, cada uma presa a um caso CTL:
 *   - 128 bits por CSPRNG (`randomBytes(16)`, hex) — forca bruta inviavel;
 *   - TTL 60 s (`NONCE_TTL_MS`, relogio INJETADO — nunca `Date.now` direto);
 *   - USO UNICO: `consume` apaga o nonce ao autorizar; replay devolve `false`
 *     (CTL-021); expirado devolve `false` (CTL-022);
 *   - o nonce e emitido POR ACAO: `consume(nonce, 'start')` nao autoriza
 *     `reset` — a acao faz parte da autorizacao;
 *   - acoes que REDUZEM exposicao (`stop`) NAO exigem nonce (CTL-024): em
 *     panico, o botao tem de funcionar de primeira. Quem exige e o controlador
 *     (`src/control/controller.ts`), nao este modulo.
 */

import { randomBytes } from 'node:crypto'

import type { ConfirmService, ControlAction, Nonce } from '../contracts/control.ts'
import { NONCE_TTL_MS } from '../contracts/control.ts'

/** Veredito de `consumirComVeredito` — distingue o expirado do desconhecido. */
export type NonceVeredito = 'ok' | 'expirado' | 'desconhecido'

/**
 * A superficie que o controlador consome: o `ConfirmService` do contrato mais
 * um veredito que distingue expiracao de replay.
 *
 * O contrato congela o MINIMO (`issue`/`consume`); a extensao existe porque
 * CTL-021 e CTL-022 exigem recusas DISTINTAS (`NONCE_INVALIDO` vs
 * `NONCE_EXPIRADO`) e `consume` so devolve `boolean`. Nada aqui viola o
 * contrato: `issue` e `consume` sao exatamente os do PREP 5.
 */
export interface ConfirmServiceComVeredito extends ConfirmService {
  consumirComVeredito(nonce: string, action: ControlAction): NonceVeredito
}

export interface ConfirmServiceDeps {
  /** Relogio injetado (`04-TESTES.md` 8.1): nunca `Date.now` direto. */
  readonly now: () => number
  /** CSPRNG. Injetavel so para o teste ser deterministico. */
  readonly randomBytes?: ((size: number) => Uint8Array) | undefined
}

/**
 * Teto de nonces vivos. Cada nonce ocupa ~100 bytes na tabela; 1024 e ~100 KiB
 * no pior caso, e o TTL de 60 s ja limpa o que ninguem consome. O teto existe
 * para uma superficie com defeito nao encher a memoria de nonces que ninguem
 * vai consumir — o mais antigo e descartado (e tambem o primeiro a expirar).
 */
export const MAX_LIVE_NONCES = 1024

export function createConfirmService(deps: ConfirmServiceDeps): ConfirmServiceComVeredito {
  const aleatorio = deps.randomBytes ?? randomBytes
  const vivos = new Map<string, { action: ControlAction; expiresAt: number }>()

  const consumirComVeredito = (nonce: string, action: ControlAction): NonceVeredito => {
    const registo = vivos.get(nonce)
    if (registo === undefined) return 'desconhecido'

    if (deps.now() >= registo.expiresAt) {
      // Expirado: limpa-se — um nonce morto nao pode voltar a vida.
      vivos.delete(nonce)
      return 'expirado'
    }

    if (registo.action !== action) {
      // Acao errada: defeito do chamador, nao do nonce. NAO se consome — o
      // nonce continua valido para a acao para que foi emitido.
      return 'desconhecido'
    }

    // USO UNICO: a segunda apresentacao encontra a tabela sem a entrada.
    vivos.delete(nonce)
    return 'ok'
  }

  return {
    issue(action: ControlAction): Nonce {
      // 16 bytes = 128 bits, em hex = 32 caracteres.
      const valor = Buffer.from(aleatorio(16)).toString('hex')
      const expiresAt = deps.now() + NONCE_TTL_MS

      if (vivos.size >= MAX_LIVE_NONCES) {
        const maisAntigo = vivos.keys().next().value
        if (maisAntigo !== undefined) vivos.delete(maisAntigo)
      }
      vivos.set(valor, { action, expiresAt })

      return { valor, expiresAt }
    },

    consume(nonce: string, action: ControlAction): boolean {
      return consumirComVeredito(nonce, action) === 'ok'
    },

    consumirComVeredito,
  }
}
