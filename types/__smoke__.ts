/**
 * SMOKE-TEST DE TIPOS (teste de contrato, nao teste de runtime).
 *
 * Nao e executado: existe para que `tsc --noEmit` PROVE que a superficie
 * espelhada em `types/**` -- copia byte-a-byte dos tarballs npm reais, ver o
 * cabecalho de proveniencia de cada ficheiro -- aceita exatamente o codigo que
 * um plugin do DSH pode escrever. Se um destes blocos deixar de compilar, o
 * contrato com o host quebrou.
 *
 * LINHA DE VERSAO: `@deepseek-ai/dsh-*@0.1.0-rc.8` (a que o harness
 * `@deepseek-ai/dsh` resolve) e `@deepseek-ai/cordis@4.0.1`. A linha
 * `0.0.1-rc.*`, para onde a tag `latest` dos subpacotes ainda aponta, e uma
 * API abandonada com outros nomes de servico; o de-para entre as duas linhas
 * esta em `docs/spikes/api-dsh.md` seccao 3.
 *
 * Os eventos usam o prefixo `smoke/` para nao colidirem com os reais.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { dshHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/* --- Prova 1: module augmentation de `Events` resolve pelo alias `paths`. --- */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode waterfall */
    'smoke/auth-check'(req: IncomingMessage, next: () => Promise<boolean>): Promise<boolean>
    /** @mode parallel */
    'smoke/permission-elevate'(scope: string, reason: string): Promise<void>
  }
}

/**
 * Grace de terminacao (SIGTERM -> grace -> SIGKILL) e de drenagem dos pipes
 * recolhidos, em milissegundos. `SubprocessSpawnSpec.graceMs` e OBRIGATORIO --
 * o assento nao aplica defaults ("this seam applies no defaults").
 *
 * `3000` nao e invencao: e o `disposeGraceMs: z.number().default(3e3)` de
 * `@deepseek-ai/dsh-terminal-bash@0.1.0-rc.8`, que o alimenta diretamente ao
 * `graceMs` do spec. O tecto e `MAX_TIMER_DELAY_MS = 2147483647` de
 * `@deepseek-ai/dsh-timeout`; `dsh-subprocess-local` rejeita valores nao
 * finitos, <= 0 ou acima desse tecto. Ver `docs/spikes/api-dsh.md`.
 */
const SMOKE_GRACE_MS = 3_000

/** O tipo do `handler` de uma rota, tal como o pacote real o declara. */
type SmokeHandler = WebRoute['handler']

const wrap = (handler: SmokeHandler): SmokeHandler => {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    await handler(req, res)
  }
}

