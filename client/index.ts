/**
 * PAINEL TELEGRAM — client half de UI para o DeepSeek Harness (dsh.client).
 *
 * Este ficheiro é a EVOLUÇÃO do spike da Onda 1: o botão do rodapé da sidebar
 * foi REMOVIDO (o utilizador prefere o acesso pelo modal de settings padrão) e
 * o client passou a contribuir SÓ com a aba `settings.section` — um PAINEL
 * COMPLETO alimentado pelos endpoints do backend half (`/__guard-ui/api/*`).
 * Toda a lógica de negócio/servidor continua no backend; o client é SÓ UI +
 * fetch + CSRF.
 *
 * O QUE O PAINEL MOSTRA (uma TRILHA de 3 checkpoints na mesma tela — só o
 * passo atual fica aberto; os concluídos colapsam em `✓`):
 *   1. "Passo 1 de 3 · Criar o bot" — sem token: o formulário do token
 *      (`POST /token` com CSRF) + `<details>` "Como criar o bot do zero"
 *      (@BotFather); erro de token com a ação "Revisar token".
 *   2. "Passo 2 de 3 · Parear" — configurado e NÃO pareado: CTA "Gerar código",
 *      código de 6 dígitos em caixa monospace espaçada + "Copiar", countdown
 *      `expira em m:ss` + "Gerar novo", uma instrução `/parear`, e o status ao
 *      vivo "Aguardando…" → "✓ Pareado".
 *   3. "Passo 3 de 3 · Usar" — pareado: comandos essenciais (3), `<details>`
 *      "Avançado" (trocar token / desfazer parear com confirmação / todos os
 *      comandos) e `<details>` "E minha conversa?" (privacidade AO VIVO —
 *      green "não encontrável" só com getMe real).
 * O estado baseia-se em `GET /token-state` + `GET /telegram` + `GET /pair-state`
 * (polling de ~5s; sondagem de pareamento a cada ~3s).
 *
 * SEGURANÇA: o token/segredo NUNCA entra neste bundle. O `@handle` (devolvido
 * pela rota quando o `getMe` o confirmou) é a única informação do bot aqui — e
 * sai do SERVIDOR, não do teu bundle. Todo POST envia `x-dsh-csrf`. A fonte do
 * token NÃO é uma só: o caminho preferido (HIGH-2) é `GET /api/csrf`, o mesmo
 * guard da superficie emitindo um token stateless FRESCO por pedido — sem
 * depender do chrome antigo. Só se o GET falhar é que o bundle cai no
 * `<meta name="dsh-guard-ui-csrf">` que o `tapIndex` injeta no índex (compat
 * com o chrome antigo). Se nenhuma das duas der, os POSTs falham com mensagem
 * clara ("CSRF indisponível — recarregue"). Nenhuma ?key, nenhum id de sessão
 * em claro, nenhuma dependência nova.
 *
 * CSS: `./guard-panel.css` (classes com prefixo `guard-`, só tokens `--dsw-*`)
 * é embebido como string pelo esbuild (loader `text`) e injetado num
 * `<style id="dsh-guard-panel-css">`. Ver `build-client.mjs`.
 *
 * @module dsh-guard-messenger/client
 */

import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import cssText from './guard-panel.css'
// A logo do plugin (root, `logo.png`) — embebida como data URL no bundle
// (loader `dataurl` do esbuild; ver `build-client.mjs`). O harness serve SÓ
// `lib/client.js`, sem side-cars, por isso a imagem NÃO pode ser um caminho
// externo.
import logoUrl from '../logo.png'

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

/** Nome do meta do chrome antigo — compat reversa, NÃO a fonte preferida. */
const CSRF_META_NAME = 'dsh-guard-ui-csrf'

/** Teto curto do GET /csrf: o token é barato; se atrasar, cai no meta. */
const CSRF_TIMEOUT_MS = 2500

/** CSRF indisponível — sinaliza ao chamador para recusar o POST. */
const CSRF_INDISPONIVEL = ''

/**
 * O token anti-CSRF a usar num POST. Fonte preferida (HIGH-2): `GET /api/csrf`,
 * o mesmo guard da superficie emitindo um token stateless FRESCO. Só se essa
 * GET falhar (rede/timeout) é que cai no `<meta name="dsh-guard-ui-csrf">` do
 * chrome antigo. `''` = nenhuma fonte deu → o POST recusa com mensagem clara.
 *
 * Exportada para o smoke de teste (test/unit/client) exercitar o fetch /csrf e
 * a ordem fonte-nova → fallback-meta sem montar o React.
 */
