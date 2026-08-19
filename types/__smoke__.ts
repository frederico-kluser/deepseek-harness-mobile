/**
 * SMOKE-TEST DE TIPOS (teste de contrato, nao teste de runtime).
 *
 * Este ficheiro nao e executado: existe para que `tsc --noEmit` PROVE que a
 * superficie declarada em `types/**` aceita exatamente o codigo canonico do
 * DeepSeek Harness -- `ctx.intercept`, `ctx.waterfall`, `ctx.parallel`,
 * `ctx.on`, `ctx.effect` e `ctx.subprocess.spawn`.
 *
 * Se um destes blocos deixar de compilar, o contrato com os plugins quebrou.
 *
 * Os eventos aqui declarados usam o prefixo `smoke/` de proposito: nao
 * colidem com os eventos reais (`http/auth-check`, `security/permission-elevate`)
 * que `src/index.ts` declara.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context, Disposer } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { SubprocessService } from '@deepseek-ai/dsh-host-subprocess'

/* --- Prova 1: module augmentation de `Events` resolve pelo alias `paths`. --- */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode waterfall */
    'smoke/auth-check'(req: IncomingMessage, next: () => Promise<boolean>): Promise<boolean>
    /** @mode parallel */
    'smoke/permission-elevate'(scope: string, reason: string): Promise<void>
  }
}

const wrap = (handler: WebRoute['handler']): WebRoute['handler'] => {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    await handler(req, res)
  }
}

export async function smoke(ctx: Context, realm: string): Promise<void> {
  /* --- Prova 2: ctx.intercept na forma `this`-tipada (a que a onda 2 usa). --- */
  ctx.intercept('webServer', {
    registerFallback(this: WebServer, originalHandler: WebRoute['handler']): Disposer {
      const secure = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
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

        await originalHandler(req, res)
      }

      // O disposer nativo TEM de ser devolvido (reversibilidade atomica).
      return this.registerFallback(secure)
    },

    register(this: WebServer, route: Parameters<WebServer['register']>[0]): Disposer {
      return this.register({ ...route, handler: wrap(route.handler) })
    },
  })

  /* --- Prova 3: ctx.intercept na forma canonica `(target, ...args)` do doc. --- */
  ctx.intercept('webServer', {
    registerFallback(target: WebServer, originalHandler: WebRoute['handler']): Disposer {
      const secureHandler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        await originalHandler.call(target, req, res)
      }
      return target.registerFallback(secureHandler)
    },
  })

  /* --- Prova 4: ctx.on devolve disposer e infere os parametros do listener. --- */
  const off: Disposer = ctx.on('smoke/auth-check', async (req, next) => {
    const header: string | undefined = req.headers.authorization
    return header === undefined ? false : next()
  })
  off()

  /* --- Prova 5: ctx.parallel e tipado a partir de `Events`. --- */
  await ctx.parallel('smoke/permission-elevate', 'tool-fs', 'danger-full-access')

  /* --- Prova 6: os servicos sao propriedades tipadas do Context. --- */
  const disposeUpgrade: Disposer = ctx.webServer.registerUpgrade({
    path: '/ws',
    handler: (): void => {},
  })
  disposeUpgrade()

  const disposeExact: Disposer = ctx.webServer.register({
    kind: 'exact',
    path: '/api/health',
    handler: (_req: IncomingMessage, res: ServerResponse): void => {
      res.end('ok')
    },
  })
  disposeExact()

  // Validacao do bind (constraint de seguranca: 0.0.0.0 expoe /api sem credenciais).
  if (ctx.webServer.host === '0.0.0.0') {
    ctx.logger.warn('smoke', `bind inseguro em ${ctx.webServer.host}:${ctx.webServer.port}`)
  }

  /* --- Prova 7: ctx.get devolve `Servico | undefined`. --- */
  const maybeSubprocess: SubprocessService | undefined = ctx.get('subprocess')
  if (maybeSubprocess === undefined) {
    throw new Error('smoke: servico `subprocess` indisponivel')
  }

  /* --- Prova 8: ctx.effect + ctx.subprocess.spawn, disposer SINCRONO. --- */
  ctx.effect((): Disposer => {
    ctx.logger.info('smoke', 'Alocando subprocesso isolado de longa duracao...')

    const abortController = new AbortController()

    const child = ctx.subprocess.spawn('python3', ['bot_long_polling.py'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      signal: abortController.signal,
      env: { ...process.env, TELEGRAM_BOT_TOKEN: 'token_seguro' },
      detached: true,
    })

    child.stdout?.on('data', (chunk: Buffer): void => {
      ctx.logger.debug('smoke', `[Worker STDOUT]: ${chunk.toString().trim()}`)
    })

    child.stderr?.on('data', (chunk: Buffer): void => {
      ctx.logger.warn('smoke', `[Worker STDERR]: ${chunk.toString().trim()}`)
    })

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null): void => {
      if (code !== 0 && !abortController.signal.aborted) {
        ctx.logger.error('smoke', `Processo encerrado abruptamente`, { code, signal })
      }
    })

    child.on('error', (error: Error): void => {
      ctx.logger.error('smoke', `Falha ao alocar subprocesso: ${error.message}`)
    })

    return (): void => {
      abortController.abort()
      if (child.pid !== undefined && !child.killed) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // Processo ja desprovido de existencia na tabela.
        }
      }
    }
  })
}
