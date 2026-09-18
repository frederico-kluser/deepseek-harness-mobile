/**
 * Pins do PAINEL do túnel na aba "Remote Access" (sub-tarefa 1.2), verificados
 * no ARTEFACTO compilado `lib/client.js` — a mesma fidelidade de smoke do
 * index.test.ts (o repo não monta React nos testes; `react` não é dependência
 * e os componentes do cartão são internos ao bundle). Cada pin falsifica uma
 * cláusula do contrato do usuário que os helpers puros sozinhos não provam:
 *
 *  F6 — as TRANSIÇÕES por estado: o gating EXATO dos 3 botões (Ligar só em
 *       STOPPED; Desligar em STARTING/READY/DEGRADED; Repor só em FAILED),
 *       o tom do chip por estado, a URL como <code> SÓ em READY (dupla
 *       checagem client) e `tentativas:` só com estado presente.
 *  6b. O CICLO de atualização: poll ~5s (o recarregarTudo inclui a GET /state),
 *       ticker de 1s (o countdown anda) e re-busca em focus/visibilitychange.
 *  6c. O LIGAR/REPOR de 2 etapas: a validação EXATA do passo 1 (200 &&
 *       passo==='confirmar' && nonce string), o nonce OPACO no ref, o confirm
 *       com {nonce}, o /stop sem nonce, o refresco SÓ no 200, o
 *       anti-duplo-clique e o Cancelar que descarta o nonce.
 *  6d. A falha {codigo,mensagem} PRECEDE a nota (nunca os dois).
 *  7.  As instruções do bot: o filtro de passos bem-formados (children puros).
 *  8.  O CSRF indisponível tratado em TODOS os SEIS fluxos POST do painel
 *       (túnel abrir, túnel confirmar, passos, token, pair, agentes).
 *  9.  O apply é a ÚNICA contribuição de UI: settings.section (order 99,
 *       id telegram-guard) e NADA na home.
 *  10. guard-panel.css: TODAS as classes guard-* e SÓ tokens --dsw-*.
 *  11. O espelho client.d.ts declara a superfície do TÚNEL (tipos + helpers).
 *
 * As assertions são SUBSTRINGS ASCII-ONLY do bundle (o esbuild foge os acentos
 * — ex. "indispon\xEDvel") e as expressões compiladas com minify:false, que
 * preserva os nomes do fonte verbatim.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'

import { ROOT, BUNDLE_AUSENTE, lerBundle } from './apoio.ts'

const CSS_PATH = resolve(ROOT, 'client/guard-panel.css')
const ESPELHO_PATH = resolve(ROOT, 'client/client.d.ts')
const FONTE_PATH = resolve(ROOT, 'client/index.ts')

/* ========================================================================== */
/* (6b) O CICLO DE ATUALIZAÇÃO — poll 5s, ticker 1s, focus/visibilitychange    */
/* ========================================================================== */

test('painel túnel (bundle): o poll de ~5s alimenta a projeção, o ticker de 1s anda o countdown e focus/visibility re-buscam', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // O poll de ~5s tem de ser o RECARREGAR TUDO (a GET /state entra nele —
  // ver o teste das rotas no index.test.ts), não uma consulta solta.
  assert.ok(
    codigo.includes('window.setInterval(() => {\n      void recarregarTudo();\n    }, 5e3);'),
    'o refresh de ~5 s recarrega TUDO (inclui a projeção do túnel /state)',
  )
  // O ticker de 1s alimenta `agora` — o countdown "expira em Xs" anda sem
  // nova rede (o CartaoTunel recebe props.agora).
  assert.ok(
    codigo.includes('window.setInterval(() => setAgora(Date.now()), 1e3)'),
    'o ticker de 1s re-render (contagem do túnel e do pareamento)',
  )
  // Re-busca em focus e em visibilitychange (voltar à aba refresca o estado).
  assert.ok(codigo.includes('window.addEventListener("focus", aoFocus)'), 're-busca em focus')
  assert.ok(codigo.includes('document.addEventListener("visibilitychange", aoVisivel)'), 're-busca em visibilitychange')
  assert.ok(
    codigo.includes('if (document.visibilityState === "visible") void recarregarTudo();'),
    'só re-busca quando a aba fica VISÍVEL (não em background)',
  )
  // E a limpeza dos listeners no unmount (sem vazamento entre remontagens).
  assert.ok(codigo.includes('window.removeEventListener("focus", aoFocus)'), 'unfocus limpo no unmount')
  assert.ok(codigo.includes('document.removeEventListener("visibilitychange", aoVisivel)'), 'unvisibilitychange limpo')
})

