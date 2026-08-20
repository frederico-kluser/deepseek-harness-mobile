/**
 * Painel HTML autocontido: sem CDN, sem build, sem recurso externo.
 *
 * DONO: T3.4 -> T5.3.
 *
 * ------------------------------------------------------------------------
 * PORQUE ZERO RECURSOS EXTERNOS -- sao DUAS razoes, e a segunda e de seguranca
 * ------------------------------------------------------------------------
 * (a) QUEBRA OFFLINE. Metade do caso de uso deste plugin e a maquina de casa
 *     alcancada de fora; a outra metade e o proprio dono em `127.0.0.1` sem
 *     rede nenhuma. Uma folha de estilo num CDN transforma "o painel abre" numa
 *     aposta sobre a rede de um terceiro.
 * (b) VAZA O `Referer`. Um `<script src>` ou uma fonte remota faz o navegador
 *     pedir esse recurso E ANUNCIAR de onde veio. Sob tunel rapido, "de onde
 *     veio" e literalmente a URL do quick tunnel -- que e o endereco publico da
 *     maquina do dono. Um unico recurso externo entrega essa URL a um terceiro
 *     que nunca foi convidado. `Referrer-Policy: no-referrer` mitiga, mas a
 *     unica forma de nao vazar e nao pedir.
 *
 * A garantia nao fica so na disciplina de quem escreve: a CSP servida com cada
 * pagina e `default-src 'none'`, o que faz o proprio navegador RECUSAR qualquer
 * carregamento externo que venha a ser introduzido aqui por engano. E
 * `test/unit/panel/html.test.ts` procura `http://`, `https://`, `//`,
 * `<script src=`, `@import` e `url(` no HTML servido.
 *
 * ------------------------------------------------------------------------
 * PORQUE `nonce` E NAO `'unsafe-inline'`
 * ------------------------------------------------------------------------
 * `script-src 'unsafe-inline'` autorizaria QUALQUER script inline, incluindo um
 * que um defeito futuro injetasse. Com nonce, so os blocos que ESTA funcao
 * escreveu correm. Custo: um valor aleatorio por resposta, o que torna o HTML
 * nao-determinista -- e por isso os testes comparam por forma, nao por igualdade
 * de ficheiro.
 *
 * ------------------------------------------------------------------------
 * OS ROTULOS EM PORTUGUES VIVEM AQUI, E SO AQUI (D7)
 * ------------------------------------------------------------------------
 * O vocabulario de estado e ingles em codigo, teste e payload IPC. "desligado",
 * "online" e companhia sao TEXTO DE INTERFACE. `src/contracts/tunnel.ts` e
 * explicito: eles existem apenas em `src/panel/**` e no bot. Um teste que
 * escrevesse o rotulo em vez de o importar daqui criaria a segunda fonte da
 * verdade que D7 existe para impedir.
 */

import { randomBytes } from 'node:crypto'

import type { TunnelState } from '../contracts/tunnel.ts'

export const PANEL_HTML_CONTENT_TYPE = 'text/html; charset=utf-8'

/** 128 bits por resposta: um nonce adivinhavel e um nonce que nao serve. */
const NONCE_BYTES = 16

/**
 * TEXTO DE INTERFACE. Ver a nota do cabecalho: nenhum outro ficheiro escreve
 * estas strings a mao -- quem precisa delas importa este mapa.
 */
export const TUNNEL_STATE_LABEL: Readonly<Record<TunnelState, string>> = Object.freeze({
  STOPPED: 'desligado',
  STARTING: 'ligando',
  READY: 'online',
  DEGRADED: 'instável, tentando de novo',
  STOPPING: 'desligando',
  FAILED: 'falhou — precisa de ação sua',
})

/** Valor novo de nonce, em base64url (sem `/` e sem `+`, logo sem `//`). */
export function newNonce(): string {
  return randomBytes(NONCE_BYTES).toString('base64url')
}

