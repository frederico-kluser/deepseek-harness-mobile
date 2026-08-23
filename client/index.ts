/**
 * PAINEL TELEGRAM — client half de UI para o DeepSeek Harness (dsh.client).
 *
 * Este ficheiro é a EVOLUÇÃO do spike da Onda 1: o botão `sidebar.footer.action`
 * (rodapé da sidebar) e a aba `settings.section` continuam, mas o conteúdo da
 * aba deixou de ser o placeholder e passou a ser UM PAINEL COMPLETO alimentado
 * pelos endpoints do backend half (`/__guard-ui/api/*`). Toda a lógica de
 * negócio/servidor continua no backend; o client é SÓ UI + fetch + CSRF.
 *
 * O QUE O PAINEL MOSTRA (4 blocos):
 *   1. Estado "configurado?" — chip (configurado / não configurado / env manda),
 *      consumindo `GET /token-state` + `GET /telegram`.
 *   2. Formulário de token — `type="password"` com toggle, `POST /token` com
 *      CSRF, e os estados de resposta renderizados DENTRO da aba (nunca alert).
 *   3. Instruções + marcador do bot — cartão com passos copiáveis (`/parear
 *      <código>` + comandos) e badge ONLINE/OFFLINE com `motivo`.
 *   4. Métricas de acesso — `GET /access`: KPIs (conexões ativas, sessões
 *      vivas), lista de sessões vivas (userAgent→device, tempos relativos, ip
 *      só quando `ipConfiavel`), refresh manual + automático a cada ~15s.
 *
 * SEGURANÇA: o token/segredo NUNCA entra neste bundle. O `@handle` (devolvido
 * pela rota quando o `getMe` o confirmou) é a única informação do bot aqui — e
 * sai do SERVIDOR, não do teu bundle. Todo POST envia `x-dsh-csrf` lido do
 * `<meta name="dsh-guard-ui-csrf">` que o tapIndex injeta no índex. Nenhuma
 * ?key, nenhum id de sessão em claro, nenhuma dependência nova.
 *
 * CSS: `./guard-panel.css` (classes com prefixo `guard-`, só tokens `--dsw-*`)
 * é embebido como string pelo esbuild (loader `text`) e injetado num
 * `<style id="dsh-guard-panel-css">`. Ver `build-client.mjs`.
 *
 * @module dsh-guarded-bot-orchestrator/client
 */

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import cssText from './guard-panel.css'

/** Serviços Cordis que o `apply` deste plugin exige no `ctx`. */
export const inject = ['slots']

/* ========================================================================== */
/* CSS INJECTION — a única coisa que o painel toca no host                    */
/* ========================================================================== */

const CSS_ID = 'dsh-guard-panel-css'

/**
 * Injeta o CSS do painel num `<style>` único, idempotente por documento:
 * a segunda chamada (re-registro do slot ao re-montar o plugin) não duplica.
 */
function asegurarCss(documento: Document): void {
  if (documento.getElementById(CSS_ID) !== null || cssText.length === 0) return
  const estilo = documento.createElement('style')
  estilo.id = CSS_ID
  // `textContent` (não innerHTML): o CSS é nosso e é estático, mas a doutrina
  // do repo é entrar no DOM por textContent sempre que possível.
  estilo.textContent = cssText
  const head = documento.head ?? documento.documentElement
  head.appendChild(estilo)
}

/* ========================================================================== */
/* CLIENT HTTP — CSRF + as rotas usadas                                       */
/* ========================================================================== */

const API_BASE = '/__guard-ui/api'

/** O token anti-CSRF do meta que o tapIndex injeta no índex. */
function csrfToken(documento: Document): string {
  const meta = documento.querySelector<HTMLMetaElement>('meta[name="dsh-guard-ui-csrf"]')
  return meta ? meta.getAttribute('content') ?? '' : ''
}

interface RespostaPost {
  readonly status: number
  readonly dados: Record<string, unknown>
}

