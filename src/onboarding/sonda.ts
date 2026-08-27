/**
 * =============================================================================
 * A SONDA — o unico I/O de rede do onboarding, agora POR PROVEDOR.
 * =============================================================================
 *
 * Tres camadas num ficheiro, e elas nao se separam:
 *
 *   1. o TRANSPORTE TELEGRAM (portado de `src/telegram/onboarding.ts`): o
 *      `criarSondaHttp` com `getMe`/`getUpdates` e a classificacao de falha
 *      MEDIDA (`docs/spikes/telegram.md`). NAO ha duplicacao: quem quiser a
 *      sonda telegram completa importa daqui (o `src/telegram/onboarding.ts`
 *      re-exporta para o CLI e os testes continuarem a encontrar a MESMA
 *      origem — o mesmo padrao da extracao de `texts.ts`);
 *   2. a SONDA DISCORD (nova): sem SDK, so `fetch` — `GET /users/@me` com o
 *      token no cabecalho `Authorization: Bearer`. O token do Discord nao
 *      viaja na URL (ao contrario do Telegram), e e essa diferenca de
 *      transporte que obriga a uma sonda propria por provedor;
 *   3. `criarSonda(provider, ...)`: a FABRICA provider-aware que devolve o
 *      probe comum `{ ok, botNome? }` — a superficie que o painel de T5.3
 *      consome sem saber com que provedor esta a falar.
 *
 * -----------------------------------------------------------------------------
 * PORQUE UM PROBE COMUM E NAO `criarSondaHttp` DIRETO NO PAINEL
 * -----------------------------------------------------------------------------
 * O painel pergunta "o token deste provedor vale? o bot tem nome publico?" —
 * e so isso. O `getUpdates` do Telegram (a sondagem de pareamento do CLI) e
 * especifico do canal e NAO faz parte dessa pergunta. O probe comum devolve o
 * minimo que a UI precisa: `ok`, `botNome` e um `erro` curto (nao prosa, nao
 * segredo). Quem precisar de mais (o CLI de pareamento) continua a usar a
 * sonda telegram completa — por injecao, nunca por duplicacao.
 *
 * -----------------------------------------------------------------------------
 * A RAZ DA API E CONFIGURAVEL POR PROVEDOR (TELEGRAM_API_ROOT / DISCORD_API_ROOT)
 * -----------------------------------------------------------------------------
 * O worker telegram le `TELEGRAM_API_ROOT` (`API_ROOT_ENV_VAR`); a sonda
 * discord le `DISCORD_API_ROOT` (o adaptador discord da Onda 3 tera o espelho
 * proprio). E a MESMA disciplina do `tokenVar`: o nome e DUPLICADO do lado do
 * worker e a paridade e um teste, nao um import — o worker so pode importar
 * `src/contracts/ipc.ts` de `src/` (`05-QUALIDADE-CODIGO.md` 5.5). Omissa,
 * cada provedor usa a raiz publica.
 */

import type { ProviderId } from '../proc/env.ts'

/* ========================================================================== */
/* Transporte telegram (PORTADO de src/telegram/onboarding.ts — nao duplicar) */
/* ========================================================================== */

/** Raiz da Bot API. SEM barra final. */
export const API_ROOT_PADRAO = 'https://api.telegram.org'

/** Teto de espera de uma chamada. Curto: isto e um CLI, nao um servico. */
export const TIMEOUT_DA_SONDA_MS = 10_000

/**
 * Quantos updates uma sondagem pede. O teto da propria Bot API e 100
 * (`Client.cpp` clampa `limit` a 1-100).
 *
 * E EXPORTADO porque e um LIMITE OBSERVAVEL, nao um detalhe: com `offset: 0` a
 * fila nunca e confirmada, logo uma resposta com exatamente
 * `LIMITE_DE_UPDATES` elementos significa "ha pelo menos mais alguns que nunca
 * veremos". Quem espera pelo `/parear` tem de reconhecer esse caso e dize-lo —
 * ver A2 no cabecalho de `bin/dsh-guard-setup.ts`.
 */
export const LIMITE_DE_UPDATES = 100

/** O que interessa do `User` devolvido por `getMe` (`#getme`). */
export interface IdentidadeDoBot {
  readonly id: number
  readonly username: string
}

