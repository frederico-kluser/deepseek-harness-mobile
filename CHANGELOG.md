# Changelog

## 0.1.1

### Patch Changes

- 2d47ab8: Correção do boot sem token do Telegram (commits bdb128f/b1e2da2).
  
  Instalação nova seguindo docs/INSTALL.md (add → `dsh web`, sem `TELEGRAM_BOT_TOKEN`)
  falhava porque src/config/assert.ts recusava `worker.token` vazio, contradizendo o
  contrato do `cordis.patch.yml` (vazio = "telegram não configurado" = arranca).
  
  Agora token vazio/ausente é válido: o Telegram fica desativado, com a mensagem
  "telegram: não configurado — rode /parear <código> no bot". Token não-string
  continua a ser recusado, e o worker do Telegram só é iniciado quando há token
  presente. +4 testes.
Todas as mudanças notáveis em `dsh-guarded-bot-orchestrator` são documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adere ao
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

A partir daqui o arquivo é gerido pelo [`@changesets/cli`](https://github.com/changesets/changesets)
(`pnpm changeset add` para registrar; `pnpm changeset version` para consolidar). O conteúdo abaixo da
linha `[Unreleased]` é substituído a cada `changeset version`.

## [Unreleased]

## [0.1.0] - 2026-08-22

- Primeira publicação do `dsh-guarded-bot-orchestrator` v0.1.0 no npm (registry npmjs.org, tag `latest`).

### Adicionado

- **Plugin Cordis** que expõe o teu próprio DeepSeek Harness pela internet através de um túnel efémero protegido por senha — sem nunca alargar o bind para fora do loopback.
- **Senha gerada pela máquina** (CSPRNG, 256 bits) e entregue **uma única vez** no terminal (texto + QR); em disco fica só o digest SHA-256.
- **Bind travado em loopback** — a recusa de bind fora de `127.0.0.1` acontece no carregamento, com falha ruidosa.
- **Portão de autenticação** que exige credencial em `/api`, no fallback da SPA e no handshake de WebSocket, com ordem origem → `Host` → credencial.
- **Túnel efémero** com TTL que o derruba sozinho e *probe fail-closed* que impede um túnel "nu" (sem portão atrás).
- **Ligar/desligar pelo Telegram ou painel** — o botão de matar para revogar a exposição em um comando.