/* ========================================================================== */
/* (6) TRANSIÇÕES POR ESTADO — gating dos 3 botões + chip + linhas             */
/* ========================================================================== */

test('painel túnel (bundle): o gating EXATO dos 3 botões por estado (F6)', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // As três expressões EXATAS de habilitação (contrato F6): Ligar SÓ em
  // STOPPED (2 etapas); Desligar em STARTING/READY/DEGRADED (confirmação,
  // sem nonce); Repor SÓ em FAILED (CTL-012). O `props.emVoo` desabilita os
  // três durante qualquer POST do túnel (anti-duplo-intent).
  const ligar = 'disabled: props.emVoo || estado !== "STOPPED",'
  const desligar = 'disabled: props.emVoo || !(estado === "STARTING" || estado === "READY" || estado === "DEGRADED"),'
  const repor = 'disabled: props.emVoo || estado !== "FAILED",'
  for (const expr of [ligar, desligar, repor]) {
    assert.equal(codigo.split(expr).length - 1, 1, `a expressão aparece EXATAMENTE uma vez: ${expr}`)
  }

  // A expressão está LIGADA ao botão certo (índice da expressão precede o
  // rótulo do botão, no mesmo bloco — não uma expressão órfã). Os rótulos
  // aparecem no bundle ESCAPADOS pelo esbuild (\xFA = ú, \xF3 = ó) — os pins
  // usam a forma EMITIDA literal (backslash duplo na fonte do teste).
  const bind = (expr: string, rotulo: string): void => {
    const iExpr = codigo.indexOf(expr)
    const iRotulo = codigo.indexOf(rotulo, iExpr)
    assert.ok(iRotulo > iExpr && iRotulo - iExpr < 200, `a expressão "${expr.slice(10, 40)}…" precede o botão "${rotulo}"`)
  }
  bind(ligar, '"Ligar t\\xFAnel"')
  bind(desligar, '"Desligar t\\xFAnel"')
  bind(repor, '"Repor (ap\\xF3s falha)"')

  // Nenhum botão do túnel acorda num estado errado: o Desligar NÃO acorda em
  // STOPPING/FAILED/STOPPED e o Repor NUNCA em DEGRADED (o literal fecha os
  // três conjuntos — a asserção acima já é a fidelidade; aqui fica o pin do
  // que NÃO pode existir: gating que ligasse o Repor em DEGRADED).
  assert.ok(!codigo.includes('estado === "DEGRADED" || estado !== "FAILED"'), 'gating do Repor não foi alargado')
})

test('painel túnel (bundle): o chip toma o tom por estado e as linhas só com dado real', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // O tom do chip segue a semântica do contrato: READY verde, DEGRADED
  // aviso, FAILED vermelho, os demais neutros.
  assert.ok(
    codigo.includes(
      'const tomChip = estado === "READY" ? " guard-chip-success" : estado === "DEGRADED" ? " guard-chip-warning" : estado === "FAILED" ? " guard-chip-error" : "";',
    ),
    'o tom do chip é o ternário EXATO do contrato',
  )
  // O rótulo do chip vem do helper dos SEIS estados (nunca um literal solto).
  assert.ok(codigo.includes('rotuloDeEstadoTunel(estado)'), 'o chip usa rotuloDeEstadoTunel(estado)')

  // A URL é <code> SÓ em READY — dupla checagem client (o backend já omite
  // fora de READY; o cliente não confia, verifica).
  assert.ok(
    codigo.includes(
      'const url = estado === "READY" && typeof props.tunel?.url === "string" && props.tunel.url.length > 0 ? props.tunel.url : null;',
    ),
    'a URL só renderiza em READY, string não-vazia',
  )
  assert.ok(codigo.includes('url !== null ? h("code", { className: "guard-tunnel-url" }, url) : null'), 'a URL é <code> com children')

  // A linha de expiração vem do helper puro (ceil, teto zero — já exercitado
  // no index.test.ts) alimentado por props.tunel?.expiraEm.
  assert.ok(codigo.includes('const expira = linhaExpiraTunel(props.tunel?.expiraEm, props.agora);'))

  // "tentativas:" só quando HÁ estado (props.tunel !== null) — o 503
  // sem-estado não pode inventar uma linha de projeção.
  assert.ok(
    codigo.includes('props.tunel !== null ? paragrafo("guard-muted", `tentativas: ${String(props.tunel.tentativas)}`) : null'),
    'a linha "tentativas:" existe SÓ com estado projetado',
  )

  // O estado vem do payload SEM default inventado: nunca `?? "STOPPED"` /
  // `?? "desligado"` (o 503 sem-estado mostra "—" honesto).
  const estado = codigo.indexOf('const estado = props.tunel?.estado;')
  assert.ok(estado > 0, 'o estado do cartão vem do payload, sem default')
  assert.ok(!codigo.includes('?? "desligado"'), 'nenhum "desligado" inventado por default')
  assert.ok(!codigo.includes('?? "STOPPED"'), 'nenhum estado inventado por default')
})

