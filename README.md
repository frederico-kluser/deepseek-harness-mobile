# dsh-guarded-bot-orchestrator

Plugin Cordis para o **DeepSeek Harness (DSH) v0.1**. Faz duas coisas:

1. **Guarda o plano de controlo HTTP.** Intercepta `ctx.webServer` — `register`,
   `registerFallback` **e** `registerUpgrade` (handshake de WebSocket) — e exige Basic
   Auth nos prefixos guardados (`/api`), valida no carregamento que o **endereço de bind**
   (`ctx.webServer.host`) não é `0.0.0.0`/`::` e consta da allowlist `allowedHosts`, e
   recusa permissões proibidas — nomeadamente `danger-full-access`.
   (`allowedHosts` é a allowlist do **endereço de bind** — a interface local onde se
   escuta. Não é uma allowlist do cabeçalho `Host` da requisição, e não se confunde com
   `trustedRemotes`, que é a allowlist da **origem da conexão**: quem pode ligar-se.
   Origem fora de `trustedRemotes` leva **403** antes de qualquer verificação de
   credencial; credencial errada leva **401**. `trustedRemotes: []` nega tudo, incluindo
   loopback — por isso o manifesto entrega `['127.0.0.1']`.)
2. **Orquestra um worker de long-polling.** Mantém um subprocesso de longa duração
   (bot do Telegram) sob `ctx.effect()`, com disposer LIFO, tree-kill garantido e
   recuo exponencial contra crash-loops. O worker recebe um ambiente **construído a
   partir de uma allowlist** — nunca `process.env` inteiro — para que a credencial do
   plano de controlo nunca chegue a um binário de terceiros que consome input da
   Internet.

## Estado atual — leia antes de instalar

Este repositório está em reconstrução ativa e **o plugin ainda não funciona ponta a
ponta**. O que este README descreve é o desenho e as invariantes já decididas, não um
produto acabado. Hoje:

- a superfície real da API do DSH foi levantada lendo os `.d.ts` dos tarballs publicados
  no npm, versão a versão, e o código está a ser migrado para ela;
- o portão de autenticação, o supervisor de subprocessos e o manifesto existem como
  desenho e como código em migração;
- **túnel, bot do Telegram e liga/desliga remoto ainda não são funcionalidade entregue.**

Não instale isto à espera de aceder ao DSH pelo telemóvel hoje. Se o que quer é apenas
autenticação na Web UI do DSH, **agora**, existe pelo menos um plugin dedicado só a isso
no ecossistema (`dsh-webui-auth`) e ele resolve esse problema sem esperar por este.

Três invariantes de desenho que não vão mudar, e que vale a pena saber já:

- **O bind continua em `127.0.0.1`.** Nenhuma funcionalidade futura alarga o socket local.
- **A senha nunca é enviada pelo Telegram.** Conversa com bot é *cloud chat*: não é
  ponta-a-ponta, o histórico fica nos servidores da Telegram e **não existe
  autodestruição para bots**. A senha aparece no terminal local, e só lá.
- **A URL de um túnel não é segredo.** Hostnames efémeros de túnel são descobríveis por
  amostragem pública — uma amostragem real devolveu dezenas de hostnames vivos. Quem
  protege é a credencial, não a obscuridade do endereço.

Compatibilidade: a linha do DSH contra a qual este trabalho é feito é **`0.1.0-rc.7`**
(faixa verificada `rc.7`–`rc.9`). Cuidado com a tag `latest` dos subpacotes
`@deepseek-ai/dsh-*`: ela aponta para a publicação **mais antiga**, não para a mais
recente. Fixe a versão explicitamente.

## Requisitos de instalação segura (leia antes de aplicar)

Três propriedades **não são verificáveis pelo plugin** e passam a ser responsabilidade
de quem instala. O plugin avisa em voz alta no arranque sobre a primeira; as outras duas
ficam documentadas aqui.

### 1. Ordem de carregamento — obrigatória

`ctx.intercept` só envolve os registos feitos **depois** do `apply()` deste plugin. Se o
pacote que regista `/api` (ou o `dsh-host-frontend-static`, que monta o fallback da SPA)
correr **antes**, essas superfícies respondem **sem credencial**. Não é hipótese remota:
`/api` e a SPA são registados pelo bundle base da instalação, e a ordem de resolução do
grafo não é garantida a seu favor por nenhuma camada. Reproduzido em laboratório — com o
registo antes do `apply`, um `POST` sem credencial para `/api/commands/execute` devolveu
**200** e a RPC executou.

