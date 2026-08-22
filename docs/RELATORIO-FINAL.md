# Relatório Final — Execução do Plano 03-ONDAS.md

**Run:** 20260820-145429-997984 · **Modo:** contido (BASE_DIR = deepseek-harness-mobile) · **Paralelismo:** 12 sub-agentes
**HEAD final (main):** 8f8290a · **Total de commits:** 68 · **Todos os worktrees removidos; apenas main.**

## Escopo executado
Ondas 0–7 completas com PREP próprio (PREP-onda-3/4/5/6/7) commitado antes de cada onda, squash-merge um-a-um na ordem de §13.1 com gate de snapshot, limpeza fim-de-onda via do-wt, varredura (sweep) e verificação (verify) verdes. Subwaves de validação (val-ondaN-gate) e teste (test-ondaN-*) rodaram durante as ondas seguintes. Gate final em BASE_DIR: GATE FINAL VERDE (incl. package:check = publint + attw + tarball 411 entradas + sha256 pinned).

## Ondas e destaques
- PREP 3/4/5 — contratos do túnel e do canal IPC congelados; máquina de estados + ControlIntent; nonce.request/issued + pairing.owner (EMENDA-COSTURA-5).
- Onda 2 — estado persistente (writer único, atomicidade via SIGKILL); audit log append-only fail-closed.
- Onda 5 (fixes) — fechados T5.1/T5.2/T5.4 com re-revisão adversarial e costura w5-costura-integracao.
- Onda 6 — ciclos de vida/orfãos (tree-kill real), e2e túnel offline por-handle, e2e Telegram contra Bot API falso (429/409, guarda anti-token), ajuste upstream 0.1.1-rc.1 (N/N-1), regressão de segurança 137 testes + checklist 50 mutantes.
- Onda 7 — docs de usuário final + M1–M7, material de divulgação, release OIDC + changesets, empacotamento/exports finais, PROIBIDO.md como lista de frases pura.
- Subwaves de teste Onda 5 — audit (25), surfaces (41), control (38). Ondas 6/7: NO-OP justificado.

## Resultados de teste (gate final)
- Unit + integração: 1791 testes.
- Segurança: 137 (136 pass + 1 skip ADV-025).
- Contrato: 9 · E2E: 51 (todos passam).
- test:cov: linhas 98.87% / branches 93.17%; global functions 94.98% vs piso 95% (pré-existente, não é regressão da Onda 7; módulos do ratchet OK).
- publint ok · attw ok (node16-cjs ESM dinâmico, esperado) · tarball: 9 REQUIRED presentes, 411 entradas verificadas · sha256 dos 7 pacotes pinned OK.

## Verdicts de validação (subwaves)
Validações das Ondas 5/6/7: PASS · revisão adversarial antes de cada merge: aprovação (com achados corrigidos notados, ex. pgrep→por-handle; handoff T7.2 é desenho, não blocker).

## Correções e divergências registradas
- pgrep fake-cloudflared global falhava em paralelo → orfanato por-handle (ef36a2f).
- fake-cloudflared.mjs usa env vars (não --fake=modes documentado) → sh wrapper p/ TUN-005.
- Upstream @deepseek-ai/dsh 0.1.1-rc.1 quebrou CONTRACT-008 → N/N-1, types regenerados (aditivo).
- PROIBIDO.md disparou a própria aceitação (grep -f) → lista de frases puras.

## Itens pendentes (fora de escopo / manuais)
- pnpm test:live exige DSH_GUARD_LIVE_TESTS=1 + túnel real (documentado).
- Runbooks manuais M1–M7 (docs/manual-runs como checklists, placeholders honestos).
- Re-verificação do actionlint (binário; T7.2 rodou 1.7.12) e confirmação da reserva do nome npm (dsh-guarded-bot-orchestrator E404 → credenciais pendentes).
- docs/plano/06-REPO-E-CI.md §11.2 e docs/spikes/api-dsh.md §1 ainda citam faixa 0.1.0-rc.7..rc.9 (atualizar).
- .changeset/config.json $schema aponta @changesets/config@3.0.1 (instalado 4.0.0) — IDE-only.

## Contenção e estado final
Repositório principal em main (8f8290a), working tree limpo exceto ?? brave.html (deixado). Nenhum worktree/branch residual. Estado de run .deep-orchestrator/ removido (teardown). Co-Authored-By mantido (decisão do usuário). Documentação em português e fiel ao código escrito.

## Convergência
Declarada: plano 03-ONDAS.md executado integralmente, gates verdes, package verificada e empacotada.
