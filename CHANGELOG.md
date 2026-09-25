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
  no repositório pertencem só a quatro classes de exceções, nomeadas e verificáveis — e o
  `grep -ri discord` devolve **exactamente** estas classes (nem mais, nem menos):
  **(a) registos desta remoção** (a decisão e o seu histórico): `.changeset/**` — hoje
  `remocao-provedor-discord.md`, incluindo o nome do ficheiro — e este changelog
  (`CHANGELOG.md`); **(b) strings de guarda anti-regressão** que nomeiam o que proíbem (3 paths
  exatos): `FORBIDDEN_PREFIXES` e o cabeçalho de `scripts/check-tarball.mjs`, a anotação
  `"//scripts"` do `package.json` e o teste `test/unit/scripts/release-artefacts.test.ts`;
  **(c) arquivo histórico de planeamento** (nunca foi doc atual): `docs/plano/**` (inclui
  `docs/plano/manifesto.md`), `docs/spikes/**`, `docs/manual-runs/**`, `docs/RELATORIO*`,
  `docs/mutantes.md`; **(d) o ficheiro do próprio guarda**,
  `test/unit/estrutural/golden-master.test.ts`, que precisa do nome para o procurar e dos paths
  das classes para as nomear (auto-isenção, agora nomeada). Fora destas classes não resta
  qualquer menção — e o recorte desta promessa é a **árvore versionada**. **Fora do recorte**
  `node_modules/**` · `.git/**` · `.deep-orchestrator/**` — categorias
  fora do recorte (dependências instaladas, controlo de versão e logs do orquestrador) que o
  grep cru sem exclusões também varre; a contagem nelas NÃO é facto e varia com a
  instalação e com o clone. Os emitidos de build (dist/lib, 457 artefactos rastreados no git
  desde o fix da instalação) passam a ser VARRIDOS pelo guarda desde esta versão: o texto
  compilado não pode trazer a literal de volta e um artefacto que a contenha é um achado a
  reportar, nunca uma isenção. Facto estável, o único número desta promessa: git grep -il discord na
  árvore versionada devolve **10** ficheiros, exactamente as classes (a)-(d) acima (a verificação
  `git grep -il discord | wc -l` dá 10 — número com asserção no guarda —, e o mesmo sai de
  `grep -ril discord . --exclude-dir=node_modules --exclude-dir=.deep-orchestrator
  --exclude-dir=.git`). O guarda
  `test/unit/estrutural/golden-master.test.ts` impõe este texto em `pnpm test` nos DOIS sentidos —
  toda a isenção que ele concede está aqui nomeada (caso «lockstep») e toda a classe aqui nomeada
  tem isenção viva no guarda — e qualquer menção nova fora das classes reprova — incluindo nos emitidos de build dist/lib,
  agora varridos, e nas variantes obfuscadas (dis-cord, dis cord) —, **excepto nos
  formatos que o guarda não varre**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.svg`,
  `.tgz`, `.gz`, `.zip`, `.woff`, `.woff2`, `.ttf`, `.otf`, `.pdf`, `.lock`, `.tsbuildinfo`
  (logos, tarballs, fontes e artefactos de build; `.svg` e `.lock` são textuais e ficam de fora
  por decisão — uma menção aí não é vista pelo golden master).

  **Pendências transitórias — RESOLVIDAS nesta versão:** existiram duas menções transitórias e
  ambas estão resolvidas antes do release: (1) um comentário em código vivo de
  `worker/providers/telegram/parse.ts` citava o nome do provedor removido — reescrito pelo fix
  que entrou nesta mesma versão (`grep -ri discord worker/providers/telegram/parse.ts` vazio);
  (2) o seu eco compilado em `dist/worker/providers/telegram/parse.js` (produto de build, hoje
  rastreado no git desde o fix da instalação) — o `clean` determinístico do `build:all` recompila
  sempre para uma árvore limpa, e
  o que sobrar é build stale que o golden master reprova —
  os emitidos de build passaram a ser varridos. Não há pendências: se o `grep -ri discord` voltar
  a encontrar o nome fora das classes acima — incluindo nos artefactos compilados, que o guarda
  agora varre —, o golden master reprova o `pnpm test`.

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
- **Comandos de tarefas — chats e worktrees reais do harness pelo bot.**
  `/novo-chat <prompt>` e `/novo-chat-wt <worktree> <prompt>` abrem **sessões
  reais do DSH** com o prompt submetido (confirmação em 2 etapas; prompt
  saneado para uma linha e cortado em 4096; o `<worktree>` tem de já existir,
  criado pelo `/worktree`); `/worktree <nome> [base]` cria uma **worktree git**
  `guard/<nome>` em `<repo>-worktrees/<nome>` (default `HEAD`) sem nunca
  destruir o que exista; `/status-tarefa <id>` mostra o detalhe de um run com
  as **métricas reais** do harness (12 campos — session-stats para
  contagens/tempos, `TokenUsage` dos eventos para tokens; não medido = `—`,
  nunca estimado). `/agentes` passa a listar agentes, chats e worktrees com
  métrica resumida (`kind`, `wt: <nome>`, tokens/ tempo). Os comandos novos
  entram no texto de `/ajuda`; a lista publicada continua `/menu`, `/parear`,
  `/ajuda`. Manual: `docs/AGENTS.md` §4b; textos exatos:
  `docs/ux/01-CONTRATO-BOT.md` §11.

### Patch

- **Repositório renomeado e documentação alinhada com o código.** O
  repositório git passou a `github.com/frederico-kluser/dsh-guard-messenger`
  (URLs atualizadas em README, SECURITY.md, templates de issue e docs; o
  redirect do GitHub cobre o slug antigo). Docs corrigidos para o estado real:
  menu publicado com 3 comandos, `/agentes` com métricas, comandos de tarefa, e
  a faixa `@deepseek-ai/dsh` `0.1.0-rc.7 .. 0.1.1-rc.1` alinhada nos sete
  lugares (scripts, headers de `types/`, `dsh-compat.yml`, README, INSTALL,
  COMPATIBILITY, SECURITY) — **sem alargar**: `0.1.5-rc.x` foi medido
  incompatível (`SubprocessHandle.pid` removido), decisão em
  `docs/plano/06-REPO-E-CI.md` §11.2 (canário `CONTRACT-008` vermelho por
  decisão). Notas de migração `**SECURITY: exige ação do utilizador
  (migração):**` espelhadas em `docs/INSTALL.md` e `docs/TROUBLESHOOTING.md`
  para quem tem `worker.provider` herdado de uma versão antiga (remover a linha
  ou usar `'telegram'`; o boot falha alto em vez de degradar). Instalação pelo
  link do repositório confirmada: `dsh plugin add
  github:frederico-kluser/dsh-guard-messenger` (install-by-link sem
  `allowBuilds`; nota de release: só funciona após o push deste ramo).
- **Fix do install-by-link — `dsh plugin add
  github:frederico-kluser/dsh-guard-messenger` passa a funcionar sem
  `allowBuilds`.** Remoção dos hooks `prepare`/`prepack` (o pnpm 11 bloqueia
  build de dependências git — `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, que era
  exactamente o que impedia o install-by-link; medido: o `prepack` sozinho já
  bloqueava) e artefactos compilados `dist/`+`lib/` **commitados no git** (o
  artefacto de um git-dep só leva o que está no git — o padrão do
  `dsh-worktree-jump`). Novo gate `scripts/check-git-install.mjs` incluído no
  `package:check` (prova a instalação por link de ponta a ponta; guarda de
  regressão em `test/unit/scripts/install-by-link.test.ts`); URLs
  `repository`/`bugs`/`homepage` do `package.json` atualizadas para o
  repositório novo. `prepublishOnly` mantém-se como hook de release. **Não
  exige ação do utilizador** (é fix); para quem chega pelo erro:
  `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` resolve-se sem `allowBuilds` a partir
  desta versão. Nota de release: o install-by-link só funciona depois de este
  ramo estar pushado no GitHub — enquanto o repositório servir a árvore antiga
  (com `prepare`), o erro persiste.

## [0.1.0] - 2026-08-22

- Primeira publicação do `dsh-guarded-bot-orchestrator` v0.1.0 no npm (registry npmjs.org, tag `latest`). (hoje: `dsh-guard-messenger` — o pacote foi renomeado a partir da 0.1.1.)

### Adicionado

- **Plugin Cordis** que expõe o teu próprio DeepSeek Harness pela internet através de um túnel efémero protegido por senha — sem nunca alargar o bind para fora do loopback.
- **Senha gerada pela máquina** (CSPRNG, 256 bits) e entregue **uma única vez** no terminal (texto + QR); em disco fica só o digest SHA-256.
- **Bind travado em loopback** — a recusa de bind fora de `127.0.0.1` acontece no carregamento, com falha ruidosa.
- **Portão de autenticação** que exige credencial em `/api`, no fallback da SPA e no handshake de WebSocket, com ordem origem → `Host` → credencial.
- **Túnel efémero** com TTL que o derruba sozinho e *probe fail-closed* que impede um túnel "nu" (sem portão atrás).
- **Ligar/desligar pelo Telegram ou painel** — o botão de matar para revogar a exposição em um comando.
