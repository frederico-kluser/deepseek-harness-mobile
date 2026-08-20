/**
 * `GET` inerte + `POST` consumidor de `/__guard/magic`.
 *
 * DONO: T3.4.
 *
 * ------------------------------------------------------------------------
 * O REQUISITO MENOS OBVIO DESTA SUB-TAREFA: O `GET` NAO PODE CONSUMIR
 * ------------------------------------------------------------------------
 * Um link magico enviado por Telegram e PRE-CARREGADO antes de o dono lhe tocar
 * -- pelo pre-visualizador de hiperligacoes do proprio Telegram, por scanners de
 * antiphishing, por clientes de e-mail e por qualquer robo que veja a mensagem.
 * Se o `GET` queimasse o `mk`, o link morria no pre-carregamento e o dono
 * receberia "link ja usado" num link que NUNCA usou. Nao e preferencia de
 * estilo: e o modo de falha que torna o controlo inutil.
 *
 * Por isso: o `GET` serve HTML ESTATICO com um formulario e nao toca no store;
 * so o `POST` consome. `MAG-001` e `PANEL-006` sao os casos que o provam --
 * dois `GET` seguidos e depois um `POST`, e o `POST` funciona.
 *
 * ------------------------------------------------------------------------
 * "CONSUMO SEM CLIQUE DETECTAVEL" -- O QUE E VERDADE E O QUE NAO E
 * ------------------------------------------------------------------------
 * AFIRMACAO RETIRADA. A versao anterior deste ficheiro dizia que o token
 * anti-CSRF ERA o sinal de clique. E FALSO, e a revisao adversarial demoliu-o
 * com dois pedidos, sem navegador e sem clique: `GET /__guard/magic` entrega o
 * token a QUALQUER anonimo (a rota e publica e o vinculo do token e a chave da
 * rota), e o `POST` seguinte com esse token consome o `mk` e recebe sessao.
 * Pior: os eventos `magic.crawler-suspect` que a suite registava vinham dos
 * `POST` CEGOS -- precisamente os que nao tinham `mk` e portanto nao tinham
 * nada para queimar. O alarme disparava quando nao havia nada a proteger e
 * calava-se quando o `mk` era queimado por um nao-humano.
 *
 * O QUE CADA CONTROLO COMPRA, agora sem exagero:
 *
 *   - TOKEN ANTI-CSRF: impede que uma pagina de OUTRA origem, aberta no
 *     navegador do dono, dispare este `POST` com a autoridade ambiente dele.
 *     E obriga a dois passos (`GET` e depois `POST`), o que exclui o buscador
 *     de pre-visualizacao ingenuo. Nao prova humano nenhum.
 *   - `Sec-Fetch-Site`: quando o cliente o envia, ele tem de dizer
 *     `same-origin` -- e o que um `fetch` disparado pela NOSSA pagina produz.
 *     Um `POST` navegado a mao, vindo de outro sitio, ou de um cliente que se
 *     faca passar por navegador com o valor errado, e recusado SEM consumir o
 *     `mk` e regista `magic.crawler-suspect`. E a "camada barata" que
 *     `02-SEGURANCA.md` 5 ja nomeava.
 *   - O `mk`: 128 bits, 120 s, uso unico. E o unico que autentica.
 *
 * PORQUE NAO SE EXIGE `Sec-Fetch-Site` QUANDO ELE FALTA: Safari so o envia
 * desde a 16.4. Exigi-lo trancava o telemovel do dono fora do produto -- e o
 * telemovel do dono E o produto. A ausencia e registada no evento de sucesso,
 * para que o alerta de sessao nova possa dize-lo.
 *
 * LIMITE CONHECIDO, e ele e estrutural, nao preguica: NAO EXISTE forma de
 * vincular o token a ESTE `mk`. O `mk` viaja no FRAGMENTO e nunca chega ao
 * servidor, logo o servidor nao o conhece no momento em que emite o token. E um
 * navegador sem cabeca satisfaz token e `Sec-Fetch-Site` na mesma. O que fica
 * excluido e o pre-visualizador do Telegram (o `GET` dele e inerte, verificado);
 * o que NAO fica excluido e um scanner que extraia o URL do TEXTO da mensagem e
 * conduza um navegador real. Contra esse, o controlo que resta e o TTL de 120 s.
 * Nao se inventa aqui heuristica de User-Agent para fingir o contrario.
 *
 * ------------------------------------------------------------------------
 * O `mk` VEM DO FRAGMENTO E NUNCA DA QUERY STRING
 * ------------------------------------------------------------------------
 * Este ficheiro NAO le `?mk=` -- nem no `GET`, nem no `POST`. O fragmento nao e
 * enviado ao servidor nem propagado em `Referer`, logo o `mk` nao entra em log
 * de servidor nem em log de intermediario. Quem o poe no corpo do `POST` e o
 * JavaScript da pagina, que o leu de `location.hash`.
 */

