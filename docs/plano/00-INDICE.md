# 00 — ÍNDICE DO PLANO

**Plugin `dsh-guarded-bot-orchestrator` para o DeepSeek Harness.** O usuário pediu quatro
capacidades: **(a)** guiar quem ainda não conectou o Telegram, passo a passo; **(b)** com o
Telegram conectado, subir o túnel Cloudflare e devolver o **link** para acessar o próprio DSH e
codificar do celular; **(c)** gerar uma **senha** que impede terceiros de entrar na máquina, com as
seguranças que isso exige; **(d)** **ligar e desligar** o servidor pelo **bot** e pela **UI**. Mais:
documentação completa, em **ondas** consumíveis pelo `deep-orchestrator`, com maneiras de testar,
padrões de código, como fazer um repositório de qualidade, como divulgar, e a quebra dos arquivos.
**Esta rodada entrega apenas o plano — nenhuma linha de implementação.**

---

## NOTA DE STATUS — leia antes de qualquer coisa

**O DeepSeek Harness é real e foi confirmado por verificação HTTP direta**, não por memória:
`deepseek-ai/deepseek-harness`, licença **MIT**, **166.821 estrelas**, push recente
(`https://api.github.com/repos/deepseek-ai/deepseek-harness`). Há **instância rodando nesta máquina
em `127.0.0.1:3080`**. Os pacotes `@deepseek-ai/cordis@4.0.1`, `dsh-host-webserver`,
`dsh-subprocess`, `dsh-subprocess-local` e `dsh-host-frontend-static` respondem 200 no npm e os
`.d.ts` foram lidos dos tarballs.

**MAS os documentos de origem erram nomes de pacote e assinaturas.** Quatro erros, catalogados como
**E1–E4** em `09-DECISOES-CANONICAS.md` §0:

| id | o que os documentos de origem dizem | o que existe de verdade |
| --- | --- | --- |
| **E1** | `@deepseek-ai/dsh-host-subprocess` | **404 no npm.** É `@deepseek-ai/dsh-subprocess` (+ `-local`) |
| **E2** | `ctx.webServer`, tipo `WebServer`, `inject: ['webServer']` | `ctx.httpServer`, classe `HttpServerService`. O símbolo `WebServer` **não existe**. `WebRoute` existe e permanece |
| **E3** | `spawn(cmd, args, opts)` | `spawn(spec: SubprocessSpawnSpec)` — objeto único, com `argv`, `cwd`, `stdio`, `graceMs` obrigatórios |
| **E4** | `dsh-host-frontend` | `@deepseek-ai/dsh-host-frontend-static` |

**Consequência prática, em duas partes:**

1. **Este plano já usa os nomes reais** em toda prescrição. Os nomes errados só aparecem em coluna
   "errado" de tabela de correção e como **alvo de asserção negativa** nos testes de contrato
   (`04-TESTES.md` §5.8, `CONTRACT-001…009`).
2. **O plugin que já existe neste repositório não compila contra o DSH real.** Ele importa E1,
   injeta E2 e chama E3. Corrigir isso é a **primeira entrega da Onda 1** (T1.1), e a Onda 0 existe
   inteira para medir a API antes de reescrever qualquer linha. Não rode o plugin atual contra a
   instância de `127.0.0.1:3080` esperando que funcione.

A camada **conceitual** dos documentos de origem bateu com o código (`intercept`, `waterfall`,
`effect`, fibers, disposers LIFO). A camada de **API** não bateu. É essa assimetria que define o
escopo da Onda 0.

---

## Os arquivos

