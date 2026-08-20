# 03 — Plano de execução em ONDAS (arquivo de consumo do `deep-orchestrator`)

> **O que este arquivo é.** O plano de *execução*, não o de arquitetura. As decisões de desenho
> estão em `01-ARQUITETURA.md` e `02-SEGURANCA.md`; aqui elas aparecem só o suficiente para que
> cada sub-tarefa seja executável sem abrir outro arquivo. Onde uma decisão determina a
> paralelização, ela está repetida aqui de propósito.
>
> **Quem consome.** A skill `deep-orchestrator`. Nomes de worktree, mapas de propriedade de
> arquivo e critérios de aceite são entrada literal para ela — não são ilustrativos.

---

## 0. Regras que o orquestrador segue

1. **Ondas topológicas.** Uma onda só começa quando a anterior fechou o gate. Dentro da onda,
   todas as sub-tarefas são **independentes** e rodam em **paralelo**, cada uma numa **git
   worktree nomeada** (nome exato na coluna `worktree`), sem jamais escrever no projeto principal.
2. **Integração serial com gate.** No fim da onda, cada worktree entra por **squash-merge, uma de
   cada vez**, na ordem de merge declarada; o gate roda **num snapshot depois de cada merge** —
   quem quebrar o snapshot volta para correção antes do próximo entrar. O comando de gate é
   **literalmente este, nesta ordem** (`09-DECISOES-CANONICAS.md` D4):

   ```
   pnpm lint && pnpm typecheck && pnpm build && pnpm test
   ```

   `lint` vem primeiro porque é o mais barato. **`pnpm test:security`, `pnpm test:contract` e
   `pnpm test:e2e` NÃO entram no gate de merge intra-onda** — são critério de aceite **da onda**
   (rodados uma vez, no fim dela, e listados no aceite) e required check de PR no CI.
   **`pnpm test:live` nunca é gate**, em nenhum ponto.

   *Armadilha tratada literalmente:* `node --test` com um glob que não casa com nenhum arquivo
   **sai com código 1**. Por isso todo diretório de teste criado por um COMMIT PREP nasce com um
   `_placeholder.test.ts` de asserção trivial verde, apagado pela primeira sub-tarefa real daquele
   diretório. Sem isso o gate fica vermelho na Onda 1 por ausência de arquivo, não por defeito.
3. **Revisão adversarial + limpeza.** Entre ondas, um revisor tenta **refutar** cada entrega com
   as perguntas falsificáveis da sub-tarefa; só depois worktree, branch e commits intermediários
   são apagados e a onda é commitada como uma unidade.

4. **Um COMMIT PREP é sempre um commit próprio**, separado do commit da onda. Isso não é estética:
   é o que garante que o repositório chegue à Onda 7 com folga sobre o piso de **≥10 commits** do
   registro `awesome-dsh-plugin` (7 commits de base + 8 preps + 8 ondas = 23). Squashar prep e onda
   no mesmo commit é violação de processo, não otimização.
5. **Símbolos `S*` (spikes) nunca aparecem na coluna `depende de`.** A coluna aceita **três**
   formas, e nenhuma outra: id de sub-tarefa (`T<onda>.<n>`), id de prep (`PREP <n>`) ou onda
   inteira (`Onda <n>`, usado só pelas Ondas 6 e 7, que dependem de tudo o que veio antes). Faixas
   (`T2.1–T2.5`) não são forma válida: enumere. O mapa `S* → T*` está em §2 e é a única forma de
   resolver um spike para um produtor.
6. **A coluna `arquivos exclusivos` é enumeração positiva.** Nunca "`X/**` exceto `Y`": glob com
   exceção em prosa não é consumível literalmente, e a exceção é justamente o que colide. Onde uma
   sub-tarefa possui quase um diretório inteiro, ela lista os caminhos que possui.
7. **A coluna `depende de` nunca nomeia uma sub-tarefa da MESMA onda.** Dentro da onda as
   sub-tarefas são independentes por definição (regra 1); quando duas precisam se acoplar, o
   acoplamento é um **contrato congelado no COMMIT PREP** e a dependência é do prep, não da irmã.
   Onde havia `contrato de T5.1` / `contrato de T7.1` / `contrato de T7.3`, agora se lê `PREP 5` e
   `PREP 7`. A única exceção declarada é o **handoff de texto** (T1.3 → T1.2 na Onda 1, T7.2 → T7.1
   na Onda 7): o produtor entrega um bloco no **relatório**, o consumidor aplica, e nenhum dos dois
   possui o arquivo do outro. Handoff está declarado na coluna, nunca implícito.
8. **Cada sub-tarefa carrega de 3 a 7 perguntas falsificáveis**, numeradas. Três é o piso; as que
   passam de cinco são as de superfície de segurança (T3.1, T3.4, T4.1, T4.4), onde cortar pergunta
   para caber num teto arbitrário seria trocar cobertura por estética. Nenhuma pode ficar abaixo de
   três, e nenhuma pode ser respondível com "sim, fizemos" — cada uma nomeia a medição.

**Parâmetros:** `max-parallel=5` (a Onda 2 tem 5 sub-tarefas; todas as outras têm 4 — o teto é a
propriedade de arquivo, não a capacidade do orquestrador). `plan=off` a partir da Onda 1: o plano
já é este documento. **Total: 8 ondas, 33 sub-tarefas.**

---

## 1. A tensão central, resolvida antes de qualquer onda

O plugin existente foi construído para **travar o DSH em loopback**. O usuário quer **expor o DSH
pela internet**. Parecem incompatíveis. Não são — e a razão determina metade do plano:

> **O `cloudflared` não pede que o bind se abra.** Ele abre uma conexão de **saída** para a borda
> da Cloudflare e conecta na origem por `http://127.0.0.1:3080`
> ([doc oficial](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)).
> Do ponto de vista do servidor HTTP do DSH, o cliente **continua sendo loopback**.

Consequências, todas viram requisito de sub-tarefa:

| Consequência | O que muda no código |
| --- | --- |
| `assertSecureBind` **fica como está**. O bind continua travado em `127.0.0.1`. | Nada. Reaproveitado integralmente. |
| `trustedRemotes: ['127.0.0.1']` **fica como está** — e **perde o significado** que tinha. | Nada no código; muda a **doutrina**. Antes, "origem loopback" provava que havia um humano na máquina. Com `cloudflared` local, loopback passa a significar "a internet inteira, via um proxy local". O gate de origem deixa de ser barreira e vira higiene. |
| **O gate de autenticação passa a ser a única barreira real** — e precisa ficar mais forte. | Ondas 2 e 3: segredo por CSPRNG, sessão, rate limit, lockout, auditoria, por cima do Basic Auth de credencial fixa. |
| Rate limit por IP fica **cego** se o `cloudflared` não repassar o IP do cliente. | Spike **S2** (Onda 0). Sem ele o limitador é por sessão/global — e isso tem que ser **declarado**, não fingido. |
| A URL do túnel **não é segredo**. Uma chamada à API pública do urlscan.io devolve dezenas de hostnames `*.trycloudflare.com`, e ~18% dos amostrados resolviam em DNS no mesmo instante. | Nenhuma sub-tarefa pode tratar a URL como credencial. O plano assume URL pública desde o segundo zero. |

**Nada do endurecimento existente é revertido.** O que se acrescenta é autenticação de verdade
por cima dele.

---

## 2. Fatos NÃO CONFIRMADOS que viram spike (ler antes de tudo)