import type { IncomingMessage } from 'node:http'

import type { GuardLogger } from '../logging/logger.ts'
import type { FailureTracker } from '../ratelimit/tracker.ts'
import type { MagicStore } from '../session/magic.ts'
import type { GuardSessionStore } from '../session/store.ts'
import type { AuditGate, PanelExchange, PanelHandler, PanelResponse } from './api.ts'
import { runThrottledAttempt } from '../ratelimit/tracker.ts'
import {
  CREDENTIAL_DENIED_RESPONSE,
  emitSession,
  INTERNAL_ERROR_RESPONSE,
  OK_JSON_RESPONSE,
} from './api.ts'
import { newNonce, panelHtmlHeaders, renderMagicPage } from './html.ts'

/** Nome do campo que transporta o `mk` no corpo do `POST`. */
export const MAGIC_FIELD_NAME = 'mk'

/**
 * O evento que D3 nomeia para o consumo sem clique detectavel.
 *
 * O nome e o literal de `09-DECISOES-CANONICAS.md` D3 e de `04-TESTES.md`
 * MAG-006. O vocabulario fechado de auditoria e de T5.4 (`src/audit/events.ts`,
 * ainda vazio); quando ele existir, esta constante passa a apontar para la em
 * vez de declarar a string.
 *
 * ELE E EMITIDO ONDE HA ALGO A PROTEGER: neste tratador, com o `mk` em mao e
 * ANTES de o consumir. Na versao anterior era emitido pelo despachante, na
 * recusa de CSRF -- ou seja, no pedido cego que nem `mk` trazia.
 */
export const MAGIC_CRAWLER_EVENT = 'magic.crawler-suspect'

/**
 * O cabecalho que diz de ONDE o pedido partiu, segundo o proprio navegador.
 *
 * Ele e `Sec-`: a especificacao de Fetch proibe que JavaScript de pagina o
 * defina ou o altere. Um `fetch` disparado pela nossa pagina produz
 * `same-origin`; uma navegacao escrita a mao produz `none`; um formulario de
 * outro sitio produz `cross-site`.
 */
export const CLICK_SIGNAL_HEADER = 'sec-fetch-site'

/** O unico valor compativel com "partiu da pagina que nos servimos". */
const CLICK_SIGNAL_EXPECTED = 'same-origin'

export type ClickSignal = 'da-nossa-pagina' | 'de-outro-sitio' | 'ausente'

/**
 * Classifica o sinal de clique. NAO decide nada -- quem decide e o tratador.
 *
 * Um cabecalho REPETIDO (`string[]`) conta como `de-outro-sitio`: escolher uma
 * das ocorrencias e escolher a do atacante em metade dos casos, tal como no
 * cookie duplicado.
 */
export function classifyClickSignal(req: IncomingMessage): ClickSignal {
  const bruto = req.headers[CLICK_SIGNAL_HEADER]
  if (bruto === undefined) return 'ausente'
  if (typeof bruto !== 'string') return 'de-outro-sitio'
  return bruto.trim().toLowerCase() === CLICK_SIGNAL_EXPECTED ? 'da-nossa-pagina' : 'de-outro-sitio'
}

export interface MagicPageBindings {
  /** Vinculo do token que o `POST /__guard/magic` vai exigir. */
  readonly magicBinding: string
  /**
   * Vinculo do token de `POST /__guard/api/login`.
   *
   * PORQUE ELE VIAJA NESTA PAGINA: `/__guard/api/login` e uma rota publica e
   * `GET /__guard/` exige sessao, logo um cliente que ainda nao tem sessao nao
   * tem nenhuma pagina NOSSA de onde tirar um token para o login. Esta pagina --
   * publica e inerte -- e essa origem. Servi-lo aqui nao enfraquece nada: uma
   * pagina de outra origem nao consegue LER a nossa resposta (o navegador
   * bloqueia a leitura entre origens e nao emitimos CORS), e quem chega pelo
   * lado do servidor nao tem autoridade ambiente nenhuma para exercer.
   */
  readonly loginBinding: string
}

