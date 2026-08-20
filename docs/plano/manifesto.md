# Manifesto: as duas camadas, e o que foi medido para chegar lá

Registo de decisão de **T1.3** (Onda 1). Assunto: quebrar o `cordis.patch.yml`
monolítico em duas camadas, fechar o spike **S6**, e especificar o bloco `dsh` do
`package.json`.

Tudo o que está aqui foi **medido** contra `@deepseek-ai/dsh@0.1.0-rc.7` instalado
num `$DSH_HOME` limpo, ou lido no código-fonte da ferramenta em causa. Onde uma
medição contradiz um documento do plano, a medição está marcada e o documento é
citado para poder ser corrigido.

---

## 1. VEREDITO S6

**Pergunta.** O CI do registro `awesome-dsh-plugin` aceita `dsh.bundle` **sem** a
subchave `patch`?

Verificado no **CÓDIGO do gate**, não na prosa do `contributing.md` — o ficheiro
foi descarregado e lido na íntegra (446 linhas).

```
VEREDITO S6: CONFIRMADO — o gate aceita dsh.bundle sem a subchave patch.
  evidência: https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/check-submission.mjs
    L232 (função `hasBundle`, caminho do manifesto apontado directamente pela entrada):
      `if (dsh.bundle) return { ok: true }`
    L189 (função `scanTree`, caminho da varredura da árvore do repositório):
      `return { ok: true, at: p }`  — dentro de `if (dsh.bundle) {` aberto na L179
    Em nenhum dos dois caminhos o gate lê `dsh.bundle.patch`, e em nenhum verifica
    se o ficheiro apontado existe. `{}` é truthy em JS, logo `"dsh": {"bundle": {}}`
    passa o check #1.
```

**A prosa diz o contrário, e a prosa não é o gate.** O `← required` aparece no
próprio `check-submission.mjs`, mas na **L441** — dentro da *string de mensagem de
erro* impressa quando a submissão falha, nunca num caminho de decisão:

```js
// check-submission.mjs L434-445 — texto de ajuda, não lógica
console.error(`
${failures.length} entr… did not pass. See contributing.md.

A bundle manifest looks like:

  {
    "dsh": {
      "bundle": { "patch": "./cordis.patch.yml" },   // <- required
      "client": { "platform": "web" }                // only if you ship browser UI
    }
  }
`)
```

Constantes conferidas na mesma leitura, para o registo: `MIN_AGE_DAYS = 1` (L21),
`MIN_COMMITS = 10` (L22), `MAX_TREE_PKGS = 40` (L24).

### 1.1 O corolário que muda a decisão — e que S6 sozinho não revela

S6 pergunta pelo **gate do registro**. Mas o gate do registro não é o único
consumidor do bloco `dsh`, e o outro consumidor discorda dele.

**Medido, com controlo e código:**

| Declaração | Gate do `awesome-dsh-plugin` | `dsh plugin add` (o produto) |
| --- | --- | --- |
| `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | passa | **ativa a camada** |
| `"dsh": { "bundle": {} }` | **passa** (S6) | **NÃO ativa nada** |
| sem chave `dsh` | reprova | não ativa nada |

O experimento de controlo, num `$DSH_HOME` limpo, com um pacote idêntico exceto
pelo bloco `dsh`:

```console
$ dsh plugin --profile web add ./pkg-emptybundle     # "dsh": { "bundle": {} }
dsh: warning: empty-bundle-probe declares no dsh.bundle — installed as a plain
     dependency, not a profile layer (a later update that gains one activates it
     automatically)

$ node -e "console.log(require('\$DSH_HOME/profiles/web/package.json').dsh.profile.bundles)"
[ '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app' ]     # não entrou
```

O código que decide, em `@deepseek-ai/dsh@0.1.0-rc.7/lib/plugin-9h8shc4d.js`,
função `exportsPatch`:

```js
// L32
return readProfileManifest(NAME, dir).dsh?.bundle?.patch !== void 0;
```

E, no arranque, `@deepseek-ai/dsh-app-boot@0.1.0-rc.7/lib/index.js`, `loadProfile`:

```js
// L548-549
const declared = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).dsh?.bundle?.patch;
if (declared === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
```

**Consequência.** A decisão registada em `06-REPO-E-CI.md` (§ "Decisão: declarar
`"dsh": { "bundle": {} }`") satisfaz o gate do registro e **não funciona no
produto**: publicaria um plugin que entra na awesome-list, instala sem erro, e
nunca ativa. É um bloco que passa no exame e reprova na vida.

Essa decisão fazia sentido no mundo antigo, em que declarar `patch` significava
apontar para um ficheiro com um `id` placeholder. **A separação em duas camadas
remove essa razão**: o `cordis.patch.yml` deste repositório passa a ser um insert
puro com um único `id`, o do próprio plugin. Declarar `patch` deixa de ser
perigoso e passa a ser obrigatório.

> **Correção pedida a `06-REPO-E-CI.md` §~1094-1110 e a `08-PESQUISA-E-FONTES.md`
> §6.2 / linha 44 do ledger:** manter a refutação do "`← required`" (está certa e
> é verificável), mas trocar a conclusão `"bundle": {}` por
> `"bundle": { "patch": "./cordis.patch.yml" }`, com a evidência de
> `exportsPatch` acima. Números de linha do `check-submission.mjs` também mudaram:
> o ledger cita L153/L193/L21-22; o ficheiro em `main` traz L189/L232/L21-22.

---

## 2. A separação: o que ficou em cada camada

| | Camada 1 — Bundle | Camada 2 — Profile |
| --- | --- | --- |
| Ficheiro | `cordis.patch.yml` | `cordis.profile.patch.example.yml` |
| Onde vive | dentro do pacote | `$DSH_HOME/profiles/<perfil>/cordis.patch.yml` |
| Como entra | automático, por `dsh.bundle.patch` | cópia deliberada do operador |
| Obrigatório? | sim, é o plugin | **não**, é endurecimento opcional |
| Operação | `insert` puro, 1 linha | override por `id` |
| `id` que alveja | só o do próprio plugin | o do servidor web (de outro pacote) |
| Pode falhar alto? | **nunca** | sim, é escolha explícita |
| Credencial | nenhuma | nenhuma |

**A regra que gerou a divisão:** um patch de Bundle é aplicado automaticamente a
toda a gente que corre `dsh plugin add`. Portanto ele não pode conter (a) `id` de
linha que ele não controla, nem (b) expressão que lance no carregamento. Tudo o
que viola (a) ou (b) desceu para a Camada 2. Nenhum ficheiro deste repositório
entra em duas camadas — a "verdade única" está preservada por **construção**, e
já não por abstenção.

### 2.1 De-para, entrada a entrada, do ficheiro antigo

| Entrada antiga | Para onde foi | Porquê |
| --- | --- | --- |
| `[1/3]` servidor web, `id` placeholder | **Camada 2**, com o `id` medido | alveja linha de outro pacote; é o único `id` que pode não casar |
| `[2/3]` `guarded-bot-orchestrator` | **Camada 1** | é o plugin; `id` próprio, não colide com nada |
| `[3/3]` `core-auth-interceptor` por caminho absoluto | **eliminada** | ver §2.2 |
| `encodedAuthString: !!js …ADMIN_USER/ADMIN_PASS…` (×2) | **eliminada** | §3 |
| secção "ORDEM DE CARREGAMENTO: REQUISITO DURO" | **eliminada** | §4 |
| `worker.cwd` absoluto | Camada 2, comentado | §7.2 |
| `worker.command: 'python3'` + `args: ['bot_long_polling.py']` | **substituída** pelo runtime Node | §7.3 |
| `worker.graceMs` | **nova**, Camada 1 | §6 |

### 2.2 Porque `core-auth-interceptor` deixou de ser uma linha do manifesto

A entrada `[3/3]` registava um segundo plugin,
`/usr/local/lib/dsh-plugins/dsh-basic-auth-interceptor`, para guardar o fallback
da SPA. Ela sai por duas razões independentes:

1. **O pacote não existe.** Nada neste repositório o constrói ou publica. Era uma
   linha que apontava para um caminho que ninguém preenche.
2. **O mecanismo que ela pressupunha foi refutado.** A barreira não se instala
   tomando o assento de fallback — o dono é único e a segunda chamada lança. O
   mecanismo real, medido, é a **troca do dono do despacho no `node:http.Server`**
   do serviço `webServer`, feita pelo próprio plugin dentro de um `ctx.effect()`
   (`docs/spikes/interceptacao.md` §9, VEREDITO S12). O `frontend-static` mantém
   o assento de fallback e continua a servir a SPA; a barreira corre antes, no
   despacho.

`core-auth-interceptor` continua a ser o **nome canónico do interceptor** (D5),
mas passa a designar a costura de interceção **dentro** do plugin — não uma linha
do `cordis.patch.yml`. **Inferência assumida**, registada aqui porque D5 lista o
nome na coluna "`id` … em `cordis.patch.yml`": ou D5 se ajusta a esta leitura, ou
alguém tem de dizer que segundo pacote deve existir. Enquanto isso, o bundle
tem exatamente uma linha, como a tarefa exige.

---

## 3. A credencial saiu do manifesto

`02-SEGURANCA.md` §8.2 regra 6 e `09-DECISOES-CANONICAS.md` **D19**:
`ADMIN_USER`/`ADMIN_PASS` **deixam de existir no fluxo**. A credencial é gerada
por **CSPRNG** pelo próprio plugin, o digest vive em
`$XDG_STATE_HOME/dsh-guarded-bot/state.json` (`0600`, dir `0700`), e o utilizador
do Basic Auth é fixo: `dsh`.

Portanto **nenhum dos dois ficheiros declara `encodedAuthString`**.

O que se removeu, e o que aquilo fazia:

```yaml
# REMOVIDO (aparecia duas vezes: linhas 238 e 419 do ficheiro antigo)
encodedAuthString: !!js '(() => { const u = process.env.ADMIN_USER, p = process.env.ADMIN_PASS; if (!u || !p) throw new Error("…"); return Buffer.from(`${u}:${p}`).toString("base64") })()'
```

Dois defeitos, não um:

1. **O manifesto é versionável.** Enquanto existisse ali uma chave de credencial,
   existia um sítio onde uma senha podia acabar commitada. A guarda `if (!u || !p)
   throw` protegia contra a variável ausente; não protegia contra alguém escrever
   o valor literal.
2. **O modo de falha sem a guarda era fail-OPEN.** `Buffer.from(...)` com as duas
   variáveis ausentes interpola a string `"undefined"` e devolve
   `dW5kZWZpbmVkOnVuZGVmaW5lZA==` — a credencial `undefined:undefined`. Não é
   inválida: é **válida, fixa e derivável por qualquer leitor**, e abre exatamente
   a barreira erguida para mitigar a #853.

**`!!js` continua válido, só para valores não sensíveis.** Fica um uso, em
`worker.token`, e ele **referencia** uma variável de ambiente sem materializar
nada:

```yaml
token: !!js "process.env.TELEGRAM_BOT_TOKEN ?? ''"
```

Ausência vira string vazia, não exceção — ver §5. A fonte preferida do token é
`$XDG_STATE_HOME/dsh-guarded-bot/secrets.env` (`0600`), gravado pelo onboarding
`/parear`; o ambiente é o fallback documentado em `02-SEGURANCA.md` §L1186.

Para calibrar o que é "não sensível", o precedente do próprio host — `dsh-base`
usa `!!js` para `process.env.DSH_TELEMETRY_MODE || 'DISABLED'`,
`process.platform === 'win32'`, `process.cwd()` e `dshHomePath('sessions')`.
Nenhum segredo.

---

## 4. A secção "ORDEM DE CARREGAMENTO: REQUISITO DURO" foi eliminada

O ficheiro antigo dedicava ~30 linhas a um requisito duro de ordenação: a linha do
plugin teria de vir **antes** de qualquer linha que registasse `/api` ou o
fallback da SPA, sob pena de essas superfícies responderem sem credencial.

**O requisito morreu com o mecanismo que o gerava.** Ele existia porque se supunha
que a barreira era instalada por `ctx.intercept`, que só envolveria registos feitos
**depois** do `apply()`. Medições da Onda 0: `ctx.intercept` é **fusão de config**,
não envolve métodos, e é **inerte** para o `webServer`.

O mecanismo real troca o dono do despacho no `node:http.Server`. Como o despacho é
o ponto por onde **toda** requisição passa, é indiferente se `/api` e o fallback
foram registados antes ou depois. `docs/spikes/interceptacao.md` §9.2, linha
"Ordem de carregamento": *"**Nenhuma exigência.** Provado pela FASE B (instalação
depois de todos) e FASE B2 (rotas depois da instalação)."*

E o host diz o mesmo, de forma independente —
`@deepseek-ai/dsh-base@0.1.0-rc.7/cordis.patch.yml`, linhas 12-13:

> *"Row order carries no load semantics (activation is service-availability
> driven); the grouping is for readers."*

Não existe `priority`, `before` ou `after`. A ativação é conduzida pela
disponibilidade do serviço: o plugin declara `inject: ['webServer']` e só ativa
depois de `webServer` existir.

O que **fica**: o par `401`/`200` do `curl` contra `POST /api/commands/execute`,
que continua a ser a melhor prova de 5 segundos de que a barreira está de pé.

---

## 5. Correções factuais medidas — o que a documentação anterior dizia errado

Estas quatro são as que mudam decisões, não redação.

### 5.1 Não é *whole-entry replace*. É *shallow merge* das chaves de topo da linha — e o `config`, se vier, vai inteiro.

**Dizia-se:** ao alvejar um `id` existente, a entrada INTEIRA é expurgada; omitir
`name` faz o servidor web não arrancar; por isso a entrada repetia `name`.

**Medido, no motor.** `@deepseek-ai/dsh-app-boot@0.1.0-rc.7/lib/index.js:100-103`:

```js
for (const [key, value] of Object.entries(overrides)) {
  if (key === "id") continue;
  target[key] = value;
}
```

É uma fusão rasa das chaves **de topo da linha**. Chave que o patch não traz nem
é tocada — por isso `name` e `inject` sobrevivem a um override que não os
menciona. E como `config` é uma dessas chaves de topo, fornecê-lo **substitui o
objeto inteiro**, sem fusão por dentro. As duas metades da regra saem da mesma
linha de código.

Evidências convergentes:

- `@deepseek-ai/dsh-base@0.1.0-rc.7/cordis.patch.yml` L5-6: *"A patch replaces the
  targeted row's whole `config` rather than merging into it"*.
- `@deepseek-ai/dsh-web-app@0.1.0-rc.7/cordis.patch.yml` faz **33 overrides** sobre
  linhas do `dsh-base` (`- id: system-prompt`, `- id: hmr`, `- id: tools`,
  `- id: tool-bash`, …) e **nenhum** repete `name`.
- Ponta a ponta: aplicado o override deste repositório, o `--dump-config` devolve
  a linha com `name` e `inject: [webStartup]` **intactos**, sem que o patch os
  mencionasse.

**A parte verdadeira sobrevive:** omitir uma chave **de dentro do `config`**
apaga-a. Por isso o override do servidor web repete `port`. O uso de
`exactOptionalPropertyTypes` justificado em `05-QUALIDADE-CODIGO.md` §2 (L312)
continua correto — só a palavra "entry" ali precisa de virar "config".

**E repetir `name` é pior do que inútil — é uma terceira via de fail-open.**
`dsh-app-boot/lib/index.js:96-98`:

```js
if (name && name !== target.name) {
  warn("patch: name mismatch for %C (expected %C, got %C), skipping", id, target.name, name);
  continue;
}
```

Um `name` repetido que não bata exatamente com o instalado faz o patch inteiro ser
**saltado**, com aviso em stderr e exit 0 — o mesmo modo de falha de §5.3. A
receita antiga ("repita `name` para não o apagar") criava, sozinha, uma forma
adicional de perder o endurecimento em silêncio, por exemplo se o pacote do
servidor web vier a ser renomeado.

### 5.2 O `id` do servidor web é descobrível, e a receita antiga estava errada

**Dizia-se:** o `id` não está publicado, o DSH não documenta comando para listar
entradas do grafo, e a descoberta é por inspeção do `cordis.patch.yml` do bundle
`@deepseek-ai/dsh-base`.

**Medido:** existe comando, e o `dsh-base` é o sítio errado para procurar.

```console
$ dsh --profile web --dump-default-config | grep -B1 dsh-host-webserver
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
```

A linha do servidor web é declarada pelo bundle de **modo**, não pelo `dsh-base`:
`@deepseek-ai/dsh-web-app@0.1.0-rc.7/cordis.patch.yml:115`, com
`inject: [webStartup]` e `host: !!js ctx.webStartup.host ?? '127.0.0.1'`.
`@deepseek-ai/dsh-base` **não tem** linha de servidor web nenhuma.

Continua a ser **específico da instalação**, e agora sabe-se porquê:
`@deepseek-ai/dsh-headless@0.1.0-rc.7` também não declara servidor web (as suas
únicas linhas são `code-runtime`, `headless-startup`, `headless-runner`), e o
conjunto de bundles ativos é do perfil — `dsh.profile.bundles` em
`$DSH_HOME/profiles/<perfil>/package.json`.

O `cordis.profile.patch.example.yml` traz o valor medido (`webserver`) **e** o
comando de confirmação. Nome canónico do valor, para D5:
`<ID-DA-ENTRADA-DO-SERVIDOR-WEB-NESTA-INSTALACAO>`.

### 5.3 `id` errado não rejeita o boot. Falha em silêncio, para o lado errado.

**Dizia-se** (`README.md` L166-171, `06-REPO-E-CI.md` L1113, `07-COMUNIDADE.md`
L181, `08-PESQUISA-E-FONTES.md` L827): `id` que não casa deixa de ser replace e
vira insert → segunda instância do servidor web → conflito de rota → boot
rejeitado (*fail loud at load*).

**Medido, `@deepseek-ai/dsh@0.1.0-rc.7`, perfil limpo. São dois modos distintos, e
ambos são silenciosos:**

| Situação | Comportamento real | Exit |
| --- | --- | --- |
| **override** com `id` que não casa | entrada **saltada**, aviso `patch: entry "<id>" not found` em stderr; o `host` fica no valor de origem e `--host 0.0.0.0` volta a funcionar | **0** |
| **`insert`** com `id` que **já existe** | **duas** linhas com o mesmo `id`, **sem aviso nenhum** | **0** |

```console
$ dsh --profile web --dump-config
dsh: [.../profiles/web/cordis.patch.yml] patch: entry "<ID-DA-ENTRADA-DO-SERVIDOR-WEB-NESTA-INSTALACAO>" not found
$ echo $?
0
```

Isto é **pior** do que o boot rejeitado que se temia: o modo de falha é fail-OPEN.
O operador vê um aviso de uma linha no meio do arranque e fica com um servidor sem
o endurecimento que julga ter aplicado.

Duas consequências de desenho, ambas já aplicadas:

1. **Contar linhas não detecta o erro** — dá 1 nos dois casos. A verificação que
   funciona lê o **valor**: `host` tem de ser o literal `127.0.0.1`.
2. **Um bundle nunca pode inserir `id` alheio**, porque a colisão duplica em
   silêncio. O bundle insere só `guarded-bot-orchestrator`, que mais ninguém
   declara.

### 5.4 `--dump-default-config` ignora a camada de perfil, de propósito

Armadilha de verificação que custou uma iteração aqui. `--dump-default-config` é
um diagnóstico de recuperação que compõe **só os bundles**, para não rebentar com
um patch de utilizador partido (`dsh-app-boot/lib/index.js` L533-537, `loadProfile`
com `options.userLayer !== false`).

Verificar um patch de perfil com ele mostra sempre a configuração **sem** esse
patch, e faz qualquer verificação correta parecer falhada. **Para verificar a
Camada 2, use `--dump-config`.**

---

## 6. `worker.graceMs` — chave nova, e o acoplamento a T1.1

Nasce nesta onda, na Camada 1:

```yaml
worker:
  graceMs: 3000
```

`SubprocessSpawnSpec` exige `graceMs` (`09-DECISOES-CANONICAS.md` E3;
`03-ONDAS.md` L106): `argv`, `cwd`, `stdio` e `graceMs` são **obrigatórios**. O
`spawn` envia SIGTERM, espera este intervalo e só então parte para SIGKILL.

**3000 ms** é o `disposeGraceMs` do `dsh-terminal-bash` — adotado por alinhamento
com o host, em vez de um número inventado.

> **Acoplamento duro com T1.1.** `worker.graceMs` no manifesto tem de casar, chave
> a chave, com `Config['worker']['graceMs']` na `interface Config` que T1.1
> acrescenta em `src/`. Se as duas não casarem, o contrato congelado quebra.

---

## 7. Chaves que o bundle **omite**, e porquê

Um patch de Bundle é aplicado automaticamente a toda a gente. **Uma expressão que
lance ali não produz "configuração inválida": produz um `dsh` que não arranca,
para alguém que só correu `dsh plugin add`.** É o critério que decidiu estas duas
omissões.

O alvo é a saída canónica do quickstart (`09-DECISOES-CANONICAS.md` D19,
`06-REPO-E-CI.md` §4.2), em que "não configurado" é um estado **legítimo**:

```console
$ dsh plugin --profile web add dsh-guarded-bot-orchestrator
$ dsh web
[guarded-bot] senha gerada (aparece UMA vez): K7QF-2M9X-...-4TZP
[guarded-bot] bind 127.0.0.1:3080 — OK
[guarded-bot] telegram: não configurado — rode /parear <código> no bot para ligar
```

### 7.1 `encodedAuthString` — omitida

Ver §3. Não há valor correto para pôr aqui: um literal é uma senha num ficheiro
versionável; um `!!js` que lança quebra o boot de quem instalou; e `''` seria uma
declaração falsa de "credencial fixada vazia". A omissão é a única opção
verdadeira, e é a que D19 exige — o plugin **gera** a credencial.

### 7.2 `worker.cwd` — omitida no bundle, exemplificada no profile

O valor antigo era `/usr/local/lib/dsh-plugins/dsh-guarded-bot-orchestrator/worker`.
Depois de `dsh plugin add`, o pacote fica sob o `node_modules` do perfil — **esse
caminho não existe**. E o plugin valida no arranque que o `cwd` existe e é um
diretório. Um caminho fixo errado num bundle transforma **cada** instalação por
npm num boot quebrado.

**E o `cwd` nem é como o worker é encontrado.** O entrypoint resolve-se a partir de
`import.meta.url` (§7.3), que é imune ao diretório de trabalho. O `cwd` é só o
diretório do processo filho, e o plugin aplica um default seguro. Quem faz a
distribuição pré-compilada fixa-o na Camada 2 — o exemplo está lá, completo.

> **Cuidado com a árvore certa:** no tarball o worker está em **`dist/worker/`**;
> `<pacote>/worker/` é **fonte** e não viaja. O `files` canónico (D13) é
> `["dist", "cordis.patch.yml", "README.md", "LICENSE", "CHANGELOG.md"]` — **`dist`
> sozinho já leva `dist/worker/`, e não se acrescenta `"worker"`**. O `files`
> atual do repositório (`["dist","src","types","!types/__smoke__.ts",…]`) ainda não
> é o de D13, mas isso é do dono do `package.json`, não desta sub-tarefa.

---

### 7.3 `worker.command` / `worker.args` — o entrypoint Python era um valor morto

**Corrigido depois da revisão adversarial.** O ficheiro antigo trazia:

```yaml
worker:
  command: 'python3'
  args: ['bot_long_polling.py']
```

`bot_long_polling.py` **não existe em lado nenhum do repositório**. É resíduo do
projeto pré-plano, e sobreviveu a uma reescrita de 554 linhas por estar numa chave
que ninguém questionou. Num patch de **Camada 1**, esse valor morto passaria a ser
aplicado automaticamente em toda instalação por npm.

O plano manda o contrário, em três sítios: `01-ARQUITETURA.md` §(b) — *"o `command`
deixa de ser `python3 bot_long_polling.py` e passa a ser o runtime Node com um
entrypoint próprio"* — e a tabela de-para de §11.2; `09-DECISOES-CANONICAS.md` D1;
`06-REPO-E-CI.md` §2.1.

**O valor entregue:**

```yaml
worker:
  command: !!js process.execPath
  args: []
```

- **`command`** é o binário do Node que já corre o host. Assim o worker roda no
  mesmo Node que o `dsh`, sem depender de haver um `node` no `PATH` nem de qual
  versão é. É `!!js` sobre valor não sensível — o mesmo padrão que o `dsh-base` usa
  para `process.cwd()` e `process.platform`. Nunca lança.
- **`args` é para argumentos EXTRA, e o entrypoint não está lá.** A decisão
  canónica (`09-DECISOES-CANONICAS.md` L199-200; `01-ARQUITETURA.md` L521-522;
  `06-REPO-E-CI.md` L283-284) é: *"o `argv` do spawn resolve
  `dist/worker/telegram-bot.js` **relativo a `import.meta.url`**, nunca por
  `cwd`"*. O plugin resolve e antepõe.

**Porque o entrypoint não pode viver no manifesto**, mesmo que se quisesse: um
caminho relativo resolveria contra o `cwd` do **host**, não o do pacote; e o
caminho absoluto do pacote só é conhecido em tempo de execução, depois de o
`dsh plugin add` decidir onde o instalou. (E spawnar o `.ts` direto de
`node_modules` é impossível — o Node recusa type stripping ali,
`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Daí compilar para `dist/worker/`.)

