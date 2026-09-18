/**
 * APOIO dos testes do client (test/unit/client/**) — o harness de smoke do
 * bundle `lib/client.js` (o mesmo espirito do test/unit/client/index.test.ts,
 * ficheiro proprio porque `node --test` corre cada `*.test.ts` isolado).
 *
 * `lib/client.js` e o bundle closure-factory do harness (window.__ModuleLoader__
 * + factory(require)). Os testes de FLUXO HTTP (apiPost/buscarTokenCsrf) e os
 * pins do painel Túnel carregam-no AQUI; o ficheiro não é um teste (não casa
 * `*.test.ts`) — só é importado.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const ROOT = resolve(import.meta.dirname, '../../..')
export const BUNDLE_PATH = resolve(ROOT, 'lib/client.js')
export const BUNDLE_AUSENTE = !existeBundle()

function existeBundle(): boolean {
  try {
    return readFileSync(BUNDLE_PATH).length > 0
  } catch {
    return false
  }
}

export function lerBundle(): string {
  return readFileSync(BUNDLE_PATH, 'utf8')
}

/** Uma resposta fetch fake. */
export function fakeResposta(status: number, corpo: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  } as unknown as Response
}

/** Captura as chamadas de fetch: `chamadas[i].url`, `.init`. */
export interface ChamadaFetch {
  readonly url: string
  readonly init: RequestInit | undefined
}

export function capturarFetch(respostas: Array<{ urlContem: string; metodo?: string; resposta: Response }>): {
  chamadas: ChamadaFetch[]
  fetchStub: typeof fetch
} {
  const chamadas: ChamadaFetch[] = []
  const fetchStub = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    chamadas.push({ url, init })
    const alvo = respostas.find(
      (r) => url.includes(r.urlContem) && (r.metodo === undefined || init?.method === r.metodo),
    )
    if (alvo === undefined) return fakeResposta(404, {})
    return alvo.resposta
  }) as typeof fetch
  return { chamadas, fetchStub }
}

/** O dom-fake minimo que o `apply` precisa (asegurarCss). */
export function fakeDocument(): { getElementById(): null; createElement(): { id: string; textContent: string }; head: { appendChild(n: unknown): void } } {
  const head = { appendChild(n: unknown): void { void n } }
  return {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    head,
  }
}

/** Um adereço de `documento` com um meta de CSRF antigo (que NÃO pode ser fonte). */
export function documentoComMeta(token: string | null): { querySelector: (sel: string) => { getAttribute(name: string): string | null } | null } {
  return {
    querySelector: (sel: string) => {
      if (sel === 'meta[name="dsh-guard-ui-csrf"]' && token !== null) {
        return { getAttribute: (name: string) => (name === 'content' ? token : null) }
      }
      return null
    },
  }
}

/**
 * Carrega `lib/client.js` num sandbox e devolve `module.exports` do factory —
 * o MESMO sandbox do smoke docs/PANEL-TELEGRAM.md (o `__ModuleLoader__.load`
 * esticado captura o factory e invoca-o com o `require` das palavras-seed do
 * harness).
 */
export function carregarBundle(fetchStub: typeof fetch): Record<string, unknown> {
  const MODULE_LOADER_KEY = '__ModuleLoader__'
  const windowHost: Record<string, unknown> = {}
  let exportsDoModulo: Record<string, unknown> | undefined

  ;(globalThis as Record<string, unknown>).fetch = fetchStub
  ;(globalThis as Record<string, unknown>).window = windowHost

  windowHost[MODULE_LOADER_KEY] = {
    load(registro: { id: string; factory: (requireFn: (id: string) => unknown) => Record<string, unknown> }) {
      assert.equal(registro.id, 'dsh-guard-messenger')
      const seeds: Record<string, unknown> = {
        react: { createElement: () => ({}) },
        'react/jsx-runtime': {},
        'react-dom': {},
        'react-dom/client': {},
        '@deepseek-ai/cordis': {},
        '@deepseek-ai/dsh-client-ui-slots': {},
        '@deepseek-ai/dsh-client-ui-primitives': {},
      }
      exportsDoModulo = registro.factory((id: string) => seeds[id] ?? {})
    },
  }

  ;(globalThis as Record<string, unknown>).document = fakeDocument()

  const codigo = lerBundle()
  const avaliar = new Function('window', codigo) as (w: Record<string, unknown>) => void
  avaliar(windowHost)

  assert.ok(exportsDoModulo !== undefined, 'o bundle nao registou o factory no __ModuleLoader__')
  return exportsDoModulo
}