**Como garantir a ordem:** a entrada `guarded-bot-orchestrator` tem de ser **resolvida
antes** das entradas que registam `/api` e o fallback da SPA — na prática, ficar como
**primeira entrada de plugin** do `insert` e confirmar que nenhuma camada superior
(Profile, Home, `--patch`) reordena ou reinsere aquelas entradas depois desta.

**Como verificar que correu bem:** um `curl` sem credencial a `/api` tem de devolver
`401`. Se devolver `200`, a ordem está errada.

```console
$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/api/commands/execute
401     # correcto
200     # ORDEM ERRADA: o plugin carregou depois de /api
```

**Porque é só um aviso e não uma asserção:** a superfície tipada de `WebServer`
(`types/dsh-host-webserver/index.d.ts`) expõe `host`, `port`, `register`,
`registerFallback` e `registerUpgrade` — e **nada** que permita enumerar rotas já
registadas. Não há, nesta distribuição, forma de o plugin **detectar** a ordem errada.
Inventar API que os `.d.ts` não declaram seria pior do que ser honesto.

### 2. `http/auth-check` — o primeiro ouvinte ganha

Num `waterfall` do Cordis, vence o **primeiro** ouvinte que responde sem invocar
`next()`. Um `http/auth-check` registado por **outro** plugin **antes** deste pode
devolver `true` e anular a barreira sem que ela chegue a correr. Isto é semântica do
Cordis, não um bug deste plugin, e não há forma de o impedir pela superfície tipada.
A mitigação que existe: o `next` **terminal** repete a verificação da credencial, o que
mantém a política fail-closed quando **não há** ouvintes. Auditar quem subscreve
`http/auth-check` faz parte da instalação segura.

### 3. `security/permission-elevate` não é emitido por ninguém (hoje)

O evento é **declarado por este plugin** (module augmentation) e **nenhum componente
documentado do DSH o emite** — a busca nos markdowns-fonte devolve zero ocorrências. O
comando perigoso viaja no **corpo** do `POST` para `/api/commands/execute`, e o portão
deliberadamente **não lê o corpo** (ler o stream e depois recusar transformaria um 401
legível num HTTP 400 opaco e impediria o handler original de o consumir nos pedidos
aprovados).

Portanto: o ouvinte de veto é um **hook de defesa em profundidade**, pronto para o dia em
que o evento passe a existir — **não** é o travão principal. O que de facto fecha a #853 é
o **portão de autenticação + allowlist de origem** sobre `/api`, o fallback e os upgrades,
somado ao bind de loopback.

## Porquê

