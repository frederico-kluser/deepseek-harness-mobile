# 2026-08-22 — registo da instalação e teste numa instância NOVA do DSH

**Resultado global: ✅ (verificação automatizada) — confirmação manual do dono pendente.**

**Ambiente:** Linux (CachyOS, não-root), Node v24.19.0, pnpm 11.7.0.
**Instância alvo:** `deepseek-harness` clonado fresco em `~/dsh-test-instance/harness`
(master `b150a55`, dsh 0.1.1-rc.2), com homes isolados `DSH_HOME=~/dsh-test`
e `DSH_AGENTS_HOME=~/.agents-test` — a instalação REAL do DSH (porta 3080) fica intocada.
**Plugin testado:** `dsh-guarded-bot-orchestrator` v0.1.1 **local** (commit `3233c54`, (hoje: dsh-guard-messenger)
+ .changeset/instalacao-nova-senha-do-portao.md), empacotado via `pnpm pack`.

## (a) Gate local — ✅ (integralmente verde nesta máquina)

| Verificação | Comando | Resultado |
| --- | --- | --- |
| Lint | `pnpm lint` | ✅ 0 erros (109 warnings) |
| Typecheck | `pnpm typecheck` | ✅ ok |
| Build | `pnpm build` | ✅ ok — `dist/{index,bin/dsh-guard-setup}.js` emitidos |
| Unit+Integration | `pnpm test` | ✅ **1796 pass / 0 fail** |
| Security | `pnpm test:security` | ✅ 136 pass / 0 fail (TAP) |
| Contract | `pnpm test:contract` | ✅ 9 pass / 0 fail |
| E2E offline | `pnpm test:e2e` | ✅ 51 pass / 0 fail |

> Nota: a corrida anterior (2026-08-22, outro ficheiro) registava 16+6 falhas —
> todas dependentes do ambiente (root + macOS). Nesta máquina (Linux, não-root)
> a suíte inteira é verde.

## (b) Instalação do plugin — ✅

`pnpm dsh plugin --profile web add <dsh-guarded-bot-orchestrator-0.1.1.tgz>` com
`DSH_HOME=~/dsh-test` (o primeiro boot do `dsh web` provisionou o profile em
`~/dsh-test/profiles/web`). `dsh.profile.bundles` depois do add:

```jsonc
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-guarded-bot-orchestrator"]
```

## (c) Boot sem token do Telegram — ✅ (fix 0.1.1)

`dsh web --host 127.0.0.1 --port 3081 --no-open` arranca sem `TELEGRAM_BOT_TOKEN`:

- portão ativo: `curl -X POST http://127.0.0.1:3081/api/commands/execute` → **401**
  (com `WWW-Authenticate: Basic realm="Secure DSH Interface"`);
- sem o erro de configuração que a 0.1.0 lançava no boot.

## (d) Obtenção da senha — ✅ (fix novo, commit 3233c54)

`dsh-guard-setup` (sem bot configurado) — na 1ª execução **provisiona** a senha
(CSPRNG 256 bits) e mostra-a UMA vez (texto agrupado + QR ASCII), independente do
Telegram; `state.json` ganha `secretDigest` (sha256), `secrets.env`/`pairing`
continuam ausentes; dir de estado `0700`; exit 3 (falta o passo Telegram — esperado).
2ª execução: "já tinha sido gerada e é mostrada uma única vez" (idempotência TG-067).

## (e) Portão com a senha — ✅

| Pedido | Sem credencial | Com a senha |
| --- | --- | --- |
| `GET /` | 401 | **200** |
| `POST /api/commands/execute` | 401 | 415 (falta body JSON — auth ok) |

## Manual do dono (pendente)

1. Abrir `http://127.0.0.1:3081` e entrar com a senha (qualquer utilizador) —
   a senha está em `~/dsh-test-instance/senha-portao.txt` (0600) e foi também
   impressa na 1ª execução do `dsh-guard-setup`.
2. Confirmar que a Web UI carrega atrás do portão.
3. (Opcional) repetir `dsh-guard-setup` num terminal real para ver o QR.
4. (Opcional, fora do escopo da instalação) Telegram + túnel: `docs/ONBOARDING-TELEGRAM.md`.

_Registado por: <nome> — confirmação manual do dono pendente; preencher e assinar após o teste._