/**
 * `GET /__guard/magic` -- INERTE.
 *
 * Sem `deps`, e isso e a prova mais curta da inercia: este tratador nao tem
 * acesso ao `MagicStore`, ao `SessionStore` nem ao limitador. Ele nao PODE
 * consumir nada, mesmo que alguem o edite distraidamente. E tambem nao devolve
 * `Set-Cookie` -- nao ha caminho no tipo de retorno por onde o fizesse sem que
 * a revisao o visse.
 *
 * Emitir os tokens anti-CSRF nao e estado: sao assinaturas HMAC sem escrita
 * nenhuma (ver o cabecalho de `csrf.ts`). Um pre-carregamento continua a custar
 * exatamente zero bytes de memoria ao servidor.
 */
export function createMagicPageHandler(bindings: MagicPageBindings): PanelHandler {
  return async (exchange: PanelExchange): Promise<PanelResponse> => {
    const nonce = newNonce()
    return {
      status: 200,
      headers: panelHtmlHeaders(nonce),
      body: renderMagicPage({
        nonce,
        magicCsrf: exchange.csrf.issue(bindings.magicBinding),
        loginCsrf: exchange.csrf.issue(bindings.loginBinding),
      }),
    }
  }
}

export interface MagicConsumeDeps {
  readonly magic: Pick<MagicStore, 'consume'>
  readonly sessions: Pick<GuardSessionStore, 'regenerate'>
  readonly limiter: FailureTracker
  readonly wait: (ms: number) => Promise<void>
  /** O PORTEIRO, e nao o sink cru -- ver {@link AuditGate}. */
  readonly audit: AuditGate
  readonly log: GuardLogger
}

/**
 * `POST /__guard/magic` -- consome, uma unica vez.
 *
 * O `mk` esta sob O MESMO limitador e conta para O MESMO teto de falhas do
 * login (D3). Nao e um limitador proprio: dois orcamentos separados dariam ao
 * atacante o dobro das tentativas pelo simples facto de haver duas portas.
 *
 * NOTA HONESTA sobre `runThrottledAttempt` com efeito colateral: ele corre
 * `verify()` mesmo quando a identidade esta banida, para o custo ser constante.
 * Aqui `verify()` QUEIMA o `mk`. Na exposicao real isso nao morde -- sob tunel
 * toda a gente e `127.0.0.1`, `Identity.ip` vem `undefined` (spike S2) e o
 * balde global NUNCA e banido, por decisao de `ratelimit/policy.ts` (banir toda
 * a gente incluia o dono). Fica registado porque, no dia em que
 * `trustEdgeHeaders` passar a `true`, um `mk` consumido durante um ban vira
 * comportamento observavel.
 */
export function createMagicConsumeHandler(deps: MagicConsumeDeps): PanelHandler {
  return async (exchange: PanelExchange): Promise<PanelResponse> => {
    const mk = exchange.fields.get(MAGIC_FIELD_NAME) ?? ''
    const sinal = classifyClickSignal(exchange.req)

    if (sinal === 'de-outro-sitio') {
      // ANTES DE CONSUMIR. Este e o unico ponto do fluxo em que "nao queima o
      // `mk`" tem significado: aqui ha um `mk` em mao e ele sai intacto.
      // A resposta e a MESMA de qualquer outra recusa -- distinguir daria a
      // quem sonda um mapa dos controlos.
      deps.audit.recordAnonymousRejection(MAGIC_CRAWLER_EVENT)
      return CREDENTIAL_DENIED_RESPONSE
    }

    const outcome = await runThrottledAttempt(
      deps.limiter,
      exchange.identity,
      () => deps.magic.consume(mk),
      deps.wait,
    )

    if (!outcome.granted) {
      deps.audit.append({
        evento: 'painel_magic',
        resultado: 'negado',
        ...(exchange.identity.ip === undefined ? {} : { ip_normalizado: exchange.identity.ip }),
      })
      // Expirado, ja gasto, malformado ou banido: UMA saida so. A razao fica no
      // log de auditoria, do lado de dentro, e nunca no fio.
      return CREDENTIAL_DENIED_RESPONSE
    }

    const emitted = emitSession({
      sessions: deps.sessions,
      origin: exchange.origin,
      presentedSessionId: exchange.presentedSessionId,
      log: deps.log,
    })
    if (!emitted.ok) return INTERNAL_ERROR_RESPONSE

    // O sufixo diz ao alerta de sessao nova (T5.4) se houve sinal de clique.
    // `ausente` nao e recusa -- e um navegador que nao envia o cabecalho -- mas
    // e um facto que o dono tem direito a ver na mensagem que recebe.
    deps.audit.append({
      evento: sinal === 'ausente' ? 'painel_magic_sem_sinal_de_clique' : 'painel_magic',
      resultado: 'permitido',
      ...(exchange.identity.ip === undefined ? {} : { ip_normalizado: exchange.identity.ip }),
    })

    return { ...OK_JSON_RESPONSE, setCookie: emitted.setCookie }
  }
}