> **Para T1.1:** `command` e `args` já existem na `Config`, portanto não há chave
> nova. O que há é um **requisito de comportamento**: o supervisor tem de
> **antepor** o entrypoint resolvido de `import.meta.url` ao `args` recebido, em
> vez de tratar `args` como a linha de comando completa.

---

## 8. Prova de que a camada é ativada — execução real, perfil limpo

`@deepseek-ai/dsh@0.1.0-rc.7`, `$DSH_HOME` novo, pacote local com o bloco `dsh`
proposto.

**1. Perfil limpo, criado pelo próprio `dsh`:**

```json
{ "name": "dsh-profile-web", "private": true, "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } } }
```

**2. `dsh plugin add` — a camada entra sozinha:**

```console
$ dsh plugin --profile web add ./pkg
+ dsh-guarded-bot-orchestrator
$ node -e "console.log(require('\$DSH_HOME/profiles/web/package.json').dsh.profile.bundles)"
[ '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-guarded-bot-orchestrator' ]
```

**3. O patch é composto — `--dump-default-config` (camadas de bundle):**

```yaml
# == dsh-guarded-bot-orchestrator
- id: guarded-bot-orchestrator
  name: dsh-guarded-bot-orchestrator
  config:
    realm: Secure DSH Interface
    …
      token: !!js process.env.TELEGRAM_BOT_TOKEN ?? ''
      graceMs: 3000
```

