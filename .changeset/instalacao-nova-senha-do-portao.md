---
'dsh-guard-messenger': patch
---

O `dsh-guard-setup` agora provisiona e mostra a **senha do portão HTTP** (texto agrupado + QR ASCII, uma única vez) na primeira execução — mesmo sem bot do Telegram configurado — antes de anunciar o passo seguinte do onboarding. Antes, a senha só era mostrada no estado `PRONTO` (Telegram pareado), o que deixava uma instalação nova sem bot trancada no portão `401` sem qualquer forma de obter a senha, contradizendo o `INSTALL.md` (Passo 4: o portão funciona só com a senha, sem Telegram). `hasSecret()` mantém a idempotência (TG-067) e `rotate()` continua fora do CLI. INSTALL.md ganhou o Passo 2.5 documentando a obtenção da senha via `dsh-guard-setup`.