export async function buscarTokenCsrf(documento: Document): Promise<string> {
  const controller = new AbortController()
  const temporizador = setTimeout(() => controller.abort(), CSRF_TIMEOUT_MS)
  try {
    const resposta = await fetch(API_BASE + '/csrf', {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (resposta.ok) {
      const corpo = (await resposta.json()) as { token?: unknown }
      if (typeof corpo.token === 'string' && corpo.token.length > 0) return corpo.token
    }
  } catch {
    /* queda de rede/timeout: cai no meta abaixo */
  } finally {
    clearTimeout(temporizador)
  }
  // Compat reversa com o chrome antigo (o meta que o tapIndex injeta).
  const meta = documento.querySelector<HTMLMetaElement>(`meta[name="${CSRF_META_NAME}"]`)
  return meta ? (meta.getAttribute('content') ?? '').trim() : CSRF_INDISPONIVEL
}

interface RespostaPost {
  readonly status: number
  readonly dados: Record<string, unknown>
  /** `true` quando o POST não chegou a sair porque o CSRF estava indisponível. */
  readonly csrfIndisponivel: boolean
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
 * POST JSON com o header anti-CSRF. O token é buscado FRESCO a CADA pedido
 * (GET /api/csrf barato e stateless, com fallback ao meta antigo) — assim o
 * valor nunca envelhece no prazo de 30min do TTL. Rede falhou ⇒ `{status:0}`
 * (NUNCA uma rejeição não tratada) — o painel renderiza um erro genérico sem
 * vazar nada. Sem CSRF disponível ⇒ `{status:0, csrfIndisponivel:true}`.
 *
 * Exportada para o smoke de teste exercitar o envio do token NOVO no header.
 */
export async function apiPost(caminho: string, corpo: Record<string, unknown>, documento: Document): Promise<RespostaPost> {
  const token = await buscarTokenCsrf(documento)
  if (token.length === 0) {
    return { status: 0, dados: {}, csrfIndisponivel: true }
  }
  let resposta: Response
  try {
    resposta = await fetch(API_BASE + caminho, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dsh-csrf': token },
      body: JSON.stringify(corpo),
    })
  } catch {
    return { status: 0, dados: {}, csrfIndisponivel: false }
  }
  let dados: Record<string, unknown> = {}
  try {
    dados = (await resposta.json()) as Record<string, unknown>
  } catch {
    /* corpo ilegível — usa o status */
  }
  return { status: resposta.status, dados, csrfIndisponivel: false }
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

/**
 * A checagem AO VIVO de descoberta (GET /api/privacidade): o backend faz um
 * `getMe` real. `ok && handle` = o bot TEM @username (encontrável); `ok &&
 * handle === null` = getMe real confirmou que o bot NÃO tem @username; `!ok` =
 * o getMe falhou (indisponível) — NUNCA se assume verde sem confirmação.
 */
type EstadoPrivacidade =
  | { readonly ok: true; readonly handle: string | null; readonly fonte: FonteDoToken }
  | { readonly ok: false; readonly erro: 'indisponivel' }

interface EstadoTelegrama {
  readonly online: boolean
  readonly motivo?: string
  readonly handle?: string
}

/** O estado do pareamento devolvido por GET /pair-state. */
interface EstadoPareamento {
  readonly pareado: boolean
  readonly handle?: string
  readonly codigo?: string
  readonly expiraEm?: number
}

type FeedbackDeForm = {
  readonly tipo: 'ok' | 'erro' | 'aviso'
  readonly texto: string
}

/** O fluxo do pareamento VIA PAINEL, estado a estado (renderizado no cartão). */
type EstadoDePareamentoUi =
  | { readonly fase: 'ocioso' }
  | { readonly fase: 'gerando' }
  | { readonly fase: 'codigo'; readonly codigo: string; readonly expiraEm: number }
  | { readonly fase: 'pareado' }
  | { readonly fase: 'expirou' }
  | { readonly fase: 'erro'; readonly mensagem: string }

/* ========================================================================== */
/* Helper puro de formatação (testável em isolamento)                         */
/* ========================================================================== */

/**
 * Contagem regressiva no formato `m:ss` (ex.: `4:23`) a partir de um prazo em
 * epoch ms. `0` ou passado devolve `0:00`. Exportada para o teste de expiração.
 */
export function formatarContagem(expiraEm: number, agoraMs: number): string {
  const falta = Math.max(0, Math.floor((expiraEm - agoraMs) / 1000))
  const minutos = Math.floor(falta / 60)
  const segundos = falta % 60
  return `${minutos}:${segundos.toString().padStart(2, '0')}`
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

/**
 * O chip do CABEÇALHO, estendido para refletir o estado AO VIVO do bot
 * (o usuário quer VER se o bot ainda existe / está conectado). Composição:
 *  - token ainda a carregar (null) → neutro "verificando…";
 *  - token NÃO configurado → comportamento atual do `chipDoEstado` (env manda /
 *    não configurado — o estado do bot é irrelevante sem token);
 *  - token configurado mas /telegram ainda a carregar (null) → neutro
 *    "verificando…";
 *  - token configurado E `/telegram` online → verde "Online" (detalhe: `@handle`
 *    quando o bot tiver username, senão a fonte do token);
 *  - token configurado E `/telegram` offline → aviso "Offline" com o `motivo`
 *    devolvido pela rota (`sem-chave` / `sem-pareamento`) quando presente.
 * Exportada para o teste de smoke exercitar os três estados sem montar React.
 */
export function chipDoBot(token: EstadoDoToken | null, telegrama: EstadoTelegrama | null): EstadoChip {
  if (token === null) return { tom: 'neutro', rotulo: 'verificando…' }
  if (!token.configurado) return chipDoEstado(token)
  if (telegrama === null) return { tom: 'neutro', rotulo: 'verificando…' }
  if (telegrama.online) {
    const detalhe = telegrama.handle !== undefined && telegrama.handle.length > 0 ? `@${telegrama.handle}` : token.fonte
    return { tom: 'ok', rotulo: 'Online', detalhe }
  }
  return { tom: 'aviso', rotulo: 'Offline', detalhe: telegrama.motivo }
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

/**
 * Os COMANDOS ESSENCIAIS do checkpoint 3 (pareado) — 3 linhas, uma ideia cada.
 * Os demais (`/ligar /desligar /acessar /rotacionar`) ficam nos botões do
 * cartão `/menu` do bot, não repetidos aqui — reduz a lista e o ruído (o
 * cartão `/menu` é renderizado do lado do bot pela Onda 3).
 */
const COMANDOS_ESSENCIAIS: readonly BlocoDeComando[] = [
  { comando: '/menu', dica: 'abrir o painel de controlo do bot' },
  { comando: '/status', dica: 'ver o estado do túnel' },
  { comando: '/emergencia', dica: 'derrubar tudo de imediato' },
]

/* ========================================================================== */
/* Os passos do @BotFather (cartão "Como criar o bot", só não-configurado)    */
/* ========================================================================== */

/**
 * Como criar um bot novo via @BotFather, passo a passo. Mantido como dados
 * planos (sem JSX) para o painel renderizar como uma lista numerada simples —
 * o cartão aparece apenas quando NÃO há token configurado.
 */
const PASSOS_BOTFATHER: readonly string[] = [
  'Abra o Telegram e converse com @BotFather.',
  'Envie /newbot.',
  'Dê um nome para o bot (ex.: "Meu dsh-messenger").',
  'Dê um username que termine em `bot` (5–32 caracteres, A-Za-z0-9_, ex.: `meu_dsh_messenger_bot`).',
  'O BotFather responde com um token no formato `<número>:<segredo>` — copie-o.',
  'Cole o token no campo abaixo e clique em "Salvar bot".',
]

/** Nota curta mostrada no fim do cartão do @BotFather. */
const NOTA_BOTFATHER = 'Se precisar trocar o token depois, use /token no @BotFather para revogar e gerar outro.'

/**
 * Nota OPCIONAL do cartão "Como criar o bot": a privacidade por desenho. Como o
 * plugin nunca mexeu no `@username`, o dono é quem decide se remove o handle no
 * @BotFather — sem `@username` o bot deixa de aparecer na busca do Telegram.
 *
 * FONTE (remover username via BotFather /setusername): a documentação do
 * BotFather confirma que o comando `/setusername` é o ponto de edição/remoção
 * do `@username` de um bot (em vez de tratar `username` como fixo e permanente)
 * — ver https://www.grambots.com/bots/botfather e
 * https://cnvrse.com/what-is-botfather . Como o prompt de remoção do BotFather
 * pode variar, o passo é escrito de forma conservadora (não inventa prompts
 * exatos): "no @BotFather, em /setusername, remova o username".
 */
const NOTA_BOTFATHER_PRIVADO = 'Opcional — bot privado: remova o username do bot no @BotFather para ele não aparecer na busca do Telegram.'

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
      copiado ? 'copiado' : 'Copiar'),
    bloco.dica ? h('span', { className: 'guard-muted' }, bloco.dica) : null,
  )
}

/**
 * Um `<details>` progressivo-disclosure: o resumo verb-first e o corpo fica
 * dobrado até abrir. Usado no passo 1 ("Como criar o bot do zero"), no passo 3
 * ("E minha conversa?" e "Avançado") — regra painel: os detalhes não atravancam
 * o CTA único do estado.
 */
function Detalhes({
  resumo,
  aberto,
  aoAlternar,
  children,
}: {
  readonly resumo: React.ReactNode
  readonly aberto?: boolean
  readonly aoAlternar?: (aberto: boolean) => void
  readonly children: React.ReactNode
}): React.ReactNode {
  const props: Record<string, unknown> = {}
  if (aberto !== undefined) props['open'] = aberto
  if (aoAlternar !== undefined) {
    props['onToggle'] = (e: React.SyntheticEvent<HTMLDetailsElement>) => aoAlternar((e.target as HTMLDetailsElement).open)
  }
  return h('details', { className: 'guard-details', ...props },
    h('summary', { className: 'guard-details-summary', 'data-guard-detail': '' }, resumo),
    h('div', { className: 'guard-details-body' }, children),
  )
}

/**
 * O cabeçalho de um checkpoint aberto: "Passo N de 3 · <titulo>", com ✓ à frente
 * quando concluído. É O título do passo atual (só ele fica aberto).
 */
function CabecalhoPasso({
  indice,
  titulo,
  concluido,
}: {
  readonly indice: number
  readonly titulo: string
  readonly concluido: boolean
}): React.ReactNode {
  return h('span', { className: 'guard-card-title' },
    concluido ? h('span', { className: 'guard-step-check', 'aria-hidden': 'true' }, '✓') : null,
    `Passo ${indice} de 3 · ${titulo}`,
  )
}

/**
 * Um checkpoint CONCLUÍDO, colapsado (só título + resumo + um text-link de
 * acção, ex.: "Trocar") — a atenção vai ao único passo aberto. O `<indice>` e
 * o `<titulo>` não entram na linha fina (só o `✓` + resumo), para o painel
 * continuar escaneável.
 */
function PassoConcluido({
  resumo,
  aoAcao,
  rotuloAcao,
}: {
  readonly resumo: string
  readonly aoAcao?: () => void
  readonly rotuloAcao?: string
}): React.ReactNode {
  return h('div', { className: 'guard-card guard-step-done' },
    h('span', { className: 'guard-card-title' },
      h('span', { className: 'guard-step-check', 'aria-hidden': 'true' }, '✓'),
      resumo,
    ),
    aoAcao !== undefined && rotuloAcao !== undefined
      ? h('div', { className: 'guard-step-done-actions' },
          h('button', { type: 'button', className: 'guard-link', onClick: aoAcao }, rotuloAcao),
        )
      : null,
  )
}

/**
 * O conteúdo dobrado "Como criar o bot do zero" — os passos numerados do
 * @BotFather (progressive disclosure: não atravancam o campo de token).
 */
function BotaoBotFatherDetalhado(): React.ReactNode {
  return h('ol', { className: 'guard-botfather-steps' },
    PASSOS_BOTFATHER.map((passo, i) => h('li', { className: 'guard-botfather-step', key: i }, passo)),
    h('li', { className: 'guard-botfather-step' }, NOTA_BOTFATHER),
    h('li', { className: 'guard-botfather-step' }, NOTA_BOTFATHER_PRIVADO),
  )
}

/* ========================================================================== */
/* Cartão "Privacidade" — o bot é só para o dono                              */
/* ========================================================================== */

/**
 * As garantias de deny-by-default, em linguagem de dono. Cada item é coberto
 * por teste (auth.test.ts / core.test.ts: PAIR-005, PAIR-006, PAIR-007,
 * TG-007, TG-089) — este bloco só as mostra ao dono, não as implementa.
 */
const GARANTIAS_PRIVACIDADE: readonly string[] = [
  'Sem o código de pareamento (que só aparece neste painel), nenhum comando funciona — o bot recusa por omissão (default deny).',
  '/start responde apenas "Olá. Este bot é privado…" — boas-vindas inócuas, iguais para todos, sem parear ninguém.',
  'Comandos de estranhos são recusados em silêncio (nenhuma resposta na conversa) e contados na auditoria.',
  'Uma segunda parelha é recusada mesmo com um código válido: só existe UM dono, definido na primeira parelha.',
  'Tentativas erradas de /parear têm tetos (por conversa e globais) e um atraso crescente, para travar força bruta.',
]

/**
 * O passo-a-passo ENXUTO para remover o username via @BotFather, mostrado
 * quando o bot AINDA tem `handle`. Escrito de forma conservadora (sem inventar
 * prompts exatos do BotFather) conforme o fluxo confirmado no web_search:
 *   https://www.grambots.com/bots/botfather · https://cnvrse.com/what-is-botfather
 * O comando `/setusername` do BotFather é onde o `@username` se edita/remove.
 */
const PASSOS_REMOVER_USERNAME: readonly string[] = [
  'No Telegram, abra a conversa com @BotFather.',
  'Envie /setusername e escolha o teu bot na lista.',
  'Remova o username (a opção "delete current username"/"remover username").',
]

/**
 * O cartão "Privacidade" (renderizado SÓ quando configurado). Dois vértices:
 *  - A descoberta (encontrável vs não) NÃO usa o `handle` do token-state (que só
 *    vive em memória após um `POST /api/token`) — usa a rota `/api/privacidade`,
 *    que faz um `getMe` AO VIVO. Um bot só é encontrado na busca do Telegram SE
 *    tiver `@username`; sem ele desaparece.
 *  - O bloco de garantias deny-by-default é estático (coberto por testes).
 *
 * Estados:
 *  - `ok && handle`  → aviso "encontrável" + passos de remoção;
 *  - `ok && null`    → badge verde (getMe REAL confirmou sem username);
 *  - `!ok`           → neutro honesto + botão "Verificar de novo";
 *  - `estado === null` (ainda a carregar) → "verificando…".
 */
function CartaoPrivacidade({
  estado,
  aoVerificar,
}: {
  readonly estado: EstadoPrivacidade | null
  readonly aoVerificar: () => void
}): React.ReactNode {
  const titulo = h('span', { className: 'guard-card-title' }, 'Privacidade — só para você')

  const corpo =
    estado === null
      ? paragrafo('guard-intro', 'A verificar a descoberta do bot…')
      : estado.ok
        ? estado.handle !== null && estado.handle.length > 0
          ? h('div', { className: 'guard-privacy-body' },
              paragrafo('guard-intro', `O bot é encontrável na busca do Telegram como @${estado.handle}. Se não quiser isso, remova o username:`),
              h('ol', { className: 'guard-botfather-steps' },
                PASSOS_REMOVER_USERNAME.map((passo, i) => h('li', { className: 'guard-botfather-step', key: i }, passo)),
              ),
              paragrafo('guard-privacy-note', `Sem username o bot deixa de aparecer na busca e o link t.me/@${estado.handle} morre — a conversa já aberta e o pareamento continuam a funcionar.`),
            )
          : h('div', { className: 'guard-privacy-body' },
              h('span', { className: 'guard-badge-ok' }, 'Não encontrável na busca ✓ — ninguém acha o bot no Telegram.'),
            )
        : h('div', { className: 'guard-privacy-body' },
            paragrafo('guard-intro', 'Não foi possível verificar agora (bot offline ou token inválido?).'),
            h('div', { className: 'guard-actions' },
              h('button', { type: 'button', className: 'guard-btn guard-btn-outline', onClick: aoVerificar },
                'Verificar de novo'),
            ),
          )

  return h('div', { className: 'guard-privacy-card' },
    titulo,
    corpo,
    h('div', { className: 'guard-privacy-block' },
      h('span', { className: 'guard-block-title' }, 'Se alguém achar o bot assim mesmo:'),
      h('ul', { className: 'guard-privacy-list' },
        GARANTIAS_PRIVACIDADE.map((g, i) => h('li', { className: 'guard-privacy-item', key: i }, g)),
      ),
    ),
  )
}

/**
 * O cartão "Privacidade" migra para o PASS0 3, dobrado num `<details>`
 * "E minha conversa?" — 1 linha de risco + 1 linha do que faz (texto EXATO do
 * contrato §3), seguido do cartão AO VIVO (getMe real decide o verde de
 * "não encontrável" — NUNCA um verde mentiroso) e das garantias deny-by-default.
 */
const TEXTO_PRIVACIDADE_CKPT3 =
  'As tuas conversas com o bot ficam neste aparelho e no Telegram, com privacidade por omissão: nenhum comando de estranho funciona e quem não pareou não recebe resposta.'

function CartaoPrivacidadeCkpt3(props: {
  readonly estado: EstadoPrivacidade | null
  readonly aoVerificar: () => void
}): React.ReactNode {
  return h(Detalhes, { resumo: 'E minha conversa?' },
    paragrafo('guard-intro', TEXTO_PRIVACIDADE_CKPT3),
    h(CartaoPrivacidade, { estado: props.estado, aoVerificar: props.aoVerificar }),
  )
}

/* ========================================================================== */
/* O pareamento VIA PAINEL                                                    */
/* ========================================================================== */

/**
 * O corpo do Passo 2 "Parear" — mostra o CTA "Gerar código" quando sem
 * pareamento, o CÓDIGO DE 6 DÍGITOS em caixa monospace espaçada + "Copiar", a
 * contagem `expira em m:ss` + "Gerar novo" e o status ao vivo "Aguardando…" →
 * "✓ Pareado" enquanto o dono digita. NUNCA `console.log` do código: ele só
 * vive neste state e no DOM.
 */
function CartaoParear(props: {
  readonly handle?: string
  readonly estado: EstadoDePareamentoUi
  readonly pareado: boolean
  readonly agora: number
  readonly aoGerar: () => void
  readonly aoNovoCodigo: () => void
}): React.ReactNode {
  const [copiado, setCopiado] = useState(false)

  switch (props.estado.fase) {
    case 'gerando':
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        paragrafo('guard-intro', 'A gerar o código…'),
      )
    case 'codigo': {
      const contagem = formatarContagem(props.estado.expiraEm, props.agora)
      const expirou = props.agora >= props.estado.expiraEm
      if (expirou) {
        return h('div', { className: 'guard-actions guard-col' },
          paragrafo('guard-error', 'Este código expirou. Gera um novo.'),
          h('button', { type: 'button', className: 'guard-btn guard-btn-primary', onClick: props.aoNovoCodigo },
            'Gerar novo código'),
        )
      }
      const digitoEspacado = espacarCodigo(props.estado.codigo)
      const copiar = async (): Promise<void> => {
        try {
          await navigator.clipboard.writeText(props.estado.codigo)
          setCopiado(true)
          window.setTimeout(() => setCopiado(false), 1200)
        } catch {
          setCopiado(false)
        }
      }
      return h('div', { className: 'guard-pair-body' },
        paragrafo('guard-intro', 'No Telegram, envia:'),
        h('div', { className: 'guard-pair-step' },
          h('code', { className: 'guard-pair-code' }, digitoEspacado),
          h('button', { type: 'button', className: 'guard-btn-sm', onClick: () => void copiar(), 'data-guard-copy-code': '' },
            copiado ? 'copiado' : 'Copiar'),
        ),
        paragrafo('guard-code-line',
          `No Telegram, envia: /parear ${props.estado.codigo} no ${props.handle && props.handle.length > 0 ? `@${props.handle}` : 'o bot'} — ou só /parear e o bot pede o código`),
        h('div', { className: 'guard-pair-countdown' },
          h('span', { className: 'guard-muted' }, `expira em ${contagem}`),
          h('button', { type: 'button', className: 'guard-btn-sm', onClick: props.aoNovoCodigo }, 'Gerar novo'),
        ),
        h('div', { className: 'guard-pair-status' },
          props.pareado
            ? h('span', { className: 'guard-chip guard-chip-success' },
                h('span', { className: 'guard-chip-dot' }),
                '✓ Pareado',
              )
            : h('span', { className: 'guard-chip' },
                h('span', { className: 'guard-chip-dot' }),
                'Aguardando…',
              ),
        ),
      )
    }
    case 'pareado':
      return h('div', { className: 'guard-pair-body' },
        h('span', { className: 'guard-chip guard-chip-success' },
          h('span', { className: 'guard-chip-dot' }),
          '✓ Pareado',
        ),
      )
    case 'expirou':
      return h('div', { className: 'guard-actions guard-col' },
        paragrafo('guard-error', 'Este código expirou. Gera um novo.'),
        h('button', { type: 'button', className: 'guard-btn guard-btn-primary', onClick: props.aoNovoCodigo },
          'Gerar novo código'),
      )
    case 'erro':
      return h('div', { className: 'guard-actions guard-col' },
        paragrafo('guard-error', props.estado.mensagem),
        h('button', { type: 'button', className: 'guard-btn guard-btn-outline', onClick: props.aoNovoCodigo },
          'Tentar de novo'),
      )
    default:
      // ocioso: CTA primário "Gerar código"
      return h('div', { className: 'guard-pair-body' },
        paragrafo('guard-intro',
          'Este painel gera um código de 6 dígitos só para ti. Tu envias esse código para o bot.'),
        h('div', { className: 'guard-actions' },
          h('button', { type: 'button', className: 'guard-btn guard-btn-primary', onClick: props.aoGerar },
            'Gerar código'),
        ),
      )
  }
}

/**
 * Espaça o código de 6 dígitos para exibição (`123456` → `1 2 3 4 5 6`) — a
 * caixa monospace espaçada ajuda a ler/copiar. O botão "Copiar" copia o código
 * CRU (sem espaços), porque o `/parear` espera os 6 dígitos juntos.
 */
function espacarCodigo(codigo: string): string {
  return codigo.split('').join(' ')
}

/* ========================================================================== */
/* O PAINEL — a section `settings.section`                                    */
/* ========================================================================== */

/**
 * Conteúdo da aba "Remote Access". Dados vêm do backend via fetch; o painel
 * re-busca ao montar e a cada ~5s (mais em `focus`/`visibilitychange`).
 */
function TelegramGuardSection(): React.ReactNode {
  const [token, setToken] = useState<EstadoDoToken | null>(null)
  // O estado AO VIVO do bot (GET /telegram): online/offline + motivo/handle —
  // alimenta o chip do cabeçalho. `null` = ainda a carregar (ou fetch falhou e
  // mantemos o último resultado honesto).
  const [telegrama, setTelegrama] = useState<EstadoTelegrama | null>(null)
  const [tokenErro, setTokenErro] = useState<string | null>(null)
  // A checagem AO VIVO de descoberta (GET /api/privacidade); `null` = ainda a
  // carregar (ou o fetch falhou e mantemos o último resultado honesto).
  const [privacidade, setPrivacidade] = useState<EstadoPrivacidade | null>(null)

  // Formulário de token.
  const [valor, setValor] = useState('')
  const [mostrarToken, setMostrarToken] = useState(false)
  const [enviando, setEnviando] = useState(false)
  const [feedback, setFeedback] = useState<FeedbackDeForm | null>(null)
  // "Trocar" (checkpoint 2/3) volta ao Passo 1 com o formulário de token aberto.
  const [trocarTokenAberto, setTrocarTokenAberto] = useState(false)
  const inputTokenRef = useRef<HTMLInputElement | null>(null)
  // Confirmação destrutiva (checkpoint 3, Avançado): 'trocar' (token) ou
  // 'desfazer' (parear). Textos exatos do contrato/section de confirmações.
  const [confirmacao, setConfirmacao] = useState<'trocar' | 'desfazer' | null>(null)

  // O fluxo do PAREAMENTO VIA PAINEL.
  const [par, setPar] = useState<EstadoDePareamentoUi>({ fase: 'ocioso' })
  const [pareado, setPareado] = useState(false)
  // Referencia para parar a sondagem no unmount / quando parear.
  const sondaParRef = useRef<number | null>(null)

  // "Agora" — ticker de 1s só para re-render (contagem do código de pareamento).
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
      if (vivo.current) {
        // Guarda o estado do bot para o chip do cabeçalho (Online/Offline).
        setTelegrama(dados)
        // O bot ONLINE = token configurado E pareamento feito. Se já está
        // pareado (ex.: via CLI, ou por outra aba), o painel reflete logo
        // "Pareado" e NUNCA mostra o botão de parear.
        if (dados.online) {
          setPareado(true)
          setPar({ fase: 'pareado' })
          if (sondaParRef.current !== null) {
            window.clearInterval(sondaParRef.current)
            sondaParRef.current = null
          }
        }
      }
    } catch {
      /* o marcador fica em "verificando…"; sem ação para o user */
    }
  }, [])

  // A checagem AO VIVO de descoberta. `forcar` contorna o cache curto do
  // backend (botão "Verificar de novo"); sem `forcar`, o backend serve um
  // resultado cacheado de ~30s para não bater getMe a cada poll de ~5s.
  const buscarPrivacidade = React.useCallback(async (forcar: boolean): Promise<void> => {
    const link = forcar ? '/privacidade?forcar=true' : '/privacidade'
    try {
      const dados = await apiGet<EstadoPrivacidade>(link)
      if (vivo.current) setPrivacidade(dados)
    } catch {
      /* mantém o último resultado (honesto); sem estado inventado */
    }
  }, [])

  const recarregarTudo = React.useCallback(async (): Promise<void> => {
    await Promise.all([buscarToken(), buscarTelegrama(), buscarPrivacidade(false)])
  }, [buscarToken, buscarTelegrama, buscarPrivacidade])

  // Sonda /pair-state a cada ~3s enquanto houver um código a aguardar (ou a
  // gerar), até o `pareado:true` chegar (o dono digitou /parear no Telegram).
  // Também reflete o pareamento feito por OUTRA via (ex.: o CLI): se ficou
  // pareado e o painel ainda mostra o botão, troca para "Pareado ✓" e para.
  const sondarPareado = React.useCallback(async (): Promise<void> => {
    if (!vivo.current) return
    let estado: EstadoPareamento
    try {
      estado = await apiGet<EstadoPareamento>('/pair-state')
    } catch {
      return // servidor inacessível — a próxima sondagem tenta de novo
    }
    if (!vivo.current) return
    if (estado.pareado) {
      setPareado(true)
      setPar({ fase: 'pareado' })
      if (sondaParRef.current !== null) {
        window.clearInterval(sondaParRef.current)
        sondaParRef.current = null
      }
      return
    }
    // Continua a aguardar: nada a mudar — a contagem regressiva já corre.
  }, [])

  // Arma a sondagem quando o fluxo está em `gerando`/`codigo`; desarma quando
  // sai ou quando o componente vive mais.
  React.useEffect(() => {
    if (par.fase === 'ocioso' || par.fase === 'pareado' || par.fase === 'expirou') return
    if (sondaParRef.current !== null) return
    sondaParRef.current = window.setInterval(() => {
      void sondarPareado()
    }, 3000)
    return () => {
      if (sondaParRef.current !== null) {
        window.clearInterval(sondaParRef.current)
        sondaParRef.current = null
      }
    }
  }, [par.fase, sondarPareado])

  // Gera UM código de pareamento (POST /pair com CSRF) e mostra-o em destaque.
  const gerarCodigo = React.useCallback(async (): Promise<void> => {
    if (!vivo.current) return
    setPar({ fase: 'gerando' })
    const r = await apiPost('/pair', {}, document)
    if (!vivo.current) return
    if (r.csrfIndisponivel) {
      setPar({ fase: 'erro', mensagem: 'CSRF indisponível — recarregue a página e tente de novo.' })
      return
    }
    if (r.status === 200) {
      const codigo = typeof r.dados.codigo === 'string' ? r.dados.codigo : ''
      const expiraEm = typeof r.dados.expiraEm === 'number' ? r.dados.expiraEm : 0
      if (codigo.length === 0 || expiraEm <= 0) {
        setPar({ fase: 'erro', mensagem: 'O servidor respondeu sem código. Tentou gerar de novo.' })
        return
      }
      setPar({ fase: 'codigo', codigo, expiraEm })
      await sondarPareado()
      return
    }
    // 409 (ja-pareado/sem-token/worker-indisponivel) ou outro erro.
    const mensagem =
      typeof r.dados.mensagem === 'string' && r.dados.mensagem.length > 0
        ? r.dados.mensagem
        : 'Não foi possível gerar o código. Tente de novo.'
    setPar({ fase: 'erro', mensagem })
    if (r.status === 409 && r.dados.erro === 'ja-pareado') {
      setPareado(true)
      await recarregarTudo()
    }
  }, [sondarPareado, recarregarTudo])

  const novoCodigo = React.useCallback((): void => {
    setPar({ fase: 'ocioso' })
  }, [])

  // Monte: marca vivo e re-busca tudo. Desmonte: marca morto.
  useEffect(() => {
    vivo.current = true
    void recarregarTudo()
    return () => {
      vivo.current = false
    }
  }, [recarregarTudo])

  // Ticker de 1s para re-render (contagem do código de pareamento).
  useEffect(() => {
    const t = window.setInterval(() => setAgora(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  // Refresh automático a cada ~5s enquanto a aba estiver aberta.
  useEffect(() => {
    const t = window.setInterval(() => {
      void recarregarTudo()
    }, 5000)
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

    if (r.csrfIndisponivel) {
      setFeedback({ tipo: 'erro', texto: 'CSRF indisponível — recarregue a página e tente de novo.' })
      return
    }

    switch (r.status) {
      case 200: {
        const handle = typeof r.dados.handle === 'string' && r.dados.handle.length > 0 ? r.dados.handle : null
        setValor('')
        setMostrarToken(false)
        setTrocarTokenAberto(false)
        setFeedback({ tipo: 'ok', texto: handle ? `Configurado ✓ @${handle}` : 'Configurado ✓' })
        await recarregarTudo()
        // Token recém-aplicado: força a checagem AO VIVO de descoberta (contorna
        // o cache de ~30s que podia ainda guardar o "sem token/não configurado").
        void buscarPrivacidade(true)
        break
      }
      case 400: {
        const erro = r.dados.erro
        setFeedback({
          tipo: 'erro',
          texto:
            erro === 'formato-invalido'
              ? 'Formato errado. O token vem assim: 123456:aaaa… (número, dois pontos, segredo).'
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
          texto: 'O Telegram não aceitou este token. Veja no @BotFather (/newbot) e tira outro.',
        })
        break
      }
      default: {
        setFeedback({
          tipo: 'erro',
          texto:
            r.status === 0
              ? 'Sem ligação ao Telegram. Verifica a rede e tenta de novo.'
              : 'O servidor não respondeu — recarregue a página e tente de novo.',
        })
      }
    }
  }

  // Ação "Revisar token": limpa o erro e foca o campo para o dono corrigir.
  const revisarToken = React.useCallback((): void => {
    setFeedback(null)
    setTrocarTokenAberto(true)
    // Focus no render seguinte.
    requestAnimationFrame(() => inputTokenRef.current?.focus())
  }, [])

  // "Trocar" (collapsed) / "Trocar o token" (Avançado): volta ao Passo 1 com o
  // formulário de token aberto.
  const abrirTrocar = React.useCallback((): void => {
    setConfirmacao(null)
    setFeedback(null)
    setTrocarTokenAberto(true)
  }, [])

  // Confirma a ação destrutiva do Avançado. Para "trocar", volta ao formulário
  // do Passo 1. Para "desfazer", o parear só se reabre com `--reset-pairing` na
  // MÁQUINA (PAIR-008) — o painel não tem rota de desfazer (o texto guia, não
  // força); a confirmação fecha e o copy já disse o que acontece. Em AMBOS os
  // casos, após confirmar, o painel dispara um refresh COMPLETO do estado
  // sincronizado + uma checagem AO VIVO de descoberta (getMe FORÇADO, que
  // contorna o cache de ~30s do backend) — responde "o bot ainda existe?" com
  // checagem real, e reflete já a nova realidade (ex.: token trocado / bot
  // removido) sem esperar o poll seguinte.
  const confirmar = React.useCallback((): void => {
    const tipo = confirmacao
    if (tipo === null) return
    if (tipo === 'trocar') {
      abrirTrocar()
    } else {
      // 'desfazer': sem rota no painel — fecha a confirmação (orientação honesta).
      setConfirmacao(null)
    }
    void recarregarTudo()
    void buscarPrivacidade(true)
  }, [confirmacao, abrirTrocar, recarregarTudo, buscarPrivacidade])

  const chip = chipDoBot(token, telegrama)
  const configurado = token?.configurado === true
  const handleChave = token?.handle
  const rotuloHandle = handleChave && handleChave.length > 0 ? `@${handleChave}` : 'o bot'
  const passo1Aberto = !configurado || trocarTokenAberto

  // --- Passo 1 ✻ formulário de token (aberto quando sem token ou ao "Trocar") ---
  const cartaoToken = h('div', { className: 'guard-card' },
    h(CabecalhoPasso, { indice: 1, titulo: 'Criar o bot', concluido: configurado }),
    h(CartaoTokenForm, {
      valor,
      mostrarToken,
      enviando,
      feedback,
      inputRef: inputTokenRef,
      aoMudar: setValor,
      aoAlternarMostrar: () => setMostrarToken((v) => !v),
      aoEnviar: enviarToken,
      aoRevisar: revisarToken,
    }),
    h(Detalhes, { resumo: 'Como criar o bot do zero' }, h(BotaoBotFatherDetalhado)),
    !configurado ? paragrafo('guard-step-hint', 'Depois disto, avanças para o Passo 2: parear.') : null,
  )

  // --- Passo 1 ✻ colapsado (concluído) quando configurado ---
  const passo1Concluido = configurado && !trocarTokenAberto
    ? h(PassoConcluido, {
        resumo: `Bot ${rotuloHandle} conectado`,
        aoAcao: abrirTrocar,
        rotuloAcao: 'Trocar',
      })
    : null

  // --- Passo 2 ✻ Parear (configurado e NÃO pareado) ---
  const passo2 = configurado && !pareado
    ? h('div', { className: 'guard-card' },
        h(CabecalhoPasso, { indice: 2, titulo: 'Parear', concluido: false }),
        h(CartaoParear, {
          handle: handleChave ?? undefined,
          estado: par,
          pareado,
          agora,
          aoGerar: () => void gerarCodigo(),
          aoNovoCodigo: () => novoCodigo(),
        }),
      )
    : null

  // --- Passo 2 ✻ "✓ Pareado" (linha fina) quando pareado ---
  const passo2Concluido = pareado
    ? h('div', { className: 'guard-card guard-step-done' },
        h('span', { className: 'guard-card-title' },
          h('span', { className: 'guard-step-check', 'aria-hidden': 'true' }, '✓'),
          'Pareado',
        ),
        paragrafo('guard-intro', 'Pareado! Este painel agora controla o bot. Vai ao Passo 3 para começar.'),
      )
    : null

  // --- Passo 3 ✻ Usar (pareado) ---
  const passo3 = pareado
    ? h('div', { className: 'guard-card' },
        h(CabecalhoPasso, { indice: 3, titulo: 'Usar', concluido: false }),
        // Comandos essenciais — 3 linhas, uma ideia cada.
        h('span', { className: 'guard-block-title' }, 'Comandos essenciais'),
        h('ul', { className: 'guard-steps' },
          COMANDOS_ESSENCIAIS.map((bloco, i) =>
            h('li', { className: 'guard-step', key: i }, h(LinhaDeComando, { bloco })),
          ),
        ),
        // Avançado (dobrado): trocar token / desfazer parear / todos os comandos.
        h(Detalhes, { resumo: 'Avançado' },
          h('ul', { className: 'guard-links' },
            h('li', null,
              h('button', { type: 'button', className: 'guard-link', onClick: () => setConfirmacao('trocar') },
                'Trocar o token'),
            ),
            h('li', null,
              h('button', { type: 'button', className: 'guard-link', onClick: () => setConfirmacao('desfazer') },
                'Desfazer parear'),
            ),
          ),
          h('span', { className: 'guard-block-title' }, 'Ver todos os comandos'),
          h('ul', { className: 'guard-steps' },
            COMANDOS_DE_USO.map((bloco, i) =>
              h('li', { className: 'guard-step', key: i }, h(LinhaDeComando, { bloco })),
            ),
          ),
        ),
        // E minha conversa? (privacidade, dobrada) — migrada do bloco solto.
        h(CartaoPrivacidadeCkpt3, {
          estado: privacidade,
          aoVerificar: () => void buscarPrivacidade(true),
        }),
      )
    : null

  // --- Confirmação destrutiva (Avançado) --------------------------------
  const caixaConfirmacao = confirmacao !== null
    ? CartaoConfirmacao({
        tipo: confirmacao,
        aoConfirmar: confirmar,
        aoCancelar: () => setConfirmacao(null),
      })
    : null

  return h('div', { className: 'guard-section' },
    // --- Bloco de marca (logo do plugin) --------------------------------
    h('div', { className: 'guard-brand' },
      h('img', { className: 'guard-logo', src: logoUrl, alt: 'dsh-guard-messenger' }),
    ),
    // --- Título + chip de estado ----------------------------------------
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
      h('h2', { className: 'guard-title', style: { margin: 0 } }, 'Remote Access'),
      h(Chip, { chip }),
    ),
    paragrafo('guard-intro', 'Acesso remoto ao Harness pelo Telegram — sem login no túnel.'),
    tokenErro ? paragrafo('guard-error', tokenErro) : null,

    // --- A TRILHA (só o passo atual aberto) -----------------------------
    passo1Aberto ? cartaoToken : passo1Concluido,
    passo2,
    passo2Concluido,
    passo3,
    caixaConfirmacao,
  )
}

/**
 * O formulário do token (Passo 1). Um CTA primário ("Salvar bot"); erro com a
 * ação "Revisar token" que limpa o feedback e foca o campo.
 */
function CartaoTokenForm(props: {
  readonly valor: string
  readonly mostrarToken: boolean
  readonly enviando: boolean
  readonly feedback: FeedbackDeForm | null
  readonly inputRef: React.RefObject<HTMLInputElement | null>
  readonly aoMudar: (v: string) => void
  readonly aoAlternarMostrar: () => void
  readonly aoEnviar: (e: React.FormEvent) => void
  readonly aoRevisar: () => void
}): React.ReactNode {
  const mostraErro = props.feedback !== null && props.feedback.tipo === 'erro'
  return h('form', { className: 'guard-field', onSubmit: props.aoEnviar },
    paragrafo('guard-intro', 'Cole o token que o @BotFather te entregou ao criar o bot. Fica guardado seguro nesta máquina.'),
    h('label', { className: 'guard-field-label', htmlFor: 'guard-token-input' }, 'Token do bot (@BotFather)'),
    h('div', { className: 'guard-input-wrap' },
      h('input', {
        id: 'guard-token-input',
        className: 'guard-input',
        ref: props.inputRef,
        type: props.mostrarToken ? 'text' : 'password',
        value: props.valor,
        autoComplete: 'off',
        spellCheck: false,
        placeholder: '1234567890:AAA…',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => props.aoMudar(e.target.value),
      }),
      h('button', {
        type: 'button',
        className: 'guard-toggle',
        'aria-label': props.mostrarToken ? 'Ocultar token' : 'Mostrar token',
        onClick: props.aoAlternarMostrar,
      }, props.mostrarToken ? '🙈' : '👁'),
    ),
    h('div', { className: 'guard-actions' },
      h('button', { type: 'submit', className: 'guard-btn guard-btn-primary', disabled: props.enviando },
        props.enviando ? 'A conectar ao Telegram…' : 'Salvar bot'),
      mostraErro
        ? h('button', { type: 'button', className: 'guard-btn guard-btn-outline', onClick: props.aoRevisar },
            'Revisar token')
        : null,
    ),
    props.feedback
      ? h('p', {
          className:
            props.feedback.tipo === 'ok' ? 'guard-success-text' : props.feedback.tipo === 'erro' ? 'guard-error' : 'guard-notice',
        }, props.feedback.texto)
      : null,
  )
}

/**
 * A confirmação destrutiva do Avançado (textos EXATOS do contrato). Dois tipos:
 * 'trocar' (token) e 'desfazer' (parear), cada um com [ação][Cancelar].
 */
function CartaoConfirmacao({
  tipo,
  aoConfirmar,
  aoCancelar,
}: {
  readonly tipo: 'trocar' | 'desfazer'
  readonly aoConfirmar: () => void
  readonly aoCancelar: () => void
}): React.ReactNode {
  const texto =
    tipo === 'trocar'
      ? 'Trocar o token desliga temporariamente o bot. Continuar?'
      : 'Desfazer o parear fecha o teu acesso pelo bot a partir deste painel. Não dá para desfazer sem parear de novo. O painel vai re-verificar o estado do bot. Continuar?'
  const rotulo = tipo === 'trocar' ? 'Trocar token' : 'Desfazer parear'
  return h('div', { className: 'guard-card guard-confirm' },
    paragrafo('guard-error', texto),
    h('div', { className: 'guard-actions' },
      h('button', { type: 'button', className: 'guard-btn guard-btn-primary', onClick: aoConfirmar }, rotulo),
      h('button', { type: 'button', className: 'guard-btn guard-btn-outline', onClick: aoCancelar }, 'Cancelar'),
    ),
  )
}

/* ========================================================================== */
/* apply — regista as contribuições e injeta o CSS                            */
/* ========================================================================== */

/**
 * Corpo do plugin client. Injeta o CSS do painel e regista a ÚNICA entrada de
 * slot: a aba `settings.section` "Remote Access" (acessível pelo rail do modal
 * de settings padrão do shell).
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

  // Aba no modal de settings (slot declarado pelo ui-settings). O botão do
  // rodapé da sidebar (`sidebar.footer.action`) foi REMOVIDO — o acesso é pelo
  // settings padrão do shell, que mostra esta aba no rail.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'telegram-guard',
        order: 99,
        label: 'Remote Access',
        registrant: 'dsh-guard-messenger',
      },
      TelegramGuardSection,
    ),
  )
}