/**
 * `verifyBasicAuth`: parse do cabecalho `Authorization` + comparacao em TEMPO
 * CONSTANTE.
 *
 * PORQUE NAO `!==`: o exemplo canonico da documentacao compara as strings com
 * `!==`. Isso e *timing-unsafe* -- a comparacao de strings do V8 termina no
 * primeiro byte diferente, pelo que o tempo de resposta revela quantos bytes
 * iniciais o atacante ja acertou, permitindo recuperar a credencial byte a byte
 * com medicoes estatisticas.
 *
 * PORQUE COMPARAR DIGESTS EM VEZ DO MATERIAL BRUTO: `crypto.timingSafeEqual`
 * LANCA `RangeError` se os buffers tiverem comprimentos diferentes -- e essa
 * excecao (ou o `return false` antecipado que a evitaria) vazaria o COMPRIMENTO
 * do segredo. Reduzir ambos os lados a um SHA-256 da sempre 32 bytes fixos, o
 * que torna a comparacao total e de duracao independente da entrada.
 *
 * ESQUEMA COMPARADO SEM DIFERENCIAR MAIUSCULAS (RFC 7235, seccao 2.1): o
 * *auth-scheme* e um token case-insensitive, pelo que `basic <credencial>` e
 * `BASIC <credencial>` sao pedidos legitimos. Comparar o esquema com `Basic `
 * literal produzia um 401 indevido a clientes conformes (curl com `--user`
 * envia `Basic`, mas bibliotecas HTTP e proxies normalizam cabecalhos de formas
 * diferentes). O PAYLOAD base64 que se segue continua a ser comparado byte a
 * byte, sensivel a maiusculas -- ai a sensibilidade e obrigatoria, porque base64
 * distingue `A` de `a`.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Compara a credencial apresentada com a esperada, em tempo constante.
 *
 * SEM CREDENCIAL CONFIGURADA, NINGUEM PASSA. `encodedAuthString` e opcional
 * desde que o `cordis.patch.yml` deixou de a poder transportar (Camada 1 /
 * Bundle; D19: credencial nao vive em ficheiro versionavel). A ausencia e
 * portanto um estado normal do arranque, e a unica leitura segura dele e
 * "nenhuma credencial e aceite" -- e a mesma direcao de `trustedRemotes: []`.
 * O retorno antecipado aqui NAO e um canal temporal util ao atacante: a
 * ausencia de credencial e um facto de configuracao, nao um segredo, e o
 * caminho rapido nao depende de nenhum byte apresentado.
 */
export function verifyBasicAuth(
  authorizationHeader: string | undefined,
  encodedAuthString: string | undefined,
): boolean {
  if (typeof encodedAuthString !== 'string' || encodedAuthString.length === 0) return false
  if (typeof authorizationHeader !== 'string') return false

  const prefix = 'basic '
  // O esquema em si nao e segredo: compara-lo em tempo variavel nao vaza nada.
  if (authorizationHeader.slice(0, prefix.length).toLowerCase() !== prefix) return false

  const presented = authorizationHeader.slice(prefix.length).trim()
  const presentedDigest = createHash('sha256').update(presented, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(encodedAuthString, 'utf8').digest()

  return timingSafeEqual(presentedDigest, expectedDigest)
}
