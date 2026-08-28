# AGENTS.md — O dispatcher de agentes: manual completo

Este documento é o manual do **dispatcher de agentes**: a feature que liga o bot
(Telegram ou Discord) ao `ctx.subagents` do DeepSeek Harness. O dono escolhe uma
**skill da allowlist** e escreve um **prompt**; o host spawna um **subagente
in-process** do harness (sessão fresca, zero contexto do pai) que trabalha na
própria máquina; o resultado chega ao chat.

> **Verdade-a-dia-da-escrita:** tudo abaixo descreve a árvore real —
> `src/agents/registry.ts` (o dispatcher no host), `src/agents/harness.ts` (o
> espelho mínimo da API do harness), `src/contracts/ipc.ts` (o transporte),
> `worker/surface/commands.ts` (a superfície) e `src/control/surface-ipc.ts`
> (o consumidor das intents no host). Nenhum nome aqui é projeto futuro.

---

## 1. O que é (e o que NÃO é)

- **É** uma porta de saída **única** do host para o harness: o dispatch passa por
  allowlist (default deny), teto de runs concorrentes, auditoria de cada ação e
  um disposer que mata tudo em LIFO. Quem dispara é **sempre** o dono pareado,
  pelo bot.
- **NÃO é** um serviço de agentes persistente: os runs vivem **só em memória** —
  nada disto persiste no `state.json`. Um reinício do DSH cancela todos os runs
  em curso e a lista recomeça vazia. Persistir runs exigiria persistir também o
  que eles estão a fazer — contrato novo, fora desta onda.
- **NÃO é** uma forma de o bot ganhar permissões novas: o agente disparado roda
  com as permissões que o **harness** lhe dá, e o request **nunca recebe token
  nem credencial** deste plugin (invariante S3 — ver §5).

O transporte é o canal IPC existente (`src/contracts/ipc.ts`, EMENDA
ONDA-4-AGENTS-HOST):

| Mensagem | Sentido | Papel |
| --- | --- | --- |
| `agent.dispatch` | worker → host | dispara UM agente com `{ skill, prompt }`. **AUMENTA exposição** (execução de código no host) → **exige nonce** (confirmação em 2 etapas), como `tunnel.up`/`secret.rotate` |
| `agent.status` | worker → host | lista os runs. Leitura pura — **não exige nonce** |
| `agent.cancel` | worker → host | cancela UM run pelo `{ agentId }`. **REDUZ** → dispensa nonce (CTL-024) |
| `agent.report` | host → worker | a lista de runs: resposta a `agent.status` **e** difusão proativa quando um run termina |

Nada de segredo viaja nestes campos (S3): skill, prompt e agentId são dados do
dono, nunca credenciais.

---

## 2. O ciclo de vida de um run

```
/agente <skill> <prompt>  (bot)
   │  1. forma: skill kebab-case, prompt não-vazio
   │  2. nonce.request (acao 'reset') → host emite nonce (TTL 60 s)   [S5: opaco]
   │  3. tela de confirmação com o prompt QUE VAI + botões [✅ Sim, disparar] [✕ Não]
   ▼
clique em ✅ → worker valida o token LOCAL (TTL 60 s, userKey+chatKey, uso único)
   │          → intent agent.dispatch com o nonce opaco + params {skill, prompt}
   ▼
HOST (surface-ipc):
   │  1. consome o nonce com 'reset' (NONCE_INVALID → rejected, sem consultar a skill)
   │  2. registry.despachar() — SINCRONO: allowlist → teto → harness presente
   │        recusas → mensagem acionável ao dono (§4); aceite → ack 'accepted'
   ▼
registry.executar() (assíncrono, depois do ack):
   │  1. resolve o PARENT: ctx.agents.roots()[0] — o agente-racaiz vivo do harness,
   │     NO MOMENTO do despacho; o cwd da sessão dele é o workspace do filho
   │  2. ctx.skills.get(skill, { cwd, signal, scope: parent }) → definição da skill
   │     (inexistente na instalação → run termina 'failed', nunca inventa)
   │  3. prompt = <skill_content> CANÓNICO (renderHarnessSkill) + instrução do dono
   │  4. ctx.subagents.start('spawn', { label: skill, prompt, parent, signal })
   ▼
resultado → statusDe(stopReason): completed→done · aborted→cancelled ·
             error/max-tokens/refusal→failed
   │   → summary = 1 linha do texto do modelo (cortado em 300 chars)
   ▼
encerrar(): audit + difusão agent.report (best-effort) → o bot notifica
   «🤖 Atualização de agentes: …» (§4)
```