test('painel túnel (bundle): a falha {codigo,mensagem} PRECEDE a nota (nunca os dois)', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // A expressão compilada inteira: falha.mensagem primeiro; a nota só entra
  // SE a falha não valer (precedência do script antigo).
  const i = codigo.indexOf('const mensagemFalha =')
  assert.ok(i > 0, 'a linha da mensagem falha/nota existe no cartão')
  const linha = codigo.slice(i, codigo.indexOf('\n', i))
  const iFalha = linha.indexOf('typeof falha.mensagem === "string"')
  const iNota = linha.indexOf('typeof props.tunel?.nota === "string"')
  assert.ok(iFalha > 0 && iNota > iFalha, 'a falha é o PRIMEIRO ramo e a nota o fallback (falha precede nota)')
  assert.ok(
    codigo.includes('falha !== null && falha !== void 0 && typeof falha.mensagem === "string" && falha.mensagem.length > 0 ? falha.mensagem : typeof props.tunel?.nota === "string" && props.tunel.nota.length > 0 ? props.tunel.nota : null'),
    'o ternário falha→nota é EXATAMENTE o contrato (guard-error vermelho)',
  )
})

/* ========================================================================== */
/* (6c) O LIGAR/REPOR de 2 etapas — validação do nonce e recusas honestas      */
/* ========================================================================== */

test('painel túnel (bundle): o passo 1 valida EXATAMENTE 200 && passo==="confirmar" && nonce string não-vazia', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // A validação EXATA do contrato (o nonce só é aceite com a resposta
  // completa: 200 + passo 'confirmar' + nonce string não-vazia).
  assert.ok(
    codigo.includes('if (r.status === 200 && r.dados.passo === "confirmar" && typeof nonce === "string" && nonce.length > 0) {'),
    'a validação do passo 1 é a exata do contrato',
  )
  // O nonce viaja OPACO no ref (o client não o lê nem o valida) e a caixa abre.
  assert.ok(codigo.includes('nonceTunelRef.current = nonce;'), 'o nonce guarda-se no ref')
  assert.ok(codigo.includes('setConfirmacaoTunel(acao);'), 'a caixa guard-confirm abre com a ação')
  // O passo 1 é o POST /start (LIGAR) ou /reset (REPOR), corpo {}.
  assert.ok(codigo.includes('const r = await apiPost(acao === "ligar" ? "/start" : "/reset", {}, document);'))
})

