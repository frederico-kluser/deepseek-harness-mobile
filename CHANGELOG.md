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
  `node_modules/**` · `.git/**` · `.deep-orchestrator/**` · `dist/**` · `lib/**` — categorias
  não-versionadas (dependências instaladas, controlo de versão, logs do orquestrador e emitidos de
  build) que o grep cru sem exclusões também varre; a contagem nelas NÃO é facto e varia com a
  instalação e com o clone. Facto estável, o único número desta promessa: git grep -il discord na
  árvore versionada devolve **10** ficheiros, exactamente as classes (a)-(d) acima (a verificação
  `git grep -il discord | wc -l` dá 10, e o mesmo sai de `grep -ril discord .
  --exclude-dir=node_modules --exclude-dir=.deep-orchestrator --exclude-dir=dist
  --exclude-dir=lib --exclude-dir=.git`). O guarda
  `test/unit/estrutural/golden-master.test.ts` impõe este texto em `pnpm test` nos DOIS sentidos —
  toda a isenção que ele concede está aqui nomeada (caso «lockstep») e toda a classe aqui nomeada
  tem isenção viva no guarda — e qualquer menção nova fora das classes reprova, **excepto nos
  formatos que o guarda não varre**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.ico`, `.svg`,
  `.tgz`, `.gz`, `.zip`, `.woff`, `.woff2`, `.ttf`, `.otf`, `.pdf`, `.lock`, `.tsbuildinfo`
  (logos, tarballs, fontes e artefactos de build; `.svg` e `.lock` são textuais e ficam de fora
  por decisão — uma menção aí não é vista pelo golden master).

  **Pendências transitórias — RESOLVIDAS nesta versão:** existiram duas menções transitórias e
  ambas estão resolvidas antes do release: (1) um comentário em código vivo de
  `worker/providers/telegram/parse.ts` citava o nome do provedor removido — reescrito pelo fix
  que entrou nesta mesma versão (`grep -ri discord worker/providers/telegram/parse.ts` vazio);
  (2) o seu eco compilado em `dist/worker/providers/telegram/parse.js` (produto de build,
  gitignored) — o `clean` determinístico do `build:all` recompila sempre para uma árvore limpa, e
  o que sobrar é build stale, fora do recorte. Não há pendências: se o `grep -ri discord` voltar
  a encontrar o nome fora das classes acima, o golden master reprova o `pnpm test`.

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
