---
"dsh-guarded-bot-orchestrator": patch
---

Correção do boot sem token do Telegram (commits bdb128f/b1e2da2).

Instalação nova seguindo docs/INSTALL.md (add → `dsh web`, sem `TELEGRAM_BOT_TOKEN`)
falhava porque src/config/assert.ts recusava `worker.token` vazio, contradizendo o
contrato do `cordis.patch.yml` (vazio = "telegram não configurado" = arranca).

Agora token vazio/ausente é válido: o Telegram fica desativado, com a mensagem
"telegram: não configurado — rode /parear <código> no bot". Token não-string
continua a ser recusado, e o worker do Telegram só é iniciado quando há token
presente. +4 testes.