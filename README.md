# dsh-guarded-bot-orchestrator

Plugin Cordis para o **DeepSeek Harness (DSH) v0.1**. Faz duas coisas:

1. **Guarda o plano de controlo HTTP.** Intercepta `ctx.webServer` e exige Basic Auth
   nos prefixos guardados (`/api`), valida no carregamento que o **endereço de bind**
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
   recuo exponencial contra crash-loops.

## Porquê

A discussão oficial [#853](https://github.com/deepseek-ai/deepseek-harness/discussions/853)
documenta execução de código remota **não autenticada** via plano de controlo da UI web
do DSH (verificada em `0.1.0-rc.6`): com o servidor ligado a `0.0.0.0`, as rotas RPC sob
`/api` respondem a sockets sem qualquer credencial, e `commands/execute` consegue injetar
`/permission danger-full-access`, derrubando o confinamento `workspace-write` do Sandbox.

O `cordis.patch.yml` deste repositório fixa o bind em `127.0.0.1` e ativa o plugin.
Exposição à rede faz-se **sempre** por proxy reverso TLS autenticado à frente do
loopback — nunca alargando o bind.

## Variáveis de ambiente exigidas

Têm de estar presentes no processo que arranca o `dsh` (são lidas em tempo de arranque
pela tag `!!js`, avaliada por `@deepseek-ai/cordis-plugin-include`; nenhum segredo é
escrito em ficheiro):

| Variável | Uso |
| --- | --- |
| `ADMIN_USER` | Utilizador do Basic Auth que guarda `/api` e a SPA. |
| `ADMIN_PASS` | Senha correspondente. |
| `TELEGRAM_BOT_TOKEN` | Token do bot, passado ao worker de long-polling. |

### O que acontece se faltar alguma

**O processo não arranca.** Cada expressão `!!js` do `cordis.patch.yml` é um IIFE que
valida o ambiente e **lança no carregamento** (*fail loud at load*). Não há arranque
degradado, não há credencial de recurso — o `dsh` aborta com uma mensagem que nomeia a
variável em falta. Uma variável presente mas **vazia** conta como ausente.

Isto é fail-closed **porque falha ruidosamente**, e não porque "arranca com credencial
inválida e recusa tudo". A distinção é a diferença entre uma porta fechada e um buraco:

```console
$ # a forma INGÉNUA — a que este repositório NÃO usa:
$ unset ADMIN_USER ADMIN_PASS
$ node -e 'console.log(Buffer.from(`${process.env.ADMIN_USER}:${process.env.ADMIN_PASS}`).toString("base64"))'
dW5kZWZpbmVkOnVuZGVmaW5lZA==     # -> descodifica para  undefined:undefined
```

Um template literal **não rebenta** com `process.env.X` ausente: interpola a string
`"undefined"`. O resultado não é uma credencial inválida — é uma credencial **válida,
fixa e derivável por qualquer pessoa**, que abriria exactamente a barreira erguida para
mitigar a RCE não autenticada da #853. Daí a guarda explícita em cada uma das três
expressões `!!js` do manifesto.

## Onde colocar o `cordis.patch.yml`

Ele pertence à **Camada 2 (Profile)** da topologia de 4 camadas
(Bundle → Profile → Home → Overlay/CLI):

```sh
cp cordis.patch.yml "$DSH_HOME/profiles/<nome_do_perfil>/cordis.patch.yml"
# ex.: $DSH_HOME/profiles/web/cordis.patch.yml
```

Esta é a **única** camada por onde este ficheiro entra. O `package.json` deste pacote
**não** declara `dsh.bundle.patch` de propósito: essa chave registaria o mesmo manifesto
como **Camada 1 (Bundle)**, a de prioridade mínima, aplicando as mesmas entradas uma
segunda vez noutra camada e criando duas verdades sobre onde o ficheiro entra. O
artefacto entregue é o patch de Profile.

O ficheiro está inteiramente comentado — leia-o antes de aplicar. O ponto que mais
surpreende: o DSH resolve patches por **substituição absoluta da entrada** do `id`
atingido (*whole-entry replace*), **não** por deep merge. Ao alvejar um `id` existente,
toda chave irmã omitida é **apagada**, não herdada. Por isso a entrada do servidor web
reescreve `name` e `port` explicitamente só para poder mudar `host`.

### Obrigatório antes de aplicar: confirmar o `id` do servidor web

A primeira entrada do manifesto traz o `id` como **placeholder**
(`'<ID-DA-ENTRADA-DO-SERVIDOR-WEB-NESTA-INSTALACAO>'`) e tem de ser substituído. Esse
`id` é **específico da instalação** — é o que o bundle `@deepseek-ai/dsh-base` declarou
na versão instalada — e **não está publicado na documentação do DSH**, que também **não
documenta qualquer comando para listar entradas do grafo**: os únicos subcomandos de
`dsh plugin` documentados são de instalação (`dsh plugin --profile <perfil> add
<pacote>`). Se a sua versão da CLI oferecer um comando de listagem, use-o; caso
contrário, a descoberta é por **inspecção**: abra o `cordis.patch.yml` do bundle
`@deepseek-ai/dsh-base` como está instalado no perfil e procure a entrada cujo
`name` é `'@deepseek-ai/dsh-host-webserver'` — o `id` dessa entrada é o valor a usar.

Errar o `id` **não é inócuo**. Como a resolução é whole-entry replace *por `id`*, um
`id` que não case com nenhuma entrada inferior **deixa de ser um replace e passa a ser um
insert**: nasce uma segunda instância do servidor web enquanto a original continua viva
no bind anterior, as duas disputam a mesma rota/porta e o motor rejeita o arranque por
conflito de rota (*fail loud at load*). O bind de loopback — a razão de ser deste patch —
nunca chega a ser aplicado.

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

No `cordis.patch.yml`, o `name` da entrada passa a ser o caminho absoluto do diretório
(o manifesto já traz uma entrada a demonstrar essa forma).

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

## Notas operacionais

- **Escrita concorrente (Issue #441).** O carregador reescreve a configuração com
  `O_TRUNC` sem rename atómico; o YAML fica a zero bytes durante micro-intervalos do
  arranque. Invocações concorrentes (`dsh --profile web "A" & dsh --profile web "B" &`)
  podem ler um ficheiro truncado. Serialize os arranques com `flock`.
- **Precedência.** Um patch em `$DSH_HOME/cordis.patch.yml` (Camada 3) ou um
  `--patch` na CLI (Camada 4) sobrepõem-se a este ficheiro — inclusive ao bind de
  loopback. Audite as camadas superiores.