Pontos que o diagrama esconde e são decisivos:

- **O ack sai ANTES do trabalho.** As recusas de política (allowlist, teto,
  harness ausente) são **síncronas** — o bot responde-as no próprio tick. O que
  é assíncrono (carregar a skill, o `start()` do harness) corre depois do ack:
  uma falha aí não desfaz o ack — o run nasce e termina `failed` com o motivo no
  `summary`, e o relatório difundido diz a verdade ao dono.
- **O parent nunca se inventa.** `SubagentStartRequest.parent` é OBRIGATÓRIO no
  harness ("The spawning agent. In-process providers derive workspace, lineage,
  and delegation depth from its durable session state"). O plugin corre no
  contexto do HOST, fora de qualquer agente — a única fonte honesta de um agente
  vivo de topo é `ctx.agents.roots()`. Sem agente vivo, o despacho é recusado.
- **A skill entra como conteúdo do prompt, no formato canónico.** O bloco
  `<skill_content>` é o MESMO que o harness injeta num agente que invoca a skill
  pelo caminho normal — o comportamento do filho é idêntico ao de um agente que
  a invocou diretamente.
- **Cancelar é duplo e imediato:** o `AbortController` aborta o sinal do harness
  (o turno para) e o `dispose()` liberta o handle publicado ("always dispose").
  O status muda para `cancelled` no próprio tick — o dono não vê `running` para
  um run que acabou de cancelar. Id desconhecido ou já terminal → **noop
  idempotente** (nunca um erro), o mesmo espírito de um `stop` em `STOPPED`.

---

## 3. Configuração

O eixo `agents` é **opcional** e vive no objeto `config` do `cordis.patch.yml`
(na prática, na **Camada 2 — Profile** `cordis.profile.patch.example.yml` ou na
**Camada 3 — Home** `$DSH_HOME/cordis.patch.yml`; o Bundle do pacote não o
declara — ver §7 para o exemplo completo e as armadilhas do motor de patches).

| Chave | Tipo | Default | Papel |
| --- | --- | --- | --- |
| `agents.skills` | lista de strings | `[]` | A **allowlist** de skills disparáveis (default deny). Cada nome é **kebab-case** — a grammar pública do harness `^[a-z0-9]+(?:-[a-z0-9]+)*$` — e é validado no arranque (`assertValidConfig`). **VAZIA ou AUSENTE = NENHUM agente disparável** (fail-closed) |
| `agents.maxRuns` | inteiro | `1` | Teto de runs **concorrentes**, validado no arranque entre **1 e 32** (`AGENTS_MAX_RUNS_CEILING`). Acima do teto, `agent.dispatch` é recusado até um run terminar |

**A ausência é a leitura mais fechada, nunca um default que abre:** `resolveAgents`
devolve `AGENTS_FAIL_CLOSED = { skills: [], maxRuns: 1 }` quando `config.agents`
não existe — o plugin funciona, só não dispara nada. O `warn` ruidoso do arranque
(`src/index.ts`) existe para a ausência ser uma **escolha visível**, nunca um
esquecimento silencioso:

```
config.agents AUSENTE: assume-se a leitura mais fechada -- skills vazio
(NENHUM agente disparavel) e maxRuns 1. Declare o eixo `agents` no
cordis.patch.yml (agents.skills + agents.maxRuns) para disparar agentes.
```

**Porque o teto é 32 e não outro número:** o relatório `agent.report` tem teto de
transporte (`MAX_RUNS_PER_REPORT` = 64 — acima disso o codec recusa a linha e o
dono ficaria sem resposta). Com `maxRuns` ≤ 32 e o histórico em memória capado em
32 (`MAX_RUNS_HISTORY`), a tabela inteira — 32 vivos + 32 terminais — cabe **por
construção** numa única mensagem. O `slice(-64)` na emissão é a rede final: mesmo
que os tetos mudem no futuro, a lista nunca estoura o codec (EMENDA
ONDA-4-FIX-REPORT-CAPS).

---

## 4. Comandos do bot (textos EXATOS)

Os comandos de agentes são do **núcleo neutro** (`worker/surface/commands.ts` +
`worker/surface/text.ts`) — funcionam **igual no Telegram e no Discord**. Os
textos abaixo são os do código; estão congelados também em
[`docs/ux/01-CONTRATO-BOT.md`](ux/01-CONTRATO-BOT.md) §10.

### `/agente <skill> <o que o agente deve fazer>`

| Situação | Texto exato |
| --- | --- |
| Sem skill (ou sem nada) | `Uso: /agente <skill> <o que o agente deve fazer>` |
| Skill fora de kebab-case | `Skill inválida (kebab-case). Uso: /agente <skill> <o que o agente deve fazer>` |
| Sem prompt | `Falta o prompt. Uso: /agente <skill> <o que o agente deve fazer>` |
| Host sem nonce (fail-closed, CTL-023) | `Não foi possível obter a confirmação do host. Tente de novo em alguns segundos.` |
| Tela de confirmação (botões `✅ Sim, disparar` e `✕ Não`) | `🤖 Disparar o agente "<skill>?"` + linha `Ele executa código na tua máquina com este prompt:` + linha `"<prompt>"` |

O prompt que se confirma é o que vai: sanitizado para UMA linha (controlos viram
espaço — o codec do canal recusa controlos no campo) e cortado em
`MAX_PROMPT_CHARS` (4096 — o teto do codec; um prompt acima dele faria o intent
ser recusado na forma). O clique em `✕ Não` é navegação local (não envia intent,
não consome nonce) e responde `Ok, cancelado.` — ver §4 do contrato do bot.

O clique em `✅ Sim, disparar` responde **sempre** ao clique (TG-027) e, quando o
token local (TTL 60 s, espelho do nonce do host) expirou ou veio de outro emissor:

`Confirmação expirada ou inválida. Mande /agente de novo.`

Depois, o ack do host edita a mensagem da confirmação:

`Agente disparado. O resultado chega aqui quando terminar.`

**Recusas de política** chegam como erro do host com mensagem acionável (o
vocabulário de códigos IPC é fechado e nenhum código diz "skill não autorizada"):

| Motivo | Texto exato |
| --- | --- |
| Skill fora da allowlist | `A skill "<skill>" nao esta autorizada neste plugin (config agents.skills).` |
| Teto atingido | `Ja ha agentes a correr ate o limite (config agents.maxRuns). Espera um terminar ou cancela um.` |
| Harness indisponível | `O harness nao esta disponivel para disparar agentes.` |

### `/agentes`

Pede a lista ao host (`agent.status`); a resposta é a difusão `agent.report` que
o host envia **antes do ack** (o ack `noop` só retira o pendente — renderizar
"Já estava assim." por cima da lista seria destrocar a resposta).

Com runs:

```
🤖 Agentes:
• <id> — <skill> — <estado> <há quanto>
   💬 <summary>
```

- Uma linha por run: `• <id> — <skill> — <rótulo> <há quanto>`; o `summary`
  (1 linha, quando o run terminou e há texto) vai numa linha própria indentada:
  `   💬 <summary>`.
- Rótulos de estado: `rodando` · `concluído` · `falhou` · `cancelado`.
- Tempos (`haQuantoTempo`): `agora mesmo`, `há menos de 1 min`, `há 2 min`,
  `há 1 h 30 min` (o mesmo relógio do `formatarDuracao`; um run acabado de
  nascer/terminar nunca lê "há agora").
- Sem runs: `Nenhum agente rodando.`

O botão `🤖 Agentes` do cartão de controlo (`/menu`) faz a mesma coisa, com o
toast `A consultar…` no clique (o padrão do "Link de acesso" — evita o botão
morto).

**Difusão proativa** — quando um ou mais runs terminam SEM `agent.status`
pendente, o host difunde `agent.report` e o bot notifica:

```
🤖 Atualização de agentes:
• <id> — <skill> — <estado> <há quanto>
   💬 <summary>
```

### `/parar-agente <id>`

REDUZ exposição → sem nonce (CTL-024), como o `/desligar`. O id viaja no
`params`; o ack decide a resposta:

| Situação | Texto exato |
| --- | --- |
| Id válido e cancelado | `Agente <id> cancelado.` |
| Id válido mas run já não existe/terminou (noop) | `Agente <id> não encontrado.` |
| Id fora da forma (não são 8 caracteres do alfabeto do ULID) | `Id inválido. Uso: /parar-agente <id> — os ids aparecem em /agentes.` |

---

## 5. Segurança (porquê cada peça existe)

1. **Dispatch AUMENTA a exposição → confirmação em 2 etapas.** Disparar um
   agente é executar código na tua máquina — a ação mais poderosa do bot. Por
   isso o `/agente` pede o **nonce do host** (a mesma ponte do `/rotacionar`,
   acao `reset` do vocabulário fechado de `ControlAction`) e só o clique no botão
   com o nonce opaco (S5: o worker nunca o lê, valida ou loga) autoriza o
   dispatch. Sem nonce não há confirmação possível — fail-closed (CTL-023). O
   cancelar, ao contrário, **reduz** exposição e dispensa nonce (CTL-024: em
   pânico, tem de funcionar à primeira).
2. **O agente roda com as permissões do harness e NUNCA recebe token.** O
   `SubagentStartRequest` carrega só texto: o bloco `<skill_content>` canónico +
   o prompt do dono. Não há campo para token nem credencial — o request deste
   plugin nunca recebe nada (S3), logo o que o agente devolve (o `summary`) não
   pode conter segredo nosso. O filho herda workspace, linhagem e profundidade do
   **agente-pai raiz** do harness, e as permissões que o harness lhe der.
3. **Allowlist default-deny antes de tudo.** A primeira checagem do `despachar`
   é `config.agents.skills` — uma skill fora da lista é recusada de forma
   síncrona, com auditoria `negado`. Vazio = nada disparável. A allowlist vive no
   HOST (como o nonce — S6): o worker não conhece a lista e não tem como listar
   skills.
4. **Runs efémeros — reinício do DSH cancela tudo.** Os runs vivem só em
   memória; o disposer do registry (`dispose()`) aborta os runs ativos em LIFO
   (o mais recente primeiro — a mesma garantia da Fiber) e liberta os handles.
   Um reinício do DSH derruba os runs em curso e a lista recomeça vazia. Sem
   `state.json` a guardar runs, não há run que sobreviva a um reboot — nem a
   uma reinicialização do bot.
5. **Auditoria em cada transição.** Despacho aceite/recusado, cancelamento e fim
   de cada run são contados com eventos fechados (`comporEventoAgente*` em
   `src/audit/events.ts`).

---

## 6. Limitações (factos do contrato, não bugs)

- **Relatório ≤ 64 runs por mensagem** — o teto de transporte do `agent.report`
  (`MAX_RUNS_PER_REPORT`): acima disso o codec recusa a linha. Por construção
  nunca acontece (maxRuns ≤ 32 + histórico ≤ 32), e o `slice(-64)` mantém os
  MAIS RECENTES se os tetos mudarem.
- **Prompt ≤ 4096 caracteres** — o teto do codec do canal (`MAX_MESSAGE_CHARS`),
  espelhado em `MAX_PROMPT_CHARS`. O corte acontece na superfície (dono da
  forma), nunca após a ida ao canal. O prompt é ainda sanitizado para UMA linha.
- **Skill em kebab-case** — `^[a-z0-9]+(?:-[a-z0-9]+)*$`, a grammar pública do
  harness. Fora disso o comando é recusado na forma (antes de ir ao host).
- **Id de run com 8 caracteres** — a parte aleatória do ULID do run (alfabeto
  `0-9A-Z` sem `I, L, O, U`), o que `/agentes` lista e `/parar-agente` cancela.
- **`summary` é texto do modelo** — o resumo de 1 linha (≤ 300 caracteres,
  `MAX_SUMMARY_CHARS`) vem da resposta do agente, cortado do texto da primeira
  linha. Não é garantia de qualidade: é o que o modelo devolveu.
- **Um dono só, uma lista** — o dispatcher serve o dono pareado; não há
  per-run por usuário nem filas por skill.
- **Sem fila de espera** — com o teto atingido, o dispatch é recusado (mensagem
  acionável); não existe enfileiramento (enfileirar um start de agente seria
  executar código horas depois de o dono o ter pedido — decidir não fazê-lo).
- **Sem persistência** — runs não sobrevivem a reinício (ver §5.4).

---

## 7. Exemplo de configuração

O Bundle (`cordis.patch.yml`) **não** declara o eixo `agents` de propósito: a
ausência é o estado fail-closed legítimo e o Bundle não pode impor skills a toda
a gente que instala. O operador declara no **seu** patch de Profile (Camada 2) ou
Home (Camada 3):

```yaml
# $DSH_HOME/cordis.patch.yml  (Camada 3) — ou cordis.profile.patch.example.yml (Camada 2)
# >>> ATENÇÃO AO MOTOR DE PATCHES: o `replace` substitui o objeto `config`
# >>> INTEIRO — um patch superior que reescreva `config` sem uma chave APAGA-A
# >>> (a mesma regra de `exposure`/`control`). Se o teu `config` já tem
# >>> allowedHosts/trustedRemotes/etc., inclui-os AQUI também; o fragmento
# >>> abaixo é o eixo NOVO, não o config inteiro.
- id: guard-messenger
  name: 'dsh-guard-messenger'
  config:
    # ... as tuas chaves existentes (allowedHosts, trustedRemotes, exposure, ...)

    # --- Dispatcher de agentes --------------------------------------------
    # A ALLOWLIST de skills disparáveis (default deny). Vazio/ausente =
    # nenhum agente disparável — o plugin funciona, só não dispara nada.
    # Cada nome é kebab-case e é validado no arranque (assertValidConfig).
    agents:
      skills:
        - 'code-review'
        - 'surf-research-agent'
      # Teto de runs CONCORRENTES, 1..32 (assert). Acima, o dispatch é
      # recusado até um run terminar.
      maxRuns: 4
```

Depois de aplicar, reinicia o DSH. O arranque valida as skills (kebab-case) e o
teto (1..32) com `assertValidConfig`; uma allowlist vazia ou eixo ausente emite o
`warn` ruidoso do §3 e nada dispara.

> **As skills da allowlist têm de existir na instalação do harness do
> agente-pai** (`ctx.skills.get` no catálogo dele): uma skill na allowlist mas
> ausente da instalação faz o run nascer e terminar `failed` com
> `A skill "<skill>" nao existe nesta instalacao do harness.` — nunca inventa.

---

## 8. Referências

- `src/agents/registry.ts` — o dispatcher: allowlist, teto, cancelar, disposer
  LIFO, o relatório capado e a difusão proativa. DONO da porta de saída.
- `src/agents/harness.ts` — o espelho mínimo da API do harness (`ctx.subagents`,
  `ctx.agents`, `ctx.skills`, `renderHarnessSkill`), pinado por ficheiro do
  upstream.
- `src/contracts/ipc.ts` — as intents `agent.*`, o payload `params` e a mensagem
  `agent.report` (vocabulário `AgentRunStatus` fechado).
- `src/ipc/channel.ts` — o codec: `MAX_MESSAGE_CHARS` (4096) e
  `MAX_RUNS_PER_REPORT` (64).
- `src/control/surface-ipc.ts` — o consumidor no host: nonce 'reset' antes da
  allowlist, as mensagens de recusa acionáveis, a difusão do relatório.
- `src/config/schema.ts` — o eixo `agents` (`AgentsConfig`, `resolveAgents`,
  `AGENTS_FAIL_CLOSED`).
- `worker/surface/commands.ts` — `/agente`, `/agentes`, `/parar-agente` e a
  confirmação em 2 etapas (textos exatos no §4).
- `worker/surface/text.ts` — rótulos de estado, `haQuantoTempo`, `linhaDeRun`, o
  texto do relatório e o da difusão.
- `worker/surface/core.ts` — os acks de `agent.status`/`agent.cancel`, o botão
  `🤖 Agentes` do cartão (toast `A consultar…`) e a difusão proativa
  (`runsTerminadosDesde`).
- `test/unit/agents/registry.test.ts` — o dispatcher com o harness falso
  injetado (allowlist, teto, cancel, LIFO, caminhos de falha pós-ack, teto de 64).