**4. Camada 2 aplicada, `--dump-config` (inclui a camada de perfil):**

```yaml
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject:
    - webStartup
  config:
    host: 127.0.0.1                          # <- o override aplicou
    port: !!js ctx.webStartup.port ?? 3080    # <- preservado
```

`name` e `inject` intactos **sem terem sido repetidos** (§5.1); exatamente **uma**
linha de servidor web; stderr vazio; exit 0.

**Nenhum `cp` manual em passo nenhum.**

> **Nota de ambiente, não é do plugin:** `npm i @deepseek-ai/dsh@0.1.0-rc.7` sozinho
> não arranca — `ERR_MODULE_NOT_FOUND: @deepseek-ai/cordis-plugin-group`, importado
> por `@deepseek-ai/dsh-app-boot`. É uma dependência transitiva em falta no
> publicado. Contorna-se instalando-a explicitamente. Vale registar para o
> `dsh-compat.yml` e para o `docs/TROUBLESHOOTING.md`.

---

## 9. Handoffs

### 9.1 Para **T1.2** — bloco `dsh` do `package.json`

T1.3 **não possui** `package.json`, em coluna nenhuma. O bloco vai como texto no
relatório; T1.2 aplica-o sem decidir a forma. Está em §10.

### 9.2 Para **T1.4** — o que sai do `README.md`