| Arquivo | O que responde | Para quem | Linhas |
| --- | --- | --- | ---: |
| `00-INDICE.md` | Onde entrar, o que já é fato, o que ainda é pergunta | todos | 188 |
| `01-ARQUITETURA.md` | Componentes e fronteiras; host × worker; máquina de estados; propagação do link; link mágico de uso único | implementador, revisor | 1444 |
| `02-SEGURANCA.md` | Modelo de ameaça (T1–T10), camadas L0–L8, o que **nunca** vai pelo Telegram, risco residual assumido | revisor de segurança, implementador | 1629 |
| `03-ONDAS.md` | **O plano executável.** 8 ondas, 33 sub-tarefas, worktree e posse de arquivo por sub-tarefa, COMMIT PREPs, aceite objetivo por onda | **orquestrador** (entrada literal) | 1670 |
| `04-TESTES.md` | Pirâmide, ~500 casos com id, dublês, mutação, roteiros manuais M1–M7, smoke pós-release | implementador, revisor | 2068 |
| `05-QUALIDADE-CODIGO.md` | ESM puro, disposer síncrono, sem estado global, critérios de fatiamento, erros tipados, anti-padrões deste domínio | implementador | 1339 |
| `06-REPO-E-CI.md` | Árvore do repositório, workflows, 12 required checks, branch protection, changesets, release por OIDC | implementador, revisor | 1444 |
| `07-COMUNIDADE.md` | Posicionamento, bloqueios duros antes de divulgar, fases Alpha→Beta→Público, playbook de crítica de segurança, ética | dono do projeto | 966 |
| `08-PESQUISA-E-FONTES.md` | Todas as fontes primárias, o que foi verificado e o que **não** foi. É o ledger dos números | revisor | 1202 |
| `09-DECISOES-CANONICAS.md` | **O árbitro.** D1–D29. Quando dois arquivos divergem, vale este | **orquestrador**, revisor | 1097 |

> Regra de precedência: **09 decide**, **03 é o que o orquestrador executa**, os demais descrevem.
> Se 05 e 06 mostrarem uma árvore diferente da de 09 §D1, os errados são 05 e 06.

---

## As oito ondas

| # | Nome | Objetivo em uma linha | Entregável visível ao fim |
| --- | --- | --- | --- |
| **0** | Reconhecimento | Trocar base factual contaminada por medição de campo | 4 relatórios em `docs/spikes/` com comando e saída colada; `types/**` casando letra por letra com os tarballs npm; `CONTRACT-001…009` verdes |
| **1** | Fundação | API real, modularização, tooling, manifesto em duas camadas | Gate verde; **nenhum arquivo acima de 400 linhas**; `dsh plugin add` ativa a camada num perfil limpo; nome reservado no npm |
| **2** | Primitivas de auth e estado | Segredo, sessão, rate limit, auditoria e o único writer do estado — puros, sem fiação | ≥95% linhas / ≥90% branches **com catraca** nos módulos de decisão de segurança; **zero** dependência de runtime nova |
| **3** | Túnel e gate | Túnel de verdade com TTL e probe fail-closed; o gate vira a defesa real | Sobe o `fake-cloudflared`, extrai a URL pelos **dois** caminhos, **401** sem credencial e **200** com sessão; não sobe se qualquer das 4 sondas falhar; cai sozinho no TTL |
| **4** | Telegram | Onboarding guiado, worker em processo separado, IPC e allowlist | `dsh-guard-setup` detecta o estado e guia **só o passo faltante**; bot responde no chat do dono e morre junto com o host |
| **5** | Liga/desliga | As duas superfícies contra uma fonte única da verdade | Ligar pelo bot e o painel refletir; ligar pelo painel e o bot notificar — com a URL e **sem a senha** |
| **6** | Integração ponta a ponta | Suíte offline com dublês de Telegram e de `cloudflared` | Suíte que roda sem rede, regressão adversarial verde, **zero** processo remanescente no teardown |
| **7** | Empacotamento e divulgação | Release reprodutível e material público sustentado | Pacote no npm com provenance, entrada no `awesome-dsh-plugin`, nenhuma afirmação sem lastro |

**Paralelismo máximo 5** (só na Onda 2, que tem 5 sub-tarefas; as outras têm 4). O teto é a
**propriedade de arquivo**, não a capacidade do orquestrador.

---

## Checklist das quatro capacidades