test('painel túnel (bundle): o passo 2 — /stop sem nonce; confirms com {nonce}; refresco SÓ no 200', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // DESLIGAR: POST /stop com corpo {} — SEM nonce (CTL-024).
  assert.ok(codigo.includes('r = await apiPost("/stop", {}, document);'), 'o desligar é POST /stop SEM nonce')
  // LIGAR/REPOR: o confirm com o nonce no corpo; sem nonce no ref → recusa
  // local (o POST nem sai).
  assert.ok(
    codigo.includes(
      'r = nonce !== null ? await apiPost(acao === "ligar" ? "/start/confirm" : "/reset/confirm", { nonce }, document) : { status: 0, dados: {}, csrfIndisponivel: true };',
    ),
    'o confirm leva {nonce} e a ausência dele recusa localmente',
  )
  // O nonce e a caixa são descartados ANTES de tratar o resultado — um
  // NÃOCE-EXPIRADO (409 motivo) ou um CSRF indisponível não deixam um nonce
  // velho reutilizável na tela.
  const iConfirmar = codigo.indexOf('const acao = confirmacaoTunel;')
  const iDescarta = codigo.indexOf('nonceTunelRef.current = null;', iConfirmar)
  const iCsrf = codigo.indexOf('if (r.csrfIndisponivel) {', iConfirmar)
  assert.ok(iConfirmar > 0 && iDescarta > iConfirmar && iCsrf > iDescarta, 'o descarte do nonce precede o tratamento do resultado')
  assert.ok(codigo.includes('setConfirmacaoTunel(null);'), 'a caixa fecha em qualquer resultado')

  // O refresco imediato da projeção acontece SÓ no 200 — um 409 "nonce
  // expirado" NÃO refresca (o estado na tela é o último honesto) e mostra o
  // motivo acionável TAL QUAL (mensagemDeErroTunel — já exercitado nos
  // literais no index.test.ts).
  assert.ok(
    codigo.includes('if (r.status === 200) {\n      setTunelErro(null);\n      await buscarTunel();\n      return;\n    }'),
    'o refresco da projeção acontece SÓ no 200',
  )
  assert.equal(codigo.split('setTunelErro(mensagemDeErroTunel(r))').length - 1, 2, 'o motivo do erro do túnel é mostrado nos DOIS pontos (passo 1 e passo 2)')

  // ANTI-DUPLO-CLIQUE do Confirmar: guarda síncrona + desabilita + só volta
  // no finally (o segundo POST com o MESMO nonce morreria em nonce inválido).
  assert.ok(codigo.includes('if (confirmandoTunel) return;'), 'a guarda síncrona do Confirmar')
  assert.ok(codigo.includes('setConfirmandoTunel(true);'), 'o Confirmar trava no 1.º clique')
  assert.ok(
    codigo.includes('void confirmarTunel().finally(() => {\n      if (vivo.current) setConfirmandoTunel(false);\n    });'),
    'o Confirmar só re-habilita quando a resposta chega',
  )

  // O CANCELAR da caixa descarta o nonce pendente (com a guarda de voo).
  assert.ok(
    codigo.includes('aoCancelar: () => {\n      if (confirmandoTunel) return;\n      nonceTunelRef.current = null;\n      setConfirmacaoTunel(null);\n    }'),
    'o cancelar descarta o nonce pendente com a caixa',
  )
})

/* ========================================================================== */
/* (7) AS INSTRUÇÕES DO BOT — filtro de passos bem-formados, children puros    */
/* ========================================================================== */

test('painel túnel (bundle): as instruções do bot filtram passos mal-formados e abrem em children', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // O clique é um POST (escrita, com CSRF): /telegram/click com corpo {}.
  assert.ok(codigo.includes('const r = await apiPost("/telegram/click", {}, document);'))

  // Resposta fora do contrato (status ≠ 200 OU passos não-array) → mensagem
  // vermelha (o motivo do backend tal qual), nunca render do lixo.
  assert.ok(
    codigo.includes('if (r.status !== 200 || !Array.isArray(r.dados.passos)) {\n        setPassosErro(mensagemDeErroTunel(r));\n        return;\n      }'),
    'passos ausentes/fora de formato → mensagem, nunca render',
  )
  // SÓ passos BEM-FORMADOS entram no estado — um item malformado do host
  // nunca derruba o painel (filtro titulo/texto strings).
  assert.ok(
    codigo.includes('(p) => p !== null && typeof p === "object" && typeof p.titulo === "string" && typeof p.texto === "string"'),
    'o filtro de bem-formação dos passos',
  )
  assert.ok(codigo.includes('setPassosBot(passos);\n      setPassosAbertos(true);'), 'os passos filtrados abrem o <details>')

  // O vazio honesto (o servidor respondeu 200 sem passos) e os passos como
  // CHILDREN de React (texto puro — a doutrina anti-innerHTML já é pinada no
  // index.test.ts; aqui fica a ligação título/texto → classes guard-tunnel-*).
  assert.ok(codigo.includes('devolveu passos.'), 'o vazio "O servidor não devolveu passos."')
  assert.ok(codigo.includes('{ className: "guard-tunnel-passo", key: i }'))
  assert.ok(codigo.includes('h("p", { className: "guard-tunnel-passo-titulo" }, passo.titulo)'))
  assert.ok(codigo.includes('h("p", { className: "guard-tunnel-passo-texto" }, passo.texto)'))
})

/* ========================================================================== */
/* (8) CSRF indisponível nos SEIS fluxos POST do painel                        */
/* ========================================================================== */