/**
 * Escapa para contexto de TEXTO e de ATRIBUTO com aspas.
 *
 * `'` e `"` entram os dois porque a mesma funcao serve os dois contextos: uma
 * funcao "so para texto" e outra "so para atributo" e como se usa a errada.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/**
 * Serializa um valor para dentro de um bloco `<script>`.
 *
 * `JSON.stringify` sozinho NAO chega: a sequencia de fecho do elemento dentro de
 * uma string JSON termina o bloco de script para o parser de HTML, que nao
 * conhece JSON. `U+2028`/`U+2029` sao terminadores de linha para o parser de
 * JavaScript e nao sao escapados pelo `JSON.stringify`.
 */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003C')
    .replace(/>/gu, '\\u003E')
    .replace(/&/gu, '\\u0026')
    .replace(/\u2028/gu, '\\u2028')
    .replace(/\u2029/gu, '\\u2029')
}

/**
 * Cabecalhos de toda resposta HTML do painel.
 *
 * `default-src 'none'` e a linha que torna a promessa "sem recurso externo"
 * EXECUTAVEL pelo navegador em vez de apenas prometida por quem escreveu o
 * ficheiro. `connect-src 'self'` existe porque o painel faz polling da propria
 * API; `form-action 'self'` impede que um defeito de HTML aponte um formulario
 * nosso para fora; `frame-ancestors 'none'` fecha clickjacking sobre um painel
 * que, na Onda 5, ganha botoes destrutivos.
 */
export function panelHtmlHeaders(nonce: string): Record<string, string> {
  return {
    'content-type': PANEL_HTML_CONTENT_TYPE,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy':
      "default-src 'none'; " +
      `script-src 'nonce-${nonce}'; ` +
      `style-src 'nonce-${nonce}'; ` +
      "connect-src 'self'; " +
      "form-action 'self'; " +
      "base-uri 'none'; " +
      "frame-ancestors 'none'",
  }
}

