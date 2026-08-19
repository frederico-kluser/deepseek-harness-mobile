# dsh-guarded-bot-orchestrator

Plugin Cordis para o **DeepSeek Harness (DSH) v0.1**. Faz duas coisas:

1. **Guarda o plano de controlo HTTP.** Intercepta `ctx.webServer` e exige Basic Auth
   nos prefixos guardados (`/api`), valida o cabeçalho `Host` contra uma lista de
   anfitriões permitidos e recusa permissões proibidas — nomeadamente
   `danger-full-access`.
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

Se qualquer uma faltar, o plugin arranca com credencial inválida e **recusa tudo**
(fail-closed). É o comportamento pretendido.

## Onde colocar o `cordis.patch.yml`

Ele pertence à **Camada 2 (Profile)** da topologia de 4 camadas
(Bundle → Profile → Home → Overlay/CLI):

```sh
cp cordis.patch.yml "$DSH_HOME/profiles/<nome_do_perfil>/cordis.patch.yml"
# ex.: $DSH_HOME/profiles/web/cordis.patch.yml
```

O ficheiro está inteiramente comentado — leia-o antes de aplicar. O ponto que mais
surpreende: o DSH resolve patches por **substituição absoluta da entrada** do `id`
atingido (*whole-entry replace*), **não** por deep merge. Ao alvejar um `id` existente,
toda chave irmã omitida é **apagada**, não herdada. Por isso a entrada do servidor web
reescreve `name` e `port` explicitamente só para poder mudar `host`.

## Instalação do plugin

Distribuição recomendada: **pré-compilada**, largada num diretório absoluto e referida
por caminho no manifesto:

```sh
sudo install -d /usr/local/lib/dsh-plugins/dsh-guarded-bot-orchestrator
# copiar o build (dist/ + package.json) para lá
```

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
