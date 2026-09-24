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
Todas as mudanças notáveis em `dsh-guard-messenger` são documentadas neste arquivo.

O formato segue [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto adere ao
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

A partir daqui o arquivo é gerido pelo [`@changesets/cli`](https://github.com/changesets/changesets)
(`pnpm changeset add` para registrar; `pnpm changeset version` para consolidar). O conteúdo abaixo da
linha `[Unreleased]` é substituído a cada `changeset version`.

## [Unreleased]

### Minor

- **Remoção do provedor Discord — o plugin fica só Telegram.** Apagados o adaptador
  `worker/providers/discord/**`, os testes/dublês/e2e do Discord, a `docs/ONBOARDING-DISCORD.md`
  e todo o código, funcionalidade, configuração, documentação e skills do Discord. O `ProviderId`
  (host e worker) passa a ser `'telegram'` e `worker.provider` aceita só o literal `'telegram'`.
  A arquitetura multi-provedor mantém-se: o registry continua fechado e fail-closed
  (`DSH_GUARD_PROVIDER` ausente → `telegram`; desconhecido → `ProvedorDesconhecidoError`).
  Para quem usa o Telegram nada muda: mesmo token, pareamento e comandos.

  **Promessa verificável (bitola literal):** o estado final desta versão tem **zero** código,
  funcionalidade, configuração, docs atuais ou skills do Discord. As menções ao nome que persistem
  no repositório pertencem só a duas classes de exceções, nomeadas e verificáveis —
  **(a) registos desta remoção**: este changelog e o `.changeset/remocao-provedor-discord.md`
  (incluindo o nome do ficheiro); **(b) strings de guarda anti-regressão** que nomeiam o que
  proíbem: `FORBIDDEN_PREFIXES` e o cabeçalho de `scripts/check-tarball.mjs`, a anotação
  `"//scripts"` do `package.json` e o teste `test/unit/scripts/release-artefacts.test.ts`. Fora
  destas duas classes — e do arquivo histórico de planeamento `docs/plano/**`, que nunca foi doc
  atual — não resta qualquer menção a Discord (`grep -ri discord` devolve exactamente estas
  exceções, mais uma pendência transitória e o seu eco compilado — ambos nomeados abaixo).

  **Pendências transitórias (condicionais):** a pendência transitória é **uma, com o seu eco
  compilado** — e ambos estão nomeados: (1) o comentário em código vivo de
  `worker/providers/telegram/parse.ts`; (2) o seu eco compilado transitório em
  `dist/worker/providers/telegram/parse.js:328` (produto de build, gitignored e apagado pelo
  `clean` a cada build — por isso invisível num `grep --exclude-dir=dist`). A menção (1) é
  removida por um fix em paralelo que **tem de entrar na mesma versão**; se não entrar, esta
  promessa fica sem efeito e as menções (1) e (2) persistem.

  **SECURITY: exige ação do utilizador (migração):** quem tem `worker.provider: 'discord'` na
  configuração (o `INSTALL.md` antigo ensinava-o) tem de **remover a linha ou mudá-la para
  `'telegram'`** antes do arranque. Sem essa alteração o plugin não arranca: `worker.provider`
  aceita apenas `'telegram'` e o boot falha alto com `config.worker.provider = 'discord' nao e um
  provedor conhecido (telegram)` — fail-loud por decisão (o registry é fechado e não degrada em
  silêncio). Quem já usa só o Telegram nada muda.
- **Arquitetura de provedores de mensageria.** O worker do bot passou a ser **neutro ao provedor**:
  o núcleo (roteador comando→intent, allowlist de dois eixos, pareamento, outbox, autolink e
  pendentes) vive agora em `worker/surface/**`, e o Telegram — hoje o único fornecedor — está
  isolado no **adaptador** `worker/providers/telegram/**` (única carga de `grammY`). O boot é
  genérico e lê o provedor ativo por `DSH_GUARD_PROVIDER` (`config.worker.provider`, default
  `telegram`). Para o utilizador **nada muda**: o token continua em `TELEGRAM_BOT_TOKEN`, o
  pareamento e os comandos do bot são os mesmos. Manual completo com o checklist de um provedor
  novo em `docs/PROVIDERS.md`.

## [0.1.0] - 2026-08-22

- Primeira publicação do `dsh-guarded-bot-orchestrator` v0.1.0 no npm (registry npmjs.org, tag `latest`). (hoje: `dsh-guard-messenger` — o pacote foi renomeado a partir da 0.1.1.)

### Adicionado

- **Plugin Cordis** que expõe o teu próprio DeepSeek Harness pela internet através de um túnel efémero protegido por senha — sem nunca alargar o bind para fora do loopback.
- **Senha gerada pela máquina** (CSPRNG, 256 bits) e entregue **uma única vez** no terminal (texto + QR); em disco fica só o digest SHA-256.
- **Bind travado em loopback** — a recusa de bind fora de `127.0.0.1` acontece no carregamento, com falha ruidosa.
- **Portão de autenticação** que exige credencial em `/api`, no fallback da SPA e no handshake de WebSocket, com ordem origem → `Host` → credencial.
- **Túnel efémero** com TTL que o derruba sozinho e *probe fail-closed* que impede um túnel "nu" (sem portão atrás).
- **Ligar/desligar pelo Telegram ou painel** — o botão de matar para revogar a exposição em um comando.
