/**
 * O ponto de contribuicao de UI nativa do DSH — mecanismo `tapIndex` medido
 * pelo spike S4 (`docs/spikes/superficie-ui.md` 4.1): um transform
 * `(html) => html` registado em `ctx.webServer.tapIndex`, executado pelo dono
 * do assento de fallback (`applyIndexTaps`) em TODA resposta de indice.
 *
 * A regra que o spike gravou na pedra: quem servir indice continua obrigado a
 * chamar `applyIndexTaps`, sob pena de matar em silencio os dois taps do host
 * (`__DSH_BOOT__` do client-modules e o tema do ui-theme). Este tap so
 * ACRESCENTA marcacao antes de `</body>` — nunca toca no resto do documento —
 * e e reversivel pelo disposer.
 *
 * O que se injeta:
 *
 *   1. Um bloco com os botoes de LIGAR / DESLIGAR e a area de STATUS, todo
 *      com ids no espaco `dsh-guard-ui-*` — unico o suficiente para nao
 *      colidir com a SPA React do DSH.
 *   2. Um `<meta name="dsh-guard-ui-csrf">` com o token anti-CSRF emitido
 *      NESTA render (a pagina que o atacante nao consegue ler e a mesma que
 *      destrava os POSTs — ver `csrf.ts`).
 *   3. `<script src="/__guard-ui/client.js" defer>` — o script da superficie
 *      como recurso EXTERNO, e nao inline. Dois motivos: (a) um CSP de
 *      script-src sem `'unsafe-inline'` na pagina bloquearia um script
 *      inline em silencio, e um recurso proprio normalmente passa; (b) o
 *      script nao muda entre renders e nao precisa de viajar no indice.
 *
 * A URL DO TUNEL NUNCA entra neste HTML — a mesma doutrina do painel
 * (`src/panel/html.ts`): o indice servido fica com ZERO ocorrencias de
 * `https://`, e a URL entra no DOM por `textContent` (que nao interpreta
 * marcacao), vinda da rota de estado. Interpolar a URL no HTML seria uma
 * injecao a espera de um dia mau.
 */

import type { CsrfGuard } from './csrf.ts'

/** Marca de presenca do bloco; e tambem o que torna o tap idempotente por documento. */
export const CHROME_MARKER = 'id="dsh-guard-ui"'