| Capacidade pedida | Onda que entrega | Sub-tarefas | Como se prova |
| --- | --- | --- | --- |
| **(a)** guiar a conectar o Telegram | **4** (motor + CLI), **7** (doc) | T4.1 principal; T4.2 e T4.4 dão bot e allowlist; T7.3 documenta | Onboarding testado nos **4 estados** (`SEM_TOKEN`, `TOKEN_INVALIDO`, `TOKEN_OK_SEM_DONO`, `PRONTO`), cada um com asserção do próximo passo emitido. `TG-060…072`, `PAIR-001…010`, roteiro **M1** |
| **(b)** túnel + link para codificar | **3** (túnel), **5** (entrega) | T3.1, T3.2; entrega por T5.1→T5.4→T5.2 e por T5.3 | `TUN-001…026`, `SUP-001…015`; a URL chega ao dono com o aviso de que é pública; túnel real só em `test/live/**` e no roteiro **M2** |
| **(c)** senha que impede terceiros | **2** (primitivas), **3** (fiação), **5** (entrega) | T2.1–T2.5, T3.3, T3.4 | 256 bits de CSPRNG, base32 sem ambíguos, **só o digest em disco** `0600`, sessão opaca em cookie `__Host-`, rate limit com teto NIST, auditoria append-only. `SECRET-001…018`, `SESS-001…010`, `RL-001…018`, `PANEL-001…010`, §6 inteira, roteiro **M5** |
| **(d)** ligar/desligar pelo bot **e** pela UI | **5** | T5.1 (dono único do estado), T5.2 (bot), T5.3 (painel), T5.4 (auditoria) | `CTL-001…040` — com **CTL-040** exigindo paridade das superfícies — `LIFE-001…023`, `TG-080…089`, roteiro **M3** |

> **Desvio declarado.** O pedido diz "extensão/UI". O plano entrega um **painel próprio** em
> `/__guard`, servido pelo plugin, porque o spike **S4** (existe ponto de contribuição de UI para
> plugins no DSH?) está aberto. Se S4 der positivo, nasce a sub-tarefa condicional **T5.5
> `w5-superficie-ui-nativa-dsh`** e o painel **continua existindo** — é a única superfície que
> sobrevive a uma troca de versão do host. Ver `03-ONDAS.md` §2.1.
>
> **Escopo de "desligar".** Desligar = derrubar a **exposição** (túnel + sessões). Desligar o
> processo DSH inteiro está **adiado**, com a razão escrita em `03-ONDAS.md` §19.

---

## Os cinco riscos principais

1. **Prompt injection não tem defesa confiável** (>85% de sucesso contra defesas estado-da-arte) e o
   agente lê conteúdo hostil como parte do trabalho normal — o veto de elevação reduz o dano, não
   fecha a porta.