export async function smoke(ctx: Context, realm: string): Promise<void> {
  /* --- Prova 2: `ctx.webServer` e a propriedade real do Context. -----------
     `@deepseek-ai/dsh-host-webserver@0.1.0-rc.8` declara
     `declare module '@deepseek-ai/cordis' { interface Context { webServer: WebServer } }`.
     Todos os `register*` devolvem `() => void` (o disposer), que TEM de ser
     propagado sob pena de quebrar a reversibilidade da Fiber. */

  const secure: SmokeHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const isAuthorized: boolean = await ctx.waterfall(
      'smoke/auth-check',
      req,
      async (): Promise<boolean> => {
        const authHeader = req.headers.authorization
        if (authHeader === undefined || !authHeader.startsWith('Basic ')) return false
        return true
      },
    )

    if (!isAuthorized) {
      res.writeHead(401, {
        'WWW-Authenticate': `Basic realm="${realm}"`,
        'Content-Type': 'text/plain; charset=utf-8',
      })
      res.end('Acesso Intercetado: Credenciais invalidas.')
      return
    }

    res.end('ok')
  }

  /* O assento de fallback e de UM SO dono: um segundo `registerFallback`
     LANCA. Na composicao Web enviada quem o reclama e
     `@deepseek-ai/dsh-host-frontend-static`.

     ATENCAO DE SEGURANCA (medido em composicao real, nao inferido): uma
     barreira instalada AQUI nao cobre `/api` nem `/plugins`. O roteador
     consulta as tabelas nomeadas (`exact`, depois maior-prefixo) ANTES do
     assento de fallback, pelo que `/` e `/rota-spa` respondem 401 enquanto
     `/api/state` e `/plugins/x/client.js` passam ao lado com 200. Guardar o
     plano de controlo exige `register` sobre esses prefixos, nao o fallback.
     Ver `docs/spikes/api-dsh.md` seccao 5. */
  const disposeFallback: () => void = ctx.webServer.registerFallback(secure)
  disposeFallback()

  /* --- Prova 3: rota nomeada (`exact` | `prefix`) e o seu disposer. --- */
  const guardedApi: WebRoute = {
    kind: 'prefix',
    path: '/api',
    handler: (_req: IncomingMessage, res: ServerResponse): void => {
      res.end('ok')
    },
  }
  const disposeApi: () => void = ctx.webServer.register({
    ...guardedApi,
    handler: wrap(guardedApi.handler),
  })
  disposeApi()

  /* --- Prova 4: `registerUpgrade` existe (bloqueador de seguranca do gate
         de WebSocket) e o handler pode ser sincrono ou assincrono. --- */
  const upgradeRoute: WebUpgradeRoute = {
    path: '/ws',
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
      ctx.logger.debug('smoke: upgrade %s (+%dB)', req.url ?? '?', head.byteLength)
      socket.destroy()
    },
  }
  const disposeUpgrade: () => void = ctx.webServer.registerUpgrade(upgradeRoute)
  disposeUpgrade()

  /* --- Prova 5: `tapIndex` e `applyIndexTaps` -- transformacao de index.html
         aplicada pelo dono do fallback. --- */
  const disposeTap: () => void = ctx.webServer.tapIndex((html: string): string => html)
  disposeTap()
  const rendered: string = ctx.webServer.applyIndexTaps('<!doctype html>')
  void rendered

  /* --- Prova 6: o bind e uma UNIAO LITERAL, nao `string`. ------------------
     `WebServer.host` devolve `Config['host']`, isto e
     `'127.0.0.1' | '0.0.0.0'`. O compilador consegue por isso exaurir a
     verificacao de bind inseguro -- nao ha terceira interface possivel. */
  const server: WebServer = ctx.webServer
  const host: '127.0.0.1' | '0.0.0.0' = server.host
  const port: number = server.port
  if (host === '0.0.0.0') {
    ctx.logger.warn('smoke: bind inseguro em %s:%d', host, port)
  }

  /* --- Prova 7: `ctx.intercept` NAO e interceptacao de metodos. ------------
     A sobrecarga tipada e
     `intercept<K extends InjectKey>(name: K, config: Context[K] extends { [symbols.config]: infer T } ? T : never): this`.
     Para `webServer` (que estende `Service`, logo `Service<never>`) o tipo de
     `config` colapsa em `never`: nao existe QUALQUER objecto de metodos que o
     satisfaca. O que o motor faz com esse argumento e juntar config a
     `ctx[Context.intercept]`, lida por `Service[symbols.resolveConfig]` --
     configuracao por servico, herdada por plugins carregados abaixo. Nunca
     envolve os metodos do servico. Ver `docs/spikes/api-dsh.md`, VEREDITO S1. */
  const derived: Context = ctx.intercept('webServer', undefined as never)
  void derived

  /* --- Prova 8: `ctx.on` devolve `() => boolean` e infere os parametros. --- */
  const off: () => boolean = ctx.on('smoke/auth-check', async (req, next) => {
    const header: string | undefined = req.headers.authorization
    return header === undefined ? false : next()
  })
  off()

  /* --- Prova 9: `ctx.parallel` e tipado a partir de `Events`. --- */
  await ctx.parallel('smoke/permission-elevate', 'tool-fs', 'danger-full-access')

  /* --- Prova 10: `ctx.get` devolve `Servico | undefined`. O assento de
         subprocessos chama-se `SubprocessRuntime` nesta linha. --- */
  const maybeSubprocess: SubprocessRuntime | undefined = ctx.get('subprocess')
  if (maybeSubprocess === undefined) {
    throw new Error('smoke: servico `subprocess` indisponivel')
  }

  /* --- Prova 11: diretorio de estado pelo helper CANONICO do host. ---------
     `@deepseek-ai/dsh-home-paths` e dependencia direta declarada do
     `@deepseek-ai/dsh` e exporta funcoes puras (nao e um servico do Cordis).
     `resolveDshHome()` aplica a precedencia configurado > `$DSH_HOME` >
     `~/.dsh`; `dshHomePath(...segmentos)` junta ao resultado. E este o
     contrato do host para caminhos de dados do utilizador. Ver VEREDITO S9. */
  const home: string = resolveDshHome()
  const stateDir: string = dshHomePath('guarded-bot')
  ctx.logger.info('smoke: home=%s estado=%s', home, stateDir)

  /* --- Prova 12: `ctx.effect` + `ctx.subprocess.spawn(spec)`. --------------
     `spawn` recebe UM objecto `SubprocessSpawnSpec` (nunca `(cmd, args, opts)`)
     e devolve um `SubprocessHandle` -- que NAO e um `ChildProcess`: nao tem
     `on`, `removeListener`, `killed` nem `kill`. A terminacao e o unico verbo
     `terminate()`, com escopo de arvore em todas as plataformas. */
  ctx.effect((): (() => void) => {
    ctx.logger.info('smoke: alocando subprocesso isolado de longa duracao')

    const abortController = new AbortController()

    const spec: SubprocessSpawnSpec = {
      argv: ['python3', 'bot_long_polling.py'],
      cwd: stateDir,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: SMOKE_GRACE_MS,
      signal: abortController.signal,
      env: { TELEGRAM_BOT_TOKEN: 'token_seguro' },
    }

    const child: SubprocessHandle = ctx.subprocess.spawn(spec)

    child.stdout?.on('data', (chunk: Buffer): void => {
      ctx.logger.debug('smoke [worker stdout]: %s', chunk.toString().trim())
    })

    child.stderr?.on('data', (chunk: Buffer): void => {
      ctx.logger.warn('smoke [worker stderr]: %s', chunk.toString().trim())
    })

    /* `done` resolve no CLOSE do processo com os factos de saida e so rejeita
       por falha de spawn. Nao ha evento `'exit'` no handle. */
    void child.done.then(
      ({ exitCode, signal }): void => {
        if (exitCode !== 0 && !abortController.signal.aborted) {
          ctx.logger.error('smoke: worker encerrado (code=%o signal=%o)', exitCode, signal)
        }
      },
      (error: unknown): void => {
        ctx.logger.error('smoke: falha ao alocar subprocesso: %o', error)
      },
    )

    /* Disposer. O tipo `Disposable<T> = () => T` do Cordis permite disposer
       assincrono ("they may be async, in which case unloading awaits them",
       `types/cordis/fiber.d.ts`) -- mantemos sincrono porque `terminate()` ja
       e sincrono e idempotente, e a espera de quiescencia da arvore pertence
       a quem quiser encadear `waitForExit`. */
    return (): void => {
      abortController.abort()
      child.terminate()
    }
  }, 'smoke/worker')
}