T1.3 **decide**, T1.4 **edita**. Ver §11.

### 9.3 Para **T1.1** — o contrato congelado

O manifesto casa chave a chave com a `interface Config`. Quatro acertos:

| # | Chave | Manifesto | Pedido a `interface Config` |
| --- | --- | --- | --- |
| 1 | `worker.graceMs` | **presente**, `3000` | **acrescentar** (já é entrega declarada de T1.1) |
| 2 | `encodedAuthString` | **ausente** (D19/regra 6) | deixar de ser `string` obrigatória |
| 3 | `worker.cwd` | **ausente** | deixar de ser obrigatória, com default seguro (o worker não é localizado por `cwd`) |
| 4 | `worker.command` / `worker.args` | `process.execPath` / `[]` | sem chave nova, mas o supervisor tem de **antepor** `dist/worker/telegram-bot.js` resolvido de `import.meta.url` (§7.3) |

(2) e (3) são consequência direta de tornar o ficheiro um **bundle**. Se não
puderem entrar nesta onda, o mínimo é torná-las opcionais — enquanto forem
obrigatórias e ausentes, a validação de config recusa o arranque e o quickstart de
D19 não roda.

### 9.4 Para **T3.3** e **T5.1** — herdam o `cordis.patch.yml`

- O ficheiro é agora **Camada 1 (Bundle)**. A regra herdada: **nada que lance no
  carregamento, e nenhum `id` que não seja do próprio plugin.** Configuração que
  precise de uma dessas coisas vai para `cordis.profile.patch.example.yml`.
