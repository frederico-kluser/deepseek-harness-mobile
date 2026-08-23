---
'dsh-guard-messenger': minor
---

Arquitetura de provedores de mensageria: o worker do bot passou a ser **neutro ao provedor** — o
núcleo (roteador comando→intent, allowlist de dois eixos, pareamento, outbox, autolink e
pendentes) vive em `worker/surface/**` e o Telegram, hoje o único fornecedor, está isolado no
**adaptador** `worker/providers/telegram/**` (única carga de `grammY`). O boot é genérico e lê o
provedor ativo por `DSH_GUARD_PROVIDER` (`config.worker.provider`, default `telegram`). Para o
utilizador **nada muda**: o token continua em `TELEGRAM_BOT_TOKEN`, o pareamento e os comandos do
bot são os mesmos. Manual completo com o checklist de um provedor novo em `docs/PROVIDERS.md`.