2. **O agente pode abrir o próprio túnel e exfiltrar pela saída**, e nada neste plano impede,
   detecta ou audita isso: todos os controles temporais vigiam só o túnel do plugin. **Aceito, não
   mitigado** (`02-SEGURANCA.md` §11 #12).
3. **Quem tem a senha tem shell.** Não há segundo fator no Modo A (quick tunnel), e com o link
   mágico ligado o **canal do Telegram vira raiz de autenticação equivalente à senha**.
4. **O ecossistema DSH inteiro está em `rc`**, com o README oficial avisando "expect breaking
   changes": uma atualização pode renomear o serviço interceptado e **desarmar o gate em silêncio**.
   A rede de proteção é o teste de fumaça que prova 401 anônimo, mais os testes de contrato.
5. **`state.json` em `0600` não é secrets management**, e `SIGKILL` no processo do DSH deixa o
   `cloudflared` órfão até a varredura do boot seguinte. Janela real, mesmo com pidfile.

Lista completa e sem corte: `02-SEGURANCA.md` §11 (13 itens).

---

## Spikes obrigatórios antes de codar

Nenhuma sub-tarefa de implementação pode assumir estes pontos como fato. Todos estão em
`03-ONDAS.md` §2, com o mapa `S* → T*` que diz quem fecha cada um.

| Spike | Pergunta | Fecha em | Se falhar |
| --- | --- | --- | --- |
| **S1** | `HttpServerService` expõe mesmo `register`, `registerFallback`, `registerUpgrade`? Qual a forma exata de `SubprocessSpawnSpec`? | T0.1 | O refactor da Onda 1 muda de escopo; o orquestrador replaneja. `registerUpgrade` é **bloqueador de segurança** |
| **S2** | O `cloudflared` repassa `CF-Connecting-IP`/`X-Forwarded-For` — e esse valor é **controlável pelo cliente**? | T0.2 | Rate limit por IP fica impossível ou forjável; `trustEdgeHeaders` trava em `false` e a limitação vai para o README |
| **S3** | O WebSocket de telemetria atravessa um quick tunnel com tráfego bidirecional? | T0.2 | Quick tunnel deixa de ser o modo padrão e a exposição por túnel fica bloqueada até haver onda própria |
| **S4** | A UI/extensão do DSH tem ponto de contribuição para plugins? | T0.4 | Fallback já é o desenho assumido: painel `/__guard` |
| **S5** | O grammY aceita `apiRoot` apontando para uma Bot API local? | T0.3 | Plano B: transporte falso na camada de rede do worker |
| **S6** | O CI do `awesome-dsh-plugin` aceita `dsh.bundle` sem a subchave `patch`? | T1.3 (embutido, 1ª hora) | Bundle mínimo com patch próprio |
| **S7** | `InlineKeyboardButton.style` existe mesmo na Bot API? | T0.3 | O teclado vai sem `style`; a semântica fica no **texto** do botão |
| **S8** | `drop_pending_updates` é de `getUpdates` ou só de `setWebhook`? | T0.3 | Descarte por `getUpdates` inicial com `offset: -1`, documentado |
| **S9** | Existe caminho canônico de diretório de estado por plugin no DSH? | T0.1 | Fica o default XDG, com o caminho vindo da config |
| **S10** | Navegador aceita cookie `__Host-`/`Secure` emitido por `http://127.0.0.1:3080`? | T0.4 | Painel local autentica por `Authorization`; o cookie só existe sob o túnel |
| **S11** | `crypto.argon2()` existe nativamente no Node da matriz (≥24.7)? | T0.1 | O caminho "senha escolhida pelo usuário" continua fora de escopo |

Além dos spikes, quatro alegações estão **proibidas** como fato em qualquer entrega: o limite de 50
usuários do Zero Trust free, os benchmarks do `jcode`/`pi2dsh`, "quick tunnel não suporta SSE"
(refutada empiricamente) e "quem tem o token do bot contorna a allowlist" (falsa neste desenho).

---

## Como executar

O único arquivo que o orquestrador consome literalmente é **`03-ONDAS.md`**.

```
/deep-orchestrator plan=off max-parallel=5 \
  Execute o plano de /home/ondokai/Projects/deepseek-harness-mobile/docs/plano/03-ONDAS.md \
  onda por onda, do COMMIT PREP 0 à Onda 7. Use a coluna `worktree` como nome exato de cada \
  worktree, a coluna `arquivos exclusivos` como fronteira de escrita, e a coluna `depende de` \
  como ordem. Antes de cada onda, aplique o COMMIT PREP dela como commit próprio. Ao fim de \
  cada sub-tarefa, rode o gate `pnpm lint && pnpm typecheck && pnpm build && pnpm test` no \
  snapshot depois de cada squash-merge, na ordem de merge declarada em §13.1. Quando dois \
  documentos divergirem, vale 09-DECISOES-CANONICAS.md.
```

Regras que não podem ser negociadas em tempo de execução:

- **Gate**, sempre nesta ordem: `pnpm lint && pnpm typecheck && pnpm build && pnpm test`.
  `test:security`, `test:contract` e `test:e2e` são aceite **de onda**, não de merge. `test:live`
  **nunca** é gate.
- **COMMIT PREP é commit próprio**, separado do commit da onda. Squashar os dois é violação de
  processo (e derruba o piso de ≥10 commits que o `awesome-dsh-plugin` exige).
- Uma sub-tarefa que precise tocar arquivo fora da coluna `arquivos exclusivos` **para e reporta**.
  Não negocia com a irmã.

---

## Ordem de leitura por perfil

| Perfil | Leia nesta ordem | Pode pular |
| --- | --- | --- |
| **Orquestrador / agente executor** | `03` inteiro → `09` (é o desempate) → `04` §13 (aceite por onda) | 07 |
| **Implementador de sub-tarefa** | `00` → a seção da sua onda em `03` → `09` D1/D4/D5 → `05` → a seção correspondente de `04` → `01` para a fronteira que você toca | 07, 08 |
| **Revisor adversarial** | `02` inteiro → `04` §6 e §7 → `08` (para checar se o número tem lastro) → `03` §18.3 | 06 §4 |
| **Revisor de segurança** | `02` → `01` §7 e §9.5 → `04` §5.7, §5.9 e §6 → `02` §11 (o que ficou aceito) | 06, 07 |
| **Dono do projeto / divulgação** | `00` → `07` → `06` §4 → `docs/PROIBIDO.md` (quando existir) | 04, 05 |
| **Quem só quer entender o desenho** | `00` → `01` §3 e §6 → `02` §1 e §11 | o resto |
