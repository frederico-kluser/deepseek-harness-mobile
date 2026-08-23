# Rascunho do PR — entrada na awesome-dsh-plugin

> **Estado:** RASCUNHO. A divulgação é ação humana posterior (07-COMUNIDADE §5): a fase
> pública SÓ acontece com este PR merged — antes disso o plugin não é instalável pelo
> dsh-market (o registro restringe instalações às fontes da lista; 08 §6.1, confiança
> Alta).
>
> **Gate do registro (07 §7.1):** descrição factual sem adjetivo, com números
> sustentados pelo código; install no formato canônico; diferenciais vs.
> dsh-webui-auth articulados e verificáveis; nenhuma afirmação da tabela 07 §14.
>
> **Reprovações automáticas a evitar:** superlativos (a lista "verifica cada número da
> descrição contra o código: Overstating is the one thing that gets an otherwise-good
> plugin sent back", 08 §6.3), descrição que promete o que o código não faz, e as
> condições automáticas de repo (< 1 dia / < 10 commits — ambas satisfeitas).

---

## Entrada proposta (linha única do registro)

DSH | dsh-guard-messenger | Expõe a Web UI do DSH por um túnel Cloudflare
efêmero sem alargar o bind de loopback: acesso local aberto; túnel protegido por chave no
link `?key=` (reutilizável, revogável); liga/desliga pelo bot do Telegram.

> A linha é a versão revisada de 07-COMUNIDADE §8.2 (zero adjetivo, cada afirmação
> verificável). Contém números/ordens rastreáveis a código (ver §Verificação) e nenhum
> número de expectativa de mercado (a mediana de estrelas não entra na entrada).

---

## Corpo do PR (para o mantenedor / reviewer)

**O quê:** plugin Cordis que serve a Web UI do DeepSeek Harness por um túnel
Cloudflare efêmero sem alargar o socket de loopback: acesso local aberto, o túnel
protegido por chave no link (`?key=`) e controle por um bot do Telegram.

**Aplicação:** dono único, máquina de desenvolvimento local.

**Install (formato canônico das 1.650 entradas, 08 §8:43):**

    dsh plugin --profile web add dsh-guard-messenger

### Por que entra (diferenciais verificáveis)

O plugin já listado dsh-webui-auth (~7★) cobre "WebUI authentication enforced at the
HTTP/transport layer: four-layer login gate (resources, plugin bundles, /api,
WebSocket)" (08 §6.1). A regra da lista é "whoever got here first keeps the slot — but
that is a tiebreaker, not tenure (…) the rule is whichever is better" (08 §6.1). Como o
nicho de auth já está ocupado, a entrada articula os diferenciais desta implementação,
cada um verificável no código deste repo:

| Diferencial | Onde está no código |
| --- | --- |
| Intercepta o handshake de upgrade de WebSocket (não só rotas HTTP) | src/http/intercept.ts captura o listener `upgrade` do servidor (L73/L110) e agrega register/registerFallback/registerUpgrade (L37); `Origin` fora da allowlist no upgrade → 403 em src/http/session-auth.ts (L170) |
| Allowlist do endereço de bind (a interface onde o servidor escuta), distinta de trustedRemotes (a origem de cada pedido) | src/config/bind.ts (allowedHosts) vs. src/config/schema.ts (trustedRemotes); falha ruidosa no load se o bind sair da allowlist |
| 403 antes de 401 — origem não confiável não chega a ver o desafio | src/http/gate.ts (L2 trustedRemotes → 403); src/ui-contrib/routes.ts: "403, nunca 401: o token não é credencial" |
| Veto de elevação para danger-full-access no load | src/permissions/deny.ts (normalização anti-bypass do token); src/index.ts veta a elevação como defesa em profundidade |
| Worker de longa duração sob ctx.effect() com ambiente construído por allowlist | src/proc/env.ts (WORKER_ENV_ALLOWLIST + prefixes; o token do bot entra por env, nunca por argv); src/index.ts instancia o processo do bot dentro de ctx.effect() com disposer síncrono |
| Ciclo de vida do túnel (abrir/fechar) como operação de primeira classe, com tree-kill real do grupo | src/proc/tree-kill.ts (process.kill(-pid, sig) / taskkill /T /F); src/tunnel/supervisor.ts + src/tunnel/pidfile.ts (SIGTERM ao grupo → janela de graça → SIGKILL) |

### Limites que a entrada declara (07 §1.3)

- Dono único: uma allowlist de from.id do Telegram e a chave do link; sem RBAC/multi-tenant.
- Não é produção/uptime: quick tunnel é "testing and development only" e "no SLA"
  (08 §8:7, doc Cloudflare).
- Não é E2E: o TLS termina na borda da Cloudflare.

---

## Verificação (rastreamento número → código/fonte primária)

Regra 1 de docs/PROIBIDO.md e 07 §7.1: qualquer número citado em material público tem
linha correspondente em 08-PESQUISA-E-FONTES §8 com URL e data.

| Número/afirmação | Fonte (§8 = 08-PESQUISA-E-FONTES.md) | Confiança |
| --- | --- | --- |
| 66 commits no repo | git rev-list --count HEAD (2026-08-21, worktree) | Alta (medido) |
| Repo criado em 2026-08-19 | git log --reverse (commit 3bb53ad) | Alta (medido) |
| ≥10 commits e ≥1 dia (reprovação automática) | §8:44 — MIN_AGE_DAYS=1, MIN_COMMITS=10 em check-submission.mjs L21-22 | Alta |
| Formato canônico dsh plugin --profile web add <pkg-npm> | §8:43 — contributing.md | Alta |
| Registro restringe instalações às fontes da lista | §6.1 — README do dsh-market; entrada do registro é o portão | Alta |
| ~7★ do dsh-webui-auth, descrição four-layer | §6.1 — plugins.json (2026-08-19) | Alta (na data) |
| Mediana ~2★ / p90 15 / p99 710 (expectativa — não na entrada) | §6.1 — plugins.json | Alta (na data) |

Números de expectativa de adoção (estrelas, downloads) não aparecem na entrada — só na
calibração (docs/divulgacao/calibragem.md).

---

## Checklist de submissão (para o humano; 07 §7.1)

- [ ] B0–B5 resolvidos
- [ ] Descrição de uma linha factual, sem adjetivo, números sustentados pelo código
- [ ] Install no formato canônico exato
- [ ] Diferenciais vs. dsh-webui-auth articulados e verificáveis (§2.1)
- [ ] Nenhuma afirmação de 07-COMUNIDADE §14 no texto
- [ ] PR aberto SÓ após dsh.bundle presente (B1 medido) — feito em package.json (§//dsh)
