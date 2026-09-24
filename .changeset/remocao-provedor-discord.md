---
'dsh-guard-messenger': minor
---

Remoção do provedor Discord — o plugin fica **só Telegram**. São apagados o adaptador `worker/providers/discord/**`, os testes/dublês/e2e do Discord (`test/unit/worker/providers/discord/**`, `test/e2e/discord-*`, `test/support/discord-server.mjs`, `test/support/fixtures/discord/**`), a doc `docs/ONBOARDING-DISCORD.md` e todas as menções a Discord em código, configuração, docs atuais e skills do repo. O `ProviderId` (host e worker) passa a ser `'telegram'` e `worker.provider` aceita só o literal `'telegram'`. A arquitetura multi-provedor **mantém-se**: o registry continua uma tabela fechada e fail-closed (`DSH_GUARD_PROVIDER` ausente/vazio → `telegram`; desconhecido → `ProvedorDesconhecidoError`, nunca degrada em silêncio). Para quem usa o Telegram **nada muda**: mesmo token (`TELEGRAM_BOT_TOKEN`), mesmo pareamento, mesmos comandos.