A discussão oficial [#853](https://github.com/deepseek-ai/deepseek-harness/discussions/853)
documenta execução de código remota **não autenticada** via plano de controlo da UI web
do DSH (verificada em `0.1.0-rc.6`): com o servidor ligado a `0.0.0.0`, as rotas RPC sob
`/api` respondem a sockets sem qualquer credencial, e `commands/execute` consegue injetar
`/permission danger-full-access`, derrubando o confinamento `workspace-write` do Sandbox.

O manifesto de **Bundle** deste pacote ativa o plugin; o exemplo de **Profile** que o
acompanha fixa o bind em `127.0.0.1` (ver «Como o manifesto entra: duas camadas»).
Exposição à rede faz-se **sempre** por uma camada autenticada à frente do loopback —
nunca alargando o bind.

## Credencial e segredos

**A credencial do plano de controlo não vem do ambiente.** Não há `ADMIN_USER` nem
`ADMIN_PASS` para exportar, e não existe forma de fixar a senha por variável de ambiente:
o utilizador do Basic Auth é fixo e a senha é **gerada pelo próprio plugin** com um
gerador criptograficamente seguro, mostrada **uma única vez** no terminal, no arranque.
Em disco fica apenas um **digest** — nunca a senha.

Isto corrige um desenho anterior deste repositório, que derivava a credencial de
`ADMIN_USER`/`ADMIN_PASS` lidos do ambiente. O motivo de a mudança ser estrutural, e não
cosmética: um template literal **não rebenta** quando `process.env.X` está ausente —
interpola a string `"undefined"`.

```console
$ # a forma INGÉNUA — a que este repositório NÃO usa:
$ unset ADMIN_USER ADMIN_PASS
$ node -e 'console.log(Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString("base64"))'
dW5kZWZpbmVkOnVuZGVmaW5lZA==     # -> descodifica para  undefined:undefined
```

O resultado não é uma credencial inválida: é uma credencial **válida, fixa e derivável
por qualquer pessoa**, que abriria exactamente a barreira erguida para mitigar a RCE não
autenticada da #853. Tirar a credencial do ambiente elimina a classe de erro inteira, em
vez de a vigiar com uma verificação a mais.

O princípio que fica é o mesmo: **falha ruidosa no carregamento** (*fail loud at load*).
Configuração inválida ou segredo em falta aborta o arranque com uma mensagem que nomeia o
que falta. Não há arranque degradado, não há credencial de recurso, e um valor presente
mas **vazio** conta como ausente.

> Isto vale para o que **este plugin** valida no seu próprio `apply()`. **Não** vale para
> a resolução de patches do host, que é silenciosa — ver «A camada de Profile é opcional».
> Não confunda as duas: o plugin grita, o motor de patches não.

### Variáveis de ambiente

Uma só, e apenas quando o worker do bot estiver em uso:

| Variável | Uso |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token do bot, entregue ao worker de long-polling pelo ambiente construído por allowlist. Vai **por ambiente, nunca por `argv`**: `/proc/<pid>/cmdline` é legível por qualquer processo local. |

## Como o manifesto entra: duas camadas

O DSH resolve configuração em quatro camadas, por precedência crescente:
**Bundle → Profile → Home → Overlay/CLI**. Este pacote usa as duas primeiras, com papéis
distintos:

| Camada | Ficheiro | Papel | Precisa de ação sua? |
| --- | --- | --- | --- |
| **1 — Bundle** | `cordis.patch.yml`, distribuído dentro do pacote | Regista **o próprio plugin**, e nada mais. É um *insert* puro: não alveja entrada nenhuma já existente e por isso **não tem `id`**. | **Não.** Entra com a instalação. |
| **2 — Profile** | `cordis.profile.patch.example.yml`, um **exemplo** que acompanha o pacote | Endurecimento **opcional** da instalação — nomeadamente fixar o *bind* do servidor web em `127.0.0.1`. Alveja uma entrada que já existe, logo depende de um `id` específico da sua instalação. | **Só se quiser** esse endurecimento. |

**Não copie ficheiro nenhum à mão para ativar o plugin.** A instalação pelo caminho
oficial já ativa a camada de Bundle:

```sh
dsh plugin --profile <nome_do_perfil> add dsh-guarded-bot-orchestrator
```

Este README trazia antes uma instrução para copiar o `cordis.patch.yml` para
`$DSH_HOME/profiles/<perfil>/`. **Ela foi removida**: com o manifesto de Bundle a entrar
pela instalação, a cópia manual aplicaria as mesmas entradas uma segunda vez, noutra
camada de precedência, criando duas verdades sobre onde este ficheiro entra.

### A camada de Profile é opcional — e é onde mora o `id`

O ficheiro de exemplo está inteiramente comentado; leia-o antes de aplicar. As três
propriedades abaixo foram lidas no motor de patches real — `applyEntryPatches` em
`@deepseek-ai/dsh-app-boot@0.1.0-rc.7`, `lib/index.js:57-106` — e não em documentação em
prosa. Se atualizar de `rc`, vale reconfirmar.

**1. A aplicação de um patch é *shallow merge* das chaves de topo, não substituição da
entrada.** O motor faz, em `:100-103`:

```js
for (const [key, value] of Object.entries(overrides)) {
  if (key === "id") continue;
  target[key] = value;
}
```

Chave irmã **omitida é preservada**, não apagada — não é preciso reescrever `port` só
para mudar `host`. A exceção que importa é o `config`: ele é uma chave de topo como as
outras, logo, **se o fornecer, substitui o objeto `config` inteiro**. Para mudar só o
`host` sem perder o `port`, o `config` que escrever tem de trazer os dois.

**2. `name` no patch é uma *asserção*, não um valor a aplicar.** Ele é retirado do objeto
de overrides antes do merge (`:69`) e usado como guarda em `:96-99`: se o `name` que
escreveu não bater com o `name` da entrada que o `id` encontrou, o patch é **descartado**.
Vale a pena incluí-lo — é o que impede um `id` errado de patchar em silêncio a linha
errada.

**3. Errar o `id` falha em SILÊNCIO — e é o ponto mais perigoso desta página.** O motor
faz, em `:91-95`:

```js
const target = entryMap.get(id);
if (!target) {
  warn("patch: entry %C not found", id);
  continue;
}
```

`warn` e `continue`. **Não há um único `throw` em todo o `applyEntryPatches`.** O arranque
segue, o processo sai com código 0, e o seu patch é simplesmente **descartado**. Um
`replace` também **nunca** se converte em `insert`: `insert` é uma chave distinta,
testada em `:70`, **antes** de qualquer resolução de `id` — não nasce segunda instância do
servidor web nem conflito de rota.

> **Versões anteriores deste README diziam o contrário** — que um `id` errado provocava
> conflito de rota e *fail loud at load*. Era **falso**, e falso na direção pior possível:
> o que fica por aplicar é justamente o endurecimento do *bind*. A entrada de origem
> (`@deepseek-ai/dsh-web-app/cordis.patch.yml:119`) traz
> `host: !!js ctx.webStartup.host ?? '127.0.0.1'`, ou seja, **honra o `--host` da linha de
> comandos**. Com o patch descartado em silêncio, um `dsh web --host 0.0.0.0` mantém o
> socket aberto para a rede e **nada** no arranque o avisa. Não procure um erro que não
> vai aparecer: procure a linha de `warn`, e confirme o efeito.

**Como confirmar que o patch pegou** — nesta ordem, do mais barato ao mais fiável:

1. **Procure a linha de aviso** no stderr do arranque: `patch: entry <id> not found`. Se
   ela aparecer, o seu patch não foi aplicado.
2. **Confirme o `id` real** com o diagnóstico de recuperação da CLI, que compõe as linhas
   dos bundles e as imprime em YAML:

   ```console
   $ dsh --profile web --dump-default-config | grep -B1 dsh-host-webserver
   ```

   Esse mesmo comando reporta, pelo `warn`, os patches que não casaram com linha nenhuma,
   com o rótulo da camada — é o sítio onde um `id` errado fica visível.
3. **Verifique o efeito, não a configuração.** É a única prova que não depende de ler
   YAML: confirme em que endereço o servidor está de facto a escutar (`ss -ltnp`,
   `lsof -iTCP -sTCP:LISTEN`) e que um `curl` sem credencial a `/api` devolve `401`.

**O `id` do servidor web.** No perfil `web` — cujo template é
`["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]` (`dsh-app-boot`, `lib/index.js:323`)
— a entrada vive no **segundo** bundle:

```yaml
# @deepseek-ai/dsh-web-app/cordis.patch.yml:115  (0.1.0-rc.7)
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject: [webStartup]
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
```

O `id` é literalmente **`webserver`**. Não está em `@deepseek-ai/dsh-base` — `grep`
por `webserver` nesse ficheiro devolve **zero**. Ainda assim, **confirme na sua
instalação** antes de aplicar, com o comando do ponto 2: o valor acima foi lido na
`0.1.0-rc.7` e nada garante que uma `rc` posterior o mantenha.

É por isto que este `id` **não** vive na camada de Bundle, que é automática: uma camada
que depende de um `id` específico da instalação, e que falha em silêncio quando ele não
casa, tem de ser uma escolha explícita de quem instala.

**O que não medimos:** não corremos o `dsh` ponta a ponta contra uma instalação real
neste trabalho. O que está acima vem da leitura do código publicado nos tarballs de
`0.1.0-rc.7`; a verificação de comportamento é o passo 3 da lista acima, do seu lado.

## Instalação do plugin

Distribuição recomendada: **pré-compilada**, largada num diretório absoluto e referida
por caminho no manifesto:

```sh
pnpm install --frozen-lockfile
pnpm run build            # tsc -p tsconfig.build.json  ->  emite dist/ (JS + .d.ts)

sudo install -d /usr/local/lib/dsh-plugins/dsh-guarded-bot-orchestrator
sudo cp -r dist package.json /usr/local/lib/dsh-plugins/dsh-guarded-bot-orchestrator/
```

Dois scripts distintos, de propósito: `pnpm run typecheck` usa o `tsconfig.json`
(`noEmit: true`, e inclui `test/**` e o smoke-test de tipos) e **não produz artefactos**;
`pnpm run build` usa o `tsconfig.build.json`, que o estende com `noEmit: false`,
`declaration: true` e `outDir: dist`, compilando **apenas** `src/**`. O `dist/` é
ignorado pelo Git (é derivado) mas vai no pacote publicado — `main`, `types` e `exports`
apontam para lá, porque o Node não carrega `.ts` a partir de `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).

Nessa forma de distribuição, o `name` da entrada que regista o plugin passa a ser o
caminho absoluto do diretório, e a entrada entra pela camada de **Profile** — os
manifestos que acompanham o pacote trazem uma entrada a demonstrar essa forma.

### Aviso: `pnpm` ≥ 10 bloqueia scripts `prepare`

Instalar por Git (`dsh plugin --profile add github:exemplo/meu-plugin`) implica um build
local acionado pelo script `prepare`. A partir do **pnpm 10.x** — a versão usada pelo DSH
— esses scripts são **bloqueados por omissão** e a instalação falha ruidosamente. Para
desbloquear é preciso autorizar manualmente no `pnpm-workspace.yaml` do inventário local:

```yaml
allowBuilds:
  dsh-guarded-bot-orchestrator: true
```

Essa autorização corre **fora** do sandbox do agente, com privilégios totais de leitura,
escrita e rede na máquina — é um vetor clássico de supply chain. É exatamente por isso
que a distribuição recomendada é pré-compilada (diretório absoluto, npm, ou um `.tgz` de
`pnpm pack`): elimina a necessidade de `allowBuilds` no cliente final.

## Divergências assumidas face ao doc-fonte

Duas, ambas deliberadas e ambas com o motivo à vista no código.

### O tree-kill ignora `child.killed` (o exemplo canónico está errado)

O disposer do doc-fonte escreve `if (child.pid && !child.killed) process.kill(-child.pid, …)`.
Essa guarda **torna o tree-kill código morto**: o Node, ao processar
`abortController.abort()`, chama `child.kill()` de forma **síncrona**, pelo que `killed`
já é `true` quando a linha seguinte corre. Medido com processos reais (pai `detached` +
neto):

```console
$ node probe.mjs            # com a guarda !child.killed
ANTES  do dispose()  filho: 1449751 1449751 1449744 worker.sh
                     neto : 1449752 1449751 1449751 sleep
DEPOIS do dispose()  filho: (pid 1449751 MORTO)
                     neto : 1449752 1449751    1830 sleep   <-- ÓRFÃO, reparentado ao init

$ node probe.mjs            # sem a guarda (o que este repositório faz)
DEPOIS do dispose()  filho: (pid 1450742 MORTO)
                     neto : (pid 1450743 MORTO)
```

`killed` significa apenas *«um sinal foi entregue ao filho»* — só o `kill` do **grupo**
alcança os netos. Aqui o tree-kill é sempre tentado quando há `pid`, com `try/catch` para
o `ESRCH` do grupo já inexistente.

### `maxAttempts` esgotado não desregista o plugin

A tabela do cliente MCP descreve `reconnect.maxAttempts` como cessando a recuperação **e
desregistando ativamente o plugin** até recarregamento manual. A superfície tipada desta
distribuição (`types/cordis/index.d.ts`) **não expõe auto-desregisto**: `Context` oferece
`intercept`, `waterfall`, `parallel`, `on`, `effect` e `get` — nada que remova a própria
Fiber. Em vez de inventar API inexistente, implementa-se o que a superfície permite:

- **estado terminal explícito e observável** (`supervisor.exhausted`), que impede
  qualquer novo arranque;
- **erro inequívoco no log**, dizendo que a recuperação cessou em definitivo e que o
  desregisto ativo exigiria API do Cordis ausente nesta distribuição.

## Notas operacionais

- **Escrita concorrente (Issue #441).** O carregador reescreve a configuração com
  `O_TRUNC` sem rename atómico; o YAML fica a zero bytes durante micro-intervalos do
  arranque. Invocações concorrentes (`dsh --profile web "A" & dsh --profile web "B" &`)
  podem ler um ficheiro truncado. Serialize os arranques com `flock`.
- **Precedência.** Um patch em `$DSH_HOME/cordis.patch.yml` (Camada 3) ou um
  `--patch` na CLI (Camada 4) sobrepõem-se aos manifestos deste pacote — inclusive ao
  bind de loopback. Audite as camadas superiores.

## Segurança, contribuição e licença

- **Encontrou uma vulnerabilidade?** Não abra issue pública: leia [`SECURITY.md`](SECURITY.md)
  e use o canal privado descrito lá. Esse ficheiro traz também a lista explícita do que
  **não** é tratado como vulnerabilidade neste projeto — a URL do túnel não ser segredo, o
  TLS terminar na borda, prompt injection ser risco aceite — para que ninguém gaste tempo
  a reportar uma decisão de desenho.
- **Quer contribuir?** [`CONTRIBUTING.md`](CONTRIBUTING.md) tem o ambiente em quatro
  comandos, os níveis de teste, e — mais importante — a lista do que **nunca** é aceite
  num PR.
- **Código de conduta:** [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1).
- **Licença:** MIT — ver [`LICENSE`](LICENSE). O DeepSeek Harness a montante também é MIT.
