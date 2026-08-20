/**
 * =============================================================================
 * dsh-guarded-bot-orchestrator -- RAIZ DE COMPOSICAO
 * Plugin Cordis v4 para o DeepSeek Harness (DSH) v0.1
 * =============================================================================
 *
 * Este ficheiro FIA MODULOS. Nao implementa regra: cada decisao vive no seu
 * modulo (`src/http/**`, `src/proc/**`, `src/config/**`, ...) e este ponto de
 * entrada limita-se a `name`, `inject` e `apply`. Enquanto tudo isto era um so
 * ficheiro de 1836 linhas, toda onda do plano tinha paralelismo 1.
 *
 * TRES RESPONSABILIDADES, na ordem em que `apply()` as instala:
 *
 *   1. ENDURECIMENTO DO PLANO DE CONTROLO
 *      Bind de loopback obrigatorio, allowlist de origens remotas fail-closed e
 *      o veto de elevacoes para `danger-full-access` como DEFESA EM PROFUNDIDADE
 *      -- nao como travao principal: ver a nota extensa no ouvinte
 *      `security/permission-elevate` mais abaixo.
 *
 *   2. BARREIRA HTTP REVERSIVEL
 *      Troca de dono do despacho no `node:http.Server` do `ctx.webServer`, com
 *      Basic Auth avaliada por `ctx.waterfall('http/auth-check', ...)`. Nenhuma
 *      biblioteca externa: so `node:http` (tipos) e `node:crypto`. A mecanica
 *      esta em `src/http/intercept.ts`, e o PORQUE de nao ser `ctx.intercept`
 *      esta la, no cabecalho.
 *
 *   3. ORQUESTRACAO ATOMICA DO WORKER DE LONG-POLLING
 *      O processo filho vive dentro de um `ctx.effect()`, cujo disposer SINCRONO
 *      aborta, mata a arvore processual e cancela o temporizador de reinicio. A
 *      Fiber do Cordis erradica tudo em LIFO.
 *
 * PORQUE E QUE ISTO EXISTE
 *   A discussao oficial #853 ("unauthenticated local/remote code execution via
 *   the dsh web UI control plane", verificada em 0.1.0-rc.6) demonstra que a
 *   sub-estacao `/api` do DSH responde a sockets SEM qualquer credencial. Entre
 *   as suas mais de 60 rotas RPC esta `commands/execute`, capaz de injetar
 *   `/permission danger-full-access` e derrubar o confinamento `workspace-write`
 *   do Sandbox (fuga documentada em #1769). Este plugin e o portao que fecha
 *   essa superficie.
 *
 * CONVENCOES APLICADAS AQUI
 *   - "fail loud at load" (Q-3): configuracao invalida ou bind inseguro fazem
 *     `throw` no `apply()`. Nunca `?? valor_por_omissao` numa decisao de
 *     seguranca.
 *   - "explicit > implicit": tudo o que e politica de seguranca vem da
 *     configuracao, nada e inferido.
 *   - Reversibilidade atomica (Q-2): TODO registo propaga um disposer SINCRONO.
 * =============================================================================
 */

import { resolveAuditLogPath } from './audit/log.ts'
import { assertValidConfig } from './config/assert.ts'
import { assertSecureBind } from './config/bind.ts'
import { resolveExposure, type Config } from './config/schema.ts'
import { resolveWebServerHttpServer, type Context, type Disposable } from './dsh/adapter.ts'
import { PLUGIN_NAME } from './errors.ts'
import { createGuardedHandler, createGuardedUpgradeHandler, type GateDeps } from './http/gate.ts'
import { installAuthBarrier } from './http/intercept.ts'
import {
  createGateAuthStack,
  createTunnelOriginRegistry,
  type GateAuth,
  type GateAuthStack,
} from './http/session-auth.ts'