O DSH é real: `deepseek-ai/deepseek-harness`, MIT, 166.821 estrelas, push recente
([API do GitHub](https://api.github.com/repos/deepseek-ai/deepseek-harness)). Mas os quatro
markdowns de referência em `~/Documents/deepseek-harness` **não são fonte confiável de API** —
acertam a arquitetura e erram nomes de pacote, de serviço e assinaturas.

| Alegação dos markdowns | Realidade verificada | Impacto |
| --- | --- | --- |
| `import … from '@deepseek-ai/dsh-host-subprocess'` | **HTTP 404 no npm.** O real é `@deepseek-ai/dsh-subprocess` (+ `dsh-subprocess-local` para a implementação) | O import atual **não compila** contra o pacote real |
| `ctx.webServer`, tipo `WebServer`, `inject: ['webServer']` | O `.d.ts` real de `@deepseek-ai/dsh-host-webserver` declara `interface Context { httpServer: HttpServerService }`. **Não existe símbolo `WebServer`** | `inject`, `ctx.intercept('webServer', …)` e o tipo inteiro precisam ser reescritos |
| `ctx.subprocess.spawn(cmd, args, opts)` | Real: `spawn(spec: SubprocessSpawnSpec): SubprocessHandle`, com `argv`, `cwd`, `stdio`, `graceMs` **obrigatórios** | Migração não é "por cima"; a chamada muda de forma |
| `dsh-host-frontend` | Real: `@deepseek-ai/dsh-host-frontend-static` | Correção de nome em doc/comentário |
| `WebRoute` | **Existe e está correto** | Único tipo que sobrevive intacto |

Confirmado e utilizável no `.d.ts` real de `@deepseek-ai/cordis@4.0.1`: `ctx.intercept`,
`ctx.waterfall`, `ctx.parallel`, `ctx.effect`, `inject`, `Service`, Fibers e disposers LIFO.
**A camada conceitual bateu com o código; a camada de API não.**

### Spikes obrigatórios

| id | Pergunta não confirmada | Onde é resolvida | Se falhar |
| --- | --- | --- | --- |
| **S1** | `HttpServerService` expõe mesmo `register`, `registerFallback`, `registerUpgrade`? Qual a forma exata de `SubprocessSpawnSpec`? | T0.1 | O refactor da Onda 1 muda de escopo; T0.1 reporta e o orquestrador replaneja a Onda 1 |
| **S2** | O `cloudflared` repassa `CF-Connecting-IP` / `X-Forwarded-For` à origem? **E — pergunta que faltava e é a que importa para segurança — esse valor é controlável pelo cliente?** Se a borda apenas *acrescenta* ao `X-Forwarded-For` que o cliente enviou, um atacante (a) rotaciona identidade a cada requisição e nunca acumula backoff/ban, e (b) envia o IP do **dono** e envenena o ban contra ele. Medir: enviar `X-Forwarded-For: 1.2.3.4` e `CF-Connecting-IP: 1.2.3.4` de fora e ver exatamente o que chega à origem, e em que posição | T0.2 | Rate limit por IP é impossível **ou forjável**; T2.3 nasce por sessão/global, `exposure.trustEdgeHeaders` fica travado em `false`, e a limitação é **declarada no código e no README**, nunca fingida |
| **S3** | O WebSocket de telemetria do DSH atravessa um quick tunnel com tráfego bidirecional? | **T0.2** (é ele quem fecha a decisão de modo do COMMIT PREP 3); T6.1 apenas **re-confirma** em e2e, e a re-confirmação **não** é pré-requisito de nenhum prep | Quick tunnel deixa de ser o modo padrão; como o Modo B está adiado (§19), a exposição por túnel fica **bloqueada** até haver onda própria |
| **S4** | A Web UI / extensão do DSH tem ponto de contribuição para plugins colocarem controles? | T0.4 | Fallback já viável: painel em rota própria (`/__guard`), que é o desenho assumido — ver §2.1 (desvio declarado do pedido) |
| **S5** | O grammY aceita `apiRoot` apontando para uma Bot API local (para teste de integração)? | T0.3, plano B em T6.2 | Plano B: transporte falso injetado na camada de rede do worker |
| **S6** | O CI do `awesome-dsh-plugin` aceita `dsh.bundle` **sem** a subchave `patch`? | **spike embutido em T1.3, primeira hora** (não é dependência de onda anterior) | Se não aceitar, T1.3 entrega o bundle mínimo com patch próprio (insert puro, sem `id`) |
| **S7** | `InlineKeyboardButton` tem mesmo o campo `style` com `"success"`/`"danger"`/`"primary"`? **Circulou como fato de confiança Alta neste plano e não foi verificado contra a Bot API.** Verificar no `getMe`/doc oficial e mandando um teclado com `style` para um chat real | T0.3 | **T5.2 entrega o teclado sem `style`** (texto do botão carrega a semântica: "🟢 Ligar" / "🔴 Desligar"). O campo sai de `01-ARQUITETURA.md` §7.2 e de qualquer caso de teste |
| **S8** | `drop_pending_updates` é parâmetro de `getUpdates` ou só de `setWebhook`/`deleteWebhook`? No grammY a superfície é `bot.start({ drop_pending_updates })`. **O plano afirmava a primeira forma sem verificar** | T0.3 | T4.2 usa a superfície que existir; se nenhuma existir no polling, o descarte é feito por um `getUpdates` inicial com `offset: -1` e isso é **documentado** |
| **S9** | Existe API do host ou caminho canônico de **diretório de estado por plugin** no DSH? O plano fixa `$XDG_STATE_HOME/dsh-guarded-bot/` como default, mas isso é escolha nossa, não contrato do host | T0.1 | Fica o default XDG, com o caminho vindo da config; T2.5 documenta que **não** há API do host e que o diretório é responsabilidade do plugin |
| **S10** | Navegador atual aceita cookie `Secure` com prefixo `__Host-` emitido por `http://127.0.0.1:3080` (origem local tratada como *secure context*)? | T0.4 | O painel **local** autentica por `Authorization: Basic`/bearer (imune a CSRF) e o cookie de sessão só existe sob o túnel (`https`). Isso resolve a tensão registrada em `02-SEGURANCA.md` §L4 ("sessão autenticada SHALL NOT cair para `http`") sem inventar exceção |
| **S11** | `crypto.argon2()` / `argon2Sync()` existem nativamente no Node da matriz do CI (≥24.7.0)? Só importa no caminho "usuário escolhe a senha", que o plano desaconselha — mas o texto afirmava como fato | T0.1 | O caminho "senha escolhida pelo usuário" continua **fora de escopo** (§19) e nenhuma linha depende do símbolo |

### Mapa `S* → T*` (é a única forma legítima de resolver um spike para um produtor)

| Spike | Produtor (sub-tarefa que fecha) | Consumidores |
| --- | --- | --- |
| S1 | **T0.1** | T1.1, T3.3, T4.3 |
| S2 | **T0.2** | T2.3, T3.3, T5.4 |
| S3 | **T0.2** | COMMIT PREP 3; re-confirmado por T6.1 |
| S4 | **T0.4** | T3.4, T5.3 |
| S5 | **T0.3** | T6.2 |
| S6 | **T1.3** (embutido) | T1.2 (recebe o bloco `dsh` por handoff) |
| S7 | **T0.3** | T5.2 |
| S8 | **T0.3** | T4.2 |
| S9 | **T0.1** | T2.5 |
| S10 | **T0.4** | T2.2, T3.4 |
| S11 | **T0.1** | ninguém (informativo) |

**Marcados NÃO CONFIRMADOS e proibidos como fato em qualquer entrega:**

- Limite de **50 usuários** do Zero Trust free — reportado por terceiros, ausente das páginas
  oficiais da Cloudflare. Nenhuma sub-tarefa pode depender do número.
- Benchmarks do `jcode` e o pacote `pi2dsh` — não corroborados pelo npm nem pelo repo oficial.
  **Proibidos** em material de divulgação (Onda 7).
- "Quick tunnel não suporta SSE" — a frase existe na doc, mas foi **refutada empiricamente**:
  POST com `text/event-stream` chegou em streaming real; o buffering afeta GET/`EventSource`
  (cf. `cloudflared` issue #1449). E este harness usa **WebSocket**, não SSE, no downlink. Não
  use essa frase como justificativa de decisão.
- "Quem tem o token do bot contorna a allowlist" — **falso neste desenho**. O token autentica
  chamadas de **saída**; a ação destrutiva vem de update de **entrada**, e em long polling não há
  endpoint onde forjar um. O risco real é outro (§ Onda 4) e precisa ser descrito como ele é.
- `InlineKeyboardButton.style` (S7), `drop_pending_updates` em `getUpdates` (S8), caminho canônico
  de diretório de estado (S9), cookie `Secure` em `http://127.0.0.1` (S10) e `crypto.argon2()`
  nativo (S11): **todos foram escritos como fato em versões anteriores deste plano e nenhum foi
  verificado.** Viraram spike pela regra da própria §2 ("vira spike, nunca premissa").

### 2.1 Desvio declarado do pedido — a "extensão/UI"

O pedido original diz "ligar e desligar pelo bot **e pela extensão/UI**". O plano entrega um
**painel próprio** em `/__guard`, servido pelo plugin, e **não** um controle dentro da UI/extensão
do DSH. Isso é um **desvio consciente**, não um esquecimento, e a razão é S4: não há evidência de
que exista ponto de contribuição de UI para plugins. Regra de replanejamento:

- **Se S4 der negativo** (o caso assumido): o painel `/__guard` é a superfície final. Nada muda.
- **Se S4 der positivo**: a Onda 5 ganha uma sub-tarefa condicional **T5.5
  `w5-superficie-ui-nativa-dsh`**, dona exclusiva de `src/ui-contrib/**` e
  `test/unit/ui-contrib/**`, que registra os mesmos dois botões no ponto de contribuição do host
  **consumindo o mesmo `ControlIntent` de T5.1** — nunca chamando o supervisor direto. O painel
  `/__guard` **continua existindo** como caminho independente de UI do host, porque ele é a única
  superfície que sobrevive a uma mudança de versão do DSH. T0.4 é quem dispara esse replanejamento,
  no relatório dela.

---

## 3. Grafo de dependências

```
ONDA 0 — reconhecimento (a base factual está contaminada; ver §2)
  T0.1 spike API real do DSH ─────────┐
  T0.2 spike cloudflared em campo ────┤   (nenhuma depende de nenhuma)
  T0.3 spike Telegram/BotFather ──────┤
  T0.4 spike superfície de UI do DSH ─┘
                                       │
                        [COMMIT PREP 1: stubs de tipo reais + esqueleto de módulos]
                                       │
ONDA 1 — fundação                      ▼
  T1.1 refactor p/ API real + split de src/ e test/ ── T0.1
  T1.2 tooling (lint, CI) + package.json ───────────── T0.1
  T1.3 manifesto: bundle vs profile ────────────────── T0.1  (S6 é spike EMBUTIDO nela)
  T1.4 higiene de repositório/comunidade ───────────── (nenhuma)
                                       │
                        [COMMIT PREP 2: src/contracts/auth.ts + src/contracts/state.ts
                         + test/support/** + baseline de deps congelados]
                                       │
ONDA 2 — primitivas de auth (puras, sem fiação)  ▼
  T2.1 segredo ──┐
  T2.2 sessão ───┤   todas dependem só de T1.1; nenhuma depende de outra
  T2.3 limite ───┤   (T2.3 consome o relatório de T0.2, que fecha S2)
  T2.4 auditoria ┤
  T2.5 estado ───┘   dono ÚNICO do writer de state.json
                                       │
                        [COMMIT PREP 3: src/contracts/tunnel.ts congelado]
                                       │
ONDA 3 — túnel + fiação do gate                  ▼
  T3.1 supervisor do cloudflared ── T0.2, T1.1
  T3.2 descoberta de URL ────────── T0.2            (T3.1 e T3.2 acopladas pelo contrato,
  T3.3 gate integra sessão ──────── T2.1..T2.5       não pelo arquivo)
  T3.4 painel HTTP /__guard ─────── T2.2
                                       │
                        [COMMIT PREP 4: src/contracts/ipc.ts congelado]
                                       │
ONDA 4 — Telegram                                ▼
  T4.1 onboarding guiado (CLI + motor) ── T0.3
  T4.2 worker do bot (grammY) ─────────── T0.3
  T4.3 IPC host↔worker ────────────────── T1.1, T3.1
  T4.4 allowlist + confirmação 2-step ─── T0.3
                                       │
                        [COMMIT PREP 5: src/contracts/control.ts congelado]
                                       │
ONDA 5 — liga/desliga nas duas superfícies       ▼
  T5.1 controlador de estado único ─ T3.1, T3.4, T4.3
  T5.2 superfície Telegram ───────── T4.2, T4.4, PREP 5
  T5.3 superfície painel ─────────── T3.4, PREP 5
  T5.4 notificação/auditoria ─────── T2.4, T4.3, PREP 5
                                       │
ONDA 6 — testes ponta a ponta                    ▼
  T6.1 e2e offline + live ─ Ondas 3,5    T6.3 regressão de segurança ─ Ondas 2,3
  T6.2 e2e Telegram ───── Ondas 4,5      T6.4 ciclo de vida/órfãos ─── Ondas 3,4
                                       │
ONDA 7 — empacotamento e divulgação              ▼
  T7.1 empacotamento ── Onda 6       T7.3 docs de usuário ── Onda 6
  T7.2 release (OIDC) ── PREP 7         T7.4 divulgação ───── PREP 7
```

**Por que 8 ondas e não 5–7.** A Onda 0 existe porque a base factual está comprovadamente errada
em quatro pontos concretos de API — construir por cima é construir sobre um build quebrado, e
nenhuma outra onda pode começar antes. A Onda 1 é estreita e majoritariamente serial (refactor
mecânico + tooling), o que é assumido, não disfarçado. As Ondas 2 e 3 são separadas de propósito:
se as primitivas de auth fossem integradas na mesma onda em que nascem, as cinco seriam donas de
`src/http/gate.ts` e o paralelismo cairia para 1. Separar "construir o módulo" de "ligar o módulo"
é a única razão de a Onda 2 ter paralelismo 5.

---

## 4. Mapa de propriedade de arquivo (rigoroso)

**Regra dura:** dois agentes da **mesma onda** nunca tocam o mesmo arquivo. Onde isso seria
inevitável, ou o arquivo vira **singleton de onda** (um dono nomeado), ou o contrato é congelado
em COMMIT PREP e o consumo vira **somente-leitura**.

**Regra derivada (forma canônica, `09-DECISOES-CANONICAS.md` D1):** o dono de `src/x/y.ts` é o
dono de `test/unit/x/y.test.ts` **e** dos arquivos de `test/integration/x/**` que exercitam
`y.ts`. Isso elimina a classe inteira de conflito "um agente escreve, outro testa". Os diretórios
`test/support/**` e `test/bin/**` são **prep-owned** (COMMIT PREP 2): leitura livre, escrita
proibida para toda sub-tarefa, em todas as ondas.

**Protocolo de violação:** se uma sub-tarefa descobrir que precisa de um arquivo que não possui,
ela **para e reporta**. O orquestrador resolve por COMMIT PREP da onda seguinte. **Nunca** libera
o arquivo no meio da onda.

### 4.1 Recursos SINGLETON — no máximo 1 agente por onda

| Recurso | Por quê | O0 | O1 | O2 | O3 | O4 | O5 | O6 | O7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **`package.json` + `pnpm-lock.yaml`** (dependências) | Edição concorrente gera conflito de lockfile irreconciliável | **T0.1** | **T1.2** | *ninguém* | **T3.1** | **T4.2** | *ninguém* | **T6.3** | **T7.1** |
| `src/index.ts` (raiz de composição) | Ponto de convergência de toda onda | — | **T1.1** | *ninguém* | **T3.3** | **T4.3** | **T5.1** | *ninguém* | *ninguém* |
| `cordis.patch.yml` | Contrato de configuração; erro aqui quebra o boot | — | **T1.3** | *ninguém* | **T3.3** | *ninguém* | **T5.1** | *ninguém* | *ninguém* |
| `tsconfig.json` / `tsconfig.build.json` | `paths`/`include` afetam todo mundo | **T0.1** | **T1.2** | *ninguém* | *ninguém* | *ninguém* | *ninguém* | *ninguém* | **T7.1** |
| `src/contracts/**` | Congelado em COMMIT PREP; leitura livre, escrita proibida | — | *prep* | *prep* | *prep* | *prep* | *prep* | *ninguém* | *ninguém* |
| `test/support/**` e `test/bin/**` (dublês) | Congelados no PREP 2; quatro conjuntos divergentes de dublê é o modo de falha | — | *prep* | *prep* | *prep* | *prep* | *prep* | *prep* | *prep* |
| `.github/workflows/**` | Dois agentes editando o mesmo workflow geram YAML irreconciliável | — | **T1.2** | *ninguém* | *ninguém* | *ninguém* | *ninguém* | *ninguém* | **T7.2** |
| `README.md` | Arquivo de vitrine; dois donos na mesma onda = diff de ida e volta | — | **T1.4** | *ninguém* | *ninguém* | *ninguém* | *ninguém* | *ninguém* | **T7.3** |
| `worker/**` | Só a Onda 4 divide o diretório, e por subdiretórios disjuntos | — | **T1.1** (cria os arquivos vazios do layout) | *ninguém* | *ninguém* | **subdirs disjuntos**: T4.2 (`worker/telegram-bot.ts`, `worker/lib/**`), T4.3 (`worker/ipc.ts`), T4.4 (`worker/auth/**`) | **T5.2** (`worker/commands/**`) | *ninguém* | *ninguém* |

Ondas marcadas ***ninguém*** para `package.json`: **nenhuma dependência nova pode ser adicionada
nessa onda.** Em particular na Onda 2 isso é deliberado — o custo de supply chain numa camada de
autenticação não vale conveniência, e base32 são ~20 linhas.

### 4.2 Layout de destino (quem passa a possuir o quê)

Hoje `src/index.ts` tem **1836 linhas** e `test/index.test.ts` tem ~2100. Enquanto forem um
arquivo só, **toda onda tem paralelismo 1**. Quebrá-los é a primeira entrega da Onda 1.

**Esta é a árvore canônica** (`09-DECISOES-CANONICAS.md` D1). Ela vence qualquer árvore de
`05-QUALIDADE-CODIGO.md` §5.4 ou de `06-REPO-E-CI.md` §2 que divirja: aqueles documentos descrevem
*o que cada arquivo é*; este diz **quem escreve**. O COMMIT PREP 1 cria exatamente estes arquivos,
vazios, com o cabeçalho da assinatura exportada.

```
src/
  index.ts                 Raiz de composição: name, inject, apply. Fia módulos, não implementa regra.  [SINGLETON: T1.1 → T3.3 → T4.3 → T5.1]
  brand.ts                 Branded IDs (SessionId, Nonce, SecretDigest) e construtores validadores.     [T1.1]
  errors.ts                Hierarquia de erro tipada + códigos estáveis (05 §6.1).                      [T1.1]
  contracts/               Interfaces congeladas em COMMIT PREP. Leitura livre, ESCRITA PROIBIDA.       [prep]
    auth.ts                SecretStore, SessionStore, RateLimiter, AuditSink.                           [PREP 2]
    state.ts               StateStore: leitura e escrita atômica do state.json.                         [PREP 2]
    tunnel.ts              TunnelState, TunnelInfo, TunnelDiscovery.                                    [PREP 3]
    ipc.ts                 Protocolo JSON-lines host↔worker.                                            [PREP 4]
    control.ts             ControlIntent, transições legais, contrato do nonce de confirmação.          [PREP 5]
  dsh/
    adapter.ts             ÚNICO ponto do repositório que toca API do DSH (ctx.httpServer, ctx.subprocess). [T1.1]
  config/
    schema.ts              interface Config — contrato congelado do cordis.patch.yml.                   [T1.1 → T3.3]
    assert.ts              assertValidConfig e os assertores primitivos que ela usa.                    [T1.1 → T3.3]
    bind.ts                assertSecureBind, isWildcardBindHost — política de bind.                     [T1.1]
  logging/
    logger.ts              Wrapper de ctx.logger com LOG_SCOPE fixo.                                    [T1.1]
    redact.ts              redact(): mascara bot<n>:<token>, Authorization, Cookie, mk e URL do túnel.  [T1.1]
  permissions/
    deny.ts                canonicalizePermissionToken, requestsDeniedPermission.                       [T1.1]
  http/
    auth-basic.ts          verifyBasicAuth: parse do header + comparação em tempo constante.            [T1.1]
    origin.ts              normalizeRemoteAddress, isTrustedRemote.                                     [T1.1]
    path.ts                canonicalRequestPath, isGuardedPath, routeMayServeGuardedPath.               [T1.1]
    responses.ts           challengeBasicAuth, denyUntrustedOrigin, denyUpgrade — corpos idênticos.     [T1.1]
    gate.ts                createGuardedHandler, createGuardedUpgradeHandler.                           [T1.1 → T3.3]
    intercept.ts           Fiação de ctx.intercept('httpServer', …) sobre register/fallback/upgrade.    [T1.1]
    session-auth.ts        Verificação do cookie de sessão dentro do gate.                              [T3.3]
    host-header.ts         Validação do header Host (L2.5 — anti DNS rebinding).                        [T3.3]
  state/
    paths.ts               Resolve $XDG_STATE_HOME/dsh-guarded-bot + fallback + modos 0700/0600.        [T2.5]
    schema.ts              Forma versionada do state.json (version: 1) e migração.                      [T2.5]
    store.ts               ÚNICO writer: tmp no mesmo dir + fsync + rename; recusa modo > 0600.         [T2.5]
  secret/
    generate.ts            CSPRNG randomBytes(32) + base32 RFC 4648 sem padding + agrupamento visual.   [T2.1]
    canonical.ts           canonicalizeSecret: upper, remove '-' e espaço.                              [T2.1]
    store.ts               Persiste só o digest, via StateStore. Nunca o segredo em claro.              [T2.1]
    verify.ts              Comparação de digests de 32 bytes em tempo constante.                        [T2.1]
    ott.ts                 Token de uso único (128 bits, TTL 10 min) que destrava /__guard/secret.      [T2.1]
  session/
    store.ts               Emissão, lookup e expiração (inatividade 60 min, absoluto 8 h). Disposer.    [T2.2]
    cookie.ts              Serialização de __Host-dsh_sid com os atributos obrigatórios.                [T2.2]
    magic.ts               Store do mk do link mágico: 128 bits, TTL 120 s, uso único, só em memória.   [T2.2]
  ratelimit/
    policy.ts              Função pura falhas→atraso (full jitter), limiar de ban, teto NIST.           [T2.3]
    tracker.ts             Contadores por identidade em memória. Disposer.                              [T2.3]
    restricted.ts          Modo restrito: ativa aos 100, persiste via StateStore, derruba o túnel.      [T2.3]
  audit/
    log.ts                 Log append-only 0600, fora do workspace. Disposer.                           [T2.4]
    format.ts              Serialização de {ts, evento, resultado, ip_normalizado, sessao_id_hash}.     [T2.4]
    events.ts              Vocabulário fechado de eventos de auditoria e de notificação.                [T5.4]
    notify.ts              Composição da notificação proativa (best-effort, sempre DEPOIS do log).      [T5.4]
  proc/
    backoff.ts             computeBackoffDelay — puro, full jitter, sem I/O.                            [T1.1]
    env.ts                 buildWorkerEnv (allowlist) e buildTunnelEnv — perfis de ambiente distintos.  [T1.1 → T4.3]
    tree-kill.ts           process.kill(-pid) sobre o grupo; ramo win32 isolado e inerte.               [T1.1]
    supervisor.ts          createWorkerSupervisor genérico; chama spawn(SubprocessSpawnSpec).           [T1.1 → T3.1 → T4.3]
  tunnel/
    args.ts                argv do cloudflared: --metrics fixo, --token-file, proíbe --loglevel debug.  [T3.1]
    supervisor.ts          Ciclo de vida do cloudflared sob ctx.effect; orçamento; não-retryable.       [T3.1]
    probe.ts               Probe fail-closed de 4 sondas anônimas ANTES de subir (D11 / 02 §L1).        [T3.1]
    ttl.ts                 Timer de TTL (default 60 min, teto 480) com relógio injetado (D6).           [T3.1]
    pidfile.ts             Pidfile do cloudflared + varredura de órfão no boot (02 §9).                 [T3.1]
    discover.ts            GET /quicktunnel + fallback regex em stderr; prefixa https://.               [T3.2]
    readiness.ts           Polling com timeout ≥30 s, abortado no 'close' do filho.                     [T3.2]
  panel/
    routes.ts              Registro das rotas /__guard/* e a política por rota da tabela de D5.         [T3.4 → T5.3]
    html.ts                Painel HTML autocontido: sem CDN, sem build, sem recurso externo.            [T3.4 → T5.3]
    api.ts                 GET /api/state, POST /api/login, POST /api/tunnel/start|stop.                [T3.4 → T5.3]
    magic.ts               GET inerte + POST consumidor de /__guard/magic.                              [T3.4]
    secret.ts              GET /__guard/secret?ott=… — uma vez; 404 idêntico ao de rota inexistente.    [T3.4]
    csrf.ts                Token anti-CSRF das rotas POST do painel.                                    [T3.4]
  telegram/
    onboarding.ts          Detecção de estado da conexão + roteiro guiado passo a passo.                [T4.1]
    pairing.ts             Código de pareamento de 6 dígitos, TTL 5 min, fechamento permanente.         [T4.1]
    ipc.ts                 Lado HOST do protocolo JSONL host↔worker.                                    [T4.3]
  control/
    controller.ts          Máquina de estado ÚNICA; fila de intents; idempotência; broadcast com seq.   [T5.1]
    confirm.ts             Nonce server-side (TTL 60 s) das ações que AUMENTAM exposição.               [T5.1]
worker/
  telegram-bot.ts          Entry do processo separado: long polling com grammY.                         [T4.2]
  ipc.ts                   Lado WORKER do protocolo JSONL sobre stdio.                                  [T4.3]
  lib/
    client.ts              Configuração do grammY: apiRoot, plugin de auto-retry, bot.catch.            [T4.2]
    polling.ts             timeout 50, allowed_updates, drop_pending_updates, 409 → sair do processo.   [T4.2]
    keyboard.ts            Teclado inline, answerCallbackQuery sempre, editMessageText in-place.        [T4.2]
  auth/
    allowlist.ts           Autorização por from.id E chat.id, fail-closed, descarte silencioso contado. [T4.4]
    guard.ts               Revalidação de identidade em todo callback_query (callback_data não prova nada). [T4.4]
    pairing.ts             Recepção de /parear <código>; segundo pareamento é recusado.                 [T4.4]
  commands/
    router.ts              Roteamento comando → intent IPC; setMyCommands com a lista canônica.         [T5.2]
    onoff.ts               /ligar e /desligar (com confirmação de 2 etapas em /ligar).                  [T5.2]
    access.ts              /acessar e /rotacionar.                                                      [T5.2]
    status.ts              /status e /emergencia.                                                       [T5.2]
bin/
  dsh-guard-setup.ts       CLI de onboarding: provision(), senha + QR ASCII, --reset-pairing.           [T4.1]
```

**Layout de `test/` (canônico; qualquer outro layout em 04/05/06 é o que muda):**

```
test/
  unit/<mesmo caminho de src/ ou worker/>/<arquivo>.test.ts   [dono = dono do fonte]
  integration/<área>/<caso>.test.ts                           [dono = dono do fonte principal do caso]
  contract/dsh-types.test.ts                                  [T0.1; roda em PR e no nightly]
  security/<vetor>.test.ts                                    [criado pelas T2.x; dono na Onda 6 é T6.3]
  e2e/<fluxo>.test.ts        OFFLINE, só dublês, BLOQUEIA PR  [T6.1, T6.2, T6.4]
  live/<fluxo>.test.ts       rede real, workflow_dispatch      [T6.1]
  support/{clock,ctx-double,child-double,telegram-server,state-dir}.ts   [PREP 2 — prep-owned]
  bin/fake-cloudflared.mjs                                    [PREP 2 — prep-owned]
docs/spikes/                relatórios da Onda 0              [dono = autor do spike]
```

**Convenção de caminho, sem exceção:** não existe `test/http/**`, `test/proc/**`, `test/tunnel/**`,
`test/panel/**`, `test/control/**`, `test/audit/**`, `test/session/**`, `test/worker/**`,
`test/lifecycle/**`, `test/helpers/**` nem `test/e2e/tunnel/**`. Todo teste de unidade vive sob
`test/unit/<caminho do fonte>/`; todo teste de integração sob `test/integration/<área>/`; e2e
direto em `test/e2e/`. Onde este documento citar um caminho antigo, o caminho **novo** é o que
vale.

### 4.3 Fronteiras que exigem atenção especial

| Fronteira | Risco | Como é separada |
| --- | --- | --- |
| `.github/` na Onda 1 | T1.2 e T1.4 ambas querem o diretório | T1.2 possui **só** `.github/workflows/`; T1.4 possui **só** `.github/ISSUE_TEMPLATE/` e `PULL_REQUEST_TEMPLATE.md`. Interseção zero |
| `src/proc/supervisor.ts` nas Ondas 3 e 4 | T3.1 generaliza, T4.3 muda o `stdio` | Ondas **diferentes**. Dentro da Onda 3 é de T3.1 (junto com `test/unit/proc/**` e `test/integration/proc/**`); dentro da Onda 4 é de T4.3, **com os mesmos diretórios de teste**. Nunca simultâneo. Sem levar o teste junto, T4.3 muda o fonte e não pode consertar o teste que ela mesma quebra |
| `src/audit/` nas Ondas 2 e 5 | T2.4 cria, T5.4 acrescenta | Enumeração **positiva**, nunca glob com exceção em prosa: T2.4 possui `src/audit/log.ts` e `src/audit/format.ts`; T5.4 possui `src/audit/events.ts` e `src/audit/notify.ts`. Nas Ondas 2 e 5 os arquivos do outro ficam fechados |
| `worker/` na Onda 4 | T4.2, T4.3 e T4.4 no mesmo diretório | Subdiretórios e arquivos disjuntos: `worker/telegram-bot.ts` + `worker/lib/**` (T4.2), `worker/ipc.ts` (T4.3), `worker/auth/**` (T4.4). Interseção vazia |
| `src/panel/` nas Ondas 3 e 5 | T3.4 cria o painel, T5.3 põe os botões | Ondas diferentes. Na Onda 5 o dono é T5.3 e T3.4 já foi mergeada |
| `src/tunnel/` na Onda 3 | T3.1 e T3.2 no mesmo diretório | Arquivos distintos e nomeados: `args.ts`/`supervisor.ts`/`probe.ts`/`ttl.ts`/`pidfile.ts` (T3.1) vs `discover.ts`/`readiness.ts` (T3.2). O acoplamento entre eles é o contrato `TunnelDiscovery`, congelado no COMMIT PREP 3 |
| `src/config/**` na Onda 3 | T3.3 amplia `Config` com o eixo `exposure` | T3.3 possui `src/config/**` **e** `test/unit/config/**`. Sem o teste junto, o contrato de config muda sem dono do teste que o prova |

---

## 5. ONDA 0 — Reconhecimento e verificação de campo

**Objetivo:** substituir a base factual contaminada por medição. **Nenhuma linha de feature.**
Cada spike entrega um relatório em `docs/spikes/` com **comandos executados e saída bruta colada**,
não parafraseada.

**COMMIT PREP 0:** `docs/spikes/.gitkeep` e `test/contract/_placeholder.test.ts` (asserção trivial
verde, para que `pnpm test:contract` não saia com código 1 num diretório vazio).

**Correção de premissa falsa, verificada:** versões anteriores deste documento exigiam
`remote origin` configurado como pré-requisito da Onda 0, alegando que "sem remote nem worktree
funciona". **Falso** — `git worktree` não usa remote nenhum, e foi verificado neste repositório,
que hoje não tem `origin`. O remote passa a ser pré-requisito **do COMMIT PREP 7** (publicação),
onde ele de fato é necessário. Nada na Onda 0 depende dele.

| id | worktree | entrega | arquivos exclusivos | depende de |
| --- | --- | --- | --- | --- |
| T0.1 | `w0-spike-api-real-dsh` | Baixa os tarballs npm reais (`@deepseek-ai/cordis`, `dsh-host-webserver`, `dsh-subprocess`, `dsh-subprocess-local`, `dsh-host-frontend-static`), extrai os `.d.ts` e **reescreve os stubs locais para casarem letra por letra**. Tabela de-para símbolo a símbolo. **Fixa versões exatas** (tudo está em `rc`, e o README upstream avisa "developer preview, expect breaking changes"). Escreve os **testes de contrato** `CONTRACT-001…009` (`test/contract/dsh-types.test.ts`), que falham no dia em que o `.d.ts` real divergir do stub. Fecha **S1**, **S9** (existe caminho canônico de diretório de estado no host?) e **S11** (`crypto.argon2()` nativo na matriz). | `types/**`, `tsconfig.json`, `tsconfig.build.json`, `package.json`, `pnpm-lock.yaml`, `docs/spikes/api-dsh.md`, `test/contract/**` | — |
| T0.2 | `w0-spike-cloudflared-runtime` | Mede em campo: (a) `GET /quicktunnel` no metrics server com `--metrics 127.0.0.1:PORT` **fixado**; (b) fallback por regex em **stderr** (stdout fica com 0 bytes); (c) **S2** — quais headers chegam à origem; (d) **S3** — WebSocket através do túnel com payload nos dois sentidos; (e) SIGTERM e ausência de resíduo na borda; (f) checksum do binário contra a release do GitHub. | `docs/spikes/cloudflared.md`, `scripts/spike/cloudflared/**` | — |
| T0.3 | `w0-spike-telegram-botfather` | Percorre o fluxo BotFather de ponta a ponta e documenta cada passo com a saída real: `/newbot`, `getMe`, `/start`, `getUpdates` → `from.id` **e** `chat.id`, `setMyCommands`. Reproduz o **409** de polling duplicado. Fecha **S5** (`apiRoot` do grammY), **S7** (`InlineKeyboardButton.style` existe? — mandar um teclado com `style` para um chat real e colar a resposta) e **S8** (`drop_pending_updates` é parâmetro de `getUpdates` ou só de `setWebhook`/`deleteWebhook`; qual superfície o grammY expõe). | `docs/spikes/telegram.md`, `scripts/spike/telegram/**` | — |
| T0.4 | `w0-spike-superficie-ui-dsh` | **S4**: existe ponto de contribuição de UI para plugins (Web UI/extensão), ou o painel tem que ser rota própria? Enumera o que `HttpServerService` realmente expõe e se há como **enumerar rotas já registradas** — o plugin de hoje admite por escrito que não há. Confirma que o prefixo `/__guard` está livre. Fecha **S10**: navegador atual aceita cookie `Secure` com prefixo `__Host-` emitido por `http://127.0.0.1:3080` (*secure context* local)? Medir em Chromium e em Firefox atuais, com o `Set-Cookie` e o `document.cookie` colados. | `docs/spikes/superficie-ui.md`, `scripts/spike/ui/**` | — |

**Singleton `package.json`: T0.1.** Único que pode mexer em dependências nesta onda.

**Perguntas falsificáveis**

*T0.1* — (1) Os `.d.ts` vieram do tarball npm real ou foram transcritos de um markdown? Mostre o
`sha256` do tarball. (2) `HttpServerService` tem mesmo `registerFallback` e `registerUpgrade`, ou
isso foi presumido a partir do stub antigo? (3) `SubprocessSpawnSpec` exige `graceMs` — que valor
o código atual usaria, e de onde ele sai? (4) As versões foram pinadas em **exato**, ou ficou
`^`? Com tudo em `rc`, `^` é bomba-relógio. (5) Algum símbolo usado no `src/index.ts` atual
**deixa de existir** e passou despercebido?

*T0.2* — (1) O `/quicktunnel` respondeu **nesta execução**, ou o relatório repetiu a pesquisa?
Cole o corpo e a porta. (2) O WebSocket transportou dados nos **dois sentidos**, ou só o `101`
foi observado? (3) Que header exatamente carrega o IP do cliente — e se **nenhum** carregar, isso
está escrito com todas as letras? (4) Após SIGTERM a URL pública devolveu 530 e a porta de
métricas recusou conexão — verificado ou inferido? (5) O teste subiu um origin **próprio**, ou
acabou expondo o DSH real que já ocupa a 3080? (Isso já aconteceu uma vez na pesquisa.)

*T0.3* — (1) O `chat_id` veio de `message.chat.id` ou de `message.from.id`? Os dois existem e a
allowlist tem que validar **os dois**. (2) O 409 foi reproduzido ou só citado? (3) `getUpdates`
com `offset` **confirma e apaga** updates no servidor — isso foi testado, com a consequência para
o onboarding declarada? (4) O `apiRoot` do grammY foi testado contra servidor local real, ou foi
lido na doc? (5) Algum token real aparece no relatório, mesmo parcialmente mascarado?

*T0.4* — (1) A conclusão "não existe ponto de contribuição de UI" vem de leitura do `.d.ts` e do
código, ou de ausência de documentação? **Ausência de doc não é prova.** (2) Existe forma de
enumerar rotas registradas? Se não, o aviso de ordem de carregamento continua sendo a única
mitigação — isso está registrado? (3) `/__guard` colide com alguma rota existente? Como foi
verificado que está livre? (4) **S10:** o cookie `__Host-…; Secure` emitido por
`http://127.0.0.1:3080` foi **realmente aceito e reenviado** pelo navegador, ou o relatório
concluiu por leitura de spec? Cole o `Set-Cookie`, o `document.cookie` e a versão do navegador —
se ele for rejeitado, o painel **local** passa a autenticar por header (`Authorization`), e isso
muda entregável de T2.2 e T3.4.

**Aceite da Onda 0 (gate verde).** Cada linha é um comando que sai com **status 0**, não uma
impressão de revisor:

| # | Comando | O que ele prova |
| --- | --- | --- |
| 1 | `pnpm typecheck` | Compila com os stubs **reais**, não com os presumidos de hoje |
| 2 | `pnpm test:contract` | `CONTRACT-001…009` verdes contra os `.d.ts` extraídos dos tarballs |
| 3 | `git status --porcelain` (saída vazia) | Nada não commitado sobrou depois do merge |
| 4 | `test -s docs/spikes/api-dsh.md && test -s docs/spikes/cloudflared.md && test -s docs/spikes/telegram.md && test -s docs/spikes/superficie-ui.md` | Os quatro relatórios existem e não estão vazios |
| 5 | `! grep -rniE 'provavelmente\|deve ser\|acredito\|imagino\|suponho' docs/spikes/` | Nenhum spike concluiu por opinião. Linguagem hedge é o sintoma de parágrafo sem evidência colada |
| 6 | `! grep -rnE '[0-9]{8,10}:[A-Za-z0-9_-]{30,}' docs/spikes/` | Nenhum token real de bot vazou para o relatório |
| 7 | `for s in S1 S2 S3 S4 S5 S7 S8 S9 S10 S11; do grep -rqE "^VEREDITO $s: (CONFIRMADO\|NAO CONFIRMADO) " docs/spikes/ \|\| { echo "sem veredito: $s"; exit 1; }; done` | Cada um dos **dez** spikes com produtor na Onda 0 tem, no relatório do seu produtor, uma linha de veredito em formato fixo — `CONFIRMADO` ou `NAO CONFIRMADO`, seguida da evidência ou da declaração de ausência dela. Formato de máquina de propósito: o orquestrador lê estas linhas para decidir se replaneja a Onda 1 (§13.3) |

**Formato obrigatório da linha de veredito** (uma por spike, no relatório do produtor declarado no
mapa `S* → T*` de §2):

```
VEREDITO S1: CONFIRMADO — HttpServerService expõe register/registerFallback/registerUpgrade.
  evidência: types/dsh-host-webserver.d.ts:41-58, extraído de <tarball> sha256 <...>
```

S6 não entra na lista porque o produtor dele é T1.3, na Onda 1.

**Reaproveitamento:** nenhum código muda. É a onda que descobre **quanto** do código atual sobrevive.

---

## 6. ONDA 1 — Fundação: API real, modularização, tooling, manifesto

**COMMIT PREP 1** (commit direto na base, antes de abrir worktrees):

1. Os `types/**` corrigidos e as versões pinadas por T0.1 já mergeados.
2. O layout de §4.2 criado como **arquivos vazios com o cabeçalho de assinatura exportada** —
   T1.1 preenche sem precisar inventar fronteira no meio do refactor. Todo diretório de `test/`
   criado aqui recebe um `_placeholder.test.ts` verde (§0, regra 2).
3. `docs/spikes/*` da Onda 0 mergeados e legíveis, com as dez linhas `VEREDITO S*:`.
4. **Reconciliação do prefixo de rota, concluída aqui e não na Onda 5.** `/__guard` é o prefixo
   canônico. `/__mobile` e `/__gate` estão mortos e não podem reaparecer como prescrição em
   nenhum documento nem em nenhum arquivo do repositório. Comando de verificação do prep:
   `! grep -rnE '/__(mobile|gate)/' docs/ src/ test/ worker/ bin/ README.md` — com a única exceção
   de tabelas de correção que mostram explicitamente a forma **errada**. Isto estava agendado no
   PREP 5, quatro ondas **depois** de as primeiras rotas nascerem; nesta posição ele impede que
   duas ondas de código nasçam contra o prefixo errado.
5. **Vocabulário de nomes canônicos aplicado** (`09-DECISOES-CANONICAS.md` D5): rotas, nome do
   cookie (`__Host-dsh_sid`), arquivo de estado (`$XDG_STATE_HOME/dsh-guarded-bot/state.json`),
   variáveis de ambiente (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`) e a lista fechada de
   comandos do bot. Nenhuma sub-tarefa inventa nome a partir daqui.

| id | worktree | entrega | arquivos exclusivos | depende de |
| --- | --- | --- | --- | --- |
| T1.1 | `w1-refactor-api-e-modulos` | Migra para a API real (`ctx.httpServer` / `HttpServerService`, `@deepseek-ai/dsh-subprocess`, `spawn(spec)`) **e** quebra `src/index.ts` e `test/index.test.ts` no layout de §4.2. Concentra **todo** o toque na API do DSH em `src/dsh/adapter.ts` — é o único arquivo do repositório que importa `@deepseek-ai/*`, e é o que torna uma breaking change do host uma edição de um arquivo. **Zero mudança de comportamento** — os testes existentes são o contrato. **Entrega adicional, obrigatória:** antes de dissolver `test/index.test.ts`, extrai os dublês que vivem dentro dele (`FakeClock`, `FakeSubprocessService`, `FakeHttpServer`, `FakeLogger`, `FakeTelegramTransport`, `FakeCloudflared`) **para o relatório de handoff do COMMIT PREP 2**, com o comentário que documenta a correção do dublê que tinha `killed = false` fixo e ignorava o `AbortSignal`. Apagar esse comentário conta como regressão. | `src/index.ts` (**singleton**), `src/brand.ts`, `src/errors.ts`, `src/dsh/**`, `src/config/**`, `src/logging/**`, `src/permissions/**`, `src/http/**`, `src/proc/**`, `src/secret/**`, `src/session/**`, `src/ratelimit/**`, `src/audit/**`, `src/state/**`, `src/tunnel/**`, `src/panel/**`, `src/telegram/**`, `src/control/**`, `worker/**`, `bin/**`, `test/index.test.ts`, `test/unit/**`, `test/integration/**` — **enumeração positiva**: `src/contracts/**`, `test/support/**`, `test/bin/**` e `test/contract/**` não estão na lista e são somente-leitura | T0.1 |
| T1.2 | `w1-tooling-lint-ci-pkg` | Gate de lint (oxlint como passada rápida + `typescript-eslint` sob ESLint 10 flat config para as regras type-aware; `.eslintrc` foi removido no ESLint v10), o **bloco de `scripts` canônico inteiro** (`09-DECISOES-CANONICAS.md` D4 / Apêndice A, incluindo `lint`, `test:security`, `test:e2e`, `test:live`, `test:cov`), workflows do GitHub Actions com `permissions: {}` no topo e mínimo por job, **matriz `ubuntu-latest`×Node 24, `ubuntu-latest`×Node 26, `macos-latest`×Node 24** (Node 22 fica fora porque o pacote declara `engines: node >=24`; Windows fica fora por `"os": ["linux","darwin"]`), `publint` + `attw --pack .` no CI. Aplica no `package.json` o bloco `dsh` **recebido por handoff de T1.3** — T1.2 não decide a forma do bloco, só o aplica. | `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `eslint.config.js`, `.github/workflows/**` | T0.1; **handoff de T1.3** (bloco `dsh` como texto no relatório dela) |
| T1.3 | `w1-manifesto-bundle-profile` | **Quebra o manifesto em dois**: `cordis.patch.yml` (Camada 1/Bundle, contendo **só** a entrada do próprio plugin, insert puro, **sem `id` placeholder**) e `cordis.profile.patch.example.yml` (Camada 2/Profile, opcional, com o endurecimento de bind e o `id` específico da instalação). Especifica o bloco `dsh.bundle` — **fecha S6** (spike embutido, primeira hora) antes de escolher a forma — e o **entrega como texto no relatório**, para T1.2 aplicar. Remove do `cordis.patch.yml` a derivação de credencial a partir de `ADMIN_USER`/`ADMIN_PASS` por `!!js`: a credencial passa a ser gerada por CSPRNG pelo próprio plugin e lida do `state.json` (`02-SEGURANCA.md` §8.2 regra 6). O `!!js` continua válido só para valores **não sensíveis**. | `cordis.patch.yml`, `cordis.profile.patch.example.yml`, `docs/plano/manifesto.md` | T0.1 |
| T1.4 | `w1-repo-hygiene-comunidade` | `LICENSE` (MIT, alinhado ao upstream), `SECURITY.md` + ativação de Private Vulnerability Reporting, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1 com o `[INSERT CONTACT METHOD]` **preenchido** e a linha de atribuição obrigatória), templates de issue com frontmatter válido. **É a dona de `README.md` nesta onda** — inclusive para remover a instrução antiga que mandava copiar o `cordis.patch.yml` à mão (a instrução some por decisão de T1.3; quem edita o arquivo é T1.4). **Reserva o nome no npm** publicando `dsh-guarded-bot-orchestrator@0.0.1` como stub documentado, sem código funcional: o risco real é name-squatting entre o primeiro anúncio e a publicação, e o custo de reservar são dois minutos (`09-DECISOES-CANONICAS.md` D21). | `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `README.md`, `.github/ISSUE_TEMPLATE/**`, `.github/PULL_REQUEST_TEMPLATE.md` | — |

**Singleton `package.json`: T1.2.** **Singleton `src/index.ts`: T1.1.**
**Singleton `README.md`: T1.4.** **Singleton `.github/workflows/**`: T1.2.**

**T1.3 não possui `package.json`, em nenhuma coluna.** Ela entrega o bloco `dsh` como **texto no
relatório**; T1.2 aplica. A aresta de handoff `T1.3 → T1.2` está declarada na coluna "depende de"
de T1.2 e é a única do tipo nesta onda. **T1.3 também não possui `README.md`**: a decisão de
remover a instrução de cópia é dela, a edição do arquivo é de T1.4. Isso não é formalismo — a
coluna "arquivos exclusivos" é lida **literalmente** pelo orquestrador, e uma entrega obrigatória
sobre um arquivo que a sub-tarefa não possui dispara o "para e reporta" de §4 e trava a onda.

**Por que a decisão do manifesto é estruturante.** O gate real do registro
`awesome-dsh-plugin` é `scripts/check-submission.mjs`, que faz `if (dsh.bundle) return { ok: true }`
— **não** lê `dsh.bundle.patch` nem verifica se o arquivo apontado existe. Ou seja, existe uma
saída que a justificativa atual no `//dsh` do `package.json` não considerou: declarar
`dsh.bundle` sem `patch` satisfaz o gate e preserva a verdade única. O obstáculo real nunca foi
a "dupla verdade": é o **`id` placeholder** específico da instalação, que como bundle automático
viraria *insert* e quebraria o boot por conflito de rota. Separar os dois arquivos resolve os
dois problemas. **T1.3 tem spike embutido (S6):** confirmar o comportamento do gate no
`check-submission.mjs` atual antes de escolher a forma, porque a prosa do `contributing.md` diz
`required` e o código diz o contrário.

**Perguntas falsificáveis**

*T1.1* — (1) O refactor é mecânico mesmo? Rode a suíte antiga contra os módulos novos: algum
teste teve o **conteúdo** alterado, ou só o import? (2) `spawn(spec)` agora passa `graceMs` —
esse valor compete com o `SIGKILL` do tree-kill pelo mesmo processo? (3)
`ctx.intercept('httpServer', …)` intercepta os mesmos três métodos, ou o serviço real tem outra
superfície e algum método ficou de fora **em silêncio**? (4) O aviso de ordem de carregamento
sobreviveu ao refactor, ou virou log perdido? (5) `buildWorkerEnv` ainda passa o token por env e
**nunca** por `argv` (porque `/proc/<pid>/cmdline` é legível por qualquer processo local)?

*T1.2* — (1) O CI **falha** quando o typecheck quebra, ou só reporta? Force uma quebra e mostre o
job vermelho. (2) `permissions: {}` está no topo e cada job concede só o mínimo, ou há
`write-all` herdado? (3) `attw --pack .` roda contra o **tarball** ou contra `src/`? (4) A matriz
Node inclui alguma versão em que o pacote não funciona — e falha lá, como deveria? (5) O lint
tem regra que proíbe `import` de `@deepseek-ai/dsh-host-subprocess` (pacote inexistente) voltar?

*T1.3* — (1) Instale o pacote num perfil limpo com `dsh plugin add`: a camada é **ativada**?
(2) O `cordis.patch.yml` de bundle tem algum `id` que possa não casar? Se tiver, vira insert e o
boot quebra. (3) O exemplo de profile ainda documenta que errar o `id` produz conflito de rota?
(4) O README ainda manda copiar o arquivo? Se sim, a dupla aplicação voltou. (5) S6 foi
verificado no código do gate, ou na prosa do `contributing.md`?

*T1.4* — (1) O `CODE_OF_CONDUCT.md` ainda tem `[INSERT CONTACT METHOD]`? (2) O `SECURITY.md`
aponta para um canal que **existe** (PVR ligado), ou para um e-mail inventado? (3) Os templates
têm frontmatter `name:`/`about:` (md) ou `name:`/`description:` (yml)? Sem isso o GitHub não os
reconhece. (4) O `LICENSE` é o texto MIT completo com titular real, ou um placeholder?

**Aceite da Onda 1.** Cada linha é um comando com status 0:

| # | Comando | O que ele prova |
| --- | --- | --- |
| 1 | `pnpm lint && pnpm typecheck && pnpm build && pnpm test` | O gate canônico, na ordem canônica |
| 2 | `pnpm test:contract` | Os contratos de T0.1 continuam verdes depois do refactor |
| 3 | `find src worker test -name '*.ts' -exec wc -l {} + \| awk '$2!="total" && $1>400 {print; f=1} END{exit f}'` | **400 linhas exatas**, não "~400". Sai 0 quando nenhum arquivo passa; imprime os infratores quando falha |
| 4 | `! grep -rn 'dsh-host-subprocess' src worker test types bin` | O pacote inexistente (E1) não voltou |
| 5 | `! grep -rnE '\bctx\.webServer\b\|\bWebServer\b' src worker test types bin` | O símbolo refutado (E2) não voltou |
| 6 | `grep -rl '@deepseek-ai/' src \| sort -u` = só `src/dsh/adapter.ts` | O adapter é mesmo o único ponto de contato com a API do host |
| 7 | `grep -c 'INSERT CONTACT METHOD' CODE_OF_CONDUCT.md` = 0 | O placeholder do Contributor Covenant foi preenchido |
| 8 | `npm view dsh-guarded-bot-orchestrator version` = `0.0.1` | O nome está reservado no npm (D21) |

Mais dois itens que **não** são comando e por isso são executados por um humano, com o resultado
colado no relatório da onda: (i) `dsh plugin add` num perfil limpo **ativa** a camada, sem `cp`
manual — verificado, não presumido; (ii) o community profile do GitHub aparece 100% na página de
Insights do repositório (screenshot no relatório).

**Reaproveitamento: tudo é mantido.** `verifyBasicAuth`, `normalizeRemoteAddress`,
`isTrustedRemote`, `canonicalRequestPath`, `isGuardedPath`, `routeMayServeGuardedPath`,
`requestsDeniedPermission`, `computeBackoffDelay`, `buildWorkerEnv`, `createWorkerSupervisor`,
`assertValidConfig`, `assertSecureBind`, `createGuardedHandler`, `createGuardedUpgradeHandler`
mudam de **arquivo** e de **nome de serviço injetado**, não de lógica. As ~2100 linhas de teste
existentes são o contrato que prova que o refactor não regrediu.

---

## 7. ONDA 2 — Primitivas de autenticação (puras, sem fiação)

**Por que puras.** Se as cinco fossem integradas aqui, todas seriam donas de `src/http/gate.ts`
e o paralelismo cairia para 1. Construir o módulo (Onda 2) e ligar o módulo (Onda 3) são etapas
separadas de propósito. **Esta é a única onda com cinco sub-tarefas** — T2.5 (estado persistente)
nasceu de uma lacuna real: quatro sub-tarefas, de três ondas diferentes, escreviam no `state.json`
e nenhuma o possuía.

**COMMIT PREP 2.** Quatro coisas congeladas antes de abrir as **cinco** worktrees:

1. **`src/contracts/auth.ts`** — `SecretStore`, `SessionStore`, `RateLimiter`, `AuditSink`, com
   assinaturas e JSDoc, **sem implementação**.
2. **`src/contracts/state.ts`** — `StateStore`: leitura e escrita atômica do `state.json`. Sem
   ele, T2.1 (digest), T2.2 (sessões), T2.3 (modo restrito) e T5.1 (`desiredState`) escreveriam no
   mesmo arquivo em ondas diferentes, sem esquema e sem writer único — que é exatamente a classe
   de conflito que este documento existe para evitar.
3. **Os dublês, aqui e não no PREP 6.** `test/support/clock.ts`, `test/support/ctx-double.ts`,
   `test/support/child-double.ts`, `test/support/telegram-server.ts`, `test/support/state-dir.ts`
   e `test/bin/fake-cloudflared.mjs`. Eles vêm do relatório de handoff de **T1.1** (extraídos do
   `test/index.test.ts` **antes** da dissolução), sem alteração de comportamento e com o
   comentário do dublê que tinha `killed = false` fixo. A partir daqui são **somente-leitura para
   toda sub-tarefa, em todas as ondas**. Congelá-los no PREP 6, como versões anteriores deste
   documento faziam, garantia quatro conjuntos divergentes de dublê e uma "migração sem alteração
   de comportamento" que na prática é reescrita — além de referenciar um `test/index.test.ts` que
   deixou de existir na Onda 1.
4. **`docs/spikes/deps-baseline.txt`** — saída literal de `pnpm ls --prod --depth 0` no fim da
   Onda 1, commitada. É contra **este** arquivo que o aceite da Onda 2 compara; "inalterado" sem
   baseline commitado não é critério.

Nenhuma sub-tarefa da Onda 2 pode alterar nada disso; quem precisar, para e reporta.

```ts
// src/contracts/auth.ts — congelado no COMMIT PREP 2 (ilustrativo, não é a implementação)
export interface SecretStore {
  /** Gera 256 bits por CSPRNG, persiste apenas sha256(segredo) com modo 0600. */
  provision(): { display: string }          // base32 RFC 4648, mostrado UMA vez
  verify(candidate: string): boolean        // timingSafeEqual sobre digests de 32 bytes
  rotate(): { display: string }             // invalida sessões vivas
}
export interface SessionStore { create(): SessionId; validate(id: string): Session | null; revokeAll(): void }
export interface RateLimiter  { check(identity: Identity): { allowed: boolean; retryAfterMs: number } }
export interface AuditSink    { append(event: AuditEvent): void }   // O_APPEND, mascarado
```

```ts
// src/contracts/state.ts — congelado no COMMIT PREP 2 (ilustrativo, não é a implementação)
export interface PersistedState {
  version: 1
  secretDigest?: string            // hex de sha256(segredo). NUNCA o segredo.
  desiredState: 'READY' | 'STOPPED'
  restricted?: { since: number; reason: 'brute-force-ceiling' }
  tunnel?: { pid: number; startedAt: number; mode: 'quick' | 'named' }   // para varredura de órfão no boot
  pairing?: { ownerUserId: number; ownerChatId: number; pairedAt: number }
}
export interface StateStore {
  read(): PersistedState                       // recusa carregar se o modo do arquivo for > 0600
  update(fn: (s: PersistedState) => PersistedState): void   // tmp no mesmo dir + fsync + rename
}
```

**Invariante do `StateStore`, congelado com o contrato:** `src/state/store.ts` é o **único writer**
do `state.json` em todo o repositório. Toda sub-tarefa que precisa persistir passa por ele. A URL
do túnel **não** é persistida (é efêmera e muda a cada restart); o que é persistido é o `pid` e o
`startedAt`, que é o que permite a varredura de órfão no boot de `02-SEGURANCA.md` §9.

| id | worktree | entrega | arquivos exclusivos | depende de |
| --- | --- | --- | --- | --- |
| T2.1 | `w2-segredo-gerar-e-hash` | Geração por `crypto.randomBytes(32)` (256 bits, folgado acima dos 128 que a ASVS 5.0 **11.5.1** exige de qualquer valor não-adivinhável), apresentação em **base32 RFC 4648** (5 bits/char, sem `0/O` nem `l/1`, ditável ao telefone), persistência **só do `sha256` em hex** — **via `StateStore` de T2.5**, nunca com `fs` próprio — e rotação. Mais o `ott.ts`: token de uso único de 128 bits, TTL 10 min, que destrava `GET /__guard/secret?ott=<token>` uma única vez; o `ott` é impresso no **stdout do terminal**, e sem `ott` válido a rota devolve **404 idêntico** ao de rota inexistente. A apresentação inclui **QR code ASCII na mesma tela** que o texto, porque é o caminho do celular quando `control.magicLink` está desligado. **Sem dependência nova.** | `src/secret/**`, `test/unit/secret/**` | T1.1, **PREP 2** |
| T2.2 | `w2-sessao-e-cookie` | O `SessionStore` **puro**: emissão de sessão opaca de ≥128 bits (ASVS 7.2.3), serialização do cookie **`__Host-dsh_sid`** com `Secure` + `HttpOnly` + `SameSite=Strict`, timeout de inatividade (60 min) e absoluto (8 h), **regeneração do id após autenticar** (anti-fixation) e disposer. Mais o `magic.ts`: store em memória do `mk` do link mágico — 128 bits, TTL 120 s, uso único, **nunca** persistido. **Nenhuma rota HTTP nesta sub-tarefa**: `POST /__guard/api/login` e `POST /__guard/magic` são entrega de **T3.4**, e a Onda 2 é "primitivas sem fiação" por construção. O caminho de bearer no header `Authorization` (imune a CSRF) é o fallback obrigatório se **S10** disser que o navegador recusa cookie `Secure` em `http://127.0.0.1`. | `src/session/**`, `test/unit/session/**` | T1.1 |
| T2.3 | `w2-ratelimit-e-lockout` | Atraso exponencial (full jitter) a partir da 5ª falha e ban temporário, **sempre com resposta `401` de corpo e headers idênticos** — o efeito do ban é atraso **interno**, nunca `429` e nunca `Retry-After`, que seriam o oráculo que `02-SEGURANCA.md` §6.1 proíbe. **Teto de 100 falhas consecutivas** (NIST SP 800-63B-4 §3.2.2) que ativa o **modo restrito** (`src/ratelimit/restricted.ts`): o gate deixa de aceitar credencial pelo túnel, aceita só loopback, **o túnel é derrubado**, o bot avisa e o modo **persiste no `state.json`** entre reinícios, via `StateStore`. **Fronteira desta onda:** `restricted.ts` **decide e persiste**; quem executa a derrubada é o `ControlIntent` consumido por T3.3/T5.1 nas ondas seguintes — a Onda 2 é sem fiação por construção, e o efeito ponta a ponta é item de aceite da Onda 3. Não é lockout permanente — com uma conta só, lockout permanente é auto-DoS irreversível; a recuperação é ir à máquina. Mensagem de erro genérica e idêntica em todos os casos. **Consome o relatório de T0.2 (S2)**: se não há IP do cliente confiável, o limitador é por sessão/global e isso é documentado no código, nunca fingido. | `src/ratelimit/**`, `test/unit/ratelimit/**`, `test/security/ratelimit-oracle.test.ts` | T1.1, T0.2 |
| T2.4 | `w2-audit-log-append-only` | Log append-only **fora do Telegram** e fora do workspace, modo `0600`, com mascaramento obrigatório de `bot\d+:[\w-]+` (o token do bot vai na **URL** da Bot API — vaza em log de HTTP, proxy e APM), do segredo, do `mk` do link mágico e da URL do túnel. Registra toda tentativa de auth, todo comando de liga/desliga e a origem. Disposer síncrono. | `src/audit/log.ts`, `src/audit/format.ts`, `test/unit/audit/log.test.ts`, `test/unit/audit/format.test.ts` | T1.1 |
| T2.5 | `w2-estado-persistente` | O **único writer** do `state.json`. `src/state/paths.ts` resolve `$XDG_STATE_HOME/dsh-guarded-bot/` com fallback para `~/.local/state/dsh-guarded-bot/`, cria o diretório `0700` e o arquivo `0600`; `src/state/schema.ts` fixa a forma versionada (`version: 1`) e a migração; `src/state/store.ts` faz escrita atômica (arquivo temporário **no mesmo diretório** + `fsync` + `rename`) e **recusa carregar** se o modo do arquivo for mais frouxo que `0600` (*fail loud*, `02-SEGURANCA.md` §8.2 item 7). Parse corrompido é erro fatal com mensagem acionável, nunca "começa do zero em silêncio" — recomeçar do zero apagaria o `secretDigest` e a senha do dono sem avisar. Consome o veredito de **S9** (T0.1): se não existe caminho canônico de diretório de estado no host, o default XDG fica e o código **documenta** que a escolha é do plugin, não contrato do host. | `src/state/**`, `test/unit/state/**` | T1.1, T0.1 |

**Singleton `package.json`: ninguém.** Nenhuma das cinco precisa de dependência nova. Se alguma
achar que precisa, **para e reporta**. Base32 são ~20 linhas e o custo de supply chain numa camada
de autenticação não vale conveniência.

**Ordem de merge desta onda (fixa, não "qualquer ordem"):** `T2.5 → T2.1 → T2.2 → T2.3 → T2.4`.

**Isto não é dependência intra-onda** — seria violação da regra §0.1. T2.1 e T2.3 dependem do
**contrato** `StateStore`, congelado no COMMIT PREP 2, e por isso podem ser escritas em paralelo
com T2.5 sem se ver. A ordem de merge existe por outra razão: quando T2.1 entrar no snapshot, a
**implementação** que satisfaz o contrato já precisa estar lá para o gate rodar. Contrato no prep
resolve o paralelismo; ordem de merge resolve o gate.

**Nota de honestidade normativa (obrigatória no comentário do código).** O argumento "ASVS 6.5.2
autoriza hash rápido para segredo com ≥112 bits" **não se aplica**: 6.5.2 trata de *lookup
secrets* de MFA (códigos de backup), não de tokens em geral — a norma é **silente** para este
caso. A justificativa correta para não usar Argon2id num token gerado por máquina é de primeiros
princípios: com 256 bits de CSPRNG o ataque offline é computacionalmente impossível, e um KDF
caro (19–46 MiB por tentativa) vira vetor de DoS de CPU/memória — risco que a própria OWASP
nomeia. **Se algum dia o usuário puder escolher a senha, Argon2id passa a ser obrigatório**
(m=19456, t=2, p=1); `crypto.argon2()` é nativo desde o Node v24.7.0 e `engines.node` já é `>=24`.

**Perguntas falsificáveis**

*T2.1* — (1) O segredo em claro é **realmente** descartado da memória, ou fica numa variável de
módulo? (2) O arquivo de hash tem mesmo `0600` — confira com `stat`, o `umask` do processo pode
ter aberto mais. (3) O alfabeto base32 exclui `0`, `1`, `8` e `9`? Se não, é ambíguo ao ditar.
(4) A rotação **invalida as sessões vivas**, ou o segredo antigo continua servindo por uma sessão
aberta? (5) Existe algum caminho em que o segredo é logado, mesmo em nível `debug`?

*T2.2* — (1) O cookie tem prefixo `__Host-`? Sem ele um subdomínio pode injetar. (2) Com bearer
no header o CSRF some — mas o XSS vira o risco dominante. Isso está **documentado**, ou trocou-se
um risco por outro em silêncio? (3) O id de sessão é regenerado **após** autenticar, ou o id
pré-login continua válido? (4) O idle timeout é medido, ou existe só como constante nunca lida?
Force o teste. (5) Sessão emitida sobre HTTP simples é rejeitada, ou o `Secure` é decorativo?

*T2.3* — (1) O limitador é por IP, por sessão ou global? Com `cloudflared` na frente **todo mundo
é 127.0.0.1**, salvo o que S2 achar — o código lida com isso ou finge que tem IP? (2) O atraso
exponencial roda **antes** ou **depois** da comparação em tempo constante? Se for depois, o
próprio limitador vira oráculo de timing. (3) O teto de 100 pode travar o dono para sempre? Qual
é o caminho de recuperação, e ele foi **executado** num teste? (4) A mensagem de erro é idêntica
para "sem sessão", "sessão expirada" e "segredo errado" — inclusive no **status code** e no
**tempo de resposta**? (5) Um atacante consegue esgotar memória criando identidades novas a cada
requisição?

*T2.4* — (1) O regex de mascaramento pega o token quando ele aparece **dentro de uma URL**, e não
só como campo isolado? (2) O log é append-only de verdade (`O_APPEND`), ou é um `writeFile` que
pode truncar? (3) Quando o disco enche, o gate abre (fail-open) ou fecha? (4) O log grava o
segredo tentado? Mesmo hasheado, isso é oráculo offline. (5) Dois processos escrevendo ao mesmo
tempo intercalam linhas parciais?

*T2.5* — (1) A escrita é atômica de verdade? O arquivo temporário é criado **no mesmo diretório**
do destino (`rename` entre sistemas de arquivos diferentes não é atômico) e há `fsync` **antes**
do `rename`? Prove matando o processo no meio da escrita e lendo o arquivo depois. (2) O boot
**recusa** carregar um `state.json` com modo `0644`, ou só loga um aviso e segue? Rode
`chmod 644` e mostre o processo falhando. (3) Um `state.json` corrompido faz o plugin **parar com
mensagem acionável**, ou faz ele "começar do zero" — apagando o `secretDigest` e trocando a senha
do dono sem que ninguém peça? (4) Existe algum outro arquivo do repositório que abra o
`state.json` para escrita? `grep -rn 'state.json' src worker bin` deveria mostrar só
`src/state/**`. (5) O `$XDG_STATE_HOME` é respeitado quando definido, e o fallback é
`~/.local/state/`? Teste com a variável apontando para um diretório temporário.

**Aceite da Onda 2:**

| # | Comando / verificação | O que ele prova |
| --- | --- | --- |
| 1 | `pnpm lint && pnpm typecheck && pnpm build && pnpm test` | O gate canônico |
| 2 | `pnpm test:cov` com piso **≥95% de linhas e ≥90% de branches** em `src/secret/**`, `src/session/**`, `src/ratelimit/**` — e **catraca**: o job `coverage` falha se o número cair em relação ao valor commitado (`09-DECISOES-CANONICAS.md` D17) | Módulo de decisão de segurança não fecha verde abaixo do piso. O piso global (90/85/95) vale para o resto |
| 3 | `pnpm test:security` | A suíte adversarial dos módulos desta onda, incluindo o oráculo de rate limit |
| 4 | `diff <(pnpm ls --prod --depth 0) docs/spikes/deps-baseline.txt` | Zero dependência de runtime acrescentada, **contra um baseline commitado** — não contra a memória de ninguém |
| 5 | `grep -rn "from '\.\./" src/secret src/session src/ratelimit src/audit src/state` só mostra imports de `src/contracts/**` | Zero acoplamento cruzado entre os cinco módulos |
| 6 | Teste estatístico de constância de tempo com **N** amostras e comparação de distribuição | Não basta "chamamos `timingSafeEqual`" |
| 7 | Teste que, **após 15 falhas**, a resposta continua sendo `401` com corpo e headers **byte a byte idênticos** ao `401` de senha errada, e **sem** `Retry-After` | O ban não vira oráculo (D9) |
| 8 | Teste que, **aos 100**, o modo restrito ativa, é persistido no `state.json` e **continua ativo após reiniciar o plugin** | O controle dos 100 é derrubar exposição e persistir — não "emitir um alerta". Nesta onda prova-se a **decisão** e a **persistência**; que o `cloudflared` de fato morra é o item de aceite da Onda 3, porque o túnel só existe lá |
| 9 | `chmod 644` no `state.json` faz o boot **falhar**; `state.json` corrompido faz o boot **falhar** com mensagem acionável | *Fail loud* do estado (`02-SEGURANCA.md` §8.2/§9) |

**Reaproveitamento:** `verifyBasicAuth` **não é apagado**. Vira o caminho de compatibilidade para
clientes não-browser (curl, scripts) sob a mesma política de rate limit, enquanto a sessão vira o
caminho do browser. O `timingSafeEqual` sobre digests de tamanho fixo — decisão certa já tomada
no código atual, inclusive porque `timingSafeEqual` **lança** com buffers de tamanhos diferentes,
o que vazaria o comprimento — é reaproveitado literalmente pelo `SecretStore`.

---

## 8. ONDA 3 — Túnel e fiação do gate

**COMMIT PREP 3:** `src/contracts/tunnel.ts` congelado — `TunnelState`
(**`STOPPED | STARTING | READY | DEGRADED | STOPPING | FAILED`** — seis estados, em inglês, na
forma congelada por `01-ARQUITETURA.md` §6; `DEGRADED` = falhou **e** ainda há orçamento, re-tenta
sozinho com backoff; `FAILED` = terminal, só sai com `reset()` humano), `TunnelInfo { url,
startedAt, mode }` e o contrato `TunnelDiscovery` que separa T3.1 de T3.2. Os rótulos em português
existem **apenas como texto de UI** e nunca aparecem em código, teste ou payload IPC.

O prep também congela `tunnel.mode` no contrato — **o valor default já está decidido**
(`'quick'`, `09-DECISOES-CANONICAS.md` D6) e **não** depende de S3. Versões anteriores deste
documento faziam o PREP 3 depender de "o resultado de S3", enquanto S3 aparecia como fechada em
T6.1: um prep da Onda 3 bloqueado por uma entrega da Onda 6. Corrigido: **S3 é entrega de T0.2**,
está no mapa `S* → T*` de §2, e T6.1 apenas **re-confirma** em e2e — a re-confirmação não é
pré-requisito de prep nenhum.

| id | worktree | entrega | arquivos exclusivos | depende de |
| --- | --- | --- | --- | --- |
| T3.1 | `w3-tunnel-supervisor` | Generaliza `createWorkerSupervisor` para supervisionar **qualquer** processo longo e instancia um supervisor de `cloudflared` sob `ctx.effect()`. Mantém `detached: true` + `process.kill(-pid)` e o backoff com jitter. Acrescenta **orçamento de reinício em janela deslizante** (contagem só zera após uptime saudável mínimo) e lista de erros não-retryable (`ENOENT`, `EACCES`) que abortam de vez. **Mais quatro controles que `02-SEGURANCA.md` declara obrigatórios e que até esta revisão não tinham dono em onda nenhuma:** (i) **probe fail-closed** (`src/tunnel/probe.ts`) das **quatro** superfícies anônimas de `02-SEGURANCA.md` §L1, como **pré-condição de `STOPPED → STARTING`**; (ii) **TTL do túnel** (`src/tunnel/ttl.ts`): `tunnel.ttlMinutes` default `60`, teto `480`, `0`/ausente é **config inválida recusada no load**; ao expirar, derruba o túnel, **invalida todas as sessões emitidas** e avisa no Telegram; (iii) **pidfile** (`src/tunnel/pidfile.ts`): grava `pid`/`startedAt` via `StateStore` e, **no boot**, varre e mata o `cloudflared` órfão registrado antes de qualquer inicialização; (iv) **argv** (`src/tunnel/args.ts`): `--metrics 127.0.0.1:PORT` fixo, `--token-file` para `tunnel.mode: 'named'` (**nunca** `--token` em `argv`, que é legível em `/proc/<pid>/cmdline`), e proibição de `--loglevel debug` (a URL e headers vazam para o log). | `src/tunnel/args.ts`, `src/tunnel/supervisor.ts`, `src/tunnel/probe.ts`, `src/tunnel/ttl.ts`, `src/tunnel/pidfile.ts`, `src/proc/**`, `test/unit/tunnel/args.test.ts`, `test/unit/tunnel/supervisor.test.ts`, `test/unit/tunnel/probe.test.ts`, `test/unit/tunnel/ttl.test.ts`, `test/unit/tunnel/pidfile.test.ts`, `test/unit/proc/**`, `test/integration/proc/**`, `package.json`, `pnpm-lock.yaml` | T0.2, T1.1 |
| T3.2 | `w3-tunnel-descoberta-url` | Extração da URL. **Primário:** `GET /quicktunnel` no metrics server, que devolve `{"hostname":"…"}` **sem esquema** (prefixar `https://`), com `--metrics 127.0.0.1:PORT` **fixado** — o default é porta aleatória, não confie na faixa 20241-20245. **Fallback:** regex `https://[-a-z0-9]+\.trycloudflare\.com` sobre **stderr** (stdout fica com 0 bytes). Polling com timeout ≥30 s (a URL levou 6–7 s nas medições). Readiness abortado no `'close'` do processo. **Fronteira explícita com T3.1:** readiness (`src/tunnel/readiness.ts`) mede *quando a URL do túnel está utilizável* e roda **depois** que o túnel subiu; o probe fail-closed de quatro sondas (T3.1) roda **antes** de o túnel subir e responde outra pergunta — *o gate está armado?*. Confundir as duas foi o que expôs o DSH real por ~40 s na pesquisa: "a aplicação responde" e "a aplicação responde **401 a quem não tem credencial**" não são a mesma afirmação. | `src/tunnel/discover.ts`, `src/tunnel/readiness.ts`, `test/unit/tunnel/discover.test.ts`, `test/unit/tunnel/readiness.test.ts` | T0.2 |
| T3.3 | `w3-gate-integra-sessao` | Liga `SecretStore` + `SessionStore` + `RateLimiter` + `AuditSink` + `StateStore` no `createGuardedHandler` e no `createGuardedUpgradeHandler`. Acrescenta **validação de `Origin` por allowlist estrita** no handshake de WebSocket (CWE-1385 — a classe de CVE-2023-26114 no code-server, CVSS 9.3, e de CVE-2025-52882 nas extensões do Claude Code) e a **validação do header `Host`** (`src/http/host-header.ts`, L2.5 — anti DNS rebinding). Amplia `Config` com o eixo **`exposure`** (`mode: 'loopback' \| 'tunnel'` — default `'loopback'`; `autoStart` default `false`; `trustEdgeHeaders` default `false`, e só pode virar `true` se S2 provar que a borda **sobrescreve** o header, nunca se ela apenas acrescenta) e com `tunnel.*` e `control.*`. Fia o **modo restrito** de T2.3: em modo restrito o gate recusa credencial vinda do túnel e emite o intent que derruba a exposição. | `src/http/gate.ts`, `src/http/session-auth.ts`, `src/http/host-header.ts`, `src/http/auth-basic.ts`, `src/index.ts` (**singleton**), `src/config/**`, `cordis.patch.yml`, `test/unit/http/**`, `test/unit/config/**`, `test/integration/http/**` | T2.1, T2.2, T2.3, T2.4, T2.5 |
| T3.4 | `w3-painel-guard-http` | Rota `/__guard`: painel mínimo (HTML autocontido, **sem CDN, sem fonte remota, sem build**) + API JSON `GET /__guard/api/state` e **`POST /__guard/api/login`** (a rota que T2.2 **não** entrega, porque a Onda 2 é sem fiação). Mais as três rotas que compõem a superfície não autenticada, e que precisam ser especificadas **porque são a única coisa exposta à internet sem credencial**: `GET /__guard/magic` **inerte** (HTML estático que não consome nada) + `POST /__guard/magic` (consome o `mk`, uso único); `GET /__guard/secret?ott=<token>` (uma vez só; sem `ott` válido devolve **404 idêntico** ao de rota inexistente); e o token anti-CSRF (`src/panel/csrf.ts`) de toda rota `POST`. **A isenção de gate é enumerada, nunca inferida**: `src/panel/routes.ts` carrega uma tabela literal rota→política (`pública` / `exige sessão`), o `isGuardedPath` continua guardando `/__guard` inteiro e a tabela é a **única** fonte de exceção — qualquer rota nova nasce guardada por default. **Sem botões de liga/desliga ainda** — isso é T5.3. | `src/panel/**`, `test/unit/panel/**`, `test/security/panel-exemptions.test.ts` | T2.1, T2.2 |

**Singleton `package.json`: T3.1** (pode precisar de detecção/instalação do `cloudflared`).
**Singleton `src/index.ts`: T3.3.** **Singleton `cordis.patch.yml`: T3.3.**

**As quatro sondas do probe fail-closed** (T3.1, `src/tunnel/probe.ts`), rodadas anonimamente
contra `127.0.0.1:<porta>` **antes** de o `cloudflared` subir:

| # | Sonda | Esperado |
| - | --- | --- |
| 1 | `GET /` (o fallback da SPA) | `401` |
| 2 | `POST /api/<rpc de leitura>` com corpo vazio | `401` |
| 3 | `GET /` com `Upgrade: websocket` + `Connection: Upgrade` | socket destruído ou `401` |
| 4 | `GET /__guard/probe-canary-<aleatório>` (caminho fora de `guardedPrefixes`) | `401` |

Qualquer `200`, ou a sonda 4 devolvendo `404` sem passar pelo gate, significa **gate não armado**:
o túnel **não sobe**, o estado vai para `FAILED` e a mensagem ao dono diz **qual** sonda falhou.
O modo de falha real que isto cobre é **ordem de carregamento**: `/` vem do `registerFallback` do
`@deepseek-ai/dsh-host-frontend-static` e `/api` vem de outro registro — provar `/` não prova
`/api`.

### Decisão de modo do túnel — **já tomada**, congelada no COMMIT PREP 3

| | Quick tunnel | Named tunnel + Access |
| --- | --- | --- |
| Pré-requisito | nenhum; zero estado em disco (`~/.cloudflared` nem chega a ser criado) | conta Cloudflare **+ domínio com DNS na Cloudflare** |
| Auth na borda | **nenhuma** — Access exige `zone_id` e **não pode** ficar na frente de um quick tunnel | Access com One-time PIN por e-mail, deny-by-default |
| URL | aleatória a cada restart, **pública e descoberta em massa** | estável, sob domínio próprio |
| Limites | 200 requisições em voo → 429; sem SLA; "testing and development only" na doc oficial | sem esses limites |
| Onde fica a auth | **inteiramente dentro do plugin** | borda **+** plugin (defesa em profundidade) |

**O que está na v0.1, literalmente** (`09-DECISOES-CANONICAS.md` D6):

- **`tunnel.mode: 'quick'` — default.** É o único com onboarding automatizado e o único que o
  README promete.
- **`tunnel.mode: 'named'` — suportado como transporte.** `tunnel.tokenFile` entregue por
  `--token-file` (nunca `--token` em `argv`). **Sem** onboarding automatizado: conta, domínio e
  política de Access o usuário configura **fora do plugin**.
- **A validação do header `Cf-Access-Jwt-Assertion`** (`kid`, `iss`, `aud`, `exp`) é **roadmap
  v0.2**, declarada como tal. Adiá-la não enfraquece a linha de base porque **L4 — o portão de
  credencial — continua obrigatório no Modo B**.

**Não negociável, e é o motivo de a validação do JWT poder esperar:** a senha do plugin nunca é
removida porque existe Access na frente. Não existe, e nunca vai existir, uma flag "tenho Access,
dispensa senha". Política mal configurada e rota de bypass são o modo de falha comum, e a ação
*Bypass* do Access, além de liberar, **não registra log**.

**TTL: obrigatório no Modo A.** `tunnel.ttlMinutes` default `60`, teto `480`, e `0`/ausente é
config inválida **recusada no load** (*fail loud*). Ao expirar: derruba o túnel, invalida **todas**
as sessões emitidas e avisa no Telegram. Dono: T3.1, `src/tunnel/ttl.ts`, testado com relógio
injetado (`test/support/clock.ts`). Sem TTL, o modo de falha realista é o do usuário que abre o
túnel numa terça à noite, fecha o notebook e descobre no domingo que ele nunca fechou — que é
exatamente a ameaça T10 de `02-SEGURANCA.md`.

**Instalação do `cloudflared`:** preferir o repositório apt assinado (`https://pkg.cloudflare.com/`,
chave `cloudflare-main.gpg`), que dá verificação automática de assinatura. Alternativa: binário do
GitHub com sha256 conferido contra as **release notes** (não existe `.sha256` por asset). Bônus
verificado: o próprio `cloudflared` loga seu checksum no startup — dá para auditar o binário em
execução sem re-hashear.

**Aviso operacional herdado da pesquisa:** `--url http://localhost:3080` publica **o que estiver
ali**, sem perguntar. Durante a pesquisa isso expôs o DSH real do usuário publicamente por ~40 s.
O supervisor precisa provar que a origem que ele aponta é a que ele mesmo gerencia, e o teste
precisa usar porta dedicada.

**Perguntas falsificáveis**

*T3.1* — (1) O supervisor foi **generalizado** ou **duplicado**? Se há dois blocos de backoff no
repo, a generalização é fictícia. (2) `SIGKILL` no supervisor deixa `cloudflared` órfão? Meça com
`ps -o pid,ppid,pgid,sid`. Se deixa, existe o dead-man's switch (pipe herdado que fecha) **e** o
pidfile que a varredura do boot seguinte usa? O `cloudflared` sobe `detached: true`, que é
precisamente o que faz o órfão sobreviver — o dead-man's switch sozinho não cobre o caso de a
máquina reiniciar. (3) O orçamento de reinício zera a contagem só após uptime saudável, ou zera a
cada sucesso — o que faria um processo que morre aos 5 min reiniciar para sempre com backoff
zerado? (4) `ENOENT` (binário ausente) é não-retryable? Lembre: em `ENOENT` o evento `'exit'`
**nunca** dispara — só `'error'` e `'close'`; quem escuta só `'exit'` trava para sempre. (5) O
`graceMs` do `SubprocessSpawnSpec` e o `SIGKILL` do tree-kill se atropelam pelo mesmo processo?
(6) **O probe roda antes ou depois do `spawn`?** Se roda depois, ele não é fail-closed: a janela
de exposição já abriu. Force o gate a ficar desarmado e prove que o `spawn` **nunca acontece**.
(7) **O TTL sobrevive a quê?** Ele é um `setTimeout` que morre com o event loop, ou o `startedAt`
persistido faz o boot seguinte perceber que o túnel já passou do prazo? E ao expirar, as sessões
são **invalidadas** ou só o processo morre — deixando cookies válidos para o próximo túnel?

*T3.2* — (1) A URL veio do `/quicktunnel` ou do regex? Force o endpoint a falhar e prove o
fallback — e vice-versa. (2) O código prefixa `https://`? O endpoint devolve hostname **sem
esquema**. (3) A porta de métricas está **fixada** com `--metrics 127.0.0.1:PORT`, ou o código
adivinha a faixa? (4) O polling aborta quando o processo morre no meio do warmup, ou espera o
timeout inteiro? (5) O readiness diz "porta aberta" ou "aplicação responde"? Não são a mesma coisa.

*T3.3* — (1) A validação de `Origin` no upgrade é **allowlist exata** ou "contém"? Um
`Origin: https://evil.com/?x=meudominio.com` passa? (2) Com sessão ativa, o `trustedRemotes` ainda
é avaliado **antes**? Se não, a ordem 403-antes-de-401 se perdeu. (3) O gate passou a ler o corpo
da requisição para decidir? O código atual deliberadamente **não** lê — isso sobreviveu? (4) Com
o túnel ligado, um `POST /api/…` sem credencial vindo **de fora** devolve 401? Prove pela URL
pública, não por curl no loopback. (5) A cascata de verificação continua **fail-closed** quando
não há ouvinte nenhum? O `next` terminal que repete a verificação sobreviveu?

*T3.4* — (1) O painel serve algum recurso externo (CDN, fonte, script)? Se serve, quebra offline
e vaza referer. (2) `GET /__guard/api/state` responde **antes** do login? O que ele vaza — a URL
do túnel é informação sensível de operação. (3) `/__guard` está na lista de `guardedPrefixes`, ou
ficou fora do gate por esquecimento? (4) O painel é servido pelo `register` ou pelo
`registerFallback`? A escolha muda quem ganha em conflito de rota. (5) **A tabela de isenção é
enumerada ou inferida?** Acrescente uma rota nova qualquer em `src/panel/routes.ts` sem tocar na
tabela: ela nasce **guardada**, ou nasce pública por acidente? Esta é a única superfície do sistema
alcançável da internet sem credencial, e um furo por default aqui anula todo o resto.
(6) `GET /__guard/secret` **sem** `ott` devolve um 404 byte a byte igual ao de uma rota que nunca
existiu, ou o corpo/tempo de resposta denuncia que a rota existe?

**Aceite da Onda 3:**

| # | Verificação | Observação |
| --- | --- | --- |
| 1 | `pnpm lint && pnpm typecheck && pnpm build && pnpm test` | Gate canônico |
| 2 | Teste que sobe o **`test/bin/fake-cloudflared.mjs`**, extrai a URL pelos **dois** caminhos (`/quicktunnel` e regex em stderr), derruba, e `pgrep -f fake-cloudflared` sai vazio | O túnel **real** é exercitado só pelo roteiro manual **M2** e por `test/live/**`. Subir quick tunnel em CI publica na internet o que estiver na porta — já expôs o DSH real do usuário por ~40 s durante a pesquisa |
| 3 | Teste que prova `401` sem credencial e `200` com sessão válida **pela URL do túnel falso** | A prova pela URL pública real é item do roteiro manual **M2**, não do gate |
| 4 | Teste que prova recusa de upgrade de WebSocket com `Origin` fora da allowlist **exata** | `Origin: https://evil.com/?x=meudominio.com` tem que ser recusado |
| 5 | Teste que, com o gate **desarmado artificialmente**, o túnel **não sobe**, o estado vai para `FAILED` e a mensagem **nomeia a sonda** que falhou — um caso por sonda (as quatro) | É o controle que impede repetir o incidente de exposição da pesquisa |
| 6 | Teste com **relógio injetado** provando que, expirado o `ttlMinutes`, o processo do `cloudflared` morre **e** toda sessão emitida deixa de autenticar | Sem este item a Onda 3 fecha verde violando o checklist de `02-SEGURANCA.md` §10.2 |
| 7 | Teste que `ttlMinutes: 0` e `ttlMinutes` ausente são **recusados no load** com erro; `ttlMinutes: 481` idem | *Fail loud*, não *clamp* silencioso |
| 8 | Teste que, com `state.json` registrando um `cloudflared` vivo de uma execução anterior, o **boot mata o órfão antes de qualquer inicialização** | Pidfile de `02-SEGURANCA.md` §9 |
| 9 | Teste que, com o modo restrito ativo no `state.json`, o boot **não** sobe o túnel e o gate recusa credencial que não venha de loopback | Fecha o ciclo do teto de 100 de T2.3 |
| 10 | `pnpm test:security` e `pnpm test:contract` verdes | Critério **da onda**, não do merge |
| 11 | `assertSecureBind` e o gate de origem continuam passando **nos testes originais** | Zero regressão de endurecimento |

**Reaproveitamento:** o supervisor inteiro (backoff com jitter, `detached`, tree-kill, allowlist
de env, `AbortController` único, disposer síncrono LIFO) é a base direta do supervisor de túnel —
é o ativo mais valioso do código atual. As duas divergências já documentadas no código (o
tree-kill ignora `child.killed`; orçamento esgotado vira estado terminal observável em vez de
auto-desregistro inexistente) continuam válidas e devem ser preservadas **com os comentários que
as justificam**. Apagar esses comentários conta como regressão na revisão adversarial.

---

## 9. ONDA 4 — Telegram: onboarding, worker e IPC

**COMMIT PREP 4:** `src/contracts/ipc.ts` congelado — protocolo JSON-lines host↔worker sobre
stdio, com os tipos de mensagem (`intent`, `state`, `ack`, `error`) e os invariantes (uma
mensagem por linha, UTF-8, **nenhum segredo no payload**).

**Decisão de arquitetura registrada:** o bot roda como **processo separado**, supervisionado pelo
supervisor existente, **não** dentro do fiber do plugin. Três razões: (a) o comentário de
concorrência já presente no código é explícito — "uma operação de longa duração nunca se hospeda
no caminho de espera de outra pessoa", com o precedente real do próprio DSH, que migrou a
telemetria de SSE para WebSocket dedicado porque canais eternos esgotavam o pool de ~6 conexões
HTTP/1.1 por origem do browser; (b) isolamento de falha para um componente que fala com a
internet; (c) reaproveita o supervisor inteiro, já testado.

**Biblioteca: grammY** (1.45.1, ~3,15 M downloads/semana, Bot API 10.2 suportado 2 dias após o
anúncio, narrowing de tipo por filter query, plugin oficial de auto-retry que lê `retry_after` do
429). `telegraf` está morto (último release fev/2024, sem Bot API 8/9/10).
`node-telegram-bot-api` v2 é legítimo e tem **zero dependências de runtime**, mas nasceu em
16/08/2026 — três dias antes deste plano; para um bot que desliga servidor, risco de juventude
não compensa. Reavaliar em ~6 meses.

| id | worktree | entrega | arquivos exclusivos | depende de |
| --- | --- | --- | --- | --- |
| T4.1 | `w4-telegram-onboarding-cli` | **Detecta o estado** (`SEM_TOKEN` / `TOKEN_INVALIDO` / `TOKEN_OK_SEM_DONO` / `PRONTO`) e guia **só o passo faltante** — não repete o tutorial inteiro. `getMe` valida o token. **O pareamento é por código, não por corrida de `/start`** (`02-SEGURANCA.md` §7.2, sete passos, e `09-DECISOES-CANONICAS.md` D8): o CLI gera um **código de 6 dígitos com TTL de 5 min** exibido **só no terminal** (e no painel local já autenticado); o dono manda `/parear 123456` para o bot; `from.id` e `chat.id` são lidos **do update que carrega o código correto**, nunca do primeiro `/start` que chegar; o pareamento então **fecha permanentemente**, e reabrir exige `--reset-pairing` **na máquina**. `/start` responde uma mensagem de boas-vindas inócua e **não pareia ninguém**. `getUpdates` continua sendo apenas o **transporte** que traz a mensagem. Entrega também o **texto** que o usuário lê em cada um dos quatro estados, na CLI e no painel — é artefato revisável, não improviso de implementação. | `src/telegram/onboarding.ts`, `src/telegram/pairing.ts`, `bin/**`, `test/unit/telegram/onboarding.test.ts`, `test/unit/telegram/pairing.test.ts` | T0.3 |
| T4.2 | `w4-worker-bot-grammy` | O processo do bot: long polling com `timeout: 50` (o servidor clampa em 50 s), `allowed_updates: ["message","callback_query"]`, `drop_pending_updates` no boot (sem ele, 24 h de comandos represados executam de uma vez — inaceitável num bot que desliga servidor), `bot.catch` cobrindo `GrammyError` **e** `HttpError`, plugin de auto-retry. **Único que adiciona dependência nesta onda** — `grammy` entra como `dependencies` de runtime, **versão exata** (`09-DECISOES-CANONICAS.md` D23). A frase "zero dependências de runtime" sai de todo material no mesmo commit em que a dependência entra; o argumento verificável passa a ser "**uma** dependência de runtime, carregada só pelo processo `worker/`". A superfície de `drop_pending_updates` é a que **S8** encontrar (T0.3): se ela não existir no polling, o descarte é feito por um `getUpdates` inicial com `offset: -1` e isso é **documentado**, nunca inventado. | `worker/telegram-bot.ts`, `worker/lib/**`, `test/unit/worker/lib/**`, `package.json`, `pnpm-lock.yaml` | T0.3 |
| T4.3 | `w4-ipc-host-worker` | Muda o `stdio` do supervisor de `['ignore','pipe','pipe']` para `['pipe','pipe','pipe']` e implementa o protocolo JSON-lines dos dois lados. O **fechamento do pipe é o dead-man's switch**: se o host morrer por `SIGKILL`, o worker se mata sozinho. Liga o worker no `src/index.ts`. O `argv` do spawn resolve `dist/worker/telegram-bot.js` **relativo a `import.meta.url`**, nunca por `cwd`. | `src/telegram/ipc.ts`, `worker/ipc.ts`, `src/proc/supervisor.ts`, `src/proc/env.ts`, `src/index.ts` (**singleton**), `test/unit/telegram/ipc.test.ts`, `test/unit/worker/ipc.test.ts`, `test/unit/proc/**`, `test/integration/proc/**` | T1.1, T3.1 |
| T4.4 | `w4-allowlist-e-2step` | **Allowlist de identidade** (`worker/auth/allowlist.ts`): valida **`from.id`** (o usuário) **e** `chat.id`, ambos por **id numérico**, nunca por username (mutável e sequestrável); `message.from` **ausente** (channel post) é negação; update fora da allowlist é descartado em silêncio e **contado** no audit. `worker/auth/guard.ts` revalida a identidade em **todo** `callback_query` — `callback_data` é fornecido pelo cliente e nunca é prova de autorização. `worker/auth/pairing.ts` recebe `/parear <código>`, e o **segundo pareamento é recusado**. **O nonce de confirmação de 2 etapas NÃO é desta sub-tarefa**: ele é emitido e validado no **host** (`src/control/confirm.ts`, T5.1, contrato congelado no PREP 5); o worker apenas o transporta opaco dentro do `callback_data`. Um nonce validado no processo que fala com a internet não é um controle — é uma variável. | `worker/auth/**`, `test/unit/worker/auth/**` | T0.3 |

**Singleton `package.json`: T4.2.** **Singleton `src/index.ts`: T4.3.**
T4.2 e T4.4 dividem `worker/`, mas em subdiretórios disjuntos; `worker/telegram-bot.ts` é
exclusivo de T4.2. Interseção zero.

### Regras duras de segurança desta onda (não negociáveis, com fonte)

1. **O segredo do plugin NUNCA trafega como texto de mensagem no Telegram.** Chats com bot são
   *cloud chats*: só têm criptografia servidor-cliente, não E2E
   ([FAQ](https://telegram.org/faq#q-so-how-do-you-encrypt-data)); a Telegram armazena o histórico
   nos servidores dela ([Privacidade 3.3.1](https://telegram.org/privacy#3-3-1-chats-em-nuvem)) e
   roda análise automatizada sobre mensagens de cloud chat; *Secret Chats* não existem para bots;
   e o FAQ oficial diz literalmente que *"any bot should be treated as a stranger — don't give
   them your passwords"*.
2. **Não existe autodestruição para bots.** `message_auto_delete_time` é somente-leitura, não há
   método `setChatMessageAutoDeleteTime`, e `deleteMessage` só funciona em mensagens com **menos
   de 48 horas**. "Eu apago depois" é higiene cosmética, não controle de segurança.
3. **`callback_data` é fornecido pelo cliente** (1–64 **bytes**, não chars — acento consome 2).
   Um cliente modificado manda qualquer string. **Nunca** é prova de autorização; revalide
   `from.id` sempre.
4. **O que o bot pode enviar:** a **URL** do túnel (pública por natureza) e, **por padrão em
   `exposure.mode: 'tunnel'`**, um **magic link de uso único com TTL de 120 s** que estabelece
   sessão. Nunca o segredo persistente. `control.magicLink` é `true` por default em modo túnel e
   `false` em `mode: 'loopback'`; **o que existe é opt-out, não opt-in** — e com o opt-out ligado
   o caminho para o celular passa a ser o QR code impresso pelo `bin/dsh-guard-setup`, lido antes
   de sair de casa. A razão de não ser opt-in está em `02-SEGURANCA.md` §5.3 e é comportamental:
   sem um caminho utilizável para o celular — que é o produto inteiro — o dono cola a senha
   permanente no chat, que é exatamente o que este plano proíbe. O trade-off fica escrito: põe-se
   uma credencial de **120 segundos e uso único** no histórico para não pôr uma de longa duração.
   O que trafega é um bearer `mk` de 128 bits que vive **só em memória**, viaja no **fragmento**
   (`#`) e nunca em query string, e está sob o mesmo rate limit do login.
5. **O token do bot é senha de controle total** — sem segundo fator, sem escopo, sem allowlist de
   IP ([doc oficial](https://core.telegram.org/bots/features#botfather)). Env/secret manager,
   `0600`, nunca em git, mascarado em log (ele vai na **URL**). Se vazar, o atacante personifica o
   bot, **rouba a fila de updates** (`getUpdates` confirmado apaga do servidor — o dono legítimo
   nunca vê aqueles comandos) e sequestra por `setWebhook`. O que ele **não** consegue neste
   desenho é fabricar um update com identidade allowlistada: as ações partem de updates de
   **entrada**, e em long polling não há endpoint onde forjar um POST; a Bot API também não
   devolve como update as mensagens que o próprio bot envia. **Isso é propriedade do desenho de
   long polling e precisa ser preservada** — se alguém migrar para webhook, `secret_token`
   (header `X-Telegram-Bot-Api-Secret-Token`, comparado em tempo constante) passa a ser
   obrigatório. O resíduo honesto: com o token, o atacante pode mandar como o bot um teclado
   inline cujo `callback_data` é destrutivo, e se **o dono clicar**, o callback chega com
   identidade válida. É *confused deputy* dependente de ação do usuário legítimo — mitigado pelo
   nonce de 2 etapas de T4.4, não eliminado.

**Perguntas falsificáveis**

*T4.1* — (1) O onboarding **detecta** estado ou só imprime tutorial linear? Rode com token já
configurado: ele pula o passo? (2) `getUpdates` com `offset` **confirma e apaga** updates no
servidor — o onboarding consome updates que o worker precisaria? (3) Se o usuário nunca mandou
`/start`, a mensagem explica que **bot não pode iniciar conversa**, ou fica em loop esperando?
(4) O token é escrito em arquivo pelo CLI? Com que permissão? (5) **Um `/parear` com código
errado pareia alguém?** E um código **expirado**? E um `/start` de estranho que chegue **antes**
do dono — ele vira dono? As três têm que falhar, e o teste tem que provar que falham: é a corrida
que `02-SEGURANCA.md` §7.2 nomeia como ameaça T4, e ganhá-la dá shell ao atacante sem que ele veja
a senha, porque `/acessar` emite sessão. (6) **Tentativas de `/parear` têm limite?** Seis dígitos
são 10⁶ e as tentativas vêm por definição de um `from.id` **desconhecido**, logo a allowlist não
pode filtrá-las: sem contagem por chat e teto com descarte, é força bruta viável dentro dos 5 min
de TTL. (7) Rodar o onboarding com o worker de polling **já rodando** dá 409 — isso é detectado e
explicado, ou vira erro cru?

*T4.2* — (1) `drop_pending_updates` está no boot? (2) O 429 é tratado lendo `retry_after`, ou há
retry cego que amplifica? (3) Duas instâncias simultâneas: o 409 é detectado e o processo sai, ou
entra em flapping infinito com o supervisor reiniciando? (4) `bot.catch` cobre `HttpError` (falha
de rede) além de `GrammyError`? (5) O token aparece em algum log, mesmo dentro de uma mensagem de
erro que cita a URL?

*T4.3* — (1) O dead-man's switch **funciona**? `SIGKILL` no host: o worker morre? Meça, não
presuma. (2) Uma linha de JSON partida entre dois chunks de `data` é reconstruída, ou o parser
quebra? (3) Mudar o `stdio` do stdin para `pipe` alterou o comportamento do tree-kill ou do
`detached`? (4) Alguma mensagem do protocolo carrega segredo? (5) Backpressure: se o worker parar
de ler, o host bloqueia?

*T4.4* — (1) A allowlist valida `from.id` **e** `chat.id`, ou só um? Em grupo, um
`callback_query` chega com `callback_query.from` — qualquer membro pode apertar o botão. (2)
`message.from` **ausente** é tratado como negação, ou como `undefined` que passa por acidente?
(3) O worker **valida** algum nonce localmente? Se validar, é defeito: o nonce é emitido e
consumido no host (T5.1) e o worker só o transporta opaco. (4) Alguma comparação usa `username`?
(5) O `callback_data` é usado para decidir autorização em algum ponto? (6) O **segundo** `/parear`,
com o pareamento já fechado, é recusado — inclusive quando vem do próprio dono?

**Aceite da Onda 4:**

| # | Verificação |
| --- | --- |
| 1 | `pnpm lint && pnpm typecheck && pnpm build && pnpm test` verde |
| 2 | Onboarding testado nos **4 estados** (`SEM_TOKEN`, `TOKEN_INVALIDO`, `TOKEN_OK_SEM_DONO`, `PRONTO`), cada um com asserção do **próximo passo emitido** e do **texto** exibido |
| 3 | Pareamento: código **errado** não pareia; código **expirado** (TTL 5 min, relógio injetado) não pareia; **segundo** `/parear` recusado; `/start` de estranho **não** vira dono; tentativas de código têm teto e as excedentes são descartadas; `--reset-pairing` é o **único** caminho de reabertura |
| 4 | `SIGKILL` no processo host → worker morto em **<2 s medido**, não afirmado |
| 5 | `from.id` fora da allowlist recebe negação **e** entra no audit log; `message.from` ausente é negação |
| 6 | Zero segredo (do plugin ou token do bot) em qualquer mensagem do protocolo IPC ou em log — asserção sobre o **payload serializado**, não sobre a intenção |
| 7 | `pnpm test:security` e `pnpm test:e2e` verdes (critério **da onda**, não do merge) |
| 8 | `diff <(pnpm ls --prod --depth 0) docs/spikes/deps-baseline.txt` mostra **exatamente uma** linha nova (`grammy`, versão exata) e nenhuma outra |

**Reaproveitamento:** `createWorkerSupervisor`, `buildWorkerEnv` (a allowlist de env já existe e
já injeta o token por env e nunca por `argv`) e `computeBackoffDelay` com jitter. O que muda: o
worker deixa de ser um binário externo hipotético e passa a ser um entrypoint Node do próprio
repositório — as entradas `worker.command`/`worker.args` do `Config` continuam existindo e passam
a apontar para o Node com o script do repo, o que **mantém o contrato de configuração intacto**.

---

## 10. ONDA 5 — Liga/desliga nas duas superfícies

**COMMIT PREP 5:** `src/contracts/control.ts` congelado — a máquina de estado (os **seis**
estados de `TunnelState`), as transições legais e
`ControlIntent { action, requestedBy, requestId, nonce, at }`. O `requestId` (ULID) é o que torna a
idempotência verificável: sem ele, "`start` em `READY` é no-op" não tem como ser provado contra
duas intents concorrentes. Diagrama commitado junto.

Congela também **duas assinaturas de acoplamento**, cada uma porque sem elas duas sub-tarefas da
Onda 5 disputariam o mesmo arquivo:

1. **O contrato do nonce de confirmação** — `issue(action): Nonce` / `consume(nonce, action):
   boolean`, TTL 60 s, uso único, **server-side no host**. A implementação é de T5.1
   (`src/control/confirm.ts`); o worker (T5.2) só transporta o valor opaco.
2. **A assinatura do evento de auditoria "sessão nova"** emitido de dentro de
   `src/http/gate.ts`. O **ponto de chamada** é congelado aqui; T5.4 implementa apenas o
   **consumidor**. Sem esse congelamento, T5.4 precisaria editar `src/http/gate.ts`, que na Onda 5
   não tem dono — e a onda pararia no "para e reporta".

**O que o PREP 5 NÃO faz mais:** reconciliar o prefixo de rota (subiu para o **PREP 1**, antes de
qualquer código de rota existir) **e não decide `start` durante `STOPPING`**. Isso foi resolvido por
`09-DECISOES-CANONICAS.md` **§D29**: `rejected` com `SHUTDOWN_IN_PROGRESS`, sem fila, e chave de
idempotência `requestId` (o nonce autoriza, não deduplica). O PREP 5 **transcreve** D29 em
`src/contracts/control.ts`; não abre a discussão.

**Decisão estruturante: existe um único dono do estado** — `src/control/controller.ts`. Telegram
e painel são **superfícies**, não donos. Nenhuma superfície chama o supervisor de túnel
diretamente. É isso que torna T5.2 e T5.3 paralelizáveis com risco zero de estado divergente.

```
        ┌──────────────┐  start()   ┌───────────┐  url pronta  ┌────────┐
        │   STOPPED    │───────────►│ STARTING  │─────────────►│ READY  │
        └──────────────┘            └───────────┘              └────────┘
              ▲   ▲                       │ falha                   │ stop()
              │   │                       ▼                         │ TTL expira
              │   │                 ┌────────────┐                  ▼
              │   └─────────────────│  DEGRADED  │◄─────────────┌───────────┐
              │   backoff esgotou   └────────────┘  morte súbita │ STOPPING  │
              │   sem sucesso            │ ▲  │                  └───────────┘
              │                          │ └──┘ re-tenta               │
              │                          │  (há orçamento)             │ falha
              │              orçamento    ▼                            ▼
              │              esgotado  ┌──────────┐                    │
              └────────────────────────│  FAILED  │◄───────────────────┘
                     reset()           └──────────┘
```

**`DEGRADED` não é enfeite:** é o estado em que o supervisor falhou **e ainda tem orçamento**, e
re-tenta sozinho com backoff. `FAILED` é terminal — orçamento esgotado, `ENOENT`, `EACCES`, config
inválida — e só sai com `reset()` humano. Sem `DEGRADED` o contrato nasceria sem um estado que o
resto do plano (backoff, orçamento, `01-ARQUITETURA.md` §6, os casos `CTL-008`/`TG-044`/`M4` de
`04-TESTES.md`) já exige. Os seis nomes são **em inglês** em código, teste e payload IPC; os
rótulos em português existem só como texto de UI.

| id | worktree | entrega | arquivos exclusivos | depende de |
| --- | --- | --- | --- | --- |
| T5.1 | `w5-controller-estado-unico` | A máquina de estado, **serialização de intents** (fila de um, sem reentrância), idempotência por `requestId` (`start` em `READY` é no-op que devolve a URL vigente, não um segundo túnel; `start` durante `STOPPING` é **recusado** com `SHUTDOWN_IN_PROGRESS`, nunca enfileirado — enfileirar reabre a exposição que alguém acabou de mandar fechar), reconciliação com o processo real e broadcast de mudança de estado com `seq` monotônico. Mais o **nonce de confirmação** (`src/control/confirm.ts`): server-side, TTL 60 s, uso único, exigido em toda ação que **aumenta** exposição (`/ligar`, `/rotacionar`) e **dispensado** nas que a reduzem (`/desligar`, `/emergencia` — em pânico, o botão tem que funcionar de primeira). **Enquanto o modo restrito estiver ativo no `state.json`, `/ligar` é recusado** por qualquer superfície: sem essa regra, o dono — ou o atacante que já controla o chat — reabre a exposição no comando seguinte e o teto de 100 falhas vira decorativo. Fiação em `src/index.ts`. | `src/control/**`, `src/index.ts` (**singleton**), `cordis.patch.yml`, `test/unit/control/**`, `test/integration/control/**` | T3.1, T3.4, T4.3, PREP 5 |
| T5.2 | `w5-superficie-telegram-onoff` | A **lista fechada** de comandos, publicada por `setMyCommands` exatamente nesta ordem: `/ligar`, `/desligar`, `/status`, `/acessar`, `/rotacionar`, `/parear <código>`, `/emergencia`. (`/start` continua existindo como boas-vindas inócuo e **não** aparece em `setMyCommands`.) **Teclado inline** — não reply keyboard, que só manda texto puro, indistinguível de digitação e sem payload. `answerCallbackQuery` **sempre**, inclusive nos caminhos de erro (sem ele o cliente mostra barra de progresso infinita). `editMessageText` para atualizar estado **in-place** em vez de mandar mensagem nova. Confirmação em 2 etapas em `/ligar` e `/rotacionar`, com o nonce **emitido pelo host** (T5.1) e transportado opaco. **Nada de `InlineKeyboardButton.style`** enquanto **S7** não confirmar que o campo existe na Bot API: até lá a semântica vai no **texto** do botão ("🟢 Ligar" / "🔴 Desligar"). Este campo circulou como fato de confiança Alta neste plano e nunca foi verificado. | `worker/commands/**`, `test/unit/worker/commands/**` | T4.2, T4.4, **PREP 5** |
| T5.3 | `w5-superficie-painel-onoff` | Botões no painel `/__guard` chamando `POST /__guard/api/tunnel/start\|stop`, com o mesmo nonce de confirmação **e** o token anti-CSRF de T3.4, estado ao vivo e exibição da URL. Sem CDN, sem recurso externo. | `src/panel/**`, `test/unit/panel/**` | T3.4, **PREP 5** |
| T5.4 | `w5-notificacao-e-auditoria` | Vocabulário fechado de eventos (`src/audit/events.ts`) e composição da notificação proativa (`src/audit/notify.ts`), **consumindo o gancho congelado no PREP 5** — T5.4 não edita `src/http/gate.ts`. Notifica em **toda sessão nova bem-sucedida**, não só na "primeira não reconhecida": é o único detector do atacante que **tem** a credencial, e uma definição dependente de IP é inútil se S2 disser que não há IP confiável. Notifica também: na **primeira falha de autenticação** de cada janela de 10 min, com botão "derrubar túnel agora"; em toda sessão nova, com botão "não fui eu" (que executa o kill switch); em todo toggle do túnel; na expiração do TTL; na entrada em modo restrito; e no `magic.crawler-suspect`. Emite ainda o **relatório periódico a cada 30 min** de túnel aberto, com o tempo restante do TTL e um botão de encerrar — é o controle desenhado contra T10 ("operador cansado"), e até esta revisão ele existia só em `02-SEGURANCA.md` §L8. Alertas são coalescidos em janela de 30 s e o `retry_after` do 429 do Telegram é respeitado, nunca retry cego. Escreve no `AuditSink` **antes** de notificar — o log é a fonte da verdade; o Telegram é entrega best-effort e nunca bloqueia o request do usuário. | `src/audit/notify.ts`, `src/audit/events.ts`, `test/unit/audit/notify.test.ts`, `test/unit/audit/events.test.ts` | T2.4, T4.3, **PREP 5** |

**Singleton `package.json`: ninguém.** **Singleton `src/index.ts`: T5.1.**
T5.4 possui **só** `notify.ts` e `events.ts` dentro de `src/audit/`; os arquivos de T2.4 ficam
fechados nesta onda.

**Desambiguação obrigatória — "desligar o server" significa o quê?** Três coisas diferentes, e o
plano só implementa a primeira por padrão:

| Ação | Efeito | Padrão |
| --- | --- | --- |
| **Desligar o túnel** | `cloudflared` morre; o DSH continua rodando em loopback | **Sim** — é o que o botão faz |
| Desligar o worker do bot | o bot para de responder; o túnel segue | Comando separado, explícito |
| Desligar o DSH inteiro | derruba o harness | **Não implementado** — desligar pelo Telegram o processo que hospeda o bot é caminho sem volta remoto |

Isso tem que estar escrito na UI e no texto do comando; senão a primeira surpresa do usuário é
descobrir que "desligar" não desligou o que ele achava.

### Entrega da senha e do link ao usuário — quem entrega o quê, e por qual canal

O pedido tem dois artefatos que precisam chegar às mãos do dono: a **senha** (item c) e o **link**
(item b). Eles viajam por **canais diferentes de propósito**, pela decisão registrada em
`02-SEGURANCA.md` (L4/L8 e a linha T6 da tabela de ameaças). Nenhuma sub-tarefa tem licença para
unificá-los.

| Artefato | Canal de entrega | Quem entrega | Por que **não** pelo outro canal |
| --- | --- | --- | --- |
| **Senha** (segredo persistente) | **Canal local apenas, sem exceção**: stdout do `bin/dsh-guard-setup` (T4.1) no `provision()`, em **texto e como QR code ASCII na mesma tela**; ou `GET http://127.0.0.1:3080/__guard/secret?ott=<token>`, onde o `ott` é de uso único, 128 bits, TTL 10 min, **impresso no stdout do terminal**, e a rota deixa de existir após o primeiro consumo (sem `ott` válido: **404 idêntico** ao de rota inexistente). Mostrada **uma única vez**; em disco só o `sha256` com `0600` (T2.1) | T2.1 gera, apresenta e emite o `ott`; T3.4 serve a rota; T4.1 e T5.3 são as superfícies de exibição | **Nunca** pelo Telegram. Chat com bot é *cloud chat*: sem E2E, histórico armazenado nos servidores da Telegram, análise automatizada sobre o conteúdo, e **não existe autodestruição para bots** (`message_auto_delete_time` é somente-leitura; `deleteMessage` só abaixo de 48 h). "Eu apago depois" é higiene cosmética, não controle |
| **Link** (URL do túnel) | **Telegram** (T5.4 compõe, T5.2 renderiza) e painel (T5.3) | T3.2 extrai → T5.1 difunde com `seq` → T5.4 compõe o `notify` → T5.2 renderiza no chat | A URL **não é segredo** (§1 e `02-SEGURANCA.md` §2.2): amostragem pública devolveu dezenas de hostnames `*.trycloudflare.com` vivos. A mensagem **tem que dizer isso**, com todas as letras — caso `PWR-12` de `04-TESTES.md` |
| **Magic link** de uso único | Telegram, **`control.magicLink` LIGADO POR PADRÃO** quando `exposure.mode: 'tunnel'` (e desligado por padrão em `mode: 'loopback'`). O que existe é **opt-out** (`control.magicLink: false`), não opt-in — ver `09-DECISOES-CANONICAS.md` D3 | T5.4 compõe e T5.2 renderiza; consome o `magic.ts` de T2.2 e a rota de T3.4 | É o único caso em que uma credencial atravessa o chat, e a razão de ser default é comportamental: sem um caminho utilizável para o celular, o dono cola a **senha permanente** no chat. Troca-se uma credencial de longa duração por um bearer `mk` de 128 bits, **TTL 120 s**, **uso único**, **só em memória**, no **fragmento** da URL e sob o mesmo rate limit do login. Com o opt-out ligado, o caminho para o celular é o **QR** do `dsh-guard-setup`, lido antes de sair de casa. **Três controles obrigatórios, sem exceção:** `GET /__guard/magic` é **inerte** (o consumo é um `POST` disparado por clique); a mensagem sai com `disable_web_page_preview: true`; consumo sem clique detectável não emite sessão, não queima o `mk` e registra `magic.crawler-suspect` no audit |

**Invariante verificável desta onda (entra no aceite).** O `git grep` heurístico continua, mas
ele **sozinho não é o controle** — ele não pega `cred`, `pw`, `this.value` nem interpolação, e
essa limitação está escrita aqui em vez de ser descoberta depois:

1. *Heurística, barata:*
   `git grep -nE 'sendMessage|notify' -- src/ worker/ | xargs -r grep -iE 'secret|senha|password|cred|passwd|\bpw\b'`
   tem que sair **vazio**.
2. *O controle de verdade, comportamental:* `SEC-14` estendido — um teste que **provisiona um
   segredo conhecido**, exercita **todos** os caminhos que produzem payload de `sendMessage` e de
   IPC (toggle, notificação, `/status`, `/acessar`, `/rotacionar`, erro), serializa cada payload e
   asserta que a **string do segredo não aparece em nenhum**, em nenhuma codificação. O `mk` do
   link mágico é explicitamente **permitido** nesse payload; o segredo permanente, não. É a
   diferença entre grep de nome de variável e prova de comportamento.

**Perguntas falsificáveis**

*T5.1* — (1) Dois `start()` simultâneos (um do Telegram, um do painel, no mesmo instante) criam
dois `cloudflared`? Force a corrida. (2) `stop()` durante `STARTING` deixa processo órfão? (3) O
estado é **derivado do processo real** ou é uma variável que pode mentir? Mate o `cloudflared`
por fora e veja se o estado converge. (4) `FAILED → STOPPED` exige intervenção humana, ou o
sistema se auto-cura em loop? (5) O disposer do fiber ainda derruba tudo em LIFO com o
controlador no meio da cadeia?

*T5.2* — (1) `answerCallbackQuery` é chamado em **todos** os caminhos, inclusive nos de erro?
(2) O `callback_data` cabe em 64 **bytes** — algum caractere acentuado estoura? (3) A confirmação
de 2 etapas é real, ou o segundo botão aceita qualquer nonce? Tente reusar um já consumido.
(4) `editMessageText` respeita o limite de 4096 caracteres? (5) O limite de **1 msg/s por chat**
é respeitado no broadcast de mudança de estado, ou um flapping do túnel gera enxurrada e 429?

*T5.3* — (1) O painel usa cookie de sessão? Então **toda** mutação precisa de token anti-CSRF —
`SameSite=Strict` sozinho **não basta** (posição da OWASP; e a NIST SP 800-63B-4 §5.1.1 usa
SHALL). Existe? (2) O botão de desligar tem confirmação, ou é um clique só? (3) Se a sessão
expirar com o painel aberto, o botão falha com 401 legível ou com erro mudo? (4) O painel revela
a URL do túnel **antes** do login?

*T5.4* — (1) "Primeiro acesso não reconhecido" é definido como quê — IP novo, sessão nova,
User-Agent novo? Se o `cloudflared` não repassa IP (S2), a definição por IP é inútil e o código
precisa dizer isso. (2) A notificação falha silenciosamente se o Telegram estiver fora do ar, ou
bloqueia o request do usuário? (3) O audit log é escrito **antes** da notificação? (4) A
notificação carrega dado sensível (segredo, token, caminho absoluto de arquivo do usuário)?

**Aceite da Onda 5:**

| # | Verificação |
| --- | --- |
| 1 | `pnpm lint && pnpm typecheck && pnpm build && pnpm test` verde |
| 2 | Teste de corrida provando **um único** `cloudflared` sob `start()` concorrente das duas superfícies, com `requestId` distinto |
| 3 | `start` durante `STOPPING` é **recusado** com `SHUTDOWN_IN_PROGRESS` — não enfileirado, não reconciliado depois para `STARTING` |
| 4 | Matar o `cloudflared` externamente faz o estado **convergir** (`DEGRADED` se há orçamento, `FAILED` se não há) — nunca ficar mentindo `READY` |
| 5 | Nonce de confirmação: replay **falha**, expiração (60 s, relógio injetado) **falha**, e o nonce é validado **no host** (um worker adulterado não consegue confirmar nada sozinho) |
| 6 | `setMyCommands` publica **exatamente** a lista de sete comandos, nesta ordem, e nenhum outro |
| 7 | Toda ação de liga/desliga aparece no audit log com origem identificada (`telegram:<id>` ou `panel:<session>`) |
| 8 | Os dois itens do invariante anti-vazamento acima: grep vazio **e** `SEC-14` estendido verde |
| 9 | Magic link: `GET` **não** consome; `POST` consome; segundo `POST` falha **e alerta**; TTL 120 s expira; `mk` some no restart do processo; User-Agent de crawler **não queima** o token e registra `magic.crawler-suspect` |
| 10 | `pnpm test:security` e `pnpm test:e2e` verdes (critério **da onda**) |

**Reaproveitamento:** o veto de `security/permission-elevate` continua onde está, **com o
comentário honesto que já corrige a alegação exagerada**: nenhum componente documentado do DSH
emite esse evento hoje, o comando perigoso viaja no **corpo** do POST e o gate deliberadamente
não lê corpo — é hook de defesa em profundidade, não o freio principal. Se alguém apagar essa
ressalva na revisão, é regressão de documentação e a onda volta.

---

## 11. ONDA 6 — Testes de integração ponta a ponta

**Por que uma onda inteira.** Até aqui cada peça foi testada isolada. O que mata este projeto não
é uma função errada — é a **composição**: ordem de carregamento, processo órfão, gate que passa
no unitário e é contornado por uma rota que ninguém previu.

**COMMIT PREP 6.** Duas coisas congeladas antes de abrir as quatro worktrees.

**O que este prep deixou de fazer, e por quê.** Versões anteriores congelavam aqui o diretório de
dublês (`test/helpers/**` + `scripts/e2e/shared/fake-cloudflared.mjs`) e mandavam migrar "os
dublês que já existem dentro do `test/index.test.ts` atual". Duas coisas estavam erradas:
(i) congelar o diretório de dublês na **Onda 6** é congelá-lo quatro ondas **depois** de os testes
começarem, o que garante quatro conjuntos divergentes e transforma "migração sem alteração de
comportamento" em reescrita; (ii) `test/index.test.ts` **não existe mais desde a Onda 1**, quando
T1.1 o dissolveu. Os dublês passaram para o **COMMIT PREP 2**, em `test/support/**` e
`test/bin/fake-cloudflared.mjs`, alimentados pelo handoff de T1.1 — que os extrai **antes** de
dissolver o arquivo. `test/helpers/**` e `scripts/e2e/shared/**` estão mortos como caminho.

1. **A lista fechada dos 50 mutantes** de `04-TESTES.md` §7.2, commitada como
   `docs/mutantes.md`, com uma linha por mutante e a coluna "teste que o mata" em branco. É o
   checklist que T6.3 preenche por leitura e por teste dirigido.
2. **A política de mutation testing, registrada como decisão e não como aspiração.** Mutation
   testing roda em **job noturno separado**, com `break` desligado, e **não bloqueia PR**. O runner
   do projeto continua sendo `node:test`; **não** se introduz Vitest — trocar o runner do projeto
   inteiro por causa de uma ferramenta de qualidade secundária é custo desproporcional numa onda
   que já é a mais pesada. T6.3 abre com um **spike de 1 h**: se o Stryker não suportar `node:test`
   na versão da matriz, o item sai do aceite e vira nota em `docs/TESTING.md`. Como quem precisa da
   dependência é T6.3, **o singleton `package.json` desta onda é T6.3**, não T6.2.

| id | worktree | entrega | arquivos exclusivos | depende de |
| --- | --- | --- | --- | --- |
| T6.1 | `w6-e2e-tunnel-e-live` | **Dois níveis, com nomes distintos e sem ambiguidade.** (i) **`test/e2e/**` — offline, bloqueia PR**: origem HTTP real em **porta dedicada** no loopback + `test/bin/fake-cloudflared.mjs`, extração da URL pelos dois caminhos, `401` sem credencial / `200` com sessão pela URL do túnel falso, teardown sem resíduo. Roda em `ubuntu-latest`, sem rede. (ii) **`test/live/**` — rede real**, quick tunnel de verdade, ataque pela URL pública, WebSocket com payload nos dois sentidos (**re-confirma S3**), opt-in por `DSH_GUARD_LIVE_TESTS=1`, `workflow_dispatch` apenas, **nunca em PR, nunca no gate**. Subir quick tunnel em CI publica na internet o que estiver na porta — foi assim que a pesquisa expôs o DSH real do usuário por ~40 s. | `test/e2e/tunnel-*.test.ts`, `test/live/**` | Ondas 3, 5 |
| T6.2 | `w6-e2e-telegram-fake-api` | Suíte contra o servidor Bot API falso de `test/support/telegram-server.ts` (prep-owned): `getMe`, `getUpdates`, `sendMessage`, `answerCallbackQuery`, `editMessageText`, **mais** o 429 com `retry_after` e o 409 de conflito, com o grammY apontado para ele por `apiRoot`. **Tem spike embutido (S5)**: se `apiRoot` não for configurável, o plano B é injetar transporte falso na camada de rede do worker — decidir na primeira hora e reportar. **Não** possui `package.json` nesta onda. | `test/e2e/telegram-*.test.ts` | Ondas 4, 5 |
| T6.3 | `w6-regressao-seguranca` | Suíte adversarial: bind fora da allowlist falha no load; origem não confiada → 403 **antes** de 401; upgrade de WS sem `Origin` válido recusado; brute force respeita teto e atraso **sem mudar o corpo da resposta**; timing da comparação sem correlação estatística; **nenhuma rota escapa do gate** (fuzzing de prefixo), incluindo as três rotas isentas de T3.4 — que têm que estar na tabela de isenção **e** em lugar nenhum além dela. Mais o **checklist dos 50 mutantes** de `docs/mutantes.md`, preenchido e assinado. **Dona do singleton `package.json`** (é ela que precisa do Stryker) e da configuração de mutation. | `test/security/**`, `docs/mutantes.md`, `stryker.config.mjs`, `package.json`, `pnpm-lock.yaml` | Ondas 2, 3 |
| T6.4 | `w6-ciclo-vida-e-orfaos` | Caos de processo: `SIGKILL` no host → nenhum `cloudflared` nem worker órfão; **varredura de pidfile no boot** matando o órfão de execução anterior; disposer do fiber em LIFO; orçamento de reinício e circuito aberto; `ENOENT` não vira loop; reparenting verificado com `ps -o pid,ppid,pgid,sid` — lembrando que em Linux moderno o órfão é adotado pelo **subreaper** mais próximo (`systemd --user`), **não** necessariamente pelo PID 1. Inclui `test/e2e/tree-kill-real.test.ts` (processos locais, offline — permanece em `e2e`, não em `live`). | `test/e2e/lifecycle-*.test.ts`, `test/e2e/tree-kill-real.test.ts` | Ondas 3, 4 |

**Singleton `package.json`: T6.3.** Nenhuma outra pode adicionar dependência de teste.
**Ordem de merge desta onda:** `T6.1 → T6.2 → T6.4 → T6.3` (o singleton entra por último).

**Perguntas falsificáveis**

*T6.1* — (1) O teste ataca a **URL pública** ou faz curl no loopback e chama de e2e? (2) O
WebSocket transportou payload de aplicação, ou só o `101`? (3) O teste roda em CI sem rede? Se
não, está marcado como opcional e **fora** do gate de PR — ou o CI vai ficar vermelho por motivo
alheio ao código? (4) Após o teardown, `pgrep -f cloudflared` é vazio? (5) O teste expôs
publicamente algum serviço real do usuário, ainda que por segundos? Qual porta ele usou?

*T6.2* — (1) O servidor falso implementa o **429 com `retry_after`** e o **409**, ou só o caminho
feliz? (2) Um token real pode vazar para o teste por env? Existe guarda que aborta se
`TELEGRAM_BOT_TOKEN` estiver setado? (3) O teste prova que `drop_pending_updates` foi enviado no
boot? (4) O nonce é testado com replay **e** com expiração? (5) O fake responde igual ao real no
formato de erro, ou o worker só passa porque o dublê é complacente?

*T6.3* — (1) O teste de timing tem **N** amostras suficientes para significância, ou são 10
medições e uma opinião? (2) O fuzzing de prefixo cobre `/api`, `/API`, `/api/../`, `/apinfo`,
`//api`, `/%61pi`? (3) O teste de brute force chega ao teto de 100 e confirma que **existe**
caminho de recuperação? (4) Troque um dublê complacente por um adversarial: o que cai?

*T6.4* — (1) O teste de órfão mede o **neto** ou só o filho direto? (2) O `SIGKILL` no host é
mesmo `SIGKILL`, ou é `SIGTERM` com handler? (3) O teste roda só em Linux? Em Windows não há
grupo POSIX e a estratégia muda inteira (`taskkill /T /F`) — se não há caminho de Windows, o
`package.json` declara suporte só a POSIX? (4) O teste distingue `ESRCH` "processo não existe" de
`ESRCH` "não é líder de grupo"? Um filho **não**-`detached` dá `ESRCH` em `kill(-pid, 0)` por
motivo diferente.

**Aceite da Onda 6:**

| # | Verificação |
| --- | --- |
| 1 | `pnpm lint && pnpm typecheck && pnpm build && pnpm test` verde |
| 2 | `pnpm test:e2e` verde **em máquina sem rede** — se algum caso de `test/e2e/**` precisar de rede, ele está no diretório errado |
| 3 | `pnpm test:security` e `pnpm test:contract` verdes |
| 4 | `pnpm test:live` **não** roda em PR nenhum; existe e só é disparável por `workflow_dispatch` com `DSH_GUARD_LIVE_TESTS=1` |
| 5 | `pnpm test:cov`: piso global 90% linhas / 85% branches / 95% funções; e **≥95% linhas / ≥90% branches com catraca** em `src/http/**`, `src/secret/**`, `src/session/**`, `src/ratelimit/**`, `src/control/**` e `worker/auth/**` |
| 6 | **Checklist dos 50 mutantes** de `docs/mutantes.md` preenchido: cada mutante com o teste nomeado que o mata, ou com a justificativa escrita de por que não é matável. **Mutation score de ferramenta não é critério de aceite** — é job noturno, `break` desligado, não bloqueia PR |
| 7 | Zero processo remanescente após a suíte completa (`pgrep -f 'cloudflared\|fake-cloudflared\|telegram-bot'` vazio no teardown global) |

**Reaproveitamento:** as ~2100 linhas de teste atuais viram a base da suíte de regressão de T6.3 —
já cobrem 401/403, normalização de IPv6-mapeado, `isGuardedPath` separando `/api` de `/apinfo`,
propagação de disposer, reversibilidade do veto, tree-kill e `ESRCH` engolido. Nada é reescrito;
é redistribuído e ampliado.

---

## 12. ONDA 7 — Empacotamento, release e divulgação

**COMMIT PREP 7:** nada público sai antes destes cinco itens estarem no repositório.

1. **`remote origin` configurado.** É **aqui** que ele é pré-requisito — na publicação —, não na
   Onda 0. `git worktree` nunca precisou dele, e isso foi verificado neste repositório.
2. **Bloqueios duros verificados**, na ordem de `07-COMUNIDADE.md` §3: build verde contra os
   pacotes `@deepseek-ai/*` **reais** (B0, fechado na Onda 0); decisão de `dsh.bundle` aplicada e
   testada em perfil limpo (B1, fechada em T1.3); `SECURITY.md` com Private Vulnerability
   Reporting **ligado** (B6, fechado em T1.4).
3. **Nome do pacote no npm: verificação, não entrega.** A reserva (`0.0.1` stub documentado) é
   entrega de **T1.4**, na Onda 1 — o risco é name-squatting entre o primeiro anúncio e a
   publicação, e postergar a reserva até aqui só aumenta a janela. O prep apenas confere que
   `npm view dsh-guarded-bot-orchestrator version` responde.
4. **Dois contratos congelados**, porque T7.2 e T7.4 dependiam de "contrato de T7.1" e "contrato
   de T7.3" — arestas **intra-onda**, que violam a regra §0.1 (dentro da onda, as sub-tarefas são
   independentes): (i) o `exports` map e o campo `repository` do `package.json`, que T7.2 precisa
   **ler** para configurar o trusted publishing sem escrever no arquivo; (ii) o **texto-base do
   README**, que T7.4 cita no material público. Com os dois congelados, a coluna "depende de"
   dessas duas sub-tarefas passa a apontar para **PREP 7**, e não para uma irmã.
5. **`docs/PROIBIDO.md`** — criado **pelo prep**, com a lista fechada de afirmações **NÃO
   CONFIRMADAS**, tratada como gate de revisão: o limite de **50 usuários** do Zero Trust free, os
   benchmarks do `jcode`, o pacote `pi2dsh`, e a frase "quick tunnel não suporta SSE" usada como
   justificativa de decisão. Somam-se a elas todas as que os spikes da Onda 0 devolverem como
   `NAO CONFIRMADO`. Nenhuma pode aparecer em README, CHANGELOG, post ou GIF.

**Ordem de lançamento, não negociável.** `07-COMUNIDADE.md` §5 registra que o erro mais caro deste
plano é postar antes de o plugin estar no registro oficial — um post viral que leva a uma
instalação impossível só gera frustração. **Awesome-list primeiro, post depois:** T7.4 só executa
a fase pública com o PR do registro **merged**.

| id | worktree | entrega | arquivos exclusivos | depende de |
| --- | --- | --- | --- | --- |
| T7.1 | `w7-empacotamento-e-exports` | `exports` map com `types` **primeiro** e `default` **por último**, ESM-only (`require(ESM)` está desflagado em toda versão de Node suportada), `publint` + `attw --pack .` verdes, `files` correto, campo `repository` preenchido (o registro npm não vincula sem ele, e o trusted publishing exige que case exatamente), keyword **`dsh-plugin`** acrescentada, `npm sbom --sbom-format cyclonedx`. | `package.json`, `pnpm-lock.yaml`, `tsconfig.build.json` | Onda 6; **handoff de T7.2** (bloco de `devDependencies` do Changesets + script `changeset`, entregue como texto no relatório dela — T7.2 não escreve `package.json`) |
| T7.2 | `w7-release-oidc-changesets` | Changesets + workflow de publicação com **Trusted Publishing (OIDC)**: `permissions: id-token: write` só no job de publish, npm CLI ≥11.5.1, configuração por pacote em npmjs. Tokens classic foram **revogados permanentemente** em 09/12/2025 e granular tokens vivem 90 dias — OIDC é o caminho. Considerar **staged publishing** (`npm stage publish` → humano aprova com 2FA). Retry na verificação de disponibilidade (o malware scanning do publish atrasa ~5 min, até 15+ em pico). **T7.2 não escreve `package.json`**: ela entrega `.changeset/**` e `release.yml`, e a devDependency `@changesets/cli` mais o script `changeset` são aplicados por **T7.1**, que é a dona do singleton — handoff declarado, no mesmo molde do `T1.3 → T1.2` da Onda 1. | `.github/workflows/**`, `.changeset/**` | Onda 6, **PREP 7**; produz o **handoff T7.2 → T7.1** (bloco de `devDependencies` + script, como texto no relatório) — não é dependência dela |
| T7.3 | `w7-docs-usuario-final` | README reescrito respondendo às 4 perguntas do guia oficial de open source, quickstart de uma linha, seção "quando **não** usar", e **modelo de ameaça honesto** — incluindo que o TLS termina na borda da Cloudflare (arquitetonicamente eles veem o texto claro; é o que permite WAF/Access/cache), que a URL do túnel é pública, e que Access **não pode** ficar na frente de um quick tunnel. Escreve os documentos de usuário com os **nomes canônicos**: `docs/INSTALL.md`, `docs/THREAT-MODEL.md`, `docs/EXPOSURE.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/ONBOARDING-TELEGRAM.md`, `docs/TUNNEL.md`, `docs/TROUBLESHOOTING.md` — **`docs/COMPATIBILITY.md` é gerado** por `scripts/gen-compat-table.mjs` a partir do `dsh-compat.yml` e editá-lo à mão é violação. Entrega também `examples/minimal/**`, com critério de aceite `401` sem credencial / `200` com credencial e `pgrep` vazio ao fim, e o `docs/assets/demo.gif` (≤20 s, ≤4 MB, auditado frame a frame por segredo). | `README.md`, `docs/INSTALL.md`, `docs/THREAT-MODEL.md`, `docs/EXPOSURE.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/ONBOARDING-TELEGRAM.md`, `docs/TUNNEL.md`, `docs/TROUBLESHOOTING.md`, `docs/assets/**`, `examples/minimal/**`, `scripts/gen-compat-table.mjs` — **enumeração positiva**: `docs/PROIBIDO.md` é do PREP 7 e `docs/COMPATIBILITY.md` é **gerado**, nunca escrito à mão | Onda 6 |
| T7.4 | `w7-divulgacao-assets` | Entrada para o `awesome-dsh-plugin` (o **portão real**: o `dsh-market` rejeita instalação de qualquer fonte fora do registro curado), rascunho do post em "Show Your Plugins!" no formato exigido (`DSH \| Project Name \| One-line description`, com GIF de demo e explicação da integração), rascunho de Show HN factual e sem superlativo. | `docs/divulgacao/**` | Onda 6, **PREP 7** |

**Singleton `package.json`: T7.1.** **Singleton `.github/workflows/**`: T7.2.**
**Singleton `README.md`: T7.3.**
**Ordem de merge desta onda:** `T7.3 → T7.4 → T7.2 → T7.1`. T7.1 é a dona do `package.json` e
**entra por último**, como manda a regra de §13.1 — e é ela quem aplica o handoff de T7.2.

**Bloqueios verificados do registro:** o CI exige repo com **≥1 dia de idade e ≥10 commits** — o
repositório tinha 7 commits do mesmo dia quando este plano foi escrito; e lê `dsh.bundle` do
`package.json`, que T1.3/T1.2 já resolvem. Concorrência direta já listada: `dsh-webui-auth` (7★)
cobre parte da função de gate; a regra do registro é "quem chegou primeiro fica com a vaga — mas
isso é desempate, não antiguidade; a regra é qual é melhor". Diferenciais **verificáveis** a
articular: interceptação do handshake de upgrade de WebSocket, allowlist do endereço de **bind**
(distinta de `trustedRemotes`), 403-antes-de-401, veto de `danger-full-access`, worker sob
`ctx.effect()` com ambiente por allowlist, e supervisor de túnel com tree-kill real.

**Calibragem de expectativa (registrar nos assets):** no `plugins.json` do registro a **mediana é
2 estrelas** por plugin, p90 = 15, p99 = 710; só 38% publicam no npm e, entre esses, a mediana é
514 downloads/semana. No Show HN a mediana é 2 pontos e 50 pontos já é top 6%. Metas realistas,
não aspiracionais.

**Restrições éticas duras:** o HN proíbe explicitamente solicitar votos; o Product Hunt proíbe
pedir upvote (peça visita e comentário) e proíbe contas de empresa; o `awesome-dsh-plugin`
rejeita superlativos e confere cada número da descrição contra o código. Segunda chance no HN é
pelo *second-chance pool* por e-mail, nunca deletar-e-repostar.

**Perguntas falsificáveis**

*T7.1* — (1) `attw --pack .` roda contra o tarball real? (2) `types` está **antes** de `default`
no `exports`? Ordem errada faz o TS resolver o arquivo errado em silêncio. (3) `files` inclui
`dist/` e o `dist/` está no `.gitignore` — o `pnpm pack` realmente contém os artefatos?
Descompacte e confira. (4) `repository` casa **exatamente** com o repo? (5) O pacote instala num
projeto ESM **e** é consumível por `require()` no Node 22, ou só foi testado no ambiente do dev?

*T7.2* — (1) O workflow publica com OIDC ou ainda tem `NODE_AUTH_TOKEN`? (2) `--provenance` está
explícito? Há relatos de que a geração automática nem sempre basta. (3) O job de publish é o
**único** com `id-token: write`? (4) O gate de release espera disponibilidade no registro com
retry, ou falha no primeiro 404?

*T7.3* — (1) O README promete algo que o código não faz? Aponte a linha de código de cada
promessa. (2) Diz que a URL do túnel é **pública**? (3) Diz que Access não pode ficar na frente
de quick tunnel? (4) Cita algum número **NÃO CONFIRMADO** (benchmarks do `jcode`, `pi2dsh`, "50
usuários do Zero Trust free")? Nenhum pode aparecer. (5) O README ainda contém a instrução antiga
de copiar o `cordis.patch.yml`, que a Onda 1 eliminou?

*T7.4* — (1) A descrição tem superlativo? (2) Cada número citado é rastreável ao código ou a
fonte primária? (3) O título do Show HN é factual, sem editorialização e sem nome de site?
(4) Algum canal está sendo usado de forma que viola a regra publicada dele?

**Aceite da Onda 7:**

- `pnpm pack` → descompactar → import a partir do tarball funciona. O tarball **contém**
  `dist/index.js`, `dist/index.d.ts`, `dist/worker/telegram-bot.js`, `cordis.patch.yml`,
  `README.md`, `LICENSE`, `CHANGELOG.md`, e **não contém** `src/`, `types/`, `test/` nem `docs/`
  (`scripts/check-tarball.mjs` falha em qualquer dos dois sentidos).
- `publint` e `attw` sem erro.
- Repositório atende aos dois checks automáticos do registro (idade e **≥10 commits**). O piso é
  garantido pela regra §0.4 — **cada COMMIT PREP é um commit separado** —, que dá 7 de base + 8
  preps + 8 ondas = 23. Squashar prep e onda no mesmo commit quebra este item de aceite.
- **Lastro de toda afirmação numérica, verificável e não subjetivo:** toda afirmação numérica do
  README e do material de divulgação tem uma linha correspondente em `08-PESQUISA-E-FONTES.md` §8,
  com URL e data de medição. O revisor **lista as que não têm**; a lista tem que sair vazia. Isto
  substitui o critério antigo ("o revisor tenta achar uma afirmação não sustentada"), que não era
  comando nem checklist — era uma opinião com aparência de gate.
- `! grep -rniFf docs/PROIBIDO.md README.md docs/ examples/` — nenhum item da lista proibida
  aparece em material público.

---

## 13. Política de integração, rollback e replanejamento

### 13.1 Ordem de merge dentro de cada onda

Regra: **quem possui singleton entra por último**, para que os merges anteriores já estejam no
snapshot que ele vai ter que fazer compilar.

| Onda | Ordem de squash-merge |
| --- | --- |
| 0 | T0.2 → T0.3 → T0.4 → **T0.1** (singleton `package.json` + `types/`) |
| 1 | T1.4 → T1.3 → **T1.2** (`package.json`) → **T1.1** (`src/index.ts`) |
| 2 | T2.5 → T2.1 → T2.2 → T2.3 → T2.4 — **cinco** sub-tarefas, ordem **fixa**. "Qualquer ordem" não é ordem: o consumidor deste documento é literal. T2.5 entra primeiro porque T2.1 e T2.3 consomem o `StateStore` dela |
| 3 | T3.2 → T3.4 → **T3.1** (`package.json`) → **T3.3** (`src/index.ts`, `cordis.patch.yml`) |
| 4 | T4.1 → T4.4 → **T4.2** (`package.json`) → **T4.3** (`src/index.ts`) |
| 5 | T5.4 → T5.2 → T5.3 → **T5.1** (`src/index.ts`, `cordis.patch.yml`) — T5.2 e T5.3 dependem do **PREP 5**, não de T5.1, então entrar antes dela não é inversão de dependência |
| 6 | T6.1 → T6.2 → T6.4 → **T6.3** (`package.json`) |
| 7 | T7.3 → T7.4 → T7.2 → **T7.1** (`package.json`) — T7.2 entra antes porque T7.1 aplica o handoff dela (`@changesets/cli` + script `changeset`) |

### 13.2 O que faz o gate ficar vermelho (e o que se faz então)

| Sintoma | Ação |
| --- | --- |
| Gate quebra depois de um merge | A worktree responsável **volta** e corrige; as seguintes não entram enquanto isso |
| Duas sub-tarefas tocaram o mesmo arquivo | **Falha de planejamento, não de execução.** O merge é revertido, o arquivo vira singleton da onda seguinte e a segunda sub-tarefa é replanejada |
| Um spike derruba uma premissa (ex.: S1 mostra que `registerUpgrade` não existe) | A onda **para**. O orquestrador replaneja a onda seguinte antes de abrir worktrees. Nenhuma sub-tarefa "adapta por conta própria" |
| Revisão adversarial refuta uma entrega | Volta para a mesma worktree com a pergunta que a refutou anexada. Não vai para a onda seguinte |
| Uma sub-tarefa quer dependência nova numa onda sem singleton | **Para e reporta.** Não instala |

### 13.3 Replanejamento entre ondas

O `deep-orchestrator` replaneja a onda seguinte a cada fechamento. Três gatilhos obrigam
replanejamento, não apenas permitem:

1. Qualquer spike de §2 retornar **NÃO CONFIRMADO** onde o plano assumiu confirmado.
2. Qualquer arquivo listado como exclusivo revelar-se compartilhado na prática.
3. Qualquer entrega precisar de dependência de runtime não prevista — porque isso muda a
   superfície de supply chain de um componente de segurança.

---

## 14. Resumo do reaproveitamento — o que se mantém, muda e nasce

| Ativo atual (`src/index.ts`, 1836 linhas) | Destino |
| --- | --- |
| `verifyBasicAuth` (digest fixo + `timingSafeEqual`) | **MANTÉM.** Vira caminho de compatibilidade para clientes não-browser, sob o mesmo rate limit |
| `normalizeRemoteAddress`, `isTrustedRemote` | **MANTÉM** literalmente. Muda a **doutrina** (§1), não o código |
| `canonicalRequestPath`, `isGuardedPath`, `routeMayServeGuardedPath` | **MANTÉM.** Ganha `/__guard` na lista de prefixos guardados |
| `assertSecureBind` + `assertValidConfig` | **MANTÉM.** O bind continua travado em loopback — o túnel não pede que ele abra |
| `createGuardedHandler` / `createGuardedUpgradeHandler` | **MUDA.** Ganha sessão, rate limit, auditoria e validação de `Origin` no upgrade |
| `inject: ['webServer']` / `ctx.intercept('webServer', …)` | **MUDA.** Vira `httpServer`; o serviço real é `HttpServerService` |
| `import … from '@deepseek-ai/dsh-host-subprocess'` | **MUDA.** Pacote não existe; o real é `@deepseek-ai/dsh-subprocess` |
| `ctx.subprocess.spawn(cmd, args, opts)` | **MUDA.** Real: `spawn(spec)` com `argv`/`cwd`/`stdio`/`graceMs` obrigatórios |
| `createWorkerSupervisor` + backoff com jitter + tree-kill | **MANTÉM e GENERALIZA.** É a base do supervisor de `cloudflared`. As duas divergências documentadas permanecem, com os comentários |
| `buildWorkerEnv` (allowlist de env; token por env, nunca por `argv`) | **MANTÉM.** Ganha as variáveis do worker Node |
| Veto de `security/permission-elevate` | **MANTÉM**, com a ressalva honesta que já está no código |
| `cordis.patch.yml` monolítico com `id` placeholder | **MUDA.** Vira bundle (só o plugin, insert puro) + profile de exemplo (endurecimento de bind com o `id` da instalação) |
| `src/index.ts` com 1836 linhas | **MUDA.** Vira raiz de composição; o resto sai para módulos |
| `test/index.test.ts` (~2100 linhas) | **MANTÉM o conteúdo**, redistribuído 1:1 com o `src/` e ampliado em T6.3 |
| — | **NASCE:** `contracts/`, `secret/`, `session/`, `ratelimit/`, `audit/`, `tunnel/`, `panel/`, `telegram/`, `control/`, `worker/`, `bin/` |

---

## 15. Índice de worktrees (nome exato, kebab-case, ≤40 chars)

| Onda | Worktree | Sub-tarefa |
| --- | --- | --- |
| 0 | `w0-spike-api-real-dsh` | T0.1 |
| 0 | `w0-spike-cloudflared-runtime` | T0.2 |
| 0 | `w0-spike-telegram-botfather` | T0.3 |
| 0 | `w0-spike-superficie-ui-dsh` | T0.4 |
| 1 | `w1-refactor-api-e-modulos` | T1.1 |
| 1 | `w1-tooling-lint-ci-pkg` | T1.2 |
| 1 | `w1-manifesto-bundle-profile` | T1.3 |
| 1 | `w1-repo-hygiene-comunidade` | T1.4 |
| 2 | `w2-estado-persistente` | T2.5 |
| 2 | `w2-segredo-gerar-e-hash` | T2.1 |
| 2 | `w2-sessao-e-cookie` | T2.2 |
| 2 | `w2-ratelimit-e-lockout` | T2.3 |
| 2 | `w2-audit-log-append-only` | T2.4 |
| 3 | `w3-tunnel-supervisor` | T3.1 |
| 3 | `w3-tunnel-descoberta-url` | T3.2 |
| 3 | `w3-gate-integra-sessao` | T3.3 |
| 3 | `w3-painel-guard-http` | T3.4 |
| 4 | `w4-telegram-onboarding-cli` | T4.1 |
| 4 | `w4-worker-bot-grammy` | T4.2 |
| 4 | `w4-ipc-host-worker` | T4.3 |
| 4 | `w4-allowlist-e-2step` | T4.4 |
| 5 | `w5-controller-estado-unico` | T5.1 |
| 5 | `w5-superficie-telegram-onoff` | T5.2 |
| 5 | `w5-superficie-painel-onoff` | T5.3 |
| 5 | `w5-notificacao-e-auditoria` | T5.4 |
| 6 | `w6-e2e-tunnel-e-live` | T6.1 |
| 6 | `w6-e2e-telegram-fake-api` | T6.2 |
| 6 | `w6-regressao-seguranca` | T6.3 |
| 6 | `w6-ciclo-vida-e-orfaos` | T6.4 |
| 7 | `w7-empacotamento-e-exports` | T7.1 |
| 7 | `w7-release-oidc-changesets` | T7.2 |
| 7 | `w7-docs-usuario-final` | T7.3 |
| 7 | `w7-divulgacao-assets` | T7.4 |
| 5 | `w5-superficie-ui-nativa-dsh` | **T5.5 — CONDICIONAL**: só existe se o veredito de S4 (T0.4) for CONFIRMADO. Ver §2.1. Não conta para o teto de paralelismo até ser ativada |

---

## 16. COMMIT PREP — mapa consolidado

Cada **COMMIT PREP** é um commit direto na base, **antes** de qualquer worktree da onda ser
aberta. Ele existe para exatamente uma finalidade: transformar um arquivo que seria disputado por
N sub-tarefas num arquivo **somente-leitura** para todas elas. Contrato congelado no prep é a
única forma de duas sub-tarefas se acoplarem sem compartilhar arquivo — é o que sustenta o
paralelismo 4 (5 na Onda 2) de ponta a ponta.

| Prep | Antes da | O que precisa existir e estar congelado | Quem pode alterar depois |
| --- | --- | --- | --- |
| **0** | Onda 0 | `docs/spikes/.gitkeep` e `test/contract/_placeholder.test.ts`. **`remote origin` NÃO é pré-requisito da Onda 0** — `git worktree` não usa remote, verificado neste repositório; o remote subiu para o PREP 7 | infra do repo |
| **1** | Onda 1 | `types/**` corrigidos e versões **pinadas em exato** por T0.1, já mergeados; o layout de §4.2 criado como **arquivos vazios com o cabeçalho da assinatura exportada** (mais `_placeholder.test.ts` em cada diretório novo de `test/`); `docs/spikes/*` da Onda 0 legíveis com as dez linhas `VEREDITO S*:`; **a reconciliação do prefixo de rota (`/__guard`) concluída**; o vocabulário de nomes canônicos de D5 aplicado | T1.1 preenche os arquivos; ninguém muda a fronteira nem os nomes |
| **2** | Onda 2 | `src/contracts/auth.ts` (`SecretStore`, `SessionStore`, `RateLimiter`, `AuditSink`) e `src/contracts/state.ts` (`StateStore`, `PersistedState`) — assinaturas e JSDoc, **sem implementação**; **os dublês**: `test/support/{clock,ctx-double,child-double,telegram-server,state-dir}.ts` e `test/bin/fake-cloudflared.mjs`, vindos do handoff de T1.1, prep-owned a partir daqui; e `docs/spikes/deps-baseline.txt` | ninguém, em nenhuma onda |
| **3** | Onda 3 | `src/contracts/tunnel.ts`: `TunnelState` com os **seis** estados (`STOPPED \| STARTING \| READY \| DEGRADED \| STOPPING \| FAILED`), `TunnelInfo { url, startedAt, mode }`, `TunnelDiscovery` (é ele que separa T3.1 de T3.2) e `tunnel.mode`. **O modo default já está decidido** (`'quick'`, D6) e o prep não depende de S3 — S3 é entrega de T0.2 e T6.1 só re-confirma | ninguém na Onda 3 |
| **4** | Onda 4 | `src/contracts/ipc.ts`: protocolo JSON-lines host↔worker sobre stdio, tipos `intent`/`state`/`ack`/`error`, invariantes (uma mensagem por linha, UTF-8, **nenhum segredo no payload**) | ninguém na Onda 4 |
| **5** | Onda 5 | `src/contracts/control.ts`: máquina de estado (seis estados), transições legais e `ControlIntent { action, requestedBy, requestId, nonce, at }`, com o diagrama commitado junto; `ipc.ts` estendido com a mensagem `notify`; **o contrato do nonce de confirmação** (emitido e consumido no host); e **a assinatura do evento de auditoria "sessão nova"** com o ponto de chamada em `src/http/gate.ts` congelado, para que T5.4 implemente só o consumidor | ninguém na Onda 5 |
| **6** | Onda 6 | `docs/mutantes.md` com a lista fechada de 50 mutantes (coluna "teste que o mata" em branco) e a política de mutation testing: job noturno, `break` desligado, **não** bloqueia PR, runner continua `node:test`. **Não congela mais diretório de dublê** — isso é do PREP 2 | ninguém na Onda 6 |
| **7** | Onda 7 | `remote origin` configurado; bloqueios duros B0/B1/B6 verificados; nome do pacote **conferido** no npm (a reserva é de T1.4); `exports` + `repository` do `package.json` e o texto-base do README congelados, para que T7.2 e T7.4 dependam do prep e não de irmãs; `docs/PROIBIDO.md` com a lista fechada de afirmações NÃO CONFIRMADAS | ninguém na Onda 7 |

**Protocolo de violação, repetido aqui porque é onde ele é esquecido:** uma sub-tarefa que
descobre que precisa alterar um contrato congelado **para e reporta**. O orquestrador resolve no
COMMIT PREP da onda **seguinte**. Liberar o arquivo no meio da onda transforma duas worktrees
independentes em duas worktrees que vão conflitar no merge — que é precisamente o que este
documento inteiro existe para evitar.

---

## 17. Tabela-resumo das ondas

| Onda | Objetivo em uma frase | Sub-tarefas | Entregável visível ao fim |
| --- | --- | --- | --- |
| **0** | Substituir a base factual contaminada por medição de campo | 4 | Quatro relatórios em `docs/spikes/` com comando e saída bruta colada; `types/**` casando letra por letra com os tarballs npm reais |
| **1** | API real, modularização, tooling e manifesto | 4 | `pnpm lint && typecheck && build && test` verde; **nenhum arquivo acima de 400 linhas** (comando, não "~"); `dsh plugin add` num perfil limpo **ativa** a camada; nome reservado no npm |
| **2** | Primitivas de autenticação e estado, puras e sem fiação | **5** | `state/`, `secret/`, `session/`, `ratelimit/`, `audit/` com **≥95% linhas / ≥90% branches com catraca** nos módulos de decisão de segurança e **zero** dependência de runtime nova contra o baseline commitado |
| **3** | Túnel de verdade, com TTL e probe fail-closed, e o gate virando a defesa real | 4 | O supervisor sobe o `fake-cloudflared`, extrai a URL pelos **dois** caminhos, devolve **401** sem credencial e **200** com sessão; **não sobe** se qualquer das 4 sondas do probe falhar; **derruba sozinho** no TTL, invalidando as sessões |
| **4** | Telegram: onboarding guiado, worker e IPC | 4 | `dsh-guard-setup` detecta o estado e guia **só o passo faltante**; bot responde no chat do dono e morre junto com o host |
| **5** | Liga/desliga nas duas superfícies, com fonte única da verdade | 4 | Ligar pelo bot e o painel refletir; ligar pelo painel e o bot notificar — com a URL, e **sem a senha** |
| **6** | Testes de integração ponta a ponta com dublês de Telegram e de `cloudflared` | 4 | Suíte que roda offline, regressão adversarial verde, zero processo remanescente no teardown global |
| **7** | Empacotamento, release e divulgação | 4 | Pacote no npm com provenance, entrada no `awesome-dsh-plugin`, material público sem uma única afirmação não sustentada |

**Total: 8 ondas, 33 sub-tarefas.** Paralelismo máximo **5** (só na Onda 2, que tem cinco
sub-tarefas); 4 em todas as outras. O teto é a **propriedade de arquivo**, não a capacidade do
orquestrador. Parâmetros: `max-parallel=5` e `plan=off` a partir da Onda 1.

---

## 18. Checklist final — cada item do pedido, ligado à onda que o entrega

### 18.1 Os quatro itens

| Item do pedido | Onda(s) | Sub-tarefa(s) | Como se prova que foi entregue |
| --- | --- | --- | --- |
| **(a)** Instruções de como conectar no Telegram e **guiar** o usuário caso ainda não esteja conectado | **4** (motor + CLI), **7** (doc) | **T4.1** principal; T4.2 e T4.4 dão bot e allowlist; T7.3 documenta | Onboarding testado nos **4 estados** (`SEM_TOKEN`, `TOKEN_INVALIDO`, `TOKEN_OK_SEM_DONO`, `PRONTO`), cada um com asserção do **próximo passo emitido** — é sub-máquina de estados, não README. Roteiro manual **M1** de `04-TESTES.md` §9 executado |
| **(b)** Uma vez conectado, faz o tunnel pelo Cloudflare e devolve um **LINK** para acessar o próprio DSH e codificar | **3** (túnel + URL + TTL + probe), **5** (entrega) | **T3.1**, **T3.2**; entrega por **T5.1**→**T5.4**→**T5.2** e por **T5.3** | Teste que sobe o `fake-cloudflared`, extrai a URL pelos **dois** caminhos, entrega ao dono pelo chat **com o aviso de que a URL é pública** (`PWR-12`), e prova que a URL serve a Web UI do DSH atrás do gate — e que o túnel **não sobe** com o gate desarmado e **cai sozinho** no TTL. O túnel **real** é exercitado pelo roteiro manual **M2** e por `test/live/**`, nunca no gate de PR |
| **(c)** Gera uma **SENHA** que impede qualquer pessoa de se conectar sem ela, com todas as seguranças necessárias | **2** (primitivas), **3** (fiação), **5** (entrega) | **T2.1**–**T2.5**, **T3.3**, **T3.4**; exibição local por T4.1 e T5.3 | 256 bits de CSPRNG, base32 sem caracteres ambíguos, **só o `sha256` em disco** com `0600`, sessão opaca ≥128 bits em cookie `__Host-`, rate limit com teto NIST e **proibição de lockout permanente**, auditoria append-only mascarada. Prova: **401 pela URL pública** sem credencial; suíte adversarial de T6.3 verde; **a senha nunca passa pelo Telegram** (invariante de grep no gate da Onda 5). Roteiro manual **M5** |
| **(d)** **LIGAR e DESLIGAR** o server pelo bot **E** pela extensão/UI | **5** | **T5.1** (dono único do estado), **T5.2** (bot), **T5.3** (painel), **T5.4** (auditoria da ação) | `start()` concorrente das duas superfícies produzindo **um único** `cloudflared`; matar o `cloudflared` por fora faz o estado convergir em vez de mentir `READY`; toda ação no audit log com origem (`telegram:<id>` / `panel:<session>`). Roteiro manual **M3**. **Escopo desambiguado na §10**: "desligar" = desligar a **exposição**; desligar o processo DSH inteiro está **adiado**, com a razão escrita (§19) |

### 18.2 As sete exigências transversais

| Exigência do pedido | Onde vive | Onda que executa |
| --- | --- | --- |
| Documentação completa | `docs/plano/01..09` (já existe) + `README.md` e os documentos de usuário com nomes canônicos: `docs/INSTALL.md`, `THREAT-MODEL.md`, `EXPOSURE.md`, `ARCHITECTURE.md`, `TESTING.md`, `ONBOARDING-TELEGRAM.md`, `TUNNEL.md`, `TROUBLESHOOTING.md`, `PROIBIDO.md` e `COMPATIBILITY.md` (**gerado**) | **7** (T7.3); `PROIBIDO.md` é do PREP 7 |
| Já no **formato de ondas** para o `deep-orchestrator` agir | **este arquivo**: worktrees nomeadas, propriedade de arquivo exclusiva, perguntas falsificáveis e critérios de aceite como entrada literal | Ondas 0–7 |
| Maneiras de **testar tudo** | `04-TESTES.md` (pirâmide, IDs, dublês, mutação, roteiros manuais M1–M6, smoke pós-release) | **6**, com teste exigido em toda onda pelo `Definition of Done` |
| **Padrões** de como criar código com qualidade | `05-QUALIDADE-CODIGO.md` (ESM puro, disposer síncrono, sem estado global de módulo, critérios objetivos de fatiamento, anti-padrões deste domínio) | **1** (T1.1, T1.2), cobrado em todo gate |
| Como criar um **repo de qualidade** | `06-REPO-E-CI.md` (árvore, arquivos de comunidade, CI com `permissions:` mínimo, branch protection, changesets, OIDC) | **1** (T1.2, T1.4) e **7** (T7.1, T7.2) |
| **Provar/divulgar** para a comunidade | `07-COMUNIDADE.md` (posicionamento, concorrentes, bloqueios duros, fases Alpha→Beta→Público, playbook de crítica de segurança, ética, métricas calibradas) | **7** (T7.4) |
| **Quebra de arquivos** | §4.2 deste arquivo (**árvore canônica**) + os critérios de fatiamento de `05-QUALIDADE-CODIGO.md` §5.3: de **1836 linhas** num `src/index.ts` para ~50 arquivos, **nenhum acima de 400 linhas** (número exato, com comando no aceite da Onda 1), com `test/unit/` espelhando `src/` e `worker/` | **1** (T1.1), com a fronteira criada no COMMIT PREP 1 |

### 18.3 O que o revisor adversarial checa antes de declarar o projeto pronto

1. A senha aparece em **algum** log, payload IPC, mensagem do Telegram, `argv` ou frame do GIF? Se
   sim, (c) não foi entregue — independentemente de quantos testes estejam verdes.
2. Com o túnel ligado, existe **alguma** rota, fallback ou upgrade que não passa pelo gate? O
   fuzzing de prefixo de T6.3 existe para responder isso; se ele não fica vermelho quando alguém
   registra uma rota crua, ele não está provando nada.
3. Depois de `dispose()`, sobrou **algum** processo `cloudflared` ou worker? Meça com `ps`, não com
   o código de retorno.
4. `assertSecureBind`, o gate de origem, o veto de elevação e os comentários que justificam o
   tree-kill sem a guarda `!child.killed` sobreviveram intactos? **Apagar esses comentários conta
   como regressão**, mesmo com a suíte verde.
5. Algum material público repete um item de `docs/PROIBIDO.md`? E toda afirmação numérica dele
   tem linha correspondente em `08-PESQUISA-E-FONTES.md` §8, com URL e data?
6. Todo controle que `02-SEGURANCA.md` declara **normativo** tem sub-tarefa que o constrói em §5–§12
   e item de aceite que o verifica — ou está explicitamente rebaixado a **risco residual aceito**
   em `02-SEGURANCA.md` §11? Não há meio-termo: um controle descrito e não construído é pior que
   um controle ausente, porque parece ativo.

---

## 19. Itens explicitamente adiados (não são esquecimento)

Registrados para que nenhuma revisão os trate como lacuna e nenhuma sub-tarefa os pegue por conta
própria no meio de uma onda:

| Item | Por que fica de fora | O que exigiria |
| --- | --- | --- |
| Desligar o **processo DSH inteiro** pelo bot | O bot roda como filho do DSH; matar o pai mata o filho e não sobra ninguém para ouvir "religue" | Supervisor externo (unit de usuário do systemd ou equivalente), que passaria a ser o componente de **maior privilégio** do sistema, com modelo de segurança próprio |
| **Validação do header `Cf-Access-Jwt-Assertion`** (`kid`, `iss`, `aud`, `exp`) e **onboarding automatizado** de named tunnel | O onboarding exige conta Cloudflare **e** domínio com DNS na Cloudflare — não conclui sozinho. E a validação do JWT é defesa em profundidade sobre uma borda que o usuário configura fora do plugin | Onda própria (roadmap v0.2). **O transporte named está na v0.1**: `tunnel.mode: 'named'` + `tunnel.tokenFile` entregue por `--token-file`. Adiar a validação não enfraquece a linha de base porque **L4 continua obrigatório no Modo B** — nunca existirá flag "tenho Access, dispensa senha" |
| **Windows** | Todo o caminho de tree-kill, `ps` e sinais é POSIX; a suíte faz skip explícito | Onda própria com `taskkill /T /F` ou Job Object (que exige addon nativo — o Node não expõe) |
| **MFA / segundo fator** no gate | Com 256 bits de CSPRNG o brute force online é irrelevante; MFA resolveria vazamento do segredo, que é outro problema | Reavaliar se o produto sair de "um dono, uma máquina" |
| **Argon2id** no segredo | Segredo gerado por máquina com 256 bits não precisa de KDF caro, e KDF caro (19–46 MiB por tentativa) vira vetor de DoS de CPU/memória | **Obrigatório** no dia em que o usuário puder **escolher** a senha (m=19456, t=2, p=1; `crypto.argon2()` nativo desde o Node v24.7.0) |
| `node-telegram-bot-api` **v2** no lugar do grammY | Nasceu em 16/08/2026, três dias antes deste plano; zero dependências de runtime é atraente, mas risco de juventude não compensa num bot que desliga exposição | Reavaliar em ~6 meses |

---

## 20. Apêndice A — Aceite objetivo e reaproveitamento, sub-tarefa a sub-tarefa

As seções por onda trazem as perguntas falsificáveis e o aceite **da onda**. Esta tabela dá ao
orquestrador **uma linha por sub-tarefa**, com o critério que faz aquele gate específico ficar
verde e o que ela reaproveita do plugin existente. Onde a coluna diz "nada", é sub-tarefa que
constrói material novo — e isso está declarado, não escondido.

| id | worktree | critério de aceite objetivo (gate verde) | o que reaproveita |
| --- | --- | --- | --- |
| T0.1 | `w0-spike-api-real-dsh` | `pnpm typecheck` verde com os `.d.ts` extraídos dos tarballs; `sha256` de cada tarball colado no relatório; versões **exatas**, zero `^` nas deps `@deepseek-ai/*`; tabela de-para símbolo a símbolo completa | nada — é a onda que **mede** quanto do código atual sobrevive |
| T0.2 | `w0-spike-cloudflared-runtime` | Relatório com o corpo do `GET /quicktunnel` **desta execução** e a porta usada; headers que chegaram à origem (S2); WebSocket com payload nos **dois sentidos** (S3); `pgrep -f cloudflared` vazio após `SIGTERM`; checksum do binário conferido | nada |
| T0.3 | `w0-spike-telegram-botfather` | `getMe` e `getUpdates`→`chat.id` colados; **409 reproduzido**, não citado; efeito de `drop_pending_updates` medido; S5 (`apiRoot`) respondido contra servidor real; **zero token real** no texto | nada |
| T0.4 | `w0-spike-superficie-ui-dsh` | Conclusão sobre ponto de contribuição de UI baseada em `.d.ts` **e** código (ausência de doc **não** é prova); `/__guard` verificado livre; resposta explícita sobre enumerar rotas registradas | nada |
| T1.1 | `w1-refactor-api-e-modulos` | Suíte antiga (~2100 linhas) verde contra os módulos novos com **conteúdo** de teste inalterado; zero import de `@deepseek-ai/dsh-host-subprocess` no repo; **nenhum arquivo acima de 400 linhas** (número exato, verificado pelo comando de aceite da onda); `grep -rl '@deepseek-ai/' src` mostrando só `src/dsh/adapter.ts`; dublês extraídos para o handoff do PREP 2 **antes** de dissolver o `test/index.test.ts` | as ~14 funções listadas em §14: mudam de **arquivo** e de nome de serviço injetado, **não** de lógica |
| T1.2 | `w1-tooling-lint-ci-pkg` | CI **falha** com typecheck quebrado (demonstrado com job vermelho); `permissions: {}` no topo e mínimo por job; `attw --pack .` contra o **tarball**; matriz `ubuntu-latest`×24, `ubuntu-latest`×26, `macos-latest`×24 (Node 22 **fora**, porque o pacote declara `engines: >=24`); bloco de `scripts` canônico completo, incluindo `lint`; regra de lint proibindo o pacote inexistente voltar | o `tsconfig.json` atual, que `05-QUALIDADE-CODIGO.md` §2.1 recomenda **manter** |
| T1.3 | `w1-manifesto-bundle-profile` | `dsh plugin add` num perfil limpo **ativa** a camada sem `cp` manual; bundle sem `id` placeholder; README já não manda copiar arquivo; **S6 verificado no código do gate**, não na prosa do `contributing.md` | o `cordis.patch.yml` atual, separado em bundle + profile de exemplo |
| T1.4 | `w1-repo-hygiene-comunidade` | Community profile do GitHub 100%; `grep -c 'INSERT CONTACT METHOD' CODE_OF_CONDUCT.md` = 0; PVR **ligado**; templates com frontmatter válido; `LICENSE` MIT com titular real | nada — arquivos novos |
| T2.1 | `w2-segredo-gerar-e-hash` | `stat` provando `0600`; alfabeto base32 sem `0/1/8/9/O/l`; rotação **invalidando sessões vivas** em teste; teste **estatístico** de constância de tempo (N amostras, comparação de distribuição) | `timingSafeEqual` sobre digests de tamanho fixo — decisão já correta no código atual, e obrigatória porque a função **lança** com buffers de tamanhos diferentes |
| T2.2 | `w2-sessao-e-cookie` | Cookie **`__Host-dsh_sid`** + `Secure` + `HttpOnly` + `SameSite=Strict`; id **regenerado após** autenticar (anti-fixation); idle timeout (60 min) e absoluto (8 h) **medidos** com relógio injetado, não constantes nunca lidas; `mk` do link mágico com TTL 120 s, uso único e **ausente após restart** (só memória); **zero rota HTTP** nos arquivos desta sub-tarefa; caminho de bearer implementado como fallback caso S10 diga que o navegador recusa cookie `Secure` em `http://127.0.0.1` | a cascata `ctx.waterfall('http/auth-check', …)` como ponto de extensão — **nenhum caminho de decisão novo é criado** |
| T2.3 | `w2-ratelimit-e-lockout` | Atraso exponencial **antes** da comparação em tempo constante; teto de 100 com caminho de recuperação **executado** em teste; mensagem, **status** e **tempo** idênticos em todos os casos de falha; limitação por sessão/global **documentada no código** se S2 disser que não há IP | `verifyBasicAuth` passa a viver sob a mesma política de limite |
| T2.5 | `w2-estado-persistente` | Escrita atômica provada matando o processo no meio (tmp **no mesmo diretório** + `fsync` + `rename`); `chmod 644` no `state.json` faz o boot **falhar**; JSON corrompido faz o boot **falhar** com mensagem acionável, nunca "recomeça do zero"; `grep -rn 'state.json' src worker bin` mostrando **só** `src/state/**` | nada — módulo novo. É o writer único que T2.1, T2.3 e T5.1 consomem; sem ele, quatro sub-tarefas de três ondas escreveriam no mesmo arquivo sem esquema |
| T2.4 | `w2-audit-log-append-only` | `O_APPEND` verificado (não `writeFile`); regex pegando `bot\d+:[\w-]+` **dentro de URL**; comportamento com disco cheio decidido e testado como **fail-closed**; escrita concorrente sem linha parcial | a lista de mascaramento já embutida no logger atual |
| T3.1 | `w3-tunnel-supervisor` | `grep` provando **um único** bloco de backoff no repo (generalizou, não duplicou); `ENOENT` tratado por `'error'`+`'close'` e **não** por `'exit'`; orçamento zerando só após uptime saudável mínimo; **probe de 4 sondas rodando ANTES do `spawn`** e abortando a subida com o nome da sonda que falhou; **TTL** derrubando o túnel e **invalidando as sessões** sob relógio injetado, com `ttlMinutes` `0`/ausente/`>480` recusado no load; **pidfile** fazendo o boot seguinte matar o órfão registrado; `--token` **nunca** em `argv` e `--loglevel debug` proibido | o supervisor inteiro: backoff com jitter, `detached`, tree-kill real, allowlist de env, `AbortController` único, disposer síncrono LIFO |
| T3.2 | `w3-tunnel-descoberta-url` | URL extraída pelos **dois** caminhos, cada um provado com o outro desabilitado; `https://` prefixado; `--metrics 127.0.0.1:PORT` **fixado**; polling abortado no `'close'` do processo, não só no timeout | nada — módulo novo, mas consome o relatório de T0.2 |
| T3.3 | `w3-gate-integra-sessao` | **401 pela URL pública** sem credencial e 200 com sessão; upgrade recusado com `Origin` fora da **allowlist exata**; ordem 403-antes-de-401 preservada; gate continua **sem ler o corpo** da requisição | `createGuardedHandler`, `createGuardedUpgradeHandler`, `canonicalRequestPath`, `isGuardedPath`, `denyUntrustedOrigin`, `assertUsableCredential` |
| T3.4 | `w3-painel-guard-http` | `grep -rE 'https?://' src/panel/` sem host externo; `/__guard` dentro de `guardedPrefixes`; `GET /__guard/api/state` **não** responde antes do login; **tabela de isenção enumerada** — rota nova acrescentada sem tocar na tabela nasce **guardada**; `GET /__guard/secret` sem `ott` devolve 404 byte a byte igual ao de rota inexistente; `GET /__guard/magic` **não** consome nada | `isGuardedPath` e a decisão `register` vs `registerFallback` já documentada no código |
| T4.1 | `w4-telegram-onboarding-cli` | Os **4 estados** testados com asserção do próximo passo; 409 detectado e **explicado**; consumo de `getUpdates` que o worker precisaria tratado explicitamente; permissão do arquivo de token verificada com `stat` | o motor é o mesmo consumido pelo painel — **uma** implementação, duas superfícies |
| T4.2 | `w4-worker-bot-grammy` | `drop_pending_updates` no boot; 429 tratado lendo `retry_after`; 409 fazendo o processo **sair** em vez de flapping com o supervisor; `bot.catch` cobrindo `GrammyError` **e** `HttpError` | `createWorkerSupervisor` e `buildWorkerEnv` (token por env, **nunca** por `argv`, porque `/proc/<pid>/cmdline` é legível por qualquer processo local) |
| T4.3 | `w4-ipc-host-worker` | `SIGKILL` no host → worker morto em **<2 s medido**; linha JSON partida entre dois chunks reconstruída; zero segredo em qualquer mensagem do protocolo; `stdio` novo sem quebrar tree-kill nem `detached` | o supervisor e o `Config` — `worker.command`/`worker.args` continuam existindo, o que **mantém o contrato de configuração intacto** |
| T4.4 | `w4-allowlist-e-2step` | `from.id` **e** `chat.id` validados por **id numérico**; `message.from` ausente = **negação**; revalidação de identidade em **todo** `callback_query`; segundo `/parear` recusado; zero comparação por `username`; **zero validação de nonce no worker** (o nonce é do host, T5.1) | nada — módulo novo, mas alimenta o `AuditSink` de T2.4 |
| T5.1 | `w5-controller-estado-unico` | `start()` concorrente das duas superfícies produzindo **um único** `cloudflared`; `start` durante `STOPPING` **recusado** com `SHUTDOWN_IN_PROGRESS`, não enfileirado; `stop()` durante `STARTING` sem processo órfão; matar o `cloudflared` por fora fazendo o estado **convergir** (`DEGRADED` com orçamento, `FAILED` sem) em vez de mentir `READY`; nonce validado **no host**, com replay e expiração falhando; disposer LIFO com o controlador no meio da cadeia | `ctx.effect` + disposer síncrono LIFO e a re-verificação de `disposed` imediatamente antes de agendar — padrão que o supervisor atual já implementa e documenta |
| T5.2 | `w5-superficie-telegram-onoff` | `setMyCommands` publicando **exatamente** os sete comandos canônicos, nesta ordem; `answerCallbackQuery` em **todos** os caminhos, inclusive os de erro; `callback_data` dentro de 64 **bytes**; nonce consumido rejeitado no replay (validado **no host**); limite de 1 msg/s por chat respeitado sob flapping; **zero uso de `InlineKeyboardButton.style`** enquanto S7 não fechar | allowlist de T4.4, `bot.catch` + auto-retry de T4.2, protocolo IPC de T4.3, nonce de T5.1 |
| T5.3 | `w5-superficie-painel-onoff` | Mutação sem token anti-CSRF **rejeitada** (`SameSite=Strict` sozinho não basta); botão de desligar com confirmação; sessão expirada dando 401 **legível**; URL do túnel **não** revelada antes do login | painel, login e API JSON de T3.4; `canonicalRequestPath`/`isGuardedPath` mantendo `/__guard` sob o gate |
| T5.4 | `w5-notificacao-e-auditoria` | Audit log escrito **antes** da notificação (o log é a fonte da verdade; o Telegram é best-effort); Telegram fora do ar **não** bloqueia o request do usuário; notificação sem segredo, sem token e sem caminho absoluto do usuário; notificação em **toda sessão nova bem-sucedida** (não só na "primeira não reconhecida"), porque se S2 disser que não há IP confiável a definição por IP não existe | `AuditSink` de T2.4 com o mascaramento de `bot\d+:[\w-]+` já implementado; `SessionStore` e `magic.ts` de T2.2 |
| T6.1 | `w6-e2e-tunnel-e-live` | `test/e2e/**` roda **sem rede** e bloqueia PR, usando só `test/bin/fake-cloudflared.mjs`; `test/live/**` ataca pela **URL pública** com WebSocket de payload nos dois sentidos, mas **nunca** em PR e nunca no gate; `pgrep` vazio no teardown dos dois; porta **dedicada** registrada no relatório (nunca a 3080 real) | `scripts/spike/cloudflared/**` de T0.2 vira a base do harness `live`; `test/bin/fake-cloudflared.mjs` do PREP 2 é a base do `e2e` |
| T6.2 | `w6-e2e-telegram-fake-api` | Dublê (`test/support/telegram-server.ts`, prep-owned) exercitado com **429 + `retry_after`** e **409**, não só o caminho feliz; guarda que **aborta** se `TELEGRAM_BOT_TOKEN` estiver setado no ambiente de teste; descarte de updates represados provado no boot pela superfície que S8 confirmar; nonce testado com replay **e** expiração | fixtures de update do Telegram de `04-TESTES.md` §8.3; `scripts/spike/telegram/**` de T0.3 |
| T6.3 | `w6-regressao-seguranca` | Teste de timing com **N** amostras suficientes para significância, não 10 medições e uma opinião; fuzzing de prefixo cobrindo `/api`, `/API`, `/api/../`, `/apinfo`, `//api`, `/%61pi` **e** as três rotas isentas de T3.4 (que só podem furar o gate pela tabela enumerada); brute force chegando ao teto, com **corpo de resposta idêntico** o tempo todo, e caminho de recuperação executado; checklist dos 50 mutantes de `docs/mutantes.md` preenchido e assinado | os ~60 casos de gate já existentes em `test/index.test.ts` são a base — 401/403, IPv6-mapeado, `/api` vs `/apinfo`, propagação de disposer, reversibilidade do veto, tree-kill, `ESRCH` |
| T6.4 | `w6-ciclo-vida-e-orfaos` | Órfão medido no **neto**, não só no filho direto; varredura de pidfile no boot matando o órfão de execução anterior; `SIGKILL` de verdade (não `SIGTERM` com handler); `ps -o pid,ppid,pgid,sid` colado, lembrando que o adotante é o **subreaper** mais próximo (`systemd --user`), não necessariamente o PID 1; `ESRCH` de "não existe" distinguido de `ESRCH` de "não é líder de grupo" | testes de reentrância e de `dispose()` idempotente que já existem para o worker — estendidos, não reescritos |
| T7.1 | `w7-empacotamento-e-exports` | `attw --pack .` contra o **tarball**; `types` **antes** de `default` no `exports`; `pnpm pack` descompactado contendo `dist/` de verdade; `repository` casando **exatamente** com o repo (o trusted publishing exige) | `tsconfig*.json` e o gate de lint/CI de T1.2; a decisão de manifesto de T1.3 |
| T7.2 | `w7-release-oidc-changesets` | Publicação por **OIDC**, sem `NODE_AUTH_TOKEN`; `id-token: write` **só** no job de publish; retry na verificação de disponibilidade no registro (o scan de malware atrasa ~5 min, até 15+ em pico); PR sem changeset **reprovado** | `ci.yml` de T1.2 como base de estrutura e de política de `permissions:` |
| T7.3 | `w7-docs-usuario-final` | Cada promessa do README apontando para a linha de código que a cumpre; diz que a **URL é pública** e que **Access não pode** ficar na frente de quick tunnel; zero número NÃO CONFIRMADO; instrução antiga de copiar o `cordis.patch.yml` **removida** | `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` de T1.4; os relatórios de spike da Onda 0 viram a seção de compatibilidade |
| T7.4 | `w7-divulgacao-assets` | Zero superlativo; cada número rastreável a código ou fonte primária; título de Show HN factual e sem editorialização; nenhuma regra publicada de canal violada (HN proíbe pedir voto; Product Hunt proíbe pedir upvote e contas de empresa) | os relatórios de spike da Onda 0 são o **ativo de credibilidade** do anúncio (`07-COMUNIDADE.md` §3.1): corrigimos a documentação upstream antes de escrever a primeira linha |

---

## 21. Arquivos irmãos

| Arquivo | O que traz que este não traz |
| --- | --- |
| `00-INDICE.md` | Porta de entrada: status do plano, mapa dos arquivos, resumo das ondas, riscos, spikes e ordem de leitura por perfil |
| `01-ARQUITETURA.md` | Componentes, fronteiras, decisão in-process vs subprocesso, máquina de estados detalhada, propagação do link |
| `02-SEGURANCA.md` | Modelo de ameaça completo, decisões de credencial, o que nunca vai pelo Telegram |
| `04-TESTES.md` | Como testar cada coisa, dublês, critérios de cobertura e mutação |
| `05-QUALIDADE-CODIGO.md` | Convenções, tsconfig, quebra de arquivos, erros, lint |
| `06-REPO-E-CI.md` | Workflows, branch protection, release, supply chain |
| `07-COMUNIDADE.md` | Posicionamento, canais, textos-modelo, métricas |
| `08-PESQUISA-E-FONTES.md` | Todas as fontes primárias, com o que foi verificado e o que não foi |
| `09-DECISOES-CANONICAS.md` | **Árbitro.** D1–D29: quando dois arquivos divergem, vale este. A árvore canônica, os scripts, os nomes, o gate |

---