test('painel túnel (bundle): o CSRF indisponível é tratado em TODOS os seis fluxos POST', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // SEIS fluxos POST na superfície: túnel-passo1 (/start|/reset), túnel-passo2
  // (/stop|/confirms), passos do bot, token, pair e agentes-cancel. CADA um
  // trata `csrfIndisponivel` com a MESMA mensagem clara — a contagem EXATA
  // falsifica "falta o tratamento em algum fluxo".
  const mensagem = 'CSRF indispon'
  assert.equal(codigo.split(mensagem).length - 1, 6, 'a mensagem clara aparece nos 6 fluxos (nenhum a menos)')
  assert.equal(codigo.split('r.csrfIndisponivel').length - 1, 6, 'cada fluxo consulta a marca da recusa')

  // Os 6 receptáculos: agentes, túnel ×2, passos, pair, token.
  assert.ok(codigo.includes('setAgentesErro("CSRF indispon'), 'fluxo agentes (/agents/:id/cancel)')
  assert.equal(codigo.split('setTunelErro("CSRF indispon').length - 1, 2, 'fluxo túnel nos DOIS pontos (passo 1 e passo 2)')
  assert.ok(codigo.includes('setPassosErro("CSRF indispon'), 'fluxo passos (/telegram/click)')
  assert.ok(codigo.includes('mensagem: "CSRF indispon'), 'fluxo pair (/pair)')
  assert.ok(codigo.includes('texto: "CSRF indispon'), 'fluxo token (/token)')
})

/* ========================================================================== */
/* (9) O apply é a ÚNICA contribuição de UI (F9 — a home não ganha nada)       */
/* ========================================================================== */

test('painel túnel (bundle): o apply regista SÓ a aba settings.section (order 99) e injeta o CSS', { skip: BUNDLE_AUSENTE }, () => {
  const codigo = lerBundle()

  // UMA ÚNICA chamada de slot.inject no bundle inteiro — a aba das settings é
  // a ÚNICA contribuição de UI do plugin no shell (nada na home).
  assert.equal(codigo.split('.inject(').length - 1, 1, 'UMA única chamada ctx.slots.inject no bundle')

  // O registro é o objeto EXATO do contrato (id ASCII, order 99, label e
  // registrant).
  assert.ok(
    codigo.includes(
      '{\n        name: "settings.section",\n        id: "telegram-guard",\n        order: 99,\n        label: "Remote Access",\n        registrant: "dsh-guard-messenger"\n      }',
    ),
    'o objeto de registro é o exato: order 99, id telegram-guard, label "Remote Access"',
  )

  // O CSS do painel entra por textContent num <style> idempotente (nunca
  // innerHTML; a segunda montagem não duplica).
  assert.ok(codigo.includes('var CSS_ID = "dsh-guard-panel-css";'))
  assert.ok(codigo.includes('estilo.textContent = guard_panel_default;'), 'o CSS entra por textContent')
  assert.ok(codigo.includes('guard_panel_default.length === 0) return;'), 'a injeção é idempotente e salta CSS vazio')

  // Nenhum resquício do chrome antigo da HOME no bundle client (o div/meta do
  // chrome morreram; API_BASE usa __guard-ui, sem o prefixo dsh-).
  assert.ok(!codigo.includes('dsh-guard-ui'), 'o antigo div/meta "dsh-guard-ui" da home não existe no bundle')
  assert.ok(!codigo.includes('index.html'), 'o bundle não toca o index.html da home')
})

/* ========================================================================== */
/* (10) guard-panel.css — namespacing guard-* e SÓ tokens --dsw-*              */
/* ========================================================================== */

