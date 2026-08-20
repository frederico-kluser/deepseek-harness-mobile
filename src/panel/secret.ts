/**
 * `GET /__guard/secret?ott=...` -- uma vez; 404 identico ao de rota inexistente.
 *
 * DONO: T3.4.
 *
 * ------------------------------------------------------------------------
 * PORQUE ESTA ROTA EXISTE
 * ------------------------------------------------------------------------
 * O segredo aparece UMA vez, no terminal onde o plugin arrancou. Quem fecha essa
 * janela sem o guardar fica sem forma de o rever -- e a alternativa seria rodar
 * o segredo, que invalida as sessoes vivas. Esta e a segunda (e ultima) tela.
 *
 * Ela nao pode ser protegida pelo proprio segredo (quem chega aqui e porque o
 * perdeu) e nao pode ser protegida por "origem loopback", que e INERTE sob
 * tunel: pelo tunel toda a gente chega como `127.0.0.1`. O que a tranca e o
 * `ott` de T2.1: 128 bits de CSPRNG impressos no STDOUT do terminal de
 * arranque, TTL de 10 minutos, uso unico. Quem le esse terminal ja esta na
 * maquina.
 *
 * ------------------------------------------------------------------------
 * SEM `ott` VALIDO, O 404 TEM DE SER INDISTINGUIVEL DE ROTA INEXISTENTE
 * ------------------------------------------------------------------------
 * Um `401` ou um `403` aqui ANUNCIA "esta rota existe" a quem varre a internet a
 * procura de quick tunnels -- e o que ela devolve, quando destrancada, e a
 * senha permanente. Por isso a resposta e `NOT_FOUND_RESPONSE`, A MESMA
 * CONSTANTE que o despachante devolve para `/__guard/qualquer-coisa-que-nunca-
 * existiu`: mesmo estado, mesmos cabecalhos, mesma ordem de cabecalhos, mesmo
 * corpo. Nao ha aqui um segundo literal onde a diferenca possa nascer.
 *
 * ------------------------------------------------------------------------
 * TEMPO: A AFIRMACAO ANTERIOR ERA GRANDE DEMAIS, E FOI MEDIDA A FALHAR
 * ------------------------------------------------------------------------
 * Esta nota dizia que os dois caminhos eram indistinguiveis no tempo. A revisao
 * adversarial mediu, com N=4000 pares alternados: +10,3 us de mediana e 92,8%
 * das amostras com o `secret` mais lento, com o `AuditSink` real; +2,9 us e
 * 87,9% com um duble em memoria. Nao era ruido.
 *
 * O QUE MUDOU NA CONSTRUCAO, e e a maior das duas contribuicoes:
 *   1. O `ott` invalido DEIXOU DE ESCREVER no disco em cada pedido. A recusa
 *      anonima passa pelo porteiro de `api.ts`, que escreve em `O(log N)`. Os
 *      ~7,4 us que separavam o sink real do duble desaparecem por construcao,
 *      e o teste de seguranca CONTA AS CHAMADAS A `write(2)` com o
 *      `openAuditLog` real -- deterministico, sem cronometro, sem flake.
 *   2. O despachante passou a calcular a chave, a politica e a sessao para
 *      TODOS os pedidos sob `/__guard`, inclusive os que nao casam rota. Isso
 *      remove tres assimetrias que so o caminho da rota existente pagava.
 *
 * O QUE SOBRA, dito sem exagero: o caminho do segredo ainda decompoe a query e
 * ainda calcula um sha256 no `consume`. Isso e alguns microssegundos e nao ha
 * como o levar a zero sem inventar trabalho-isco no caminho de toda a rota
 * inexistente -- o que amplificaria qualquer varredura para pagar um bit que ja
 * e publico.
 *
 * E ELE E PUBLICO: `GET /__guard` responde `401` com
 * `WWW-Authenticate: Basic realm="Secure DSH Interface"`, o plugin e software
 * aberto e a tabela de rotas esta na documentacao. Descobrir que
 * `/__guard/secret` existe nao custa um cronometro.
 *
 * A AFIRMACAO QUE FICA, e esta e verificavel: o canal de tempo nao carrega UM
 * BIT sobre o `ott` nem sobre o segredo. `consume` compara digests com
 * `timingSafeEqual` e faz o mesmo trabalho para todo candidato -- valido,
 * invalido, curto, longo ou vazio. O que um cronometro distingue e "esta rota e
 * `/__guard/secret`", nunca "este palpite esteve perto".
 *
 * `04-TESTES.md` 5.1.3 continua a proibir cronometro em CI, e com razao: um
 * limiar apertado o bastante para apanhar 10 us e uma maquina de flake. Por
 * isso o guarda de regressao e a CONTAGEM DE ESCRITAS, que e exata.
 *
 * ------------------------------------------------------------------------
 * O SEGREDO APARECE NESTA RESPOSTA E EM SITIO NENHUM ALEM DELA
 * ------------------------------------------------------------------------
 * Nao entra em log (nem em `debug`), nao entra em mensagem de erro, nao entra em
 * evento de auditoria e nao entra em rasto de pilha. O evento de auditoria
 * regista que a tela foi servida, nunca o que ela continha.
 */