/** Porque o `getMe` nao confirmou o token. Cada causa tem um texto proprio. */
export type CausaDeFalha =
  /** `401 Unauthorized: invalid token specified` — revogado ou errado. */
  | 'recusado'
  /** `404 Not Found` — o token nem chega a formar uma rota valida. */
  | 'rota-inexistente'
  /** `409 Conflict` — ja ha outra ligacao a usar este bot. */
  | 'conflito'
  /** `429` com `retry_after`. */
  | 'limite-de-taxa'
  /** Nao houve resposta: DNS, proxy, cabo. */
  | 'rede'
  /** Houve resposta e nao se percebeu — HTTP inesperado ou corpo nao-JSON. */
  | 'resposta-ininteligivel'

export interface FalhaDoGetMe {
  readonly causa: CausaDeFalha
  /** `0` quando nao houve resposta HTTP nenhuma. */
  readonly httpStatus: number
  readonly errorCode?: number | undefined
  /** `description` da API. NAO e apresentada em cru: ver {@link diagnostico}. */
  readonly description?: string | undefined
  /** Segundos pedidos por um `429` (`ResponseParameters.retry_after`). */
  readonly retryAfter?: number | undefined
}

export type RespostaGetMe =
  | { readonly ok: true; readonly bot: IdentidadeDoBot }
  | { readonly ok: false; readonly falha: FalhaDoGetMe }

/**
 * Classifica um par (HTTP, corpo) da Bot API.
 *
 * Os valores vem MEDIDOS, nao presumidos (`docs/spikes/telegram.md` 2.1 e 6):
 *   - `401 {"ok":false,"error_code":401,"description":"Unauthorized: invalid
 *     token specified"}` — token bem formado sem conta por tras;
 *   - `404 {"ok":false,"error_code":404,"description":"Not Found"}` — token sem
 *     `:`, que cai fora da rota `/bot<token>/<metodo>`;
 *   - `409 Conflict: terminated by other getUpdates request...` — ha outra
 *     instancia a fazer long polling com o MESMO token.
 */