export function escapeHtml(texto: string): string {
  return texto
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * O bloco injetado. `csrfToken` e o token desta render; `scriptSrc` e o
 * caminho absoluto do script da superficie.
 */
export function renderChrome(input: { readonly csrfToken: string; readonly scriptSrc: string }): string {
  const estiloBloco =
    'font-family: system-ui, sans-serif; font-size: 14px; margin: 16px 0; padding: 12px; ' +
    'border: 1px solid #00000022; border-radius: 8px; max-width: 480px;'
  return (
    `<div id="dsh-guard-ui" style="${estiloBloco}">` +
    '<p style="margin: 0 0 6px; font-weight: 600;">Túnel — controle do DSH</p>' +
    '<p style="margin: 0 0 4px;" id="dsh-guard-ui-estado">…</p>' +
    '<p style="margin: 0 0 4px; word-break: break-all;" id="dsh-guard-ui-url">—</p>' +
    '<p style="margin: 0 0 4px;" id="dsh-guard-ui-expira">—</p>' +
    '<p style="margin: 0 0 8px;" id="dsh-guard-ui-tentativas">—</p>' +
    '<p style="margin: 0 0 8px; color: #b3261e;" id="dsh-guard-ui-falha" hidden></p>' +
    '<p style="margin: 0 0 8px;">' +
    '<button type="button" id="dsh-guard-ui-ligar" disabled>Ligar túnel</button> ' +
    '<button type="button" id="dsh-guard-ui-desligar" disabled>Desligar túnel</button> ' +
    '<button type="button" id="dsh-guard-ui-repor" disabled>Repor (após falha)</button>' +
    '</p>' +
    '<div id="dsh-guard-ui-barra" hidden style="margin: 0 0 8px;">' +
    '<p style="margin: 0 0 4px;" id="dsh-guard-ui-texto"></p>' +
    '<button type="button" id="dsh-guard-ui-confirmar">Confirmar</button> ' +
    '<button type="button" id="dsh-guard-ui-cancelar">Cancelar</button>' +
    '</div>' +
    '<p style="margin: 0; color: #666666;" id="dsh-guard-ui-seq"></p>' +
    '</div>' +
    `<meta name="dsh-guard-ui-csrf" content="${escapeHtml(input.csrfToken)}">` +
    `<script src="${escapeHtml(input.scriptSrc)}" defer></script>`
  )
}

/**
 * O transform registado em `tapIndex`. Emite um token de CSRF NOVO a cada
 * render — o token nao e estado do servidor, e a pagina de um separador
 * esquecido morre com o prazo dele.
 */
export function createIndexTap(input: {
  readonly csrf: CsrfGuard
  /** O vinculo do token: a superficie inteira, nao uma rota. */
  readonly binding: string
  readonly scriptSrc: string
}): (html: string) => string {
  return (html: string): string => {
    if (typeof html !== 'string' || html.includes(CHROME_MARKER)) return html
    const token = input.csrf.issue(input.binding)
    const chrome = renderChrome({ csrfToken: token, scriptSrc: input.scriptSrc })
    const pos = html.lastIndexOf('</body>')
    if (pos === -1) return html + chrome
    return html.slice(0, pos) + chrome + html.slice(pos)
  }
}

/**
 * O script da superficie (`/__guard-ui/client.js`), como fonte.
 *
 * PROJECCAO no navegador: o script nao guarda estado — poe o relogio a correr
 * (poll de 2 s do estado, como o painel) e desenha a ultima projecao que o
 * servidor lhe deu. O unico "estado" do cliente e o nonce de confirmacao
 * entre o passo 1 e o passo 2 do LIGAR — e ele viaja OPACO (S5): o script nao
 * o le, nao o valida e nao o mostra; so o devolve no passo 2.
 *
 * DESAMBIGUACAO DE 03-ONDAS 10 escrita no texto do DESLIGAR: o botao desliga
 * o TUNEL; o DSH continua a correr em loopback, o bot e o painel nao sao
 * afetados.
 */
export function createClientScript(): string {
  return `(() => {
  'use strict';
  const ROTULOS = {
    STOPPED: 'desligado',
    STARTING: 'ligando',
    READY: 'online',
    DEGRADED: 'instável — tentando de novo',
    STOPPING: 'desligando',
    FAILED: 'falhou — precisa de ação sua',
  };
  const BASE = '/__guard-ui/api';
  const ID = {
    estado: 'dsh-guard-ui-estado',
    url: 'dsh-guard-ui-url',
    expira: 'dsh-guard-ui-expira',
    tentativas: 'dsh-guard-ui-tentativas',
    falha: 'dsh-guard-ui-falha',
    seq: 'dsh-guard-ui-seq',
    ligar: 'dsh-guard-ui-ligar',
    desligar: 'dsh-guard-ui-desligar',
    repor: 'dsh-guard-ui-repor',
    barra: 'dsh-guard-ui-barra',
    texto: 'dsh-guard-ui-texto',
    confirmar: 'dsh-guard-ui-confirmar',
    cancelar: 'dsh-guard-ui-cancelar',
  };
  const meta = document.querySelector('meta[name="dsh-guard-ui-csrf"]');
  const CSRF = meta ? meta.getAttribute('content') || '' : '';
  let passo = null;      // o nonce do LIGAR entre o passo 1 e o passo 2 — opaco
  let aConfirmar = null; // a acao pendente da barra de confirmacao

  function el(nome) { return document.getElementById(ID[nome]); }
  function texto(nome, valor) { const n = el(nome); if (n) n.textContent = valor; }
  function mostrar(nome, visivel) { const n = el(nome); if (n) n.hidden = !visivel; }

  async function pedir(caminho, corpo) {
    let resposta;
    try {
      resposta = await fetch(BASE + caminho, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-csrf': CSRF },
        body: corpo ? JSON.stringify(corpo) : '{}',
      });
    } catch (ignorado) {
      // Erro de rede: NUNCA uma rejeicao de promise nao tratada — o clique
      // devolve uma resposta legivel e a barra de confirmacao fecha.
      return { status: 0, dados: { motivo: 'rede falhou — tente de novo' } };
    }
    let dados = {};
    try { dados = await resposta.json(); } catch (ignorado) { /* corpo ilegivel */ }
    return { status: resposta.status, dados: dados };
  }

  function pintarEstado(s) {
    texto('estado', ROTULOS[s.estado] || s.estado);
    texto('url', typeof s.url === 'string' ? s.url : '—');
    if (typeof s.expiraEm === 'number') {
      const restante = Math.max(0, Math.ceil((s.expiraEm - Date.now()) / 1000));
      texto('expira', 'expira em ' + restante + ' s');
    } else {
      texto('expira', '—');
    }
    texto('tentativas', 'tentativas: ' + String(s.tentativas));
    texto('seq', 'atualização #' + String(s.seq));
    if (s.falha && typeof s.falha.mensagem === 'string') {
      texto('falha', s.falha.mensagem);
      mostrar('falha', true);
    } else if (typeof s.nota === 'string') {
      texto('falha', s.nota);
      mostrar('falha', true);
    } else {
      texto('falha', '');
      mostrar('falha', false);
    }
    const ligar = el('ligar');
    const desligar = el('desligar');
    const repor = el('repor');
    if (ligar) ligar.disabled = s.estado !== 'STOPPED';
    if (desligar) desligar.disabled = !(s.estado === 'STARTING' || s.estado === 'READY' || s.estado === 'DEGRADED');
    // W3: FAILED so sai por reset humano (CTL-012) — o botao so acorda nesse estado.
    if (repor) repor.disabled = s.estado !== 'FAILED';
  }

  function abrirConfirmacao(mensagem, acao) {
    aConfirmar = acao;
    texto('texto', mensagem);
    mostrar('barra', true);
  }

  function fecharConfirmacao() {
    aConfirmar = null;
    passo = null;
    mostrar('barra', false);
  }

  function tratarResultado(r) {
    const d = r.dados || {};
    fecharConfirmacao();
    if (r.status === 200) { tick(); return; }
    if (r.status === 409 && typeof d.motivo === 'string') {
      texto('falha', d.motivo);
      mostrar('falha', true);
      return;
    }
    texto('falha', d.motivo || 'o servidor não respondeu — recarregue a página');
    mostrar('falha', true);
  }

  async function tick() {
    let resposta;
    try {
      resposta = await fetch(BASE + '/state', { credentials: 'same-origin', headers: { accept: 'application/json' } });
    } catch (ignorado) {
      texto('seq', 'sem ligação ao servidor');
      return;
    }
    if (!resposta.ok) { texto('seq', 'o servidor não respondeu ao estado'); return; }
    try { pintarEstado(await resposta.json()); } catch (ignorado) { texto('seq', 'estado ilegível'); }
  }

  if (!el('ligar') || !el('desligar') || !el('repor') || !el('confirmar') || !el('cancelar')) return;

  el('ligar').addEventListener('click', async () => {
    const r = await pedir('/start', {});
    if (r.status !== 200 || r.dados.passo !== 'confirmar') { tratarResultado(r); return; }
    passo = r.dados.nonce; // opaco: so o host valida
    abrirConfirmacao('Ligar o túnel abre esta máquina à internet. Confirmar?', async () => {
      const c = await pedir('/start/confirm', { nonce: passo });
      passo = null;
      tratarResultado(c);
    });
  });

  // W3 (revisao T5.5): reset em FAILED — o mesmo fluxo de 2 etapas com
  // nonce opaco do LIGAR (CTL-012/023).
  el('repor').addEventListener('click', async () => {
    const r = await pedir('/reset', {});
    if (r.status !== 200 || r.dados.passo !== 'confirmar') { tratarResultado(r); return; }
    passo = r.dados.nonce;
    abrirConfirmacao('Repor o estado de falha e voltar a desligado? (o túnel permanece desligado)', async () => {
      const c = await pedir('/reset/confirm', { nonce: passo });
      passo = null;
      tratarResultado(c);
    });
  });

  el('desligar').addEventListener('click', () => {
    abrirConfirmacao('Desligar o TÚNEL? O DSH continua a correr em loopback; o bot e o painel não são afetados.', async () => {
      const c = await pedir('/stop', {});
      tratarResultado(c);
    });
  });

  el('confirmar').addEventListener('click', () => {
    if (!aConfirmar) return;
    // Duplo clique em Confirmar mandaria DOIS intents com o MESMO nonce (o
    // segundo morreria em NONCE_INVALIDO com um motivo enganador). O botao
    // desabilita no primeiro clique e so volta quando a resposta chegar.
    const confirmar = el('confirmar');
    confirmar.disabled = true;
    confirmar.textContent = 'a confirmar…';
    Promise.resolve(aConfirmar()).finally(() => {
      confirmar.disabled = false;
      confirmar.textContent = 'Confirmar';
    });
  });
  el('cancelar').addEventListener('click', fecharConfirmacao);

  tick();
  setInterval(tick, 2000);
})();
`
}