/**
 * REEXPORTADO PARA T3.4 / PREP 4, e nao instanciado aqui de proposito.
 *
 * `PanelDeps.resolveOrigin` (T3.4) precisa de decidir o ESQUEMA do pedido para
 * poder emitir o cookie `__Host-dsh_sid`, e a decisao correta depende de
 * `exposure.mode` -- que o painel nao conhece e esta raiz sim.
 * {@link createRequestOriginResolver} e a implementacao a injetar; o JSDoc dela
 * explica porque a condicao e o MODO e nao o HOST (uma instalacao em LAN e
 * nao-loopback e nao tem borda nenhuma a frente).
 *
 * A INJECAO em si nao esta feita porque `src/panel/routes.ts` ainda e o
 * esqueleto do COMMIT PREP 1 nesta arvore: instanciar o resolutor sem chamador
 * seria exatamente o codigo dormente que esta onda removeu do portao.
 */
export { createRequestOriginResolver } from './http/session-auth.ts'
import { readSessionCookie } from './session/cookie.ts'
import { createGuardLogger } from './logging/logger.ts'
import { requestsDeniedPermission } from './permissions/deny.ts'
import { createWorkerSupervisor } from './proc/supervisor.ts'
import { resolveStatePaths } from './state/paths.ts'

export { PLUGIN_NAME } from './errors.ts'
export type { Config, BackoffConfig, ControlConfig } from './config/schema.ts'
export { shouldAutoStartTunnel, resolveExposure } from './config/schema.ts'

/**
 * As UNICAS portas que o portao deixa passar sem credencial.
 *
 * PORQUE EXISTEM, e porque sao exatamente estas tres. A barreira e dona do
 * despacho e guarda a superficie INTEIRA -- incluindo o painel. Sem excecao
 * nenhuma nao haveria como AUTENTICAR: as tres rotas abaixo sao os passos que
 * ANTECEDEM a existencia de uma sessao, e cada uma traz a sua propria credencial
 * de uso unico em vez de depender da que ainda nao existe.
 *
 *   `/__guard/magic`     GET inerte + POST que consome o `mk` do link do Telegram;
 *   `/__guard/secret`    mostra o segredo UMA vez, destrancado por um `ott`;
 *   `/__guard/api/login` cria a sessao a partir do segredo (rota de T3.4).
 *
 * ISENCAO DE L3, E SO DE L3: `trustedRemotes` (L2) e o `Host` (L2.5) continuam a
 * correr sobre elas. Uma porta sem credencial aberta a rede inteira nao e uma
 * porta, e um buraco.
 *
 * >>> QUEM ACRESCENTAR UMA LINHA AQUI ESTA A ABRIR UMA ROTA SEM CREDENCIAL. <<<
 * A lista e curta de proposito, e a comparacao e por SEGMENTO (`isGuardedPath`):
 * `/__guard/magic` NAO cobre `/__guard/magico`.
 */
export const UNAUTHENTICATED_PANEL_PREFIXES: readonly string[] = [
  '/__guard/magic',
  '/__guard/secret',
  '/__guard/api/login',
]

/**
 * CANAL LOCAL APENAS -- 404 quando o pedido nao chega por um nome de loopback.
 *
 * ===========================================================================
 * ISTO FECHA UM FURO REAL, e vale a pena o furo ficar escrito.
 * ===========================================================================
 * `/__guard/secret` esta -- e continua -- na lista de isencao acima, porque quem
 * o vem buscar e precisamente quem ainda NAO tem o segredo: exigir credencial ali
 * era um ciclo. Eu tinha justificado a isencao com "L2 (`trustedRemotes`) e L2.5
 * (`Host`) continuam a correr". O raciocinio estava certo; a PREMISSA nao:
 *
 *   sob `cloudflared`, quem abre o socket e o `cloudflared`, que corre em
 *   `127.0.0.1` e portanto passa L2; e a origem do tunel e DELIBERADAMENTE
 *   acrescentada a allowlist de `Host` enquanto ele esta `READY`, logo passa
 *   L2.5. As duas camadas defendem de outros processos locais e de DNS
 *   rebinding -- nao da internet que o tunel deixa entrar de proposito.
 *
 * O resultado era `GET https://<x>.trycloudflare.com/__guard/secret?ott=<token>`
 * a servir o SEGREDO PERSISTENTE em texto claro, da internet publica, sem
 * credencial. `02-SEGURANCA.md` 4.4 e literal em sentido contrario: **"Canal
 * local apenas, sem excecao"**.
 *
 * O `ott` nao salva isto sozinho, e e por isso que a invariante importa mais do
 * que a aritmetica dele: 128 bits, uso unico e 10 minutos tornam a forca bruta
 * inviavel, mas o token e impresso no STDOUT DO TERMINAL -- vive em scrollback,
 * em multiplexador, em gravacao de sessao, em captura de ecra, no historico de
 * quem faz copiar-colar. O desenho inteiro tolera isso PORQUE a rota so e
 * alcancavel de quem ja esta na maquina.
 *
 * >>> AS OUTRAS DUAS ENTRADAS NAO ENTRAM AQUI, E ISSO E DELIBERADO. <<<
 * `/__guard/magic` existe precisamente para ser aberto do telemovel PELO TUNEL,
 * e `/__guard/api/login` TEM de ser alcancavel de fora ou nao ha como
 * autenticar. Trancar qualquer uma das duas no loopback nao endurecia nada --
 * partia o produto.
 */