import type { GuardLogger } from '../logging/logger.ts'
import type { OneTimeTokenStore } from '../secret/ott.ts'
import type { AuditGate, PanelExchange, PanelHandler, PanelResponse } from './api.ts'
import { NOT_FOUND_RESPONSE } from './api.ts'
import { renderSecretPanel } from '../secret/generate.ts'
import { newNonce, panelHtmlHeaders, renderSecretPage } from './html.ts'

/** O unico parametro de query que esta rota le. */
export const OTT_QUERY_PARAM = 'ott'

/**
 * De onde sai o segredo em claro.
 *
 * ELE NAO PODE VIR DO `SecretStore`: aquele modulo guarda o DIGEST e nunca
 * retem o segredo -- e essa e uma propriedade que nao se enfraquece para
 * servir uma tela. Quem retem o valor em claro e quem o gerou (o CLI de
 * arranque, T4.1), pelo tempo em que ele ainda pode ser mostrado. Aqui ele
 * entra por funcao injetada, e `null` significa "ja nao ha nada para mostrar".
 */
export interface SecretRevealDeps {
  readonly ott: Pick<OneTimeTokenStore, 'consume'>
  readonly reveal: () => string | null
  /** O PORTEIRO, e nao o sink cru -- ver {@link AuditGate}. */
  readonly audit: AuditGate
  readonly log: GuardLogger
}

/**
 * Nome do evento da recusa anonima desta rota.
 *
 * ELE E AGREGADO, e nao escrito por pedido. Um `ott` invalido nao e uma
 * tentativa de autenticacao e NAO passa pelo limitador de T2.3 -- que e a
 * condicao com que `src/audit/log.ts` justifica nao ter rotacao. Escrever uma
 * linha por pedido dava a um anonimo, pela internet, uma torneira de 1,4 MiB/s
 * para dentro de um ficheiro `0600` que por desenho nao se pode rodar nem
 * truncar. Medido pela revisao adversarial, nao imaginado.
 */
export const SECRET_REJECTION_EVENT = 'painel_segredo_recusa_anonima'

/**
 * Extrai a query de um `req.url` cru.
 *
 * Sem `new URL(...)`: `req.url` do `node:http` e um caminho relativo, nao um URL
 * absoluto, e dar-lhe uma base falsa so para o poder decompor e convidar a base
 * a aparecer numa mensagem qualquer. O fragmento e cortado porque um cliente
 * pode envia-lo (nao devia, mas o campo e livre) e ele nao faz parte da query.
 */
function queryOf(rawUrl: string): URLSearchParams {
  const start = rawUrl.indexOf('?')
  if (start === -1) return new URLSearchParams()
  const hash = rawUrl.indexOf('#', start)
  const end = hash === -1 ? rawUrl.length : hash
  return new URLSearchParams(rawUrl.slice(start + 1, end))
}

export function createSecretHandler(deps: SecretRevealDeps): PanelHandler {
  return async (exchange: PanelExchange): Promise<PanelResponse> => {
    const candidate = queryOf(exchange.rawUrl).get(OTT_QUERY_PARAM) ?? ''

    // `consume` faz o uso unico: so o ACERTO queima o token (ver `ott.ts`), por
    // isso um palpite errado nao custa ao dono o token que ele ainda nao usou.
    if (!deps.ott.consume(candidate)) {
      deps.audit.recordAnonymousRejection(SECRET_REJECTION_EVENT)
      return NOT_FOUND_RESPONSE
    }

    const secret = deps.reveal()
    if (secret === null) {
      // O token era valido e ja foi queimado, mas nao ha segredo em memoria para
      // mostrar. FECHA-SE: devolver uma pagina a explicar isto distinguiria esta
      // rota de uma inexistente, que e exatamente o que nao pode acontecer. O
      // operador fica a saber pelo log; o fio nao.
      deps.log.warn(
        '[painel] ott valido consumido sem segredo em memoria para mostrar; ' +
          'a tela do segredo so existe enquanto o processo que o gerou estiver vivo',
      )
      return NOT_FOUND_RESPONSE
    }

    deps.audit.append({ evento: 'painel_segredo', resultado: 'permitido' })

    const nonce = newNonce()
    return {
      status: 200,
      headers: panelHtmlHeaders(nonce),
      // `renderSecretPanel` e de T2.1 e desenha o texto agrupado MAIS o QR na
      // mesma tela. Nao se remonta nada: duplicar o desenho era ficar com duas
      // telas que divergem, e uma delas com a polaridade do QR errada.
      body: renderSecretPage({ nonce, secretPanel: renderSecretPanel(secret) }),
    }
  }
}