/** GET JSON (só leitura das rotas de estado). Larga em qualquer falha. */
async function apiGet<T>(caminho: string): Promise<T> {
  const resposta = await fetch(API_BASE + caminho, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  if (!resposta.ok) throw new Error(`http-${resposta.status}`)
  return (await resposta.json()) as T
}

/**
 * POST JSON com o header anti-CSRF. Rede falhou ⇒ `{status:0}` (NUNCA uma
 * rejeição não tratada) — o painel renderiza um erro genérico sem vazar nada.
 */
async function apiPost(caminho: string, corpo: Record<string, unknown>, documento: Document): Promise<RespostaPost> {
  let resposta: Response
  try {
    resposta = await fetch(API_BASE + caminho, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dsh-csrf': csrfToken(documento) },
      body: JSON.stringify(corpo),
    })
  } catch {
    return { status: 0, dados: {} }
  }
  let dados: Record<string, unknown> = {}
  try {
    dados = (await resposta.json()) as Record<string, unknown>
  } catch {
    /* corpo ilegível — usa o status */
  }
  return { status: resposta.status, dados }
}

/* ========================================================================== */
/* Tipos dos contratos do backend (espelho das rotas, SEM rede local)         */
/* ========================================================================== */

type FonteDoToken = 'env' | 'secrets' | 'nenhum'

interface EstadoDoToken {
  readonly configurado: boolean
  readonly handle?: string | null
  readonly fonte: FonteDoToken
}

interface EstadoTelegrama {
  readonly online: boolean
  readonly motivo?: string
  readonly handle?: string
}

interface SessaoDeAcesso {
  readonly hash: string
  readonly criadaEm: number
  readonly ultimoUsoEm: number
  readonly ip: string | null
  readonly userAgent: string | null
}

interface EstadoDeAcesso {
  readonly totalConexoes: number
  readonly totalSessoes: number
  readonly conexoesAtivas: number
  readonly ipConfiavel: boolean
  readonly sessoes: readonly SessaoDeAcesso[]
}

type FeedbackDeForm = {
  readonly tipo: 'ok' | 'erro' | 'aviso'
  readonly texto: string
}

/* ========================================================================== */
/* Helper puro de formatação (testável em isolamento)                         */
/* ========================================================================== */

/**
 * NORMALIZAÇÃO do userAgent → <navegador> no <aparelho/OS>. Feita em casa, sem
 * dependência nova (o requisito proíbe libs). Reconhece os navegadores/OS mais
 * comuns e DEVOLVE o userAgent cru como fallback se nada bater (nunca uma
 * string vazia por cima de um dado real).
 */
