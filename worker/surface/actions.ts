/**
 * AS LINHAS DE ACAO e o marcador `alerta:` da NOTIFICACAO proativa (onda 2 —
 * nucleo). Port fiel de `worker/commands/router.ts` (DONO de referencia: T5.2):
 * {@link TIPOS_DE_ALERTA}, {@link extrairAlerta} e a neutralizacao de
 * `botoesDoAlerta` -> {@link botoesDeAlerta}.
 *
 * ===========================================================================
 * ANTES: `InlineButtonSpec` (botao Telegram com `callback_data` montado) → AGORA:
 * `ActionRowLayout` (linhas de acao NEUTRAS do contrato — `worker/surface/contract.ts`).
 * ===========================================================================
 * O router antigo devolvia `buildInlineKeyboard([[{ text, data ...
 * buildCallbackData('emergency', gerarTokenOpaque()) }]])` — ja a STRING do
 * `callback_data` do Telegram. O nucleo neutro nao conhece o `callback_data`:
 * devolve {@link ActionRowLayout} com {@link ActionRow}{label, action, token,
 * kind?}. O ADAPTADOR do provedor (onda 3) serializa essas linhas no formato do
 * canal. O ROTULO continua IDENTICO byte a byte (o botao que o dono ve nao muda)
 * e o token continua OPACO e gerado localmente (S5: o host que valida; o botao
 * de `emergency` REDUZ exposicao, por isso o worker gera o token e o host nao o
 * consome — CTL-024).
 *
 * `kind: 'emergency'` anota a NATUREZA da acao (reduz exposicao) para o adaptador
 * apresentar, sem nunca anular o `action`.
 */

import type { ActionRow, ActionRowLayout } from './contract.ts'
import { gerarTokenOpaque } from './tokens.ts'

/* ========================================================================== */
/* 1. O VOCABULARIO FECHADO DE ALERTAS                                         */
/* ========================================================================== */

/**
 * O vocabulario de `alerta:<tipo>` do notify — CONTRATO DE T5.4 (fechado). A
 * primeira linha do texto e o marcador; a renderizacao pode oculta-lo. O tipo
 * e FECHADO de proposito: um `alerta:` desconhecido nao ganha botoes e o corpo
 * e mostrado tal qual (fail-closed, sem inventar accao).
 */
export const TIPOS_DE_ALERTA = Object.freeze([
  'sessao-nova',
  'auth-falha',
  'tunel-ligar',
  'tunel-desligar',
  'ttl-expirado',
  'modo-restrito',
  'magic-suspeito',
  'relatorio',
  'link-magico',
] as const)

export type TipoDeAlerta = (typeof TIPOS_DE_ALERTA)[number]

const PREFIXO_ALERTA = 'alerta:'

/**
 * Separa a primeira linha (o marcador) do corpo mostrado ao dono.
 *
 * A primeira linha comeca por `alerta:`? Devolve o tipo (se reconhecido) e o
 * corpo (o resto). Senao, tipo `undefined` e corpo = o texto INTEIRO — o marcador
 * so existe quando e a PRIMEIRA linha, e um `alerta:` a meio do corpo e texto
 * normal que o dono ve.
 */
export function extrairAlerta(texto: string): { tipo: TipoDeAlerta | undefined; corpo: string } {
  const quebra = texto.indexOf('\n')
  const primeira = quebra === -1 ? texto : texto.slice(0, quebra)
  const corpo = quebra === -1 ? '' : texto.slice(quebra + 1)
  if (!primeira.startsWith(PREFIXO_ALERTA)) return { tipo: undefined, corpo: texto }
  const tipo = primeira.slice(PREFIXO_ALERTA.length).trim()
  return {
    tipo: (TIPOS_DE_ALERTA as readonly string[]).includes(tipo) ? (tipo as TipoDeAlerta) : undefined,
    corpo,
  }
}

/* ========================================================================== */
/* 2. AS LINHAS DE ACAO POR TIPO DE ALERTA                                     */
/* ========================================================================== */

/**
 * O mapeamento tipo -> linhas de acao do notify (decisao de T5.2, documentada):
 * os tipos que oferecem accao ao dono ganham UMA linha com intencao `emergency`
 * (a accao que REDUZ exposicao, sem nonce — CTL-024); `link-magico` nao ganha
 * linha mas liga `disable_web_page_preview` no envio (o nucleo trata disso no
 * onNotify). O token da linha e gerado pelo worker, viaja opaco e o host nao o
 * consome para `emergency`.
 */
export function botoesDeAlerta(tipo: TipoDeAlerta | undefined): ActionRowLayout {
  switch (tipo) {
    case 'sessao-nova':
      return [[linha('Não fui eu')]]
    case 'auth-falha':
      return [[linha('Derrubar túnel agora')]]
    case 'ttl-expirado':
    case 'relatorio':
      return [[linha('Encerrar')]]
    case 'tunel-ligar':
    case 'tunel-desligar':
    case 'modo-restrito':
    case 'magic-suspeito':
    case 'link-magico':
    case undefined:
      return []
  }
}

/** Uma linha de accao `emergency` com token opaco local e kind informativo. */
function linha(label: string): ActionRow {
  return {
    label,
    action: 'emergency',
    token: gerarTokenOpaque(),
    kind: 'emergency',
  }
}