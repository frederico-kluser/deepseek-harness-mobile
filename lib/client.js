window.__ModuleLoader__.load({
	id: "dsh-guard-messenger",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/index.ts
var index_exports = {};
__export(index_exports, {
  apiPost: () => apiPost,
  apply: () => apply,
  buscarTokenCsrf: () => buscarTokenCsrf,
  chipDoBot: () => chipDoBot,
  formatarContagem: () => formatarContagem,
  formatarHaQuanto: () => formatarHaQuanto,
  inject: () => inject,
  linhaExpiraTunel: () => linhaExpiraTunel,
  mensagemDeErroTunel: () => mensagemDeErroTunel,
  normalizarProvider: () => normalizarProvider,
  rotuloDeEstadoTunel: () => rotuloDeEstadoTunel,
  rotuloDeStatus: () => rotuloDeStatus,
  rotulosDoProvider: () => rotulosDoProvider
});
module.exports = __toCommonJS(index_exports);
var React = __toESM(require("react"), 1);
var import_react = require("react");

// client/guard-panel.css
var guard_panel_default = `/* ===========================================================================
 * guard-panel.css \u2014 o look-and-feel do painel Telegram (dsh.client).
 *
 * Todas as classes t\xEAm o prefixo \`guard-\` e s\xE3o LOWER-HYPHEN (\`guard-section\`,
 * \`guard-card\`, \u2026) para NUNCA colidir com o host (as classes dos ui-settings-*
 * s\xE3o CSS Modules hasheadas pelo Vite; as nossas s\xE3o cruas por escolha do
 * build \u2014 ver build-client.mjs) e para coincidir 1:1 com os \`className\` do
 * \`client/index.ts\`.
 *
 * Vocabul\xE1rio de DESIGN herdado dos ui-settings (SettingsRoot.module.css,
 * ModelsSection.module.css e os primitives Button/Input): body 14/22,
 * caption 12/18, t\xEDtulos 16/500 lh24, controlo c\xE1psula r18 (h36) e campo de
 * 32px com focus brand, separadores border-l2, e TODA a cor atrav\xE9s de token
 * \`--dsw-alias-*\`. Nenhum literal de cor/estado \u2014 \xE9 isso que mant\xE9m o painel
 * a ler o tema light E dark do shell em runtime.
 *
 * O CSS \xE9 embebido no bundle pelo loader \`text\` do esbuild e injetado num
 * \`<style id="dsh-guard-panel-css">\` pelo apply (ver asegurarCss). Sem
 * literais hardcoded de tema: s\xF3 tokens. =================================== */

/* C\xE1psula da pr\xF3pria section \u2014 estende o .options do panel sem toc\xE1-lo.
   Largura limitada (640px) como as sections stub dos ui-settings. */
.guard-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 640px;
  color: var(--dsw-alias-label-primary);
}

/* Bloco de marca \u2014 a logo do plugin (PNG est\xE1tico, embebido como data URL)
   no topo da aba. Centralizado, com folga inferior para o respirar em
   rela\xE7\xE3o ao restante do painel. S\xF3 \`--dsw-*\` onde faz sentido; a imagem em
   si \xE9 est\xE1tica e n\xE3o segue o tema (tem fundo pr\xF3prio). */
.guard-brand {
  display: flex;
  justify-content: center;
  margin-bottom: 8px;
}

.guard-logo {
  max-height: 72px;
  width: auto;
  object-fit: contain;
  display: block;
}

/* T\xEDtulo do painel (mesmo peso/ritmo do .title dos ui-settings). */
.guard-title {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* Par\xE1grafo de apoio / quebra-linhas. */
.guard-intro {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}

.guard-muted {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* ---------------------------------------------------------------------------
 * Chips / badges de estado \u2014 o "badge do DSH": c\xE1psula pequena com contorno
 * l3 e tom de label secund\xE1rio (regra .rowTag dos ModelsSection), tingida
 * pelo estado de cor quando aplic\xE1vel.
 * ---------------------------------------------------------------- */

.guard-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 999px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  white-space: nowrap;
}

/* O pontinho de estado (mesma regra do credentialDot dos ModelsSection). */
.guard-chip-dot {
  box-sizing: border-box;
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.9;
}

.guard-chip-success {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}

.guard-chip-warning {
  border-color: var(--dsw-alias-state-warn-primary);
  color: var(--dsw-alias-state-warn-label);
}

/* O @handle que estampa o detalhe do chip. */
.guard-chip-handle {
  font-weight: 600;
}

/* ---------------------------------------------------------------------------
 * Cart\xE3o \u2014 a superf\xEDcie "outlined on panel fill" dos ModelsSection (.rowCard):
 * r12, hairline border-l2. Usado pelos checkpoints da trilha (token, parear,
 * usar) e pela confirma\xE7\xE3o destrutiva.
 * ---------------------------------------------------------------- */

.guard-card {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: transparent;
}

.guard-card-title {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  line-height: 22px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* A lista de passos das instru\xE7\xF5es (/parear, /ligar, \u2026). */
.guard-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.guard-step {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ---------------------------------------------------------------------------
 * Lista numerada do cart\xE3o "Como criar o bot" (@BotFather). Reaproveita o
 * ritmo de .guard-steps (gap 8) mas como <ol> com numerais autom\xE1ticos e
 * indenta\xE7\xE3o \xE0 esquerda para a numera\xE7\xE3o respirar.
 * ---------------------------------------------------------------- */

.guard-botfather-steps {
  margin: 0;
  padding: 0 0 0 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-secondary);
}

.guard-botfather-step {
  margin: 0;
}

/* ---------------------------------------------------------------------------
 * Cart\xE3o "Privacidade \u2014 s\xF3 para voc\xEA": estado de descoberta (handle presente
 * vs removido) + bloco de garantias deny-by-default.
 * ---------------------------------------------------------------- */

.guard-privacy-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* A nota "sem username \u2026" ap\xF3s os passos de remo\xE7\xE3o. */
.guard-privacy-note {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* Badge verde "N\xE3o encontr\xE1vel na busca \u2713". */
.guard-badge-ok {
  align-self: flex-start;
  border: 1px solid var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  line-height: 18px;
  font-weight: 500;
}

/* O bloco "Se algu\xE9m achar o bot assim mesmo:" \u2014 caixa discreta. */
.guard-privacy-block {
  border: 1px solid var(--dsw-alias-border-l2);
  border-top-color: var(--dsw-alias-state-warn-primary);
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.guard-block-title {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.guard-privacy-list {
  list-style: disc;
  margin: 0;
  padding: 0 0 0 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.guard-privacy-item {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* Linha de comando copi\xE1vel com bot\xE3o ("copiar"). */
.guard-cmd-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-wrap: wrap;
}

/* O comando copi\xE1vel \u2014 monospace agarrado ao texto do passo. */
.guard-code {
  font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 6px;
  padding: 1px 6px;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
}

/* A grade de KPIs (Total conex\xF5es / Sess\xF5es vivas). */
.guard-kpis {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.guard-kpi {
  flex: 1 1 130px;
  min-width: 130px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.guard-kpi-value {
  font-size: 22px;
  line-height: 28px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.guard-kpi-label {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* ---------------------------------------------------------------------------
 * Formul\xE1rio de token.
 * ---------------------------------------------------------------- */

.guard-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.guard-field-label {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

/* O campo 32px do harness (.wrap do Input) com o toggle dentro. */
.guard-input-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
}

.guard-input-wrap:focus-within {
  border-color: var(--dsw-alias-brand-primary);
}

.guard-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace;
}

.guard-input::placeholder {
  color: var(--dsw-alias-label-dimmed);
  font-family: inherit;
}

/* O bot\xE3o de mostrar/ocultar dentro do campo. */
.guard-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  color: var(--dsw-alias-label-tertiary);
}

.guard-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

/* A barra do bot\xE3o principal \u2014 c\xE1psula r18 h36 (.button .primary/ghost). */
.guard-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.guard-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  border-radius: 18px;
  cursor: pointer;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  padding: 0 16px;
  height: 36px;
}

.guard-btn:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.guard-btn-primary {
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}

.guard-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover);
}

.guard-btn-ghost:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.guard-btn-ghost:active:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active);
}

.guard-btn-outline {
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
}

.guard-btn-outline:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* Bot\xE3o pequeno (c\xE1psula r14 h28; Button .sm). */
.guard-btn-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: none;
  border-radius: 14px;
  cursor: pointer;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  padding: 0 10px;
  height: 28px;
}

.guard-btn-sm:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}

.guard-btn-sm:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}

/* ---------------------------------------------------------------------------
 * Feedback de formul\xE1rio \u2014 estados renderizados DENTRO da aba (regra .notice
 * do ModelsSection: 12/18) no tom do estado correspondente.
 * ---------------------------------------------------------------- */

.guard-notice {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-warn-label);
}

.guard-error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-error-primary);
}

.guard-success-text {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-state-success-primary);
}

/* ---------------------------------------------------------------------------
 * Lista de sess\xF5es vivas \u2014 cada linha um cart\xE3o delgado.
 * ---------------------------------------------------------------- */

.guard-sessions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.guard-session {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.guard-session-id {
  flex: none;
  font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 4px;
  color: var(--dsw-alias-label-secondary);
}

.guard-session-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.guard-session-device {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guard-session-meta {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.guard-session-ip {
  flex: none;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace;
  white-space: nowrap;
}

/* A tag "IP n\xE3o confi\xE1vel". */
.guard-tag {
  flex: none;
  font-size: 11px;
  line-height: 16px;
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 4px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}

/* Rodap\xE9 ligeiro do refresh autom\xE1tico. */
.guard-report-footer {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* ---------------------------------------------------------------------------
 * Pareamento VIA PAINEL \u2014 o c\xF3digo em destaque e o estado de espera.
 * ---------------------------------------------------------------- */

/* A caixa que p\xF5e o c\xF3digo em EVID\xCANCIA (mono, grande, fundo de camada 1). */
.guard-pair-step {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 4px 0;
}

.guard-pair-code {
  font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 34px;
  line-height: 44px;
  font-weight: 600;
  letter-spacing: 2px;
  padding: 8px 16px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-brand-primary);
  user-select: all;
}

/* A linha de status ao vivo do pareamento ("Aguardando\u2026" \u2192 "\u2713 Pareado"). */
.guard-pair-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
}

/* ---------------------------------------------------------------------------
 * Trilha de checkpoints \u2014 s\xF3 o passo atual aberto; conclu\xEDdos colapsam.
 * ---------------------------------------------------------------- */

/* O "\u2713" \xE0 frente de um passo conclu\xEDdo (t\xEDtulo do passo atual ou linha fina). */
.guard-step-check {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 1px solid var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
  font-size: 12px;
  line-height: 1;
  font-weight: 600;
}

/* Passo conclu\xEDdo, colapsado \u2014 um cart\xE3o resumido com text-link ("Trocar"). */
.guard-step-done {
  align-items: flex-start;
}

.guard-step-done-actions {
  display: flex;
  gap: 8px;
  margin-top: -4px;
}

/* Texto fraco que ensina o pr\xF3ximo passo (vazio do checkpoint 1). */
.guard-step-hint {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}

/* Text-link (a\xE7\xF5es n\xE3o destrutivas do painel: "Trocar", "Trocar o token", \u2026). */
.guard-link {
  appearance: none;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-brand-primary);
  text-align: left;
}

.guard-link:hover {
  text-decoration: underline;
}

/* Lista de text-links do "Avan\xE7ado" / "E minha conversa?". */
.guard-links {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ---------------------------------------------------------------------------
 * <details> de progressive disclosure (BotFather / Avan\xE7ado / privacidade).
 * ---------------------------------------------------------------- */

.guard-details {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: transparent;
}

.guard-details-summary {
  cursor: pointer;
  user-select: none;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}

.guard-details-summary::-webkit-details-marker {
  display: none;
}

.guard-details-summary::after {
  content: '\u25B8';
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  transition: transform 0.15s ease;
}

.guard-details[open] .guard-details-summary::after {
  transform: rotate(90deg);
}

.guard-details-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 14px 12px;
}

/* ---------------------------------------------------------------------------
 * Corpo do pareamento VIA PAINEL (Passo 2) \u2014 c\xF3digo espa\xE7ado + countdown.
 * ---------------------------------------------------------------- */

.guard-pair-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* A linha de instru\xE7\xE3o UMA final: "No Telegram, envia: /parear 123456 no @handle". */
.guard-code-line {
  margin: 0;
  font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
}

/* A fila countdown ("expira em 4:53") + bot\xE3o "Gerar novo". */
.guard-pair-countdown {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

/* Coluna de a\xE7\xF5es para os estados de erro/expira\xE7\xE3o (bot\xE3o abaixo da frase). */
.guard-col {
  flex-direction: column;
  align-items: flex-start;
}

/* O bloco "Uso recente" (m\xE9tricas) do Passo 3. */
.guard-metrics {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding-top: 10px;
  margin-top: 2px;
}

/* A confirma\xE7\xE3o destrutiva do Avan\xE7ado (texto + [a\xE7\xE3o][Cancelar]). */
.guard-confirm {
  border-top-color: var(--dsw-alias-state-warn-primary);
}

/* O cart\xE3o de privacidade AO VIVO, dentro do <details> "E minha conversa?". */
.guard-privacy-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 12px 14px;
}

/* ---------------------------------------------------------------------------
 * Bloco "Agentes" \u2014 a lista de runs do dispatcher (id, skill, status PT-BR,
 * h\xE1 quanto tempo, resumo cortado) + o bot\xE3o "Cancelar" por run ativo.
 * ---------------------------------------------------------------- */

/* O chip de status com tom de ERRO (falhou) \u2014 o 3.\xBA tom dos chips de estado. */
.guard-chip-error {
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary);
}

/* A lista de runs \u2014 uma linha delgada por run, como a lista de sess\xF5es. */
.guard-agents {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* O corpo do cart\xE3o (nota de erro + lista / vazio). */
.guard-agents-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* UMA linha de run: id, corpo (skill \xB7 status \xB7 h\xE1 quanto / resumo) e a\xE7\xE3o. */
.guard-agent {
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  padding: 10px 14px;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  min-width: 0;
}

/* O id CURTO do run \u2014 badge mono como o id de sess\xE3o. */
.guard-agent-id {
  flex: none;
  font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  padding: 1px 6px;
  border: 1px solid var(--dsw-alias-border-l3);
  border-radius: 4px;
  color: var(--dsw-alias-label-secondary);
}

/* O corpo da linha (o que estica e corta). */
.guard-agent-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* A linha "skill \xB7 status \xB7 h\xE1 quanto tempo". */
.guard-agent-linha {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

/* A skill disparada (kebab-case) \u2014 destaque da linha. */
.guard-agent-skill {
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* O resumo cortado do run (texto do modelo, nunca segredo). */
.guard-agent-summary {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------------------------------------------------------------------------
 * Cart\xE3o "T\xFAnel" \u2014 o controle que veio da home (estado projetado, URL,
 * countdown, falha/nota, os tr\xEAs bot\xF5es e as instru\xE7\xF5es "como ligar o bot").
 * M\xEDnimo necess\xE1rio: o cart\xE3o/caixa/chips/bot\xF5es j\xE1 existem (guard-card,
 * guard-confirm, guard-chip*, guard-btn*); aqui s\xF3 a coluna do corpo, a URL
 * mono e os passos do bot. Toda cor via token --dsw-alias-*.
 * ---------------------------------------------------------------- */

/* O corpo do cart\xE3o do t\xFAnel (coluna com o mesmo respiro dos cart\xF5es). */
.guard-tunnel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* A URL do t\xFAnel \u2014 s\xF3 em READY. Monospace como o id de run, com quebra de
   linha palavra-a-palavra (URLs longas n\xE3o estouram o cart\xE3o). */
.guard-tunnel-url {
  display: block;
  font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary);
  word-break: break-all;
  overflow-wrap: anywhere;
}

/* O bloco "Como ligar o bot" (t\xEDtulo + bot\xE3o + <details> dos passos). */
.guard-tunnel-bot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2);
  padding-top: 10px;
  margin-top: 2px;
}

/* UM passo das instru\xE7\xF5es: t\xEDtulo em negrito + texto (brancos preservados \u2014
   o texto do backend usa \\n para o comando em bloco). */
.guard-tunnel-passo {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.guard-tunnel-passo-titulo {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.guard-tunnel-passo-texto {
  margin: 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}`;

// logo.png
var logo_default = "data:image/png;base64,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";

// client/index.ts
var inject = ["slots"];
var CSS_ID = "dsh-guard-panel-css";
function asegurarCss(documento) {
  if (documento.getElementById(CSS_ID) !== null || guard_panel_default.length === 0) return;
  const estilo = documento.createElement("style");
  estilo.id = CSS_ID;
  estilo.textContent = guard_panel_default;
  const head = documento.head ?? documento.documentElement;
  head.appendChild(estilo);
}
var API_BASE = "/__guard-ui/api";
var CSRF_TIMEOUT_MS = 2500;
var CSRF_INDISPONIVEL = "";
async function buscarTokenCsrf(documento) {
  const controller = new AbortController();
  const temporizador = setTimeout(() => controller.abort(), CSRF_TIMEOUT_MS);
  try {
    const resposta = await fetch(API_BASE + "/csrf", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (resposta.ok) {
      const corpo = await resposta.json();
      if (typeof corpo.token === "string" && corpo.token.length > 0) return corpo.token;
    }
  } catch {
  } finally {
    clearTimeout(temporizador);
  }
  return CSRF_INDISPONIVEL;
}
async function apiGet(caminho) {
  const resposta = await fetch(API_BASE + caminho, {
    credentials: "same-origin",
    headers: { accept: "application/json" }
  });
  if (!resposta.ok) throw new Error(`http-${resposta.status}`);
  return await resposta.json();
}
async function apiPost(caminho, corpo, documento) {
  const token = await buscarTokenCsrf(documento);
  if (token.length === 0) {
    return { status: 0, dados: {}, csrfIndisponivel: true };
  }
  let resposta;
  try {
    resposta = await fetch(API_BASE + caminho, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-dsh-csrf": token },
      body: JSON.stringify(corpo)
    });
  } catch {
    return { status: 0, dados: {}, csrfIndisponivel: false };
  }
  let dados = {};
  try {
    dados = await resposta.json();
  } catch {
  }
  return { status: resposta.status, dados, csrfIndisponivel: false };
}
function formatarContagem(expiraEm, agoraMs) {
  const falta = Math.max(0, Math.floor((expiraEm - agoraMs) / 1e3));
  const minutos = Math.floor(falta / 60);
  const segundos = falta % 60;
  return `${minutos}:${segundos.toString().padStart(2, "0")}`;
}
var ROTULOS_DE_STATUS_DE_AGENTE = Object.freeze({
  running: "rodando",
  done: "conclu\xEDdo",
  failed: "falhou",
  cancelled: "cancelado"
});
function rotuloDeStatus(status) {
  return ROTULOS_DE_STATUS_DE_AGENTE[status];
}
function formatarHaQuanto(startedAt, agoraMs) {
  const ms = agoraMs - startedAt;
  if (ms <= 0) return "agora mesmo";
  if (ms < 6e4) return "h\xE1 menos de 1 min";
  const minutos = Math.floor(ms / 6e4);
  if (minutos < 60) return `h\xE1 ${String(minutos)} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto === 0 ? `h\xE1 ${String(horas)} h` : `h\xE1 ${String(horas)} h ${String(resto)} min`;
}
var MAX_RESUMO_EXIBIDO = 120;
function resumoExibido(summary) {
  return summary.length <= MAX_RESUMO_EXIBIDO ? summary : `${summary.slice(0, MAX_RESUMO_EXIBIDO - 1)}\u2026`;
}
var ROTULOS_DE_ESTADO_TUNEL = Object.freeze({
  STOPPED: "desligado",
  STARTING: "ligando",
  READY: "online",
  DEGRADED: "inst\xE1vel \u2014 tentando de novo",
  STOPPING: "desligando",
  FAILED: "falhou \u2014 precisa de a\xE7\xE3o sua"
});
function rotuloDeEstadoTunel(estado) {
  if (typeof estado === "string" && Object.hasOwn(ROTULOS_DE_ESTADO_TUNEL, estado)) {
    return ROTULOS_DE_ESTADO_TUNEL[estado];
  }
  return typeof estado === "string" && estado.length > 0 ? estado : "\u2014";
}
function linhaExpiraTunel(expiraEm, agoraMs) {
  if (typeof expiraEm !== "number") return null;
  const restante = Math.max(0, Math.ceil((expiraEm - agoraMs) / 1e3));
  return `expira em ${restante} s`;
}
function mensagemDeErroTunel(resposta) {
  const motivo = resposta.dados["motivo"];
  if (typeof motivo === "string" && motivo.length > 0) return motivo;
  return resposta.status === 0 ? "Sem liga\xE7\xE3o ao servidor. Verifica a rede e tenta de novo." : "O servidor n\xE3o respondeu \u2014 recarregue a p\xE1gina e tente de novo.";
}
function chipDoEstado(token, provider) {
  if (token === null) return { tom: "neutro", rotulo: "verificando\u2026" };
  if (token.fonte === "env") {
    if (token.configurado) return { tom: "aviso", rotulo: "Configurado via env", detalhe: `${rotulosDoProvider(provider).tokenVar} manda` };
    return { tom: "aviso", rotulo: "Env manda", detalhe: "sem token at\xE9 remover a vari\xE1vel" };
  }
  if (token.configurado) return { tom: "ok", rotulo: "Configurado", detalhe: token.fonte };
  return { tom: "neutro", rotulo: "N\xE3o configurado" };
}
function chipDoBot(token, telegrama, provider = "telegram") {
  if (token === null) return { tom: "neutro", rotulo: "verificando\u2026" };
  if (!token.configurado) return chipDoEstado(token, provider);
  if (telegrama === null) return { tom: "neutro", rotulo: "verificando\u2026" };
  if (telegrama.online) {
    const detalhe = telegrama.handle !== void 0 && telegrama.handle.length > 0 ? `@${telegrama.handle}` : token.fonte;
    return { tom: "ok", rotulo: "Online", detalhe };
  }
  return { tom: "aviso", rotulo: "Offline", detalhe: telegrama.motivo };
}
var COMANDOS_DE_USO = [
  { comando: "/parear <c\xF3digo>", dica: "parear este navegador (c\xF3digo no terminal)" },
  { comando: "/acessar", dica: "receber um convite de sess\xE3o" },
  { comando: "/ligar", dica: "ligar o t\xFAnel" },
  { comando: "/status", dica: "estado do bot e do t\xFAnel" },
  { comando: "/rotacionar", dica: "revogar a chave atual (?key)" },
  { comando: "/desligar", dica: "derrubar o t\xFAnel" },
  { comando: "/emergencia", dica: "derrubar tudo de imediato" }
];
var COMANDOS_ESSENCIAIS = [
  { comando: "/menu", dica: "abrir o painel de controlo do bot" },
  { comando: "/status", dica: "ver o estado do t\xFAnel" },
  { comando: "/emergencia", dica: "derrubar tudo de imediato" }
];
var ROTULOS_TELEGRAM = Object.freeze({
  botFather: "@BotFather",
  tokenVar: "TELEGRAM_BOT_TOKEN",
  tokenPlaceholder: "1234567890:AAA\u2026",
  coleToken: "Cole o token que o @BotFather te entregou ao criar o bot. Fica guardado seguro nesta m\xE1quina.",
  rotuloCampoToken: "Token do bot (@BotFather)",
  conectando: "A conectar ao Telegram\u2026",
  criacao: [
    "Abra o Telegram e converse com @BotFather.",
    "Envie /newbot.",
    'D\xEA um nome para o bot (ex.: "Meu dsh-messenger").',
    "D\xEA um username que termine em `bot` (5\u201332 caracteres, A-Za-z0-9_, ex.: `meu_dsh_messenger_bot`).",
    "O BotFather responde com um token no formato `<n\xFAmero>:<segredo>` \u2014 copie-o.",
    'Cole o token no campo abaixo e clique em "Salvar bot".'
  ],
  notaCriacao: "Se precisar trocar o token depois, use /token no @BotFather para revogar e gerar outro.",
  notaPrivado: "Opcional \u2014 bot privado: remova o username do bot no @BotFather para ele n\xE3o aparecer na busca do Telegram.",
  formatoInvalido: "Formato errado. O token vem assim: 123456:aaaa\u2026 (n\xFAmero, dois pontos, segredo).",
  tokenRecusado: "O Telegram n\xE3o aceitou este token. Veja no @BotFather (/newbot) e tira outro.",
  envManda: "A vari\xE1vel TELEGRAM_BOT_TOKEN do ambiente manda; remova-a ou use o token dela.",
  naConversa: "No Telegram, envia:",
  parearNoBot: "No Telegram, envia: /parear {codigo} no {ref} \u2014 ou s\xF3 /parear e o bot pede o c\xF3digo",
  acessoIntro: "Acesso remoto ao Harness pelo Telegram \u2014 sem login no t\xFAnel.",
  encontravel: "O bot \xE9 encontr\xE1vel na busca do Telegram como @{handle}. Se n\xE3o quiser isso, remova o username:",
  naoEncontravel: "N\xE3o encontr\xE1vel na busca \u2713 \u2014 ningu\xE9m acha o bot no Telegram.",
  passosRemoverUsername: [
    "No Telegram, abra a conversa com @BotFather.",
    "Envie /setusername e escolha o teu bot na lista.",
    'Remova o username (a op\xE7\xE3o "delete current username"/"remover username").'
  ],
  semUsernameNota: "Sem username o bot deixa de aparecer na busca e o link t.me/@{handle} morre \u2014 a conversa j\xE1 aberta e o pareamento continuam a funcionar.",
  ckpt3Conversas: "As tuas conversas com o bot ficam neste aparelho e no Telegram, com privacidade por omiss\xE3o: nenhum comando de estranho funciona e quem n\xE3o pareou n\xE3o recebe resposta."
});
var ROTULOS_POR_PROVIDER = {
  telegram: ROTULOS_TELEGRAM
};
function rotulosDoProvider(provider) {
  return provider === "telegram" ? ROTULOS_POR_PROVIDER[provider] : ROTULOS_TELEGRAM;
}
function normalizarProvider(_valor) {
  return "telegram";
}
var h = React.createElement;
function paragrafo(classe, ...filhos) {
  return h("p", { className: classe }, ...filhos);
}
function Chip({ chip }) {
  return h(
    "span",
    { className: `guard-chip ${chip.tom === "ok" ? "guard-chip-success" : chip.tom === "aviso" ? "guard-chip-warning" : ""}` },
    h("span", { className: "guard-chip-dot" }),
    chip.rotulo,
    chip.detalhe ? h("span", { className: "guard-chip-handle" }, ` \xB7 ${chip.detalhe}`) : null
  );
}
function LinhaDeComando({ bloco }) {
  const [copiado, setCopiado] = (0, import_react.useState)(false);
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(bloco.comando);
      setCopiado(true);
      window.setTimeout(() => setCopiado(false), 1200);
    } catch {
      setCopiado(false);
    }
  };
  return h(
    "div",
    { className: "guard-cmd-row" },
    h("code", { className: "guard-code" }, bloco.comando),
    h(
      "button",
      { type: "button", className: "guard-btn-sm", onClick: () => copiar(), "data-guard-copy": "" },
      copiado ? "copiado" : "Copiar"
    ),
    bloco.dica ? h("span", { className: "guard-muted" }, bloco.dica) : null
  );
}
function Detalhes({
  resumo,
  aberto,
  aoAlternar,
  children
}) {
  const props = {};
  if (aberto !== void 0) props["open"] = aberto;
  if (aoAlternar !== void 0) {
    props["onToggle"] = (e) => aoAlternar(e.target.open);
  }
  return h(
    "details",
    { className: "guard-details", ...props },
    h("summary", { className: "guard-details-summary", "data-guard-detail": "" }, resumo),
    h("div", { className: "guard-details-body" }, children)
  );
}
function CabecalhoPasso({
  indice,
  titulo,
  concluido
}) {
  return h(
    "span",
    { className: "guard-card-title" },
    concluido ? h("span", { className: "guard-step-check", "aria-hidden": "true" }, "\u2713") : null,
    `Passo ${indice} de 3 \xB7 ${titulo}`
  );
}
function PassoConcluido({
  resumo,
  aoAcao,
  rotuloAcao
}) {
  return h(
    "div",
    { className: "guard-card guard-step-done" },
    h(
      "span",
      { className: "guard-card-title" },
      h("span", { className: "guard-step-check", "aria-hidden": "true" }, "\u2713"),
      resumo
    ),
    aoAcao !== void 0 && rotuloAcao !== void 0 ? h(
      "div",
      { className: "guard-step-done-actions" },
      h("button", { type: "button", className: "guard-link", onClick: aoAcao }, rotuloAcao)
    ) : null
  );
}
function BotaoBotFatherDetalhado({ rotulos }) {
  return h(
    "ol",
    { className: "guard-botfather-steps" },
    rotulos.criacao.map((passo, i) => h("li", { className: "guard-botfather-step", key: i }, passo)),
    h("li", { className: "guard-botfather-step" }, rotulos.notaCriacao),
    h("li", { className: "guard-botfather-step" }, rotulos.notaPrivado)
  );
}
var GARANTIAS_PRIVACIDADE = [
  "Sem o c\xF3digo de pareamento (que s\xF3 aparece neste painel), nenhum comando funciona \u2014 o bot recusa por omiss\xE3o (default deny).",
  '/start responde apenas "Ol\xE1. Este bot \xE9 privado\u2026" \u2014 boas-vindas in\xF3cuas, iguais para todos, sem parear ningu\xE9m.',
  "Comandos de estranhos s\xE3o recusados em sil\xEAncio (nenhuma resposta na conversa) e contados na auditoria.",
  "Uma segunda parelha \xE9 recusada mesmo com um c\xF3digo v\xE1lido: s\xF3 existe UM dono, definido na primeira parelha.",
  "Tentativas erradas de /parear t\xEAm tetos (por conversa e globais) e um atraso crescente, para travar for\xE7a bruta."
];
function CartaoPrivacidade({
  estado,
  rotulos,
  aoVerificar
}) {
  const titulo = h("span", { className: "guard-card-title" }, "Privacidade \u2014 s\xF3 para voc\xEA");
  const corpo = estado === null ? paragrafo("guard-intro", "A verificar a descoberta do bot\u2026") : estado.ok ? estado.handle !== null && estado.handle.length > 0 ? h(
    "div",
    { className: "guard-privacy-body" },
    paragrafo("guard-intro", rotulos.encontravel.replaceAll("{handle}", estado.handle)),
    h(
      "ol",
      { className: "guard-botfather-steps" },
      rotulos.passosRemoverUsername.map((passo, i) => h("li", { className: "guard-botfather-step", key: i }, passo))
    ),
    paragrafo("guard-privacy-note", rotulos.semUsernameNota.replaceAll("{handle}", estado.handle))
  ) : h(
    "div",
    { className: "guard-privacy-body" },
    h("span", { className: "guard-badge-ok" }, rotulos.naoEncontravel)
  ) : h(
    "div",
    { className: "guard-privacy-body" },
    paragrafo("guard-intro", "N\xE3o foi poss\xEDvel verificar agora (bot offline ou token inv\xE1lido?)."),
    h(
      "div",
      { className: "guard-actions" },
      h(
        "button",
        { type: "button", className: "guard-btn guard-btn-outline", onClick: aoVerificar },
        "Verificar de novo"
      )
    )
  );
  return h(
    "div",
    { className: "guard-privacy-card" },
    titulo,
    corpo,
    h(
      "div",
      { className: "guard-privacy-block" },
      h("span", { className: "guard-block-title" }, "Se algu\xE9m achar o bot assim mesmo:"),
      h(
        "ul",
        { className: "guard-privacy-list" },
        GARANTIAS_PRIVACIDADE.map((g, i) => h("li", { className: "guard-privacy-item", key: i }, g))
      )
    )
  );
}
function CartaoPrivacidadeCkpt3(props) {
  return h(
    Detalhes,
    { resumo: "E minha conversa?" },
    paragrafo("guard-intro", props.rotulos.ckpt3Conversas),
    h(CartaoPrivacidade, { estado: props.estado, rotulos: props.rotulos, aoVerificar: props.aoVerificar })
  );
}
function CartaoParear(props) {
  const [copiado, setCopiado] = (0, import_react.useState)(false);
  switch (props.estado.fase) {
    case "gerando":
      return h(
        "div",
        { style: { display: "flex", flexDirection: "column", gap: 10 } },
        paragrafo("guard-intro", "A gerar o c\xF3digo\u2026")
      );
    case "codigo": {
      const contagem = formatarContagem(props.estado.expiraEm, props.agora);
      const expirou = props.agora >= props.estado.expiraEm;
      if (expirou) {
        return h(
          "div",
          { className: "guard-actions guard-col" },
          paragrafo("guard-error", "Este c\xF3digo expirou. Gera um novo."),
          h(
            "button",
            { type: "button", className: "guard-btn guard-btn-primary", onClick: props.aoNovoCodigo },
            "Gerar novo c\xF3digo"
          )
        );
      }
      const digitoEspacado = espacarCodigo(props.estado.codigo);
      const copiar = async () => {
        try {
          await navigator.clipboard.writeText(props.estado.codigo);
          setCopiado(true);
          window.setTimeout(() => setCopiado(false), 1200);
        } catch {
          setCopiado(false);
        }
      };
      return h(
        "div",
        { className: "guard-pair-body" },
        paragrafo("guard-intro", props.rotulos.naConversa),
        h(
          "div",
          { className: "guard-pair-step" },
          h("code", { className: "guard-pair-code" }, digitoEspacado),
          h(
            "button",
            { type: "button", className: "guard-btn-sm", onClick: () => void copiar(), "data-guard-copy-code": "" },
            copiado ? "copiado" : "Copiar"
          )
        ),
        paragrafo(
          "guard-code-line",
          props.rotulos.parearNoBot.replaceAll("{codigo}", props.estado.codigo).replaceAll("{ref}", props.handle && props.handle.length > 0 ? `@${props.handle}` : "o bot")
        ),
        h(
          "div",
          { className: "guard-pair-countdown" },
          h("span", { className: "guard-muted" }, `expira em ${contagem}`),
          h("button", { type: "button", className: "guard-btn-sm", onClick: props.aoNovoCodigo }, "Gerar novo")
        ),
        h(
          "div",
          { className: "guard-pair-status" },
          props.pareado ? h(
            "span",
            { className: "guard-chip guard-chip-success" },
            h("span", { className: "guard-chip-dot" }),
            "\u2713 Pareado"
          ) : h(
            "span",
            { className: "guard-chip" },
            h("span", { className: "guard-chip-dot" }),
            "Aguardando\u2026"
          )
        )
      );
    }
    case "pareado":
      return h(
        "div",
        { className: "guard-pair-body" },
        h(
          "span",
          { className: "guard-chip guard-chip-success" },
          h("span", { className: "guard-chip-dot" }),
          "\u2713 Pareado"
        )
      );
    case "expirou":
      return h(
        "div",
        { className: "guard-actions guard-col" },
        paragrafo("guard-error", "Este c\xF3digo expirou. Gera um novo."),
        h(
          "button",
          { type: "button", className: "guard-btn guard-btn-primary", onClick: props.aoNovoCodigo },
          "Gerar novo c\xF3digo"
        )
      );
    case "erro":
      return h(
        "div",
        { className: "guard-actions guard-col" },
        paragrafo("guard-error", props.estado.mensagem),
        h(
          "button",
          { type: "button", className: "guard-btn guard-btn-outline", onClick: props.aoNovoCodigo },
          "Tentar de novo"
        )
      );
    default:
      return h(
        "div",
        { className: "guard-pair-body" },
        paragrafo(
          "guard-intro",
          "Este painel gera um c\xF3digo de 6 d\xEDgitos s\xF3 para ti. Tu envias esse c\xF3digo para o bot."
        ),
        h(
          "div",
          { className: "guard-actions" },
          h(
            "button",
            { type: "button", className: "guard-btn guard-btn-primary", onClick: props.aoGerar },
            "Gerar c\xF3digo"
          )
        )
      );
  }
}
function espacarCodigo(codigo) {
  return codigo.split("").join(" ");
}
function ChipDeStatusDeAgente({ status }) {
  const extra = status === "done" ? " guard-chip-success" : status === "failed" ? " guard-chip-error" : "";
  return h(
    "span",
    { className: `guard-chip${extra}` },
    h("span", { className: "guard-chip-dot" }),
    rotuloDeStatus(status)
  );
}
function CartaoAgentes(props) {
  const titulo = h("span", { className: "guard-card-title" }, "\u{1F916} Agentes");
  const notaDeErro = props.erro !== null ? paragrafo("guard-error", props.erro) : null;
  const corpo = props.estado === null ? props.erro === null ? paragrafo("guard-intro", "A carregar os agentes\u2026") : h("div", { className: "guard-agents-body" }, notaDeErro) : props.estado.runs.length === 0 ? h(
    "div",
    { className: "guard-agents-body" },
    notaDeErro,
    paragrafo("guard-intro", "Nenhum agente rodando.")
  ) : h(
    "div",
    { className: "guard-agents-body" },
    notaDeErro,
    h(
      "ul",
      { className: "guard-agents" },
      props.estado.runs.map(
        (run) => h(
          "li",
          { className: "guard-agent", key: run.id },
          h("code", { className: "guard-agent-id" }, run.id),
          h(
            "div",
            { className: "guard-agent-body" },
            h(
              "div",
              { className: "guard-agent-linha" },
              h("span", { className: "guard-agent-skill" }, run.skill),
              h(ChipDeStatusDeAgente, { status: run.status }),
              h("span", { className: "guard-muted" }, formatarHaQuanto(run.startedAt, props.agora))
            ),
            run.summary !== void 0 && run.summary.length > 0 ? h("div", { className: "guard-agent-summary" }, resumoExibido(run.summary)) : null
          ),
          // O botao so existe para runs ATIVOS; o cancelar REDUZ
          // exposicao e por isso nao pede confirmacao (CTL-024).
          run.status === "running" ? h("button", {
            type: "button",
            className: "guard-btn-sm",
            "data-guard-cancel-agent": run.id,
            disabled: props.cancelandoId === run.id,
            onClick: () => props.aoCancelar(run.id)
          }, props.cancelandoId === run.id ? "Cancelando\u2026" : "Cancelar") : null
        )
      )
    )
  );
  return h("div", { className: "guard-card" }, titulo, corpo);
}
var TEXTO_CONFIRMACAO_TUNEL = Object.freeze({
  ligar: "Ligar o t\xFAnel abre esta m\xE1quina \xE0 internet. Confirmar?",
  desligar: "Desligar o T\xDANEL? O DSH continua a correr em loopback; o bot e o painel n\xE3o s\xE3o afetados.",
  repor: "Repor o estado de falha e voltar a desligado? (o t\xFAnel permanece desligado)"
});
function CartaoConfirmacaoTunel(props) {
  return h(
    "div",
    { className: "guard-card guard-confirm" },
    paragrafo("guard-error", TEXTO_CONFIRMACAO_TUNEL[props.acao]),
    h(
      "div",
      { className: "guard-actions" },
      h("button", {
        type: "button",
        className: "guard-btn guard-btn-primary",
        disabled: props.confirmando,
        onClick: props.aoConfirmar
      }, props.confirmando ? "a confirmar\u2026" : "Confirmar"),
      h("button", {
        type: "button",
        className: "guard-btn guard-btn-outline",
        disabled: props.confirmando,
        onClick: props.aoCancelar
      }, "Cancelar")
    )
  );
}
function CartaoTunel(props) {
  const estado = props.tunel?.estado;
  const titulo = h("span", { className: "guard-card-title" }, "T\xFAnel");
  const tomChip = estado === "READY" ? " guard-chip-success" : estado === "DEGRADED" ? " guard-chip-warning" : estado === "FAILED" ? " guard-chip-error" : "";
  const url = estado === "READY" && typeof props.tunel?.url === "string" && props.tunel.url.length > 0 ? props.tunel.url : null;
  const expira = linhaExpiraTunel(props.tunel?.expiraEm, props.agora);
  const falha = props.tunel?.falha;
  const mensagemFalha = falha !== null && falha !== void 0 && typeof falha.mensagem === "string" && falha.mensagem.length > 0 ? falha.mensagem : typeof props.tunel?.nota === "string" && props.tunel.nota.length > 0 ? props.tunel.nota : null;
  return h(
    "div",
    { className: "guard-card" },
    titulo,
    h(
      "div",
      { className: "guard-tunnel" },
      h(
        "div",
        null,
        h(
          "span",
          { className: `guard-chip${tomChip}` },
          h("span", { className: "guard-chip-dot" }),
          rotuloDeEstadoTunel(estado)
        )
      ),
      url !== null ? h("code", { className: "guard-tunnel-url" }, url) : null,
      expira !== null ? paragrafo("guard-muted", expira) : null,
      props.tunel !== null ? paragrafo("guard-muted", `tentativas: ${String(props.tunel.tentativas)}`) : null,
      mensagemFalha !== null ? paragrafo("guard-error", mensagemFalha) : null,
      props.erro !== null ? paragrafo("guard-error", props.erro) : null,
      h(
        "div",
        { className: "guard-actions" },
        h("button", {
          type: "button",
          className: "guard-btn guard-btn-primary",
          disabled: props.emVoo || estado !== "STOPPED",
          onClick: props.aoLigar
        }, "Ligar t\xFAnel"),
        h("button", {
          type: "button",
          className: "guard-btn guard-btn-outline",
          disabled: props.emVoo || !(estado === "STARTING" || estado === "READY" || estado === "DEGRADED"),
          onClick: props.aoDesligar
        }, "Desligar t\xFAnel"),
        // FAILED só sai por reset humano (CTL-012) — o botão só acorda aí,
        // como no script antigo.
        h("button", {
          type: "button",
          className: "guard-btn guard-btn-outline",
          disabled: props.emVoo || estado !== "FAILED",
          onClick: props.aoRepor
        }, "Repor (ap\xF3s falha)")
      ),
      // Instruções "como ligar o bot" — o clique é um POST (escrita, com
      // CSRF) que devolve os passos do provedor ativo; os textos entram como
      // CHILDREN de React num <details> dobrado.
      h(
        "div",
        { className: "guard-tunnel-bot" },
        h("span", { className: "guard-block-title" }, "Como ligar o bot"),
        h(
          "div",
          { className: "guard-actions" },
          h("button", {
            type: "button",
            className: "guard-btn-sm",
            disabled: props.passosEmVoo,
            onClick: props.aoPassos
          }, props.passosEmVoo ? "A pedir\u2026" : "Ver instru\xE7\xF5es")
        ),
        props.passosErro !== null ? paragrafo("guard-error", props.passosErro) : null,
        props.passos !== null ? h(
          Detalhes,
          {
            resumo: "Passos",
            aberto: props.passosAbertos,
            aoAlternar: props.aoAlternarPassos
          },
          props.passos.length === 0 ? paragrafo("guard-intro", "O servidor n\xE3o devolveu passos.") : props.passos.map(
            (passo, i) => h(
              "div",
              { className: "guard-tunnel-passo", key: i },
              h("p", { className: "guard-tunnel-passo-titulo" }, passo.titulo),
              h("p", { className: "guard-tunnel-passo-texto" }, passo.texto)
            )
          )
        ) : null
      )
    )
  );
}
function TelegramGuardSection() {
  const [token, setToken] = (0, import_react.useState)(null);
  const [telegrama, setTelegrama] = (0, import_react.useState)(null);
  const [provider, setProvider] = (0, import_react.useState)("telegram");
  const [tokenErro, setTokenErro] = (0, import_react.useState)(null);
  const [privacidade, setPrivacidade] = (0, import_react.useState)(null);
  const [agentes, setAgentes] = (0, import_react.useState)(null);
  const [agentesErro, setAgentesErro] = (0, import_react.useState)(null);
  const [cancelandoId, setCancelandoId] = (0, import_react.useState)(null);
  const [tunel, setTunel] = (0, import_react.useState)(null);
  const [tunelErro, setTunelErro] = (0, import_react.useState)(null);
  const [tunelEmVoo, setTunelEmVoo] = (0, import_react.useState)(false);
  const [confirmacaoTunel, setConfirmacaoTunel] = (0, import_react.useState)(null);
  const [confirmandoTunel, setConfirmandoTunel] = (0, import_react.useState)(false);
  const nonceTunelRef = (0, import_react.useRef)(null);
  const [passosBot, setPassosBot] = (0, import_react.useState)(null);
  const [passosAbertos, setPassosAbertos] = (0, import_react.useState)(false);
  const [passosEmVoo, setPassosEmVoo] = (0, import_react.useState)(false);
  const [passosErro, setPassosErro] = (0, import_react.useState)(null);
  const [valor, setValor] = (0, import_react.useState)("");
  const [mostrarToken, setMostrarToken] = (0, import_react.useState)(false);
  const [enviando, setEnviando] = (0, import_react.useState)(false);
  const [feedback, setFeedback] = (0, import_react.useState)(null);
  const [trocarTokenAberto, setTrocarTokenAberto] = (0, import_react.useState)(false);
  const inputTokenRef = (0, import_react.useRef)(null);
  const [confirmacao, setConfirmacao] = (0, import_react.useState)(null);
  const [par, setPar] = (0, import_react.useState)({ fase: "ocioso" });
  const [pareado, setPareado] = (0, import_react.useState)(false);
  const sondaParRef = (0, import_react.useRef)(null);
  const [agora, setAgora] = (0, import_react.useState)(() => Date.now());
  const vivo = (0, import_react.useRef)(true);
  const buscarToken = React.useCallback(async () => {
    try {
      const dados = await apiGet("/token-state");
      if (vivo.current) setToken(dados);
    } catch {
      if (vivo.current) setTokenErro("n\xE3o foi poss\xEDvel ler o estado \u2014 servidor inacess\xEDvel");
    }
  }, []);
  const buscarTelegrama = React.useCallback(async () => {
    try {
      const dados = await apiGet("/telegram");
      if (vivo.current) {
        setProvider(normalizarProvider(dados.provider));
        setTelegrama(dados);
        if (dados.online) {
          setPareado(true);
          setPar({ fase: "pareado" });
          if (sondaParRef.current !== null) {
            window.clearInterval(sondaParRef.current);
            sondaParRef.current = null;
          }
        }
      }
    } catch {
    }
  }, []);
  const buscarPrivacidade = React.useCallback(async (forcar) => {
    const link = forcar ? "/privacidade?forcar=true" : "/privacidade";
    try {
      const dados = await apiGet(link);
      if (vivo.current) setPrivacidade(dados);
    } catch {
    }
  }, []);
  const buscarAgentes = React.useCallback(async () => {
    try {
      const dados = await apiGet("/agents");
      if (vivo.current) {
        setAgentes(dados);
        setAgentesErro(null);
      }
    } catch {
      if (vivo.current) setAgentesErro("n\xE3o foi poss\xEDvel carregar os agentes \u2014 servidor inacess\xEDvel");
    }
  }, []);
  const cancelarAgente = React.useCallback(
    async (id) => {
      if (!vivo.current) return;
      setCancelandoId(id);
      const r = await apiPost(`/agents/${id}/cancel`, {}, document);
      setCancelandoId(null);
      if (!vivo.current) return;
      if (r.csrfIndisponivel) {
        setAgentesErro("CSRF indispon\xEDvel \u2014 recarregue a p\xE1gina e tente de novo.");
        return;
      }
      if (r.status !== 200) {
        setAgentesErro("N\xE3o foi poss\xEDvel cancelar o agente. Tente de novo.");
        return;
      }
      setAgentesErro(null);
      await buscarAgentes();
    },
    [buscarAgentes]
  );
  const buscarTunel = React.useCallback(async () => {
    try {
      const dados = await apiGet("/state");
      if (vivo.current) setTunel(dados);
    } catch {
    }
  }, []);
  const abrirTunel = React.useCallback(async (acao) => {
    if (!vivo.current) return;
    setTunelErro(null);
    setTunelEmVoo(true);
    try {
      const r = await apiPost(acao === "ligar" ? "/start" : "/reset", {}, document);
      if (!vivo.current) return;
      if (r.csrfIndisponivel) {
        setTunelErro("CSRF indispon\xEDvel \u2014 recarregue a p\xE1gina e tente de novo.");
        return;
      }
      const nonce = r.dados.nonce;
      if (r.status === 200 && r.dados.passo === "confirmar" && typeof nonce === "string" && nonce.length > 0) {
        nonceTunelRef.current = nonce;
        setConfirmacaoTunel(acao);
        return;
      }
      setTunelErro(mensagemDeErroTunel(r));
    } finally {
      setTunelEmVoo(false);
    }
  }, []);
  const desligarTunel = React.useCallback(() => {
    setTunelErro(null);
    setConfirmacaoTunel("desligar");
  }, []);
  const confirmarTunel = React.useCallback(async () => {
    const acao = confirmacaoTunel;
    if (acao === null) return;
    let r;
    if (acao === "desligar") {
      r = await apiPost("/stop", {}, document);
    } else {
      const nonce = nonceTunelRef.current;
      r = nonce !== null ? await apiPost(acao === "ligar" ? "/start/confirm" : "/reset/confirm", { nonce }, document) : { status: 0, dados: {}, csrfIndisponivel: true };
    }
    nonceTunelRef.current = null;
    setConfirmacaoTunel(null);
    if (!vivo.current) return;
    if (r.csrfIndisponivel) {
      setTunelErro("CSRF indispon\xEDvel \u2014 recarregue a p\xE1gina e tente de novo.");
      return;
    }
    if (r.status === 200) {
      setTunelErro(null);
      await buscarTunel();
      return;
    }
    setTunelErro(mensagemDeErroTunel(r));
  }, [confirmacaoTunel, buscarTunel]);
  const aoConfirmarTunel = React.useCallback(() => {
    if (confirmandoTunel) return;
    setConfirmandoTunel(true);
    void confirmarTunel().finally(() => {
      if (vivo.current) setConfirmandoTunel(false);
    });
  }, [confirmandoTunel, confirmarTunel]);
  const pedirPassosDoBot = React.useCallback(async () => {
    if (!vivo.current) return;
    setPassosErro(null);
    setPassosEmVoo(true);
    try {
      const r = await apiPost("/telegram/click", {}, document);
      if (!vivo.current) return;
      if (r.csrfIndisponivel) {
        setPassosErro("CSRF indispon\xEDvel \u2014 recarregue a p\xE1gina e tente de novo.");
        return;
      }
      if (r.status !== 200 || !Array.isArray(r.dados.passos)) {
        setPassosErro(mensagemDeErroTunel(r));
        return;
      }
      const passos = r.dados.passos.filter(
        (p) => p !== null && typeof p === "object" && typeof p.titulo === "string" && typeof p.texto === "string"
      );
      setPassosBot(passos);
      setPassosAbertos(true);
    } finally {
      setPassosEmVoo(false);
    }
  }, []);
  const recarregarTudo = React.useCallback(async () => {
    await Promise.all([buscarToken(), buscarTelegrama(), buscarPrivacidade(false), buscarAgentes(), buscarTunel()]);
  }, [buscarToken, buscarTelegrama, buscarPrivacidade, buscarAgentes, buscarTunel]);
  const sondarPareado = React.useCallback(async () => {
    if (!vivo.current) return;
    let estado;
    try {
      estado = await apiGet("/pair-state");
    } catch {
      return;
    }
    if (!vivo.current) return;
    if (estado.pareado) {
      setPareado(true);
      setPar({ fase: "pareado" });
      if (sondaParRef.current !== null) {
        window.clearInterval(sondaParRef.current);
        sondaParRef.current = null;
      }
      return;
    }
  }, []);
  React.useEffect(() => {
    if (par.fase === "ocioso" || par.fase === "pareado" || par.fase === "expirou") return;
    if (sondaParRef.current !== null) return;
    sondaParRef.current = window.setInterval(() => {
      void sondarPareado();
    }, 3e3);
    return () => {
      if (sondaParRef.current !== null) {
        window.clearInterval(sondaParRef.current);
        sondaParRef.current = null;
      }
    };
  }, [par.fase, sondarPareado]);
  const gerarCodigo = React.useCallback(async () => {
    if (!vivo.current) return;
    setPar({ fase: "gerando" });
    const r = await apiPost("/pair", {}, document);
    if (!vivo.current) return;
    if (r.csrfIndisponivel) {
      setPar({ fase: "erro", mensagem: "CSRF indispon\xEDvel \u2014 recarregue a p\xE1gina e tente de novo." });
      return;
    }
    if (r.status === 200) {
      const codigo = typeof r.dados.codigo === "string" ? r.dados.codigo : "";
      const expiraEm = typeof r.dados.expiraEm === "number" ? r.dados.expiraEm : 0;
      if (codigo.length === 0 || expiraEm <= 0) {
        setPar({ fase: "erro", mensagem: "O servidor respondeu sem c\xF3digo. Tentou gerar de novo." });
        return;
      }
      setPar({ fase: "codigo", codigo, expiraEm });
      await sondarPareado();
      return;
    }
    const mensagem = typeof r.dados.mensagem === "string" && r.dados.mensagem.length > 0 ? r.dados.mensagem : "N\xE3o foi poss\xEDvel gerar o c\xF3digo. Tente de novo.";
    setPar({ fase: "erro", mensagem });
    if (r.status === 409 && r.dados.erro === "ja-pareado") {
      setPareado(true);
      await recarregarTudo();
    }
  }, [sondarPareado, recarregarTudo]);
  const novoCodigo = React.useCallback(() => {
    setPar({ fase: "ocioso" });
  }, []);
  (0, import_react.useEffect)(() => {
    vivo.current = true;
    void recarregarTudo();
    return () => {
      vivo.current = false;
    };
  }, [recarregarTudo]);
  (0, import_react.useEffect)(() => {
    const t = window.setInterval(() => setAgora(Date.now()), 1e3);
    return () => window.clearInterval(t);
  }, []);
  (0, import_react.useEffect)(() => {
    const t = window.setInterval(() => {
      void recarregarTudo();
    }, 5e3);
    return () => window.clearInterval(t);
  }, [recarregarTudo]);
  (0, import_react.useEffect)(() => {
    const aoFocus = () => {
      void recarregarTudo();
    };
    const aoVisivel = () => {
      if (document.visibilityState === "visible") void recarregarTudo();
    };
    window.addEventListener("focus", aoFocus);
    document.addEventListener("visibilitychange", aoVisivel);
    return () => {
      window.removeEventListener("focus", aoFocus);
      document.removeEventListener("visibilitychange", aoVisivel);
    };
  }, [recarregarTudo]);
  const enviarToken = async (e) => {
    e.preventDefault();
    const bruto = valor.trim();
    if (bruto.length === 0) {
      setFeedback({ tipo: "erro", texto: "Digite a chave do bot antes de validar." });
      return;
    }
    setEnviando(true);
    setFeedback(null);
    const r = await apiPost("/token", { token: bruto }, document);
    setEnviando(false);
    if (!vivo.current) return;
    if (r.csrfIndisponivel) {
      setFeedback({ tipo: "erro", texto: "CSRF indispon\xEDvel \u2014 recarregue a p\xE1gina e tente de novo." });
      return;
    }
    switch (r.status) {
      case 200: {
        const handle = typeof r.dados.handle === "string" && r.dados.handle.length > 0 ? r.dados.handle : null;
        setValor("");
        setMostrarToken(false);
        setTrocarTokenAberto(false);
        setFeedback({ tipo: "ok", texto: handle ? `Configurado \u2713 @${handle}` : "Configurado \u2713" });
        await recarregarTudo();
        void buscarPrivacidade(true);
        break;
      }
      case 400: {
        const erro = r.dados.erro;
        setFeedback({
          tipo: "erro",
          texto: erro === "formato-invalido" ? rotulos.formatoInvalido : "Token vazio \u2014 cole a chave antes de validar."
        });
        break;
      }
      case 409: {
        const aviso = typeof r.dados.aviso === "string" ? r.dados.aviso : "";
        setFeedback({
          tipo: "aviso",
          texto: aviso.length > 0 ? aviso : rotulos.envManda
        });
        await recarregarTudo();
        break;
      }
      case 422: {
        setFeedback({
          tipo: "erro",
          texto: rotulos.tokenRecusado
        });
        break;
      }
      default: {
        setFeedback({
          tipo: "erro",
          texto: r.status === 0 ? "Sem liga\xE7\xE3o ao Telegram. Verifica a rede e tenta de novo." : "O servidor n\xE3o respondeu \u2014 recarregue a p\xE1gina e tente de novo."
        });
      }
    }
  };
  const revisarToken = React.useCallback(() => {
    setFeedback(null);
    setTrocarTokenAberto(true);
    requestAnimationFrame(() => inputTokenRef.current?.focus());
  }, []);
  const abrirTrocar = React.useCallback(() => {
    setConfirmacao(null);
    setFeedback(null);
    setTrocarTokenAberto(true);
  }, []);
  const confirmar = React.useCallback(() => {
    const tipo = confirmacao;
    if (tipo === null) return;
    if (tipo === "trocar") {
      abrirTrocar();
    } else {
      setConfirmacao(null);
    }
    void recarregarTudo();
    void buscarPrivacidade(true);
  }, [confirmacao, abrirTrocar, recarregarTudo, buscarPrivacidade]);
  const rotulos = rotulosDoProvider(provider);
  const chip = chipDoBot(token, telegrama, provider);
  const configurado = token?.configurado === true;
  const handleChave = token?.handle;
  const rotuloHandle = handleChave && handleChave.length > 0 ? `@${handleChave}` : "o bot";
  const passo1Aberto = !configurado || trocarTokenAberto;
  const cartaoToken = h(
    "div",
    { className: "guard-card" },
    h(CabecalhoPasso, { indice: 1, titulo: "Criar o bot", concluido: configurado }),
    h(CartaoTokenForm, {
      valor,
      mostrarToken,
      enviando,
      feedback,
      inputRef: inputTokenRef,
      rotulos,
      aoMudar: setValor,
      aoAlternarMostrar: () => setMostrarToken((v) => !v),
      aoEnviar: enviarToken,
      aoRevisar: revisarToken
    }),
    h(Detalhes, { resumo: "Como criar o bot do zero" }, h(BotaoBotFatherDetalhado, { rotulos })),
    !configurado ? paragrafo("guard-step-hint", "Depois disto, avan\xE7as para o Passo 2: parear.") : null
  );
  const passo1Concluido = configurado && !trocarTokenAberto ? h(PassoConcluido, {
    resumo: `Bot ${rotuloHandle} conectado`,
    aoAcao: abrirTrocar,
    rotuloAcao: "Trocar"
  }) : null;
  const passo2 = configurado && !pareado ? h(
    "div",
    { className: "guard-card" },
    h(CabecalhoPasso, { indice: 2, titulo: "Parear", concluido: false }),
    h(CartaoParear, {
      handle: handleChave ?? void 0,
      estado: par,
      pareado,
      agora,
      rotulos,
      aoGerar: () => void gerarCodigo(),
      aoNovoCodigo: () => novoCodigo()
    })
  ) : null;
  const passo2Concluido = pareado ? h(
    "div",
    { className: "guard-card guard-step-done" },
    h(
      "span",
      { className: "guard-card-title" },
      h("span", { className: "guard-step-check", "aria-hidden": "true" }, "\u2713"),
      "Pareado"
    ),
    paragrafo("guard-intro", "Pareado! Este painel agora controla o bot. Vai ao Passo 3 para come\xE7ar.")
  ) : null;
  const passo3 = pareado ? h(
    "div",
    { className: "guard-card" },
    h(CabecalhoPasso, { indice: 3, titulo: "Usar", concluido: false }),
    // Comandos essenciais — 3 linhas, uma ideia cada.
    h("span", { className: "guard-block-title" }, "Comandos essenciais"),
    h(
      "ul",
      { className: "guard-steps" },
      COMANDOS_ESSENCIAIS.map(
        (bloco, i) => h("li", { className: "guard-step", key: i }, h(LinhaDeComando, { bloco }))
      )
    ),
    // Avançado (dobrado): trocar token / desfazer parear / todos os comandos.
    h(
      Detalhes,
      { resumo: "Avan\xE7ado" },
      h(
        "ul",
        { className: "guard-links" },
        h(
          "li",
          null,
          h(
            "button",
            { type: "button", className: "guard-link", onClick: () => setConfirmacao("trocar") },
            "Trocar o token"
          )
        ),
        h(
          "li",
          null,
          h(
            "button",
            { type: "button", className: "guard-link", onClick: () => setConfirmacao("desfazer") },
            "Desfazer parear"
          )
        )
      ),
      h("span", { className: "guard-block-title" }, "Ver todos os comandos"),
      h(
        "ul",
        { className: "guard-steps" },
        COMANDOS_DE_USO.map(
          (bloco, i) => h("li", { className: "guard-step", key: i }, h(LinhaDeComando, { bloco }))
        )
      )
    ),
    // E minha conversa? (privacidade, dobrada) — migrada do bloco solto.
    h(CartaoPrivacidadeCkpt3, {
      estado: privacidade,
      rotulos,
      aoVerificar: () => void buscarPrivacidade(true)
    })
  ) : null;
  const caixaConfirmacao = confirmacao !== null ? CartaoConfirmacao({
    tipo: confirmacao,
    aoConfirmar: confirmar,
    aoCancelar: () => setConfirmacao(null)
  }) : null;
  const cartaoTunel = h(CartaoTunel, {
    tunel,
    agora,
    erro: tunelErro,
    emVoo: tunelEmVoo,
    aoLigar: () => void abrirTunel("ligar"),
    aoDesligar: desligarTunel,
    aoRepor: () => void abrirTunel("repor"),
    passos: passosBot,
    passosAbertos,
    passosEmVoo,
    passosErro,
    aoPassos: () => void pedirPassosDoBot(),
    aoAlternarPassos: setPassosAbertos
  });
  const caixaConfirmacaoTunel = confirmacaoTunel !== null ? h(CartaoConfirmacaoTunel, {
    acao: confirmacaoTunel,
    confirmando: confirmandoTunel,
    aoConfirmar: aoConfirmarTunel,
    aoCancelar: () => {
      if (confirmandoTunel) return;
      nonceTunelRef.current = null;
      setConfirmacaoTunel(null);
    }
  }) : null;
  const blocoAgentes = h(CartaoAgentes, {
    estado: agentes,
    erro: agentesErro,
    cancelandoId,
    agora,
    aoCancelar: (id) => void cancelarAgente(id)
  });
  return h(
    "div",
    { className: "guard-section" },
    // --- Bloco de marca (logo do plugin) --------------------------------
    h(
      "div",
      { className: "guard-brand" },
      h("img", { className: "guard-logo", src: logo_default, alt: "dsh-guard-messenger" })
    ),
    // --- Título + chip de estado ----------------------------------------
    h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
      h("h2", { className: "guard-title", style: { margin: 0 } }, "Remote Access"),
      h(Chip, { chip })
    ),
    paragrafo("guard-intro", rotulos.acessoIntro),
    tokenErro ? paragrafo("guard-error", tokenErro) : null,
    // --- A TRILHA (só o passo atual aberto) -----------------------------
    passo1Aberto ? cartaoToken : passo1Concluido,
    passo2,
    passo2Concluido,
    passo3,
    caixaConfirmacao,
    // --- TÚNEL + instruções do bot (o ex-bloco da home) -----------------
    cartaoTunel,
    caixaConfirmacaoTunel,
    blocoAgentes
  );
}
function CartaoTokenForm(props) {
  const mostraErro = props.feedback !== null && props.feedback.tipo === "erro";
  return h(
    "form",
    { className: "guard-field", onSubmit: props.aoEnviar },
    paragrafo("guard-intro", props.rotulos.coleToken),
    h("label", { className: "guard-field-label", htmlFor: "guard-token-input" }, props.rotulos.rotuloCampoToken),
    h(
      "div",
      { className: "guard-input-wrap" },
      h("input", {
        id: "guard-token-input",
        className: "guard-input",
        ref: props.inputRef,
        type: props.mostrarToken ? "text" : "password",
        value: props.valor,
        autoComplete: "off",
        spellCheck: false,
        placeholder: props.rotulos.tokenPlaceholder,
        onChange: (e) => props.aoMudar(e.target.value)
      }),
      h("button", {
        type: "button",
        className: "guard-toggle",
        "aria-label": props.mostrarToken ? "Ocultar token" : "Mostrar token",
        onClick: props.aoAlternarMostrar
      }, props.mostrarToken ? "\u{1F648}" : "\u{1F441}")
    ),
    h(
      "div",
      { className: "guard-actions" },
      h(
        "button",
        { type: "submit", className: "guard-btn guard-btn-primary", disabled: props.enviando },
        props.enviando ? props.rotulos.conectando : "Salvar bot"
      ),
      mostraErro ? h(
        "button",
        { type: "button", className: "guard-btn guard-btn-outline", onClick: props.aoRevisar },
        "Revisar token"
      ) : null
    ),
    props.feedback ? h("p", {
      className: props.feedback.tipo === "ok" ? "guard-success-text" : props.feedback.tipo === "erro" ? "guard-error" : "guard-notice"
    }, props.feedback.texto) : null
  );
}
function CartaoConfirmacao({
  tipo,
  aoConfirmar,
  aoCancelar
}) {
  const texto = tipo === "trocar" ? "Trocar o token desliga temporariamente o bot. Continuar?" : "Desfazer o parear fecha o teu acesso pelo bot a partir deste painel. N\xE3o d\xE1 para desfazer sem parear de novo. O painel vai re-verificar o estado do bot. Continuar?";
  const rotulo = tipo === "trocar" ? "Trocar token" : "Desfazer parear";
  return h(
    "div",
    { className: "guard-card guard-confirm" },
    paragrafo("guard-error", texto),
    h(
      "div",
      { className: "guard-actions" },
      h("button", { type: "button", className: "guard-btn guard-btn-primary", onClick: aoConfirmar }, rotulo),
      h("button", { type: "button", className: "guard-btn guard-btn-outline", onClick: aoCancelar }, "Cancelar")
    )
  );
}
function apply(ctx) {
  asegurarCss(document);
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "telegram-guard",
        order: 99,
        label: "Remote Access",
        registrant: "dsh-guard-messenger"
      },
      TelegramGuardSection
    )
  );
}
	return module.exports;
	}
});
//# sourceMappingURL=client.js.map