export function normalizarUserAgent(userAgent: string): string {
  const ua = (userAgent ?? '').trim()
  if (ua.length === 0) return 'Dispositivo desconhecido'

  let navegador = 'Navegador'
  if (/Edg\//u.test(ua)) navegador = 'Edge'
  else if (/OPR\/|Opera/u.test(ua)) navegador = 'Opera'
  else if (/CriOS\//u.test(ua)) navegador = 'Chrome'
  else if (/FxiOS\//u.test(ua)) navegador = 'Firefox'
  else if (/Firefox\//u.test(ua)) navegador = 'Firefox'
  else if (/Chrome\//u.test(ua)) navegador = 'Chrome'
  else if (/\bSafari\//u.test(ua)) navegador = 'Safari'

  let aparelho: string
  if (/iPhone/u.test(ua)) aparelho = 'iPhone'
  else if (/iPad/u.test(ua)) aparelho = 'iPad'
  else if (/iPod/u.test(ua)) aparelho = 'iPod'
  else if (/Windows NT/u.test(ua)) aparelho = 'Windows'
  else if (/Android/u.test(ua)) aparelho = 'Android'
  else if (/Mac OS X/u.test(ua)) aparelho = 'macOS'
  else if (/CrOS/u.test(ua)) aparelho = 'ChromeOS'
  else if (/Linux/u.test(ua)) aparelho = 'Linux'
  else aparelho = 'desconhecido'

  // Só diz "Navegador no X" se reconheceu AMBOS; senão devolve o userAgent cru
  // (encurtado) — é dado do utilizador, não uma invenção nossa.
  const conhecido = navegador !== 'Navegador' && aparelho !== 'desconhecido'
  if (!conhecido) {
    return ua.length > 72 ? `${ua.slice(0, 69)}…` : ua
  }
  return `${navegador} no ${aparelho}`
}

/** "agora", "3 min atrás", "2 h atrás", "5 d atrás" — relativo a `agora`. */
export function tempoRelativo(milissegundos: number, agora: number): string {
  const segundos = Math.max(0, Math.floor((agora - milissegundos) / 1000))
  if (segundos < 60) return 'agora'
  const minutos = Math.floor(segundos / 60)
  if (minutos < 60) return `${minutos} min atrás`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `${horas} h atrás`
  const dias = Math.floor(horas / 24)
  return `${dias} d atrás`
}

/** Identidade visual da sessão — o hash truncado a 8 chars, nunca o ?key nem o id. */
export function encurtarIdentidade(hash: string): string {
  const limpo = (hash ?? '').trim()
  return limpo.length > 8 ? limpo.slice(0, 8) : limpo
}

/* ========================================================================== */
/* Chips de estado (funções puras para render)                                */
/* ========================================================================== */

type EstadoChip =
  | { readonly tom: 'ok'; readonly rotulo: string; readonly detalhe?: string }
  | { readonly tom: 'aviso'; readonly rotulo: string; readonly detalhe?: string }
  | { readonly tom: 'neutro'; readonly rotulo: string; readonly detalhe?: string }

function chipDoEstado(token: EstadoDoToken | null): EstadoChip {
  if (token === null) return { tom: 'neutro', rotulo: 'verificando…' }
  if (token.fonte === 'env') {
    if (token.configurado) return { tom: 'aviso', rotulo: 'Configurado via env', detalhe: 'TELEGRAM_BOT_TOKEN manda' }
    return { tom: 'aviso', rotulo: 'Env manda', detalhe: 'sem token até remover a variável' }
  }
  if (token.configurado) return { tom: 'ok', rotulo: 'Configurado', detalhe: token.fonte }
  return { tom: 'neutro', rotulo: 'Não configurado' }
}

/** O rótulo do marcador do bot (ONLINE/OFFLINE + motivo). */
function rotuloDoBot(telegrama: EstadoTelegrama | null): string {
  if (telegrama === null) return 'verificando…'
  if (telegrama.online) return telegrama.handle ? `Bot ONLINE · ${telegrama.handle}` : 'Bot ONLINE'
  const motivo = telegrama.motivo === 'sem-chave' ? 'sem chave' : telegrama.motivo === 'sem-pareamento' ? 'sem pareamento' : undefined
  return motivo ? `Bot OFFLINE · ${motivo}` : 'Bot OFFLINE'
}

/* ========================================================================== */
/* Comandos de uso mostrados no cartão "Instruções"                           */
/* ========================================================================== */

interface BlocoDeComando {
  readonly comando: string
  /** Legenda opcional à direita; `undefined` dispensa. */
  readonly dica?: string
}

/** O cartão de instruções quando há token configurado. */
const COMANDOS_DE_USO: readonly BlocoDeComando[] = [
  { comando: '/parear <código>', dica: 'parear este navegador (código no terminal)' },
  { comando: '/acessar', dica: 'receber um convite de sessão' },
  { comando: '/ligar', dica: 'ligar o túnel' },
  { comando: '/status', dica: 'estado do bot e do túnel' },
  { comando: '/rotacionar', dica: 'revogar a chave atual (?key)' },
  { comando: '/desligar', dica: 'derrubar o túnel' },
  { comando: '/emergencia', dica: 'derrubar tudo de imediato' },
]

/* ========================================================================== */
/* Render helpers (React puro, sem JSX)                                       */
/* ========================================================================== */

const h = React.createElement

type Children = React.ReactNode

function paragrafo(classe: string, ...filhos: Children[]): React.ReactNode {
  return h('p', { className: classe }, ...filhos)
}

/** O pontinho + texto de um chip de estado. */
function Chip({ chip }: { readonly chip: EstadoChip }): React.ReactNode {
  return h('span', { className: `guard-chip ${chip.tom === 'ok' ? 'guard-chip-success' : chip.tom === 'aviso' ? 'guard-chip-warning' : ''}` },
    h('span', { className: 'guard-chip-dot' }),
    chip.rotulo,
    chip.detalhe ? h('span', { className: 'guard-chip-handle' }, ` · ${chip.detalhe}`) : null,
  )
}

/** O marcador ONLINE/OFFLINE do bot. */
function MarcadorDoBot({ telegrama }: { readonly telegrama: EstadoTelegrama | null }): React.ReactNode {
  const online = telegrama?.online === true
  const classe = telegrama === null ? '' : online ? 'guard-chip-success' : 'guard-chip-warning'
  return h('span', { className: `guard-chip ${classe}` },
    h('span', { className: 'guard-chip-dot' }),
    rotuloDoBot(telegrama),
  )
}

/** Um comando copiável (monospace + botão "copiar" com feedback). */
function LinhaDeComando({ bloco }: { readonly bloco: BlocoDeComando }): React.ReactNode {
  const [copiado, setCopiado] = useState(false)
  const copiar = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(bloco.comando)
      setCopiado(true)
      window.setTimeout(() => setCopiado(false), 1200)
    } catch {
      setCopiado(false)
    }
  }
  return h('div', { className: 'guard-cmd-row' },
    h('code', { className: 'guard-code' }, bloco.comando),
    h('button', { type: 'button', className: 'guard-btn-sm', onClick: () => copiar(), 'data-guard-copy': '' },
      copiado ? 'copiado' : 'copiar'),
    bloco.dica ? h('span', { className: 'guard-muted' }, bloco.dica) : null,
  )
}

/* ========================================================================== */
/* O PAINEL — a section `settings.section`                                    */
/* ========================================================================== */

/**
 * Conteúdo da aba "Telegram Guard". Dados vêm do backend via fetch; o painel
 * re-busca ao montar e a cada ~15s (mais em `focus`/`visibilitychange`).
 */
function TelegramGuardSection(): React.ReactNode {
  const [token, setToken] = useState<EstadoDoToken | null>(null)
  const [telegrama, setTelegrama] = useState<EstadoTelegrama | null>(null)
  const [acesso, setAcesso] = useState<EstadoDeAcesso | null>(null)
  const [acessoFalhou, setAcessoFalhou] = useState(false)
  const [tokenErro, setTokenErro] = useState<string | null>(null)

  // Formulário de token.
  const [valor, setValor] = useState('')
  const [mostrarToken, setMostrarToken] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackDeForm | null>(null)

  // "Agora" para tempos relativos — ticker de 1s só para re-render.
  const [agora, setAgora] = useState(() => Date.now())

  // Evita setState depois do unmount (fetch async que termina tarde).
  const vivo = useRef(true)

  const buscarToken = React.useCallback(async (): Promise<void> => {
    try {
      const dados = await apiGet<EstadoDoToken>('/token-state')
      if (vivo.current) setToken(dados)
    } catch {
      if (vivo.current) setTokenErro('não foi possível ler o estado — servidor inacessível')
    }
  }, [])

  const buscarTelegrama = React.useCallback(async (): Promise<void> => {
    try {
      const dados = await apiGet<EstadoTelegrama>('/telegram')
      if (vivo.current) setTelegrama(dados)
    } catch {
      /* o marcador fica em "verificando…"; sem ação para o user */
    }
  }, [])

  const buscarAcesso = React.useCallback(async (): Promise<void> => {
    try {
      const dados = await apiGet<EstadoDeAcesso>('/access')
      if (vivo.current) {
        setAcesso(dados)
        setAcessoFalhou(false)
      }
    } catch {
      if (vivo.current) setAcessoFalhou(true)
    }
  }, [])

  const recarregarTudo = React.useCallback(async (): Promise<void> => {
    await Promise.all([buscarToken(), buscarTelegrama(), buscarAcesso()])
  }, [buscarToken, buscarTelegrama, buscarAcesso])

  // Monte: marca vivo e re-busca tudo. Desmonte: marca morto.
  useEffect(() => {
    vivo.current = true
    void recarregarTudo()
    return () => {
      vivo.current = false
    }
  }, [recarregarTudo])

  // Ticker de 1s para animar os tempos relativos.
  useEffect(() => {
    const t = window.setInterval(() => setAgora(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  // Refresh automático a cada ~15s enquanto a aba estiver aberta.
  useEffect(() => {
    const t = window.setInterval(() => {
      void recarregarTudo()
    }, 15000)
    return () => window.clearInterval(t)
  }, [recarregarTudo])

  // Re-busca em focus/visibilitychange (o estado muda quando o user configura).
  useEffect(() => {
    const aoFocus = (): void => {
      void recarregarTudo()
    }
    const aoVisivel = (): void => {
      if (document.visibilityState === 'visible') void recarregarTudo()
    }
    window.addEventListener('focus', aoFocus)
    document.addEventListener('visibilitychange', aoVisivel)
    return () => {
      window.removeEventListener('focus', aoFocus)
      document.removeEventListener('visibilitychange', aoVisivel)
    }
  }, [recarregarTudo])

  const enviarToken = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const bruto = valor.trim()
    if (bruto.length === 0) {
      setFeedback({ tipo: 'erro', texto: 'Digite a chave do bot antes de validar.' })
      return
    }
    setEnviando(true)
    setFeedback(null)
    const r = await apiPost('/token', { token: bruto }, document)
    setEnviando(false)
    if (!vivo.current) return

    switch (r.status) {
      case 200: {
        const handle = typeof r.dados.handle === 'string' && r.dados.handle.length > 0 ? r.dados.handle : null
        setValor('')
        setMostrarToken(false)
        setFeedback({ tipo: 'ok', texto: handle ? `Configurado ✓ @${handle}` : 'Configurado ✓' })
        await recarregarTudo()
        break
      }
      case 400: {
        const erro = r.dados.erro
        setFeedback({
          tipo: 'erro',
          texto:
            erro === 'formato-invalido'
              ? 'Formato inválido — espera-se uma chave <número>:<segredo> do @BotFather.'
              : 'Token vazio — cole a chave antes de validar.',
        })
        break
      }
      case 409: {
        const aviso = typeof r.dados.aviso === 'string' ? r.dados.aviso : ''
        setFeedback({
          tipo: 'aviso',
          texto:
            aviso.length > 0
              ? aviso
              : 'A variável TELEGRAM_BOT_TOKEN do ambiente manda; remova-a ou use o token dela.',
        })
        await recarregarTudo()
        break
      }
      case 422: {
        setFeedback({
          tipo: 'erro',
          texto: 'O Telegram rejeitou o token — confira no @BotFather (/newbot → revogue e gere de novo).',
        })
        break
      }
      default: {
        setFeedback({
          tipo: 'erro',
          texto:
            r.status === 0
              ? 'Rede falhou — verifique a ligação e tente de novo.'
              : 'O servidor não respondeu — recarregue a página e tente de novo.',
        })
      }
    }
  }

  const chip = chipDoEstado(token)
  const configurado = token?.configurado === true
  const handleChave = token?.handle

  return h('div', { className: 'guard-section' },
    // --- Título + chip de estado ------------------------------------------
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('h2', { className: 'guard-title', style: { margin: 0 } }, 'Telegram Guard'),
      h(Chip, { chip }),
    ),
    paragrafo('guard-intro', 'Acesso remoto ao Harness pelo Telegram — sem login no túnel.'),
    tokenErro ? paragrafo('guard-error', tokenErro) : null,

    // --- Formulário de token ----------------------------------------------
    h('div', { className: 'guard-card' },
      h('span', { className: 'guard-card-title' }, 'Chave do bot'),
      paragrafo('guard-intro', 'Cole o token que o @BotFather deu ao criar o bot. Fica no secrets.env desta máquina.'),
      h('form', { className: 'guard-field', onSubmit: enviarToken },
        h('label', { className: 'guard-field-label', htmlFor: 'guard-token-input' }, 'Token do bot (@BotFather)'),
        h('div', { className: 'guard-input-wrap' },
          h('input', {
            id: 'guard-token-input',
            className: 'guard-input',
            type: mostrarToken ? 'text' : 'password',
            value: valor,
            autoComplete: 'off',
            spellCheck: false,
            placeholder: '1234567890:AAA…',
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValor(e.target.value),
          }),
          h('button', {
            type: 'button',
            className: 'guard-toggle',
            'aria-label': mostrarToken ? 'Ocultar token' : 'Mostrar token',
            onClick: () => setMostrarToken((v) => !v),
          }, mostrarToken ? '🙈' : '👁'),
        ),
        h('div', { className: 'guard-actions' },
          h('button', { type: 'submit', className: 'guard-btn guard-btn-primary', disabled: enviando },
            enviando ? 'a validar…' : 'Validar e configurar'),
        ),
        feedback
          ? h('p', {
              className:
                feedback.tipo === 'ok' ? 'guard-success-text' : feedback.tipo === 'erro' ? 'guard-error' : 'guard-notice',
            }, feedback.texto)
          : null,
      ),
    ),

    // --- Cartão de instruções + marcador do bot ----------------------------
    configurado
      ? h('div', { className: 'guard-card' },
          h('span', { className: 'guard-card-title' },
            'Instruções',
            h(MarcadorDoBot, { telegrama }),
          ),
          paragrafo('guard-intro',
            handleChave && handleChave.length > 0
              ? `O bot está associado a ${handleChave}. Pareie este navegador e use os comandos na conversa.`
              : 'Pareie este navegador e use os comandos na conversa com o bot.'),
          h('ul', { className: 'guard-steps' },
            COMANDOS_DE_USO.map((bloco, i) =>
              h('li', { className: 'guard-step', key: i },
                h(LinhaDeComando, { bloco }),
              ),
            ),
          ),
        )
      : null,

    // --- Métricas de acesso -------------------------------------------------
    h('div', { className: 'guard-card' },
      h('div', { className: 'guard-card-title' },
        'Acesso agora',
        h('button', {
          type: 'button',
          className: 'guard-btn-sm',
          onClick: () => void recarregarTudo(),
          'data-guard-refresh': '',
        }, 'Atualizar'),
      ),
      h('div', { className: 'guard-kpis' },
        h('div', { className: 'guard-kpi' },
          h('span', { className: 'guard-kpi-value' }, String(acesso?.conexoesAtivas ?? '—')),
          h('span', { className: 'guard-kpi-label' }, 'Conexões ativas'),
        ),
        h('div', { className: 'guard-kpi' },
          h('span', { className: 'guard-kpi-value' }, String(acesso?.totalSessoes ?? '—')),
          h('span', { className: 'guard-kpi-label' }, 'Sessões vivas'),
        ),
      ),
      acessoFalhou && acesso === null
        ? paragrafo('guard-error', 'não foi possível ler o acesso — servidor inacessível')
        : null,

      !acessoFalhou && acesso && !acesso.ipConfiavel
        ? h('div', { className: 'guard-warn-box' },
            paragrafo('',
              h('strong', null, 'IP da borda não confiável. '),
              'O IP real do navegador só aparece com trustEdgeHeaders no patch do profile (o túnel não entrega cf-connecting-ip por omissão).'),
          )
        : null,

      !acessoFalhou && acesso
        ? h('ul', { className: 'guard-sessions' },
            acesso.sessoes.length === 0
              ? h('li', { className: 'guard-session' },
                  h('span', { className: 'guard-session-meta' }, 'Nenhuma sessão viva agora.'))
              : acesso.sessoes.map((s, i) => {
                  const device = s.userAgent !== null ? normalizarUserAgent(s.userAgent) : 'Sessão de dispositivo'
                  const criada = tempoRelativo(s.criadaEm, agora)
                  const uso = tempoRelativo(s.ultimoUsoEm, agora)
                  const identidade = encurtarIdentidade(s.hash)
                  return h('li', { className: 'guard-session', key: i },
                    h('span', { className: 'guard-session-id' }, identidade),
                    h('div', { className: 'guard-session-body' },
                      h('span', { className: 'guard-session-device' }, device),
                      h('span', { className: 'guard-session-meta' }, `aberta ${criada} · usada ${uso}`),
                    ),
                    s.ip !== null
                      ? h('span', { className: 'guard-session-ip' }, s.ip)
                      : h('span', { className: 'guard-tag' }, 'IP não confiável'),
                  )
                }),
          )
        : null,
      paragrafo('guard-report-footer', 'Atualizado automaticamente a cada ~15 s enquanto a aba estiver aberta.'),
    ),
  )
}

/**
 * O botão que vai para `sidebar.footer.action` (junto ao botão de settings).
 * Props de dono do slot (ui-sidebar/contract/slots.ts): `{ wide: boolean }`.
 */
function GuardBotSidebarAction(props: { wide: boolean }): React.ReactNode {
  const { wide } = props
  const icon = h('span', { 'aria-hidden': true, style: { fontSize: 16, lineHeight: 1 } }, '✈️')
  return h('button', {
    type: 'button',
    title: 'Telegram Guard — abrir configurações',
    'data-guard-bot-trigger': '',
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      background: 'transparent',
      border: 'none',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
      padding: wide ? '6px 4px' : '6px',
      width: '100%',
      justifyContent: wide ? 'flex-start' : 'center',
    },
    onClick: () => {
      openSettingsOnSection('telegram-guard')
    },
  }, icon, wide ? h('span', { style: { fontSize: 12 } }, 'Telegram') : null)
}

/* ========================================================================== */
/* O affordance DOM — abrir o settings na aba do painel                       */
/* ========================================================================== */

/**
 * Abre o modal de settings já na aba `sectionId`. O open do modal é estado
 * local do `SettingsRoot` sem handle global; o caminho empírico (Onda 1) é
 * DOM affordance: clicar no trigger `button[aria-haspopup="dialog"]` visível
 * dentro do assento de settings do rodapé e depois no item do rail cujo texto
 * é o label da aba ('Telegram Guard'). Idempotente quanto à presença do modal.
 */
function openSettingsOnSection(_sectionId: string): void {
  const findSettingsTrigger = (): HTMLButtonElement | null => {
    const scopes = [
      [...document.querySelectorAll<HTMLElement>('[class*="_settingsArea"]')],
      [...document.querySelectorAll<HTMLElement>('[class*="_footArea"]')],
      [...document.querySelectorAll<HTMLElement>('[class*="_sidebarCol"], [class*="_sidebarContainer"]')],
    ]
    const visible = (el: HTMLElement): boolean =>
      el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    const firstVisible = (root: ParentNode): HTMLButtonElement | null => {
      const buttons = root.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')
      return Array.from(buttons).find((b) => visible(b)) ?? null
    }
    for (const group of scopes) {
      for (const el of group) {
        const found = firstVisible(el)
        if (found !== null) return found
      }
    }
    return (
      Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="dialog"]')).find((b) =>
        visible(b)) ?? null
    )
  }

  const trigger = findSettingsTrigger()
  if (trigger === null) return
  const jaAberto = trigger.getAttribute('aria-expanded') === 'true'
  if (!jaAberto) trigger.click()

  const findNavItem = (): HTMLButtonElement | null => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    if (dialog === null) return null
    const cells = dialog.querySelectorAll<HTMLButtonElement>('button')
    return Array.from(cells).find((cell: HTMLButtonElement) => cell.textContent?.includes('Telegram Guard')) ?? null
  }

  let tentativas = 0
  const tentarClicar = (): void => {
    const cell = findNavItem()
    if (cell !== null) {
      cell.click()
      return
    }
    if (tentativas < 12) {
      tentativas += 1
      window.requestAnimationFrame(tentarClicar)
    }
  }
  tentarClicar()
}

/* ========================================================================== */
/* apply — regista as contribuições e injeta o CSS                            */
/* ========================================================================== */

/**
 * Corpo do plugin client. Injeta o CSS do painel e regista as duas entradas
 * de slot.
 * @param ctx - contexto raiz Cordis do browser (injeta `slots`).
 */
export function apply(ctx: {
  slots: {
    inject(key: string, cb: () => unknown): unknown
    register(options: unknown, component: unknown): unknown
  }
}): void {
  // O CSS do painel (guard-panel.css) entra no DOM aqui, UMA vez, antes de
  // qualquer registo renderizar o cartão.
  asegurarCss(document)

  // Botão no rodapé da sidebar (slot declarado pelo ui-sidebar).
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'guard-bot-button',
        order: 0,
        registrant: 'dsh-guarded-bot-orchestrator',
      },
      GuardBotSidebarAction,
    ),
  )
  // Aba nova no modal de settings (slot declarado pelo ui-settings).
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'telegram-guard',
        order: 99,
        label: 'Telegram Guard',
        registrant: 'dsh-guarded-bot-orchestrator',
      },
      TelegramGuardSection,
    ),
  )
}