export function classificarFalha(httpStatus: number, corpo: unknown): FalhaDoGetMe {
  const errorCode = numeroDe(corpo, 'error_code')
  const description = textoDe(corpo, 'description')
  const retryAfter = numeroDe(propriedade(corpo, 'parameters'), 'retry_after')
  const codigo = errorCode ?? httpStatus

  const causa: CausaDeFalha =
    codigo === 401
      ? 'recusado'
      : codigo === 404
        ? 'rota-inexistente'
        : codigo === 409
          ? 'conflito'
          : codigo === 429
            ? 'limite-de-taxa'
            : 'resposta-ininteligivel'

  return {
    causa,
    httpStatus,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(description === undefined ? {} : { description }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  }
}

/** Le um `User` de `{"ok":true,"result":{...}}`, sem confiar na forma. */
export function lerIdentidade(corpo: unknown): IdentidadeDoBot | undefined {
  const result = propriedade(corpo, 'result')
  const id = numeroDe(result, 'id')
  const username = textoDe(result, 'username')
  if (id === undefined || username === undefined) return undefined
  return { id, username }
}

function propriedade(valor: unknown, chave: string): unknown {
  if (typeof valor !== 'object' || valor === null) return undefined
  return (valor as Record<string, unknown>)[chave]
}

function numeroDe(valor: unknown, chave: string): number | undefined {
  const bruto = propriedade(valor, chave)
  return typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : undefined
}

function textoDe(valor: unknown, chave: string): string | undefined {
  const bruto = propriedade(valor, chave)
  return typeof bruto === 'string' && bruto.length > 0 ? bruto : undefined
}

export type ResultadoDeUpdates =
  | { readonly ok: true; readonly updates: readonly unknown[] }
  | { readonly ok: false; readonly falha: FalhaDoGetMe }

/**
 * O transporte, injetavel.
 *
 * PORQUE E UMA INTERFACE E NAO UM `fetch` solto: e por aqui que o motor de
 * pareamento deixa de depender de rede nenhuma. Hoje o CLI passa
 * {@link criarSondaHttp}; no dia em que o IPC host<->worker (T4.3) existir, a
 * fonte dos updates passa a ser o WORKER e nada no pareamento muda. Ver o
 * comentario de {@link SondaTelegram.getUpdates} para a razao dura.
 */
export interface SondaTelegram {
  getMe(token: string): Promise<RespostaGetMe>
  /**
   * Le updates SEM OS CONFIRMAR, e sem pendurar long poll.
   *
   * DUAS DECISOES, e as duas vem de medicao (`docs/spikes/telegram.md` 6 e 7):
   *
   *   1. `offset` NUNCA AVANCA. `getUpdates` com um `offset` maior que um
   *      `update_id` CONFIRMA e APAGA esse update no servidor — para sempre,
   *      para toda a gente. Se o onboarding confirmasse, os comandos que o
   *      worker precisava de ver desapareciam antes de ele nascer. Com
   *      `offset: 0` le-se a mesma fila as vezes que forem precisas e nao se
   *      apaga nada: o custo e reler updates ja vistos, que se descartam por
   *      `update_id` aqui dentro, e o beneficio e nao destruir a fila alheia.
   *   2. `timeout: 0` — sondagem curta, nunca long poll. Assim ESTA ferramenta
   *      nunca fica pendurada a espera, e nunca e ELA a vitima de um `409`
   *      quando o worker chegar depois.
   *
   * >>> O QUE ESTA POR CONFIRMAR, e fica escrito como tal <<<
   * Uma versao anterior deste comentario concluia que, por nao pendurar long
   * poll, esta ferramenta nao derrubaria o worker. ISSO NAO SE SEGUE. Pela
   * semantica do servidor oficial (`Client.cpp`, `abort_long_poll`), quem
   * termina o long poll pendente e a CHEGADA de um `getUpdates` novo, nao a
   * duracao dele — e esta ferramenta, chegando depois, e a que chega por
   * ultimo. O efeito de ~150 sondagens curtas ao longo do TTL sobre um worker
   * ja a fazer long polling NAO FOI MEDIDO: medi-lo exige trafego autenticado
   * contra `api.telegram.org`, que este repositorio proibe.
   *
   * O QUE SUSTENTAMOS, e que e o essencial: com `offset: 0` esta ferramenta
   * NUNCA CONFIRMA nada, logo nunca apaga do servidor um update de que o
   * worker precise. Nenhuma mensagem se perde por causa dela.
   *
   * O QUE SE FAZ COM A PARTE POR CONFIRMAR: a saida do CLI DECLARA a
   * pre-condicao ("o harness nao deve estar a correr com este mesmo bot") em
   * vez de a presumir resolvida, e um `409` que apareca e detectado e explicado
   * em portugues. `docs/spikes/telegram.md` 7 aponta a saida definitiva — o
   * update chega pelo IPC do worker (T4.3) — e e para isso que a sonda entra
   * por injecao.
   */
  getUpdates(token: string): Promise<ResultadoDeUpdates>
}

export interface OpcoesDaSonda {
  /** Raiz da API. Os testes apontam-na para um servidor local. SEM barra final. */
  readonly apiRoot?: string | undefined
  /** `fetch` injetavel. Omitido: o global do Node 24. */
  readonly buscar?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

export function criarSondaHttp(opcoes: OpcoesDaSonda = {}): SondaTelegram {
  const apiRoot = (opcoes.apiRoot ?? API_ROOT_PADRAO).replace(/\/+$/u, '')
  const buscar = opcoes.buscar ?? fetch
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_DA_SONDA_MS

  /**
   * Uma chamada a Bot API.
   *
   * O TOKEN VIAJA NO CAMINHO DO URL — e a forma da API (`/bot<token>/<metodo>`)
   * e nao ha alternativa. Por isso NADA do que sai daqui contem o URL: nem a
   * mensagem de erro, nem o `description`. E tambem por isso que
   * `src/logging/redact.ts` existe e tem uma forma para este token.
   */
  const chamar = async (
    token: string,
    metodo: string,
    corpo: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly httpStatus: number; readonly corpo: unknown } | { readonly rede: true }> => {
    try {
      const resposta = await buscar(`${apiRoot}/bot${token}/${metodo}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const texto = await resposta.text()
      let lido: unknown
      try {
        lido = JSON.parse(texto)
      } catch (erroDeJson) {
        // NAO se engole: um corpo nao-JSON e um proxy corporativo a devolver
        // uma pagina de bloqueio, e a pessoa tem de saber que houve resposta.
        void erroDeJson
        lido = undefined
      }
      return { httpStatus: resposta.status, corpo: lido }
    } catch (erroDeRede) {
      // A mensagem de `fetch` traz o URL, e o URL traz o token. Ela e
      // DELIBERADAMENTE descartada: a causa `rede` diz tudo o que a pessoa
      // pode accionar, e nada do que ela pode vazar.
      void erroDeRede
      return { rede: true }
    }
  }

  return {
    async getMe(token: string): Promise<RespostaGetMe> {
      const resposta = await chamar(token, 'getMe', {})
      if ('rede' in resposta) {
        return { ok: false, falha: { causa: 'rede', httpStatus: 0 } }
      }
      const identidade =
        resposta.httpStatus === 200 && propriedade(resposta.corpo, 'ok') === true
          ? lerIdentidade(resposta.corpo)
          : undefined
      if (identidade !== undefined) return { ok: true, bot: identidade }
      return { ok: false, falha: classificarFalha(resposta.httpStatus, resposta.corpo) }
    },

    async getUpdates(token: string): Promise<ResultadoDeUpdates> {
      // `offset: 0` e `timeout: 0`: ver o JSDoc da interface. Estes dois zeros
      // sao a entrega, nao um valor por omissao esquecido.
      const resposta = await chamar(token, 'getUpdates', {
        offset: 0,
        timeout: 0,
        limit: LIMITE_DE_UPDATES,
        allowed_updates: ['message'],
      })
      if ('rede' in resposta) {
        return { ok: false, falha: { causa: 'rede', httpStatus: 0 } }
      }
      const resultado = propriedade(resposta.corpo, 'result')
      if (resposta.httpStatus === 200 && Array.isArray(resultado)) {
        return { ok: true, updates: resultado as readonly unknown[] }
      }
      return { ok: false, falha: classificarFalha(resposta.httpStatus, resposta.corpo) }
    },
  }
}

/* ========================================================================== */
/* O probe comum por provedor                                                  */
/* ========================================================================== */

/** Raiz publica da API do Discord (v10). SEM barra final. */
export const DISCORD_API_ROOT_PADRAO = 'https://discord.com/api/v10'

/**
 * Variavel de ambiente da raiz da API, por provedor — o nome DUPLICADO do lado
 * do worker (`TELEGRAM_API_ROOT` em `worker/providers/telegram/token.ts`); a
 * paridade e um teste, nao um import (cone de import).
 */
const API_ROOT_VAR: Readonly<Record<ProviderId, string>> = {
  telegram: 'TELEGRAM_API_ROOT',
  discord: 'DISCORD_API_ROOT',
}

/**
 * Resolve a raiz da API do provedor a partir do ambiente.
 *
 * Omissa (ou vazia) = a raiz publica do provedor — o valor que o painel usa
 * quando ninguem apontou para um duplo de teste. Configuravel por
 * `TELEGRAM_API_ROOT` (telegram) e `DISCORD_API_ROOT` (discord).
 */
export function apiRootDe(
  provider: ProviderId,
  ambiente: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const bruto = ambiente[API_ROOT_VAR[provider]]?.trim()
  return bruto === undefined || bruto === '' ? undefined : bruto
}

/** Porque o token do provedor nao foi confirmado. Curto e estavel (UI). */
export type MotivoDeFalhaDaProva = 'token-invalido' | 'rede' | 'indisponivel'

/**
 * O probe COMUM: a resposta a "este token vale? o bot tem nome publico?".
 *
 *   - `ok: true` + `botNome` — o token vale e o bot tem nome publico;
 *   - `ok: true` sem `botNome` — o bot EXISTE mas nao tem nome publico (no
 *     Telegram, o `getMe` com HTTP 200 sem `username` — ver {@link criarSonda});
 *   - `ok: false` + `erro` — o token foi recusado, a rede falhou, ou a resposta
 *     nao se interpretou. `erro` e um codigo curto, nunca prosa nem segredo.
 */
export interface ResultadoDeProva {
  readonly ok: boolean
  readonly botNome?: string | undefined
  readonly erro?: MotivoDeFalhaDaProva | undefined
}

/** O probe que a UI consome: confirma o token do provedor ativo. */
export interface SondaDeProvedor {
  verificar(token: string): Promise<ResultadoDeProva>
}

export interface OpcoesDeSondaDeProvedor {
  /** Raiz da API (duplo de teste). Omissa: a raiz publica do provedor. */
  readonly apiRoot?: string | undefined
  /** `fetch` injetavel. Omitido: o global do Node 24. */
  readonly buscar?: typeof fetch | undefined
  readonly timeoutMs?: number | undefined
}

/**
 * A sonda discord: `GET /users/@me` com o token no cabecalho, sem SDK.
 *
 * DIFERENCA DE TRANSPORTE QUE OBRIGA A ISTO, e vale a pena dizer em voz alta:
 * o token do Telegram viaja no CAMINHO do URL (`/bot<token>/getMe`) — a forma
 * daquela API; o token do Discord viaja no CABECALHO `Authorization: Bearer`.
 * O probe comum esconde essa diferenca, mas o transporte nao podia ser o
 * mesmo. A raiz e configuravel (`DISCORD_API_ROOT`) para o duplo de teste.
 *
 * O que se classifica: 200 com `username` -> ok; 200 sem `username` -> ok sem
 * nome (espelho do caso medido no telegram); 401 -> token recusado; qualquer
 * outro status -> indisponivel; sem resposta -> rede. A mensagem de erro do
 * `fetch` e DELIBERADAMENTE descartada (pode citar a URL; o corpo nunca e
 * devolvido em cru para a UI).
 */
export function criarSondaDiscord(opcoes: OpcoesDeSondaDeProvedor = {}): SondaDeProvedor {
  const apiRoot = (opcoes.apiRoot ?? DISCORD_API_ROOT_PADRAO).replace(/\/+$/u, '')
  const buscar = opcoes.buscar ?? fetch
  const timeoutMs = opcoes.timeoutMs ?? TIMEOUT_DA_SONDA_MS

  return {
    async verificar(token: string): Promise<ResultadoDeProva> {
      try {
        const resposta = await buscar(`${apiRoot}/users/@me`, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (resposta.status === 401) return { ok: false, erro: 'token-invalido' }
        const texto = await resposta.text()
        let corpo: unknown
        try {
          corpo = JSON.parse(texto)
        } catch (erroDeJson) {
          void erroDeJson
          corpo = undefined
        }
        if (resposta.status === 200) {
          const username = textoDe(corpo, 'username')
          if (username !== undefined) return { ok: true, botNome: username }
          // 200 sem `username`: o endpoint respondeu mas nao como um User —
          // espelho do caso telegram (bot existe sem nome publico).
          return { ok: true }
        }
        return { ok: false, erro: 'indisponivel' }
      } catch (erroDeRede) {
        void erroDeRede
        return { ok: false, erro: 'rede' }
      }
    },
  }
}

/**
 * A FABRICA provider-aware: devolve o probe comum para o provedor ativo.
 *
 * O dispatcher e o `ProviderId` FECHADO de `src/proc/env.ts` — um provedor
 * novo acrescenta aqui o ramo e a sua implementacao. Nada no chamador muda.
 */
export function criarSonda(
  provider: ProviderId,
  opcoes: OpcoesDeSondaDeProvedor = {},
): SondaDeProvedor {
  if (provider === 'discord') return criarSondaDiscord(opcoes)

  // Telegram: o probe comum por cima do transporte portado — o getMe decide.
  // `ok:false` com HTTP 200 = o bot EXISTE e nao tem @username (o contrato do
  // getMe colapsa o "sem username" nesse 200) — verde legitimo, sem nome.
  const sonda = criarSondaHttp(opcoes)
  return {
    async verificar(token: string): Promise<ResultadoDeProva> {
      const resposta = await sonda.getMe(token)
      if (resposta.ok) return { ok: true, botNome: resposta.bot.username }
      if (resposta.falha.httpStatus === 200) return { ok: true }
      const erro: MotivoDeFalhaDaProva =
        resposta.falha.causa === 'recusado' || resposta.falha.causa === 'rota-inexistente'
          ? 'token-invalido'
          : resposta.falha.causa === 'rede'
            ? 'rede'
            : 'indisponivel'
      return { ok: false, erro }
    },
  }
}