export const LOOPBACK_ONLY_PREFIXES: readonly string[] = ['/__guard/secret']

/** Nome do PLUGIN (identidade do modulo perante o motor Cordis). */
export const name = PLUGIN_NAME

/**
 * Injecao de dependencias (composicao espacial). O motor so ativa a Fiber deste
 * plugin depois de `ctx.webServer` e `ctx.subprocess` estarem disponiveis -- e
 * descarta-a de novo se alguma desaparecer.
 *
 * `webServer` (e nao `httpServer`) e o nome REAL do servico na linha que o
 * harness resolve. Ver o cabecalho de `src/dsh/adapter.ts`.
 *
 * E esta injeccao que garante a PRECONDICAO da barreira: o `WebServer` ja passou
 * por `[Service.init]` e o seu `node:http.Server` ja esta a escutar, portanto ja
 * tem despacho para nos tomarmos.
 *
 * -----------------------------------------------------------------------------
 * PORQUE `logger` NAO ESTA AQUI -- e nao pode voltar a estar.
 *
 * `LoggerService` NAO estende `Service` (`types/cordis/logger.d.ts:96`:
 * `export declare class LoggerService {`, contra `class WebServer extends
 * Service`). Nao entra no reflect store: o Context raiz cria-o como propriedade
 * PROPRIA (`this.logger = new LoggerService(self)`), pelo que `ctx.get('logger')`
 * devolve `undefined`. Uma Fiber que injecte `'logger'` fica PENDING para sempre
 * -- `apply()` NUNCA corre, e nao ha erro nem log.
 *
 * Medido contra o cordis real: `inject: ['webServer','subprocess']` -> fiber
 * ACTIVE; acrescentando `'logger'` -> fiber PENDING, `_store` so com
 * `['webServer','subprocess']`, e o E2E responde 200 sem credencial nenhuma.
 *
 * E a MESMA CLASSE DE FALHA que a barreira desta onda existe para corrigir:
 * `inject: string[]` aceita qualquer string em silencio, o `tsc` passa, e o
 * defeito e invisivel -- tal como `ctx.intercept(name, config: any)` aceitava um
 * objeto de metodos e nao fazia nada. `ctx.logger` continua acessivel sem
 * injeccao, que e como todos os pacotes DSH publicados o usam.
 * -----------------------------------------------------------------------------
 */
export const inject = ['webServer', 'subprocess']

/**
 * Ativa o plugin na Fiber corrente.
 *
 * A ORDEM DOS `ctx.effect` E DELIBERADA, porque os disposers correm em LIFO: o
 * worker e o primeiro a ser erradicado quando a Fiber transita para DISPOSED, e
 * so depois a barreira e levantada. Levantar a barreira primeiro deixaria uma
 * janela em que o plano de controlo responde sem credencial enquanto o worker
 * ainda esta vivo.
 */
