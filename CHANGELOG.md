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
- 1027db7: Exemplo de changeset para a release 0.1.0 (primeira publicacao publica do plugin:
  0.1.x e o ramo de versao enquanto o DSH estiver em developer preview, ver
  docs/plano/06-REPO-E-CI.md secao 7.3).
  
  Regras do changeset neste repositorio:
  - cada PR que mexe no produto (src/, worker/, test/, cordis.patch.yml) DEVE trazer
    um ficheiro `.changeset/*.md` com um bump explicitamente escolhido — `patch`,
    `minor` ou `major` — porque `1.0.0` so e promessa, nao inferencia de prefixo de
    commit (06-REPO-E-CI.md secao 7.2).
  - em `0.x` o `minor` e o bump que quebra instalacao existente; `patch` e o que
    nao quebra (adaptacao a nova rc do DSH, feature retrocompativel, correcao de
    seguranca).

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