- **T3.3** amplia `Config` com `exposure.*` (`mode` default `'loopback'`,
  `autoStart` default `false`, `trustEdgeHeaders` default `false`), `tunnel.*` e
  `control.*` (nomes canónicos em D5). Essas chaves **ainda não estão** no
  manifesto, deliberadamente: não estão na `interface Config` desta onda, e
  acrescentá-las agora quebraria o contrato congelado. Quando entrarem, os
  defaults de fábrica têm de manter `'loopback'` + `autoStart: false`
  (`04-TESTES.md` TENSAO-003).
- Ao acrescentar chaves, confirme o efeito real:
  `dsh --profile web --dump-config` — **não** `--dump-default-config` (§5.4).

---

## 10. Bloco `dsh` para T1.2 aplicar

Colar no `package.json`, no mesmo nível de `keywords`, **substituindo** a chave
`"//dsh"` atual (que documenta a decisão contrária e deixa de valer):

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
```

**Justificação, em três linhas:**

1. É a forma que o próprio harness usa —
   `@deepseek-ai/dsh-base@0.1.0-rc.7` e `@deepseek-ai/dsh-web-app@0.1.0-rc.7`
   declaram exatamente `{"bundle":{"patch":"./cordis.patch.yml"}}`.
2. É **necessária** para o plugin ativar: `exportsPatch` testa
   `dsh?.bundle?.patch !== void 0`, e `loadProfile` **lança** no boot se um bundle
   listado não a declarar (§1.1).
3. Já não é perigosa: o ficheiro apontado é insert puro, com um único `id`, o do
   próprio plugin (§2).

`files` já inclui `"cordis.patch.yml"` — condição necessária, porque o `patch` é
resolvido contra o diretório do pacote instalado. **Não acrescente `"worker"`**: o
worker viaja compilado dentro de `dist/` (§7.2, §7.3).

---

## 11. Pedido a T1.4 — `README.md`

O `README.md` é de T1.4 nesta onda. Estas quatro edições são decisões de T1.3;
T1.3 não tocou no ficheiro.

1. **§"Onde colocar o `cordis.patch.yml`" (L130-148) — remover a instrução de
   copiar à mão.** Hoje o README manda `cp cordis.patch.yml "$DSH_HOME/profiles/…"`
   e explica que o `package.json` **não** declara `dsh.bundle.patch` de propósito.
   As duas coisas deixam de valer. A instalação é:

   ```console
   $ dsh plugin --profile web add dsh-guarded-bot-orchestrator
   ```

   O `cp` só aparece — opcional, e para o **outro** ficheiro — na secção do
   endurecimento de bind.

2. **§"Obrigatório antes de aplicar: confirmar o `id` do servidor web"
   (L150-171) — reescrever.** Deixa de ser "obrigatório antes de aplicar" (não é
   preciso para instalar) e passa a ser um passo do endurecimento opcional. E a
   receita muda: existe comando (`dsh --profile web --dump-default-config | grep -B1
   dsh-host-webserver`), o `id` medido é `webserver`, e quem o declara é
   `@deepseek-ai/dsh-web-app`, **não** o `dsh-base` (§5.2).

3. **Corrigir *whole-entry replace* (L145-148, L166-171).** A formulação exata é:
   o override é um **shallow merge das chaves de topo da linha**, e o `config`, se
   fornecido, é substituído **inteiro**. O README afirma que a entrada do servidor
   web reescreve `name` e `port` "só para poder mudar `host`". `port`, sim;
   `name`, **não** — e repetir `name` é ativamente arriscado, porque um `name` que
   não bate faz o patch ser saltado em silêncio (§5.1).

4. **Corrigir o modo de falha do `id` errado (L166-171).** O README promete
   conflito de rota e boot rejeitado. O medido é: entrada saltada, aviso em stderr,
   **exit 0**, endurecimento silenciosamente ausente (§5.3). E a verificação tem de
   ler o **valor** de `host`, porque contar linhas dá 1 nos dois casos.

Ainda por cima: L109 diz *"Cada expressão `!!js` do `cordis.patch.yml` é um IIFE
que…"* e a secção de credencial inteira (~L100-129) descreve o mecanismo
`ADMIN_USER`/`ADMIN_PASS` que D19 elimina. Se a reescrita de T1.4 não a alcançar,
fica como pedido explícito.

---

## 12. Premissas assumidas

1. **`core-auth-interceptor` não é linha de manifesto** (§2.2). D5 lista o nome na
   coluna de `id` do `cordis.patch.yml`; a tarefa exige que o bundle contenha só a
   entrada do próprio plugin, e o pacote que a linha referenciava não existe.
2. **`exposure.*`, `control.*` e `tunnel.*` ficam fora do manifesto nesta onda**
   (§9.4). São nomes canónicos de D5, mas não estão na `interface Config` desta
   onda; declará-los agora violaria o contrato congelado. São de T3.3/T5.1.
3. **O `id` medido `webserver` entra no exemplo como valor vivo**, com o nome
   canónico do placeholder mantido na prosa e o comando de confirmação ao lado.
   Um placeholder literal no ficheiro produz exatamente o fail-open de §5.3.
4. **`port` no override do servidor web copia a expressão de origem**
   (`!!js ctx.webStartup.port ?? 3080`) em vez de um literal, para que `--port`
   continue a funcionar. Endurece-se o endereço, que é o que expõe à rede; a porta
   não é decisão de segurança.
5. **O bloco `dsh` mantém `bundle` como único filho.** Não se declara
   `dsh.client`: o plugin não serve UI de browser própria nesta onda. O
   `contributing.md` avisa que declarar **só** `dsh.client` reprova — declarar só
   `bundle` é o caso aceite.