export function apply(ctx: Context, config: Config): void {
  /* --- 1. Validacao ruidosa no arranque -------------------------------- */
  assertValidConfig(config)
  assertSecureBind(ctx.webServer.host, config.allowedHosts)

  const log = createGuardLogger(ctx)

  if (config.encodedAuthString === undefined) {
    // Nao e erro: a credencial deixou de poder viajar no manifesto (Camada 1 /
    // Bundle, D19) e a Onda 2 gera-a por CSPRNG. Ate la NINGUEM se autentica, o
    // que e a leitura fail-closed da ausencia -- e tem de ser dito em voz alta,
    // porque um plano de controlo que responde 401 a toda a gente parece avariado
    // a quem nao sabe porque.
    log.warn(
      'config.encodedAuthString AUSENTE: nenhuma credencial estatica esta configurada, ' +
        'logo TODAS as requisicoes recebem 401. E a politica fail-closed, nao uma avaria. ' +
        'O segredo passa a ser emitido pelo proprio plugin (Onda 2).',
    )
  }

  if (config.trustedRemotes.length === 0) {
    // Nao e erro: e a politica fail-closed a funcionar. Mas e ruidoso de
    // proposito, porque nesta configuracao o plano de controlo fica inacessivel a
    // TODA a gente, e isso tem de ser uma escolha consciente.
    log.warn(
      'config.trustedRemotes esta vazio: politica fail-closed ativa, ' +
        'TODAS as origens serao recusadas com 403. ' +
        'Acrescenta 127.0.0.1 para permitir o loopback.',
    )
  }

  if (config.guardedPrefixes.length === 0) {
    // O aviso mudou de significado nesta onda e a mudanca esta declarada em
    // `src/config/schema.ts`: a barreira e dona do DESPACHO e guarda a superficie
    // inteira, pelo que uma lista vazia JA NAO abre a sub-estacao `/api`. O que
    // uma lista vazia continua a significar e um inventario de plano de controlo
    // por declarar -- e a Onda 3 constroi a politica por rota do painel em cima
    // desse inventario.
    log.warn(
      'config.guardedPrefixes esta VAZIO: o inventario do plano de controlo nao esta ' +
        'declarado. A barreira continua a guardar a superficie inteira (e dona do despacho), ' +
        'mas a politica por rota do painel nao tem sobre o que se apoiar. ' +
        "Declara pelo menos '/api'.",
    )
  }

  if (config.deniedPermissions.length === 0) {
    // Mesma classe de armadilha: lista vazia = nenhuma elevacao e vetada, em
    // silencio. Ruidoso de proposito, tal como para `trustedRemotes`.
    log.warn(
      'config.deniedPermissions esta VAZIO: NENHUMA elevacao de permissao sera vetada, ' +
        "incluindo 'danger-full-access' (#853 -> #1769).",
    )
  }

  /* --- 1b. Os eixos da Onda 3 ----------------------------------------- */
  const exposure = resolveExposure(config)

  if (config.exposure === undefined) {
    // A ausencia e lida na direccao FECHADA (`LOOPBACK_ONLY_EXPOSURE`) -- nao ha
    // como ela abrir alguma coisa. Mas tem de ser VISTA: quem espera aceder pelo
    // telemovel e nao declarou `exposure` vai concluir que o tunel esta avariado.
    log.warn(
      'config.exposure AUSENTE: assume-se a leitura mais fechada -- ' +
        "mode='loopback', autoStart=false, trustEdgeHeaders=false. Nenhum tunel pode subir. " +
        'Declare o eixo `exposure` no cordis.patch.yml para mudar isto.',
    )
  }

  if (exposure.trustEdgeHeaders) {
    // Nao e erro (`assertValidConfig` ja recusou a combinacao impossivel), mas e
    // a chave mais perigosa do ficheiro: acreditar num cabecalho de IP e deixar
    // que ele decida o balde do rate limit e a linha do audit log.
    log.warn(
      `config.exposure.trustEdgeHeaders=true: o cabecalho da borda passa a decidir ` +
        'a identidade do cliente. So e seguro porque a borda da Cloudflare RECUSA (403) ' +
        'o pedido em que o cliente envia CF-Connecting-IP (spike S2) -- e SO esse ' +
        'cabecalho e lido. X-Forwarded-For e ACRESCENTADO ao valor do cliente e ' +
        'continua proibido em todos os modos.',
    )
  }

  /**
   * ORDEM DE CARREGAMENTO -- O AVISO INVERTEU-SE, E O REGISTO FICA.
   *
   * Ate esta onda, este ponto emitia um `warn` a dizer que o plugin so guardava
   * registos feitos DEPOIS do seu `apply()`, e que o operador tinha de garantir
   * a posicao da entrada no `cordis.patch.yml`. Isso era verdade do mecanismo
   * ANTIGO (envolver `register`/`registerFallback`/`registerUpgrade`), que alias
   * nunca chegou a funcionar.
   *
   * O mecanismo medido NAO TEM essa exigencia: o `EventEmitter` resolve a lista
   * de listeners a cada evento e as rotas vivem nas tabelas por baixo do
   * despacho. Provado nos dois sentidos -- barreira instalada DEPOIS de todos os
   * registos guarda as 7 rotas reais, e uma rota registada DEPOIS da barreira
   * tambem fica guardada. Bate com `dsh-base@0.1.0-rc.7/cordis.patch.yml:12-13`:
   * "Row order carries no load semantics".
   *
   * A linha fica -- invertida e ao nivel `info` -- em vez de desaparecer: um
   * aviso que some sem explicacao e indistinguivel de um aviso que se perdeu no
   * refactor, e o operador que leu o antigo precisa de ver o novo.
   */
  log.info(
    'ORDEM DE CARREGAMENTO: sem exigencia. A barreira e dona do despacho do ' +
      'node:http.Server, logo guarda tambem as rotas registadas DEPOIS dela. A posicao ' +
      'da entrada deste plugin no cordis.patch.yml e indiferente.',
  )

  log.info(
    `Portao ativo em ${ctx.webServer.host}:${ctx.webServer.port} ` +
      `(inventario do plano de controlo: ${config.guardedPrefixes.join(', ') || 'nenhum'}).`,
  )

  /**
   * A PILHA DE AUTENTICACAO, SOB PROCURA.
   *
   * `apply()` NAO TOCA NO SISTEMA DE FICHEIROS, e isso e deliberado: montar a
   * pilha abre o `state.json` e o `audit.log`, e carregar um plugin -- num
   * harness que talvez nunca sirva um pedido -- nao pode criar ficheiros na casa
   * do operador. A pilha nasce no PRIMEIRO pedido que precisa de decidir.
   *
   * O QUE CONTINUA A FALHAR ALTO NO CARREGAMENTO: a RESOLUCAO dos caminhos, que
   * e pura e nao toca no disco. Um `$DSH_HOME` ou um `$DSH_GUARD_AUDIT_LOG`
   * relativo -- a classe de erro de configuracao que faria o estado aparecer e
   * desaparecer conforme o diretorio de arranque -- lanca AQUI, no `apply()`, e
   * nao no primeiro 401 de madrugada.
   */
  const statePaths = resolveStatePaths()
  const auditPath = resolveAuditLogPath()
  log.info(`Estado em ${statePaths.file}; auditoria em ${auditPath}.`)

  const tunnelOrigin = createTunnelOriginRegistry()

  let stack: GateAuthStack | undefined
  const authStack = (): GateAuthStack => {
    // MEMOIZADO: uma so montagem por Fiber. Duas montagens dariam dois
    // `SessionStore` e um cookie emitido por um nunca validaria no outro.
    stack ??= createGateAuthStack({ log, tunnelOrigin })
    return stack
  }
  const auth = (): GateAuth => authStack().auth

  /**
   * O TUNEL PODE SUBIR SOZINHO?
   *
   * A resposta le o `state.json` -- e por isso corre DEPOIS de a pilha existir,
   * ou seja, nunca em `apply()`. O que fica em `apply()` e a decisao ESCRITA:
   * `shouldAutoStartTunnel` e exportado e e o predicado que T3.1/T5.1 tem de
   * consultar antes de spawnar o `cloudflared`. Com o modo restrito ativo no
   * `state.json` ele devolve `false` -- reiniciar o DSH nao e o bypass.
   */
  if (exposure.mode === 'tunnel' && exposure.autoStart) {
    log.info(
      'exposure.autoStart=true: o tunel sobe no arranque, EXCETO se o modo restrito ' +
        'estiver ativo no state.json (shouldAutoStartTunnel).',
    )
  }

  /* --- 2. Veto de elevacao de permissao -------------------------------- */
  /**
   * Ouvinte em cascata que IGNORA (veta) pedidos de elevacao para permissoes
   * irrestritas. Devolver `false` SEM invocar `next()` instaura o curto-circuito
   * irreversivel descrito na primer do Cordis.
   *
   * -------------------------------------------------------------------------
   * CORRECAO DE UM CLAIM FALSO QUE ESTAVA AQUI. Este comentario afirmava ser "o
   * travao final da #853 -> #1769". NAO E, e a diferenca importa:
   *
   *   - `security/permission-elevate` e um evento DECLARADO POR ESTE PLUGIN (a
   *     augmentation de `Events` em `src/dsh/adapter.ts`). Nenhum componente
   *     DOCUMENTADO do DSH o emite: uma busca pelos markdowns-fonte devolve zero
   *     ocorrencias, e os unicos emissores existentes sao os testes deste
   *     repositorio;
   *   - o comando perigoso viaja no CORPO do POST para `/api/commands/execute`, e
   *     o portao HTTP deliberadamente NAO le o corpo (ver `createGuardedHandler`).
   *     Logo este ouvinte nunca chega a ver o comando de um pedido real.
   *
   * O que fecha de facto a #853 e a BARREIRA DE AUTENTICACAO + ALLOWLIST DE
   * ORIGEM sobre o despacho inteiro, mais o bind de loopback. Este ouvinte e um
   * HOOK DE DEFESA EM PROFUNDIDADE: fica no lugar, com o tokenizador endurecido,
   * para o dia em que o DSH (ou outro plugin) passe a emitir o evento. Nao e o
   * travao principal e nao deve ser contabilizado como tal em nenhuma auditoria.
   * -------------------------------------------------------------------------
   *
   * `ctx.on` devolve o disposer nativo (`() => boolean`); encaminha-lo por
   * `ctx.effect` inscreve-o na contabilidade LIFO da Fiber.
   */
  ctx.effect(
    (): Disposable =>
      ctx.on('security/permission-elevate', async (command, next): Promise<boolean> => {
        const denied = requestsDeniedPermission(command, config.deniedPermissions)

        if (denied !== undefined) {
          log.error(
            `VETO de elevacao de permissao: o comando pediu '${denied}', ` +
              `que consta de config.deniedPermissions. Comando recusado: ${command}`,
          )
          return false // curto-circuito: `next()` NAO e invocado.
        }

        return next()
      }),
    'dsh-guard.veto-de-permissao',
  )

  /* --- 3. Ouvinte de autenticacao (around-middleware) ------------------ */
  /**
   * VETO ESTRUTURAL, sem I/O e sem comparacao de credencial.
   *
   * -------------------------------------------------------------------------
   * O QUE ESTE OUVINTE DEIXOU DE FAZER, E PORQUE (mudanca desta onda)
   * -------------------------------------------------------------------------
   * Ate aqui ele repetia `verifyBasicAuth`. Isso deixou de ser correcto no
   * instante em que o portao passou a aceitar TRES credenciais -- sessao, Basic
   * estatico e o segredo gerado pelo plugin -- porque o `encodedAuthString` e
   * normalmente AUSENTE (D19) e este ouvinte vetava, ANTES do terminal, um
   * pedido que se autenticava perfeitamente pelo segredo.
   *
   * Repetir aqui a verificacao COMPLETA tambem nao serve: ela roda o atraso
   * interno do limitador e conta a tentativa. Corrida duas vezes por pedido,
   * duplicaria o atraso e contaria a mesma tentativa duas vezes.
   *
   * O que sobra e o que este ponto pode fazer sem custo e sem estado: recusar o
   * que nao apresenta credencial NENHUMA. E leitura de cabecalho, sem disco, sem
   * relogio e sem alocacao dependente da entrada. O veredito final continua a
   * ser o do terminal, que e a decisao ja tomada pelo portao.
   *
   * `false` SEM invocar `next()` instaura o curto-circuito irreversivel da
   * cascata; com credencial apresentada, delega em `next()` para que outros
   * plugins possam acrescentar politicas (2FA, mTLS) por cima desta.
   */
  ctx.effect(
    (): Disposable =>
      ctx.on('http/auth-check', async (req, next): Promise<boolean> => {
        const temAutorizacao = typeof req.headers.authorization === 'string'
        const temSessao =
          readSessionCookie(
            typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
          ) !== null

        if (!temAutorizacao && !temSessao) return false // veto: sem `next()`.
        return next()
      }),
    'dsh-guard.auth-check',
  )

  /* --- 4. A barreira, sobre o despacho do node:http.Server ------------- */
  const gate: GateDeps = {
    ctx,
    log,
    config,
    auth,
    tunnelOrigin,
    // L2.5: o endereco por que este servidor responde de facto. NAO e
    // `config.allowedHosts` (allowlist do BIND) nem `config.trustedRemotes`
    // (allowlist da PONTA REMOTA) -- ver o cabecalho de `src/http/host-header.ts`.
    bindHost: ctx.webServer.host,
    loopbackAuthority: `${ctx.webServer.host}:${String(ctx.webServer.port)}`,
    loopbackOnlyPrefixes: LOOPBACK_ONLY_PREFIXES,
    unauthenticatedPrefixes: UNAUTHENTICATED_PANEL_PREFIXES,
  }

  /**
   * A superficie e guardada INTEIRA, e a razao e estrutural: no ponto de
   * despacho existe o `req` (metodo, pathname, cabecalhos) mas NAO a identidade
   * do plugin dono da rota. Uma politica diferenciada por rota teria de
   * reconstruir as tabelas do `WebServer`, o que acopla a tres ou quatro campos
   * `private` em vez de um.
   *
   * ISTO E UM ENDURECIMENTO, e esta declarado: o assento de fallback ja era
   * guardado incondicionalmente e apanha tudo o que nenhuma rota nomeada
   * reclama, pelo que a diferenca observavel e apenas nas rotas NOMEADAS fora do
   * inventario -- na composicao Web medida, `prefix /plugins` e a sonda de
   * invariante `exact`, que passam de abertas a 401.
   *
   * O PARAMETRO `alwaysGuarded` DESAPARECEU. Ele era passado como `true`
   * literal e nenhuma chave de configuracao o podia mudar -- um controlo com
   * aparencia de configuravel que nao existia. O que existe no lugar e
   * {@link UNAUTHENTICATED_PANEL_PREFIXES}, que tem valor real e chamador real.
   */
  ctx.effect((): Disposable => {
    const server = resolveWebServerHttpServer(ctx.webServer)

    const revert = installAuthBarrier(
      server,
      {
        wrapRequest: (delegate) => createGuardedHandler(gate, delegate, 'dispatch:request'),
        wrapUpgrade: (delegate) => createGuardedUpgradeHandler(gate, delegate, 'dispatch:upgrade'),
      },
      log,
    )

    return (): void => {
      // ORDEM FAIL-CLOSED, e ela e o inverso do que a intuicao sugere: fecha-se
      // PRIMEIRO a pilha de autenticacao e so DEPOIS se devolve o despacho. Um
      // pedido que esteja a decidir neste instante encontra um `SessionStore`
      // disposto (que devolve `null`) e um limitador disposto (que LANCA) --
      // ambos desaguam no mesmo 401. Pela ordem inversa, haveria uma janela em
      // que o despacho original ja responde e a pilha ainda decide.
      try {
        stack?.dispose()
      } finally {
        revert()
      }
    }
  }, 'dsh-guard.barreira')

  /* --- 5. Worker de long-polling sob ciclo de vida atomico ------------- */
  /**
   * Toda a instanciacao do processo do bot vive dentro de `ctx.effect()`.
   *
   * A funcao produtora devolve um disposer SINCRONO (`() => void`). Nunca
   * `async`, nunca devolvendo `Promise`: o motor precisa de executar os disposers
   * em ordem estritamente inversa a instanciacao sem intercalar microtasks, e uma
   * promessa quebraria essa garantia LIFO -- a nova Fiber PENDING poderia
   * arrancar um segundo worker antes de o primeiro ter morrido.
   *
   * (O host TOLERA disposers assincronos -- `Fiber.effect` documenta "they may be
   * async, in which case unloading awaits them". Nos nao usamos essa tolerancia;
   * a regra Q-2 do projeto e mais apertada do que a do host, de proposito.)
   */
  ctx.effect((): Disposable => {
    const supervisor = createWorkerSupervisor(ctx, config)
    supervisor.start()
    return supervisor.dispose
  }, 'dsh-guard.worker')
}