test('client/guard-panel.css: TODAS as classes são guard-* e SÓ tokens --dsw-* (namespacing)', () => {
  const css = readFileSync(CSS_PATH, 'utf8')
  // Sem comentários (a doc cita seletivos do shell — .options, .title — em
  // comentários; só o CSS EFETIVO conta).
  const semComentarios = css.replace(/\/\*[\s\S]*?\*\//gu, '')

  const classes = [...semComentarios.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/gu)].flatMap((m) =>
    typeof m[1] === 'string' ? [m[1]] : [],
  )
  assert.ok(classes.length >= 80, `esperava as classes do painel, achei ${classes.length}`)
  const estranhas = [...new Set(classes)].filter((c) => !c.startsWith('guard-'))
  assert.deepEqual(
    estranhas,
    [],
    `TODAS as classes do guard-panel.css são namespaced guard-*; fora do padrão: ${estranhas.join(', ')}`,
  )

  // SÓ tokens do design system (--dsw-*) — nenhuma cor/literal próprio.
  const vars = [...semComentarios.matchAll(/var\((--[a-zA-Z0-9-]+)\)/gu)].flatMap((m) =>
    typeof m[1] === 'string' ? [m[1]] : [],
  )
  assert.ok(vars.length > 0, 'o CSS consome tokens do design system')
  const fora = [...new Set(vars)].filter((v) => !v.startsWith('--dsw-'))
  assert.deepEqual(fora, [], `só tokens --dsw-*; fora do padrão: ${fora.join(', ')}`)

  // E o CSS EFETIVO está embutido no bundle (a string que o apply injeta).
  const codigo = lerBundle()
  assert.ok(codigo.includes('var guard_panel_default = `'), 'o CSS é embebido como template string no bundle')
  assert.ok(codigo.includes('.guard-tunnel'), 'o CSS do cartão Túnel está no bundle')
  assert.ok(codigo.includes('dsh-guard-panel-css'), 'o id do <style> do painel está no bundle')
})

/* ========================================================================== */
/* (11) O espelho client.d.ts declara a superfície do TÚNEL                    */
/* ========================================================================== */

test('client.d.ts (espelho): a superfície do TÚNEL declarada com o MESMO shape do fonte', () => {
  const fonte = readFileSync(FONTE_PATH, 'utf8')
  const espelho = readFileSync(ESPELHO_PATH, 'utf8')

  // O union FECHADO dos seis estados — os MESMOS literais, na MESMA ordem.
  assert.match(
    espelho,
    /export type EstadoTunel = 'STOPPED' \| 'STARTING' \| 'READY' \| 'DEGRADED' \| 'STOPPING' \| 'FAILED'/u,
    'o union dos seis estados no espelho',
  )

  // O corpo de GET /state: seq/estado/tentativas + url?/expiraEm? SÓ-READY +
  // falha{codigo,mensagem}|null + nota|null — o espelho NÃO pode afrouxar o
  // shape do backend (o "—" honesto depende de expiraEm/falha/nota
  // precisos).
  assert.match(espelho, /export interface EstadoProjetado \{/u)
  assert.match(espelho, /readonly seq: number/u)
  assert.match(espelho, /readonly estado: EstadoTunel/u)
  assert.match(espelho, /readonly tentativas: number/u)
  assert.match(espelho, /readonly url\?: string \| undefined/u)
  assert.match(espelho, /readonly expiraEm\?: number \| undefined/u)
  assert.match(
    espelho,
    /readonly falha: \{ readonly codigo: string; readonly mensagem: string \} \| null/u,
    'a falha {codigo,mensagem}|null no espelho',
  )
  assert.match(espelho, /readonly nota: string \| null/u, 'a nota|null no espelho')

  // Os TRÊS helpers do túnel + a superfície HTTP do CSRF, com assinatura.
  assert.match(espelho, /export function rotuloDeEstadoTunel\(estado: unknown\): string/u)
  assert.match(
    espelho,
    /export function linhaExpiraTunel\(expiraEm: number \| undefined \| null, agoraMs: number\): string \| null/u,
  )
  assert.match(
    espelho,
    /export function mensagemDeErroTunel\(resposta: \{\s*readonly status: number\s*readonly dados: Record<string, unknown>\s*\}\): string/u,
  )
  assert.match(espelho, /export function buscarTokenCsrf\(documento: Document\): Promise<string>/u)
  assert.match(
    espelho,
    /export function apiPost\(caminho: string, corpo: Record<string, unknown>, documento: Document\): Promise<RespostaPost>/u,
  )
  assert.match(espelho, /export interface RespostaPost \{[\s\S]*readonly csrfIndisponivel: boolean/u)

  // E o FONTE continua sendo a fonte de verdade: os exports do túnel existem
  // lá (a viagem fonte → espelho do build-client.mjs).
  for (const nome of ['EstadoTunel', 'EstadoProjetado', 'rotuloDeEstadoTunel', 'linhaExpiraTunel', 'mensagemDeErroTunel']) {
    assert.ok(
      new RegExp(`export (?:async )?(?:function|const|type|interface)\\s+${nome}\\b`, 'u').test(fonte),
      `o fonte deve exportar ${nome}`,
    )
  }
})