/** Folha de estilo unica. Sem `url(`, sem `@import`, sem fonte remota. */
const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 1.5rem 1rem;
  background: #101215;
  color: #e6e8ea;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  line-height: 1.5;
}
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 1.1rem; letter-spacing: .04em; text-transform: uppercase; color: #9aa4ad; margin: 0 0 1rem; }
.cartao { background: #181b1f; border: 1px solid #262b31; border-radius: .6rem; padding: 1rem 1.1rem; margin-bottom: 1rem; }
.estado { font-size: 1.6rem; font-weight: 600; margin: 0; }
.linha { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .5rem; color: #9aa4ad; font-size: .9rem; }
.valor { color: #e6e8ea; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.aviso { color: #f0b429; }
.erro { color: #f2777a; }
pre { margin: 0; padding: 1rem; background: #000; color: #fff; border-radius: .4rem; overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; line-height: 1.05; }
button { font: inherit; padding: .7rem 1.2rem; border-radius: .4rem; border: 1px solid #2f6f4f; background: #1d4b36; color: #eafff4; cursor: pointer; }
button[disabled] { opacity: .5; cursor: default; }
.rodape { color: #6f7880; font-size: .8rem; }
`.trim()

/**
 * Molde comum. Um so sitio a decidir `<!doctype>`, `lang`, `viewport` e CSP.
 *
 * `script: ''` NAO emite um `<script>` vazio: emite ZERO elementos de script. A
 * pagina do segredo nao tem uma linha de JavaScript, e a diferenca e visivel --
 * um `<script>` vazio convida a proxima pessoa a "aproveitar que ja esta la".
 */
function renderDocument(input: {
  readonly nonce: string
  readonly title: string
  readonly body: string
  readonly script: string
}): string {
  const scriptBlock =
    input.script.length === 0
      ? ''
      : `\n<script nonce="${escapeHtml(input.nonce)}">${input.script}</script>`

  return `<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(input.title)}</title>
<style nonce="${escapeHtml(input.nonce)}">${STYLE}</style>
</head>
<body>
<main>
${input.body}
</main>${scriptBlock}
</body>
</html>
`
}

/* ========================================================================== */
/* Painel                                                                     */
/* ========================================================================== */

/**
 * O painel NAO leva a URL do tunel embutida no HTML, e isso e desenho e nao
 * acaso: (a) o HTML servido fica com ZERO ocorrencias de `https://`, o que torna
 * a asercao "nenhum recurso externo" verificavel por `grep` sem falso positivo;
 * (b) a URL entra no DOM por `textContent`, que nao interpreta marcacao --
 * interpolar a URL no HTML seria uma injecao a espera de um dia mau.
 *
 * SEM BOTOES DE LIGA/DESLIGA. Isso e T5.3, na Onda 5. O `<meta>` com o token
 * anti-CSRF ja vai aqui porque e o que essa sub-tarefa vai consumir, e emiti-lo
 * agora nao abre superficie nenhuma: sem rota de mutacao, ele nao destranca nada.
 */
export function renderPanelPage(input: { readonly nonce: string; readonly csrfToken: string }): string {
  const body = `<h1>DSH · painel</h1>
<meta name="dsh-csrf" content="${escapeHtml(input.csrfToken)}">
<section class="cartao">
  <p class="estado" id="estado">…</p>
  <div class="linha"><span>túnel</span><span class="valor" id="url">—</span></div>
  <div class="linha"><span>tentativas</span><span class="valor" id="tentativas">—</span></div>
  <div class="linha"><span>expira</span><span class="valor" id="expira">—</span></div>
  <p class="erro" id="falha" hidden></p>
</section>
<p class="rodape" id="rodape">a atualizar a cada 2 s</p>`

  const script = `
const ROTULOS = ${jsonForScript(TUNNEL_STATE_LABEL)};
const elEstado = document.getElementById('estado');
const elUrl = document.getElementById('url');
const elTentativas = document.getElementById('tentativas');
const elExpira = document.getElementById('expira');
const elFalha = document.getElementById('falha');
const elRodape = document.getElementById('rodape');
let vivo = true;

function parar(mensagem) {
  vivo = false;
  elRodape.textContent = mensagem;
  elRodape.className = 'rodape aviso';
}

function pintar(s) {
  const rotulo = Object.prototype.hasOwnProperty.call(ROTULOS, s.state) ? ROTULOS[s.state] : s.state;
  elEstado.textContent = rotulo;
  elUrl.textContent = s.info && typeof s.info.url === 'string' ? s.info.url : '—';
  elTentativas.textContent = String(s.attempts);
  elExpira.textContent = typeof s.expiresAt === 'number' ? new Date(s.expiresAt).toLocaleString() : '—';
  if (s.failure && typeof s.failure.message === 'string') {
    elFalha.textContent = s.failure.message;
    elFalha.hidden = false;
  } else {
    elFalha.textContent = '';
    elFalha.hidden = true;
  }
}

async function tick() {
  if (!vivo) return;
  let resposta;
  try {
    resposta = await fetch('/__guard/api/state', { credentials: 'same-origin', headers: { accept: 'application/json' } });
  } catch (erro) {
    elRodape.textContent = 'sem ligação ao servidor';
    return;
  }
  if (resposta.status === 401) { parar('sessão expirada — entre outra vez'); return; }
  if (!resposta.ok) { elRodape.textContent = 'o servidor não respondeu ao estado'; return; }
  try {
    pintar(await resposta.json());
    elRodape.textContent = 'a atualizar a cada 2 s';
    elRodape.className = 'rodape';
  } catch (erro) {
    elRodape.textContent = 'resposta de estado ilegível';
  }
}

tick();
setInterval(tick, 2000);
`.trim()

  return renderDocument({ nonce: input.nonce, title: 'DSH · painel', body, script })
}

/* ========================================================================== */
/* Link magico -- a pagina INERTE                                             */
/* ========================================================================== */

/**
 * A pagina que o `GET /__guard/magic` serve.
 *
 * ELA NAO CONSOME NADA, e a razao esta no modo de falha e nao no gosto: um link
 * enviado por Telegram e PRE-CARREGADO pelo pre-visualizador do proprio
 * Telegram, por scanners de antiphishing e por clientes de e-mail. Se o `GET`
 * queimasse o `mk`, o link morria antes de o dono lhe tocar e ele veria "link
 * invalido" num link que nunca usou. O consumo e o `POST`, disparado por um
 * CLIQUE explicito -- e o clique e o unico sinal que distingue o dono de um
 * robo que segue hiperligacoes.
 *
 * O `mk` chega no FRAGMENTO (`#`), que o navegador NAO envia ao servidor: por
 * isso esta pagina nao o recebe do lado do servidor e tem de o ler do
 * `location.hash`. E tambem por isso o `mk` nunca aparece num log de servidor
 * nem num `Referer`.
 */
export function renderMagicPage(input: {
  readonly nonce: string
  readonly magicCsrf: string
  readonly loginCsrf: string
}): string {
  const body = `<h1>DSH · entrar</h1>
<meta name="dsh-csrf" content="${escapeHtml(input.magicCsrf)}">
<meta name="dsh-csrf-login" content="${escapeHtml(input.loginCsrf)}">
<section class="cartao">
  <p id="mensagem">Toque no botão para entrar. Este link vale uma única vez.</p>
  <p><button id="entrar" type="button">Entrar</button></p>
</section>`

  const script = `
const CSRF = document.querySelector('meta[name="dsh-csrf"]').content;
const botao = document.getElementById('entrar');
const mensagem = document.getElementById('mensagem');

function tokenDoFragmento() {
  const bruto = window.location.hash;
  return bruto.length > 1 ? bruto.slice(1) : '';
}

if (tokenDoFragmento() === '') {
  mensagem.textContent = 'Este endereço precisa do link completo enviado pelo bot.';
  botao.disabled = true;
}

botao.addEventListener('click', async () => {
  const mk = tokenDoFragmento();
  if (mk === '') return;
  botao.disabled = true;
  mensagem.textContent = 'A entrar…';
  const corpo = new URLSearchParams();
  corpo.set('mk', mk);
  corpo.set('csrf', CSRF);
  let resposta;
  try {
    resposta = await fetch('/__guard/magic', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-dsh-csrf': CSRF },
      body: corpo.toString(),
    });
  } catch (erro) {
    mensagem.textContent = 'Sem ligação ao servidor.';
    botao.disabled = false;
    return;
  }
  if (resposta.ok) {
    window.location.replace('/__guard');
    return;
  }
  mensagem.textContent = 'Este link já não é válido. Peça outro ao bot.';
});
`.trim()

  return renderDocument({ nonce: input.nonce, title: 'DSH · entrar', body, script })
}

/* ========================================================================== */
/* Segredo -- a segunda (e ultima) vez que ele aparece                        */
/* ========================================================================== */

/**
 * A pagina de `GET /__guard/secret?ott=<token>`.
 *
 * `secretPanel` e a saida de `renderSecretPanel()` de T2.1: o segredo agrupado
 * MAIS o QR, na mesma tela. Nao se remonta nada aqui -- o agrupamento e a
 * polaridade do QR sao decisoes daquele modulo, e duplicar o desenho era ficar
 * com duas telas que divergem.
 *
 * O `<pre>` tem fundo PRETO de proposito: `renderQrAscii` desenha para fundo
 * escuro por omissao (o glifo claro e o modulo claro). Sobre fundo branco a
 * polaridade inverte e muitos leitores de QR deixam de ler.
 *
 * SEM `<script>` COM DADOS: o segredo entra por texto escapado e mais nada. Ele
 * aparece nesta resposta HTTP e em sitio nenhum alem dela -- nem em log, nem em
 * mensagem de erro, nem em rasto de pilha.
 */
export function renderSecretPage(input: {
  readonly nonce: string
  readonly secretPanel: string
}): string {
  const body = `<h1>DSH · senha</h1>
<section class="cartao">
  <p class="aviso">Mostrada uma única vez. Este endereço deixou de existir neste instante.</p>
  <pre>${escapeHtml(input.secretPanel)}</pre>
  <p class="rodape">Guarde-a agora. Para a substituir, use a rotação — ela invalida as sessões vivas.</p>
</section>`

  return renderDocument({ nonce: input.nonce, title: 'DSH · senha', body, script: '' })
}
