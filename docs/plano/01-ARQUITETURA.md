# 01 — Arquitetura da solução

> Parte do plano em `docs/plano/`. Este arquivo define **o quê** e **por quê**.
> As ondas de execução (`03-ONDAS.md`), o modelo de ameaça e o tratamento de segredos
> (`02-SEGURANCA.md`), a estratégia de testes (`04-TESTES.md`), os padrões de código
> (`05-QUALIDADE-CODIGO.md`), o repositório/CI (`06-REPO-E-CI.md`), a divulgação
> (`07-COMUNIDADE.md`) e o rastro de fontes (`08-PESQUISA-E-FONTES.md`) vivem nos
> arquivos irmãos. Nada aqui é implementação: são decisões, fronteiras e critérios.

---

## 1. Visão geral

O objetivo é permitir que o dono da máquina use a Web UI do DeepSeek Harness (DSH) para
codificar a partir do celular, **sem abrir nenhuma porta de entrada no firewall e sem
alargar o bind para além do loopback**. O plugin que já existe neste repositório
(`dsh-guarded-bot-orchestrator`) é o portão HTTP do plano de controle: intercepta (hoje: dsh-guard-messenger)
`register` / `registerFallback` / `registerUpgrade`, exige credencial, recusa origens
fora da allowlist, trava o bind em `127.0.0.1` com falha ruidosa no load, veta elevação
de permissão e supervisiona um subprocesso de longa duração com tree-kill real. A
evolução planejada **mantém tudo isso** e acrescenta quatro peças: um **supervisor de
`cloudflared`** que abre um túnel de saída apontado para `127.0.0.1:<porta do DSH>`; um
**serviço de bot do Telegram** que é a superfície de comando remota (onboarding guiado,
ligar/desligar, entrega do link); uma **máquina de estados** que é a fonte única da
verdade do sistema; e uma **superfície de controle local** (rotas `/__guard/*` + painel
mínimo) que faz exatamente o mesmo que o bot, contra a mesma máquina de estados. O ponto
de partida honesto: o DSH nunca passa a escutar na internet — quem escuta continua sendo
`127.0.0.1`, e o `cloudflared` se conecta a ele como qualquer cliente local.

---

## 2. Fluxo completo (diagrama)

```
   CELULAR DO DONO                        │  MÁQUINA DO DONO — nenhuma porta de ENTRADA aberta
  ┌──────────────────┐                    │
  │   App Telegram   │                    │  ┌──────────────────────────────────────────────┐
  │  (chat com o bot)│                    │  │  Processo DSH (Node)                         │
  └────────┬─────────┘                    │  │                                              │
           │ (1) /ligar                   │  │  ┌────────────────────────────────────────┐  │
           v                              │  │  │ PLUGIN dsh-guarded-bot-orchestrator    │  │
  ┌──────────────────┐                    │  │  │ (Fiber Cordis; disposers LIFO)         │  │
  │ api.telegram.org │                    │  │  │                                        │  │
  └────────┬─────────┘                    │  │  │   ┌────────────────────────────────┐   │  │
           │ (2) long polling             │  │  │   │  StateMachine                  │   │  │
           │     getUpdates timeout=50     │  │  │   │  FONTE ÚNICA DA VERDADE        │   │  │
           │     (conexão de SAÍDA)        │  │  │   │  seq monotônico + persistência │   │  │
           v                              │  │  │   └───┬────────────┬───────────┬───┘   │  │
  ┌────────────────────────────┐  (3) JSONL  │  │       │            │           │       │  │
  │ SUBPROCESSO bot-telegram   │<== stdin ===│==│=======┤            │           │       │  │
  │ Node + grammY, detached,   │             │  │       │            │           │       │  │
  │ env por ALLOWLIST          │=== stdout ==│==│=====> │            │           │       │  │
  │ (sem senha do gate)        │             │  │  ┌────v─────┐ ┌────v──────┐ ┌──v─────┐ │  │
  └────────────────────────────┘             │  │  │ BotBridge│ │  Tunnel   │ │ Rotas  │ │  │
                                             │  │  │  (codec) │ │ Supervisor│ │/__guard │ │  │
                                             │  │  └──────────┘ └────┬──────┘ └──┬─────┘ │  │
                                             │  │                    │           │       │  │
                                             │  │   ┌────────────────v───────────v────┐  │  │
                                             │  │   │ GATE HTTP (JÁ EXISTE)          │  │  │
                                             │  │   │ intercept register /           │  │  │
                                             │  │   │ registerFallback /             │  │  │
                                             │  │   │ registerUpgrade                │  │  │
                                             │  │   └───────────────┬────────────────┘  │  │
                                             │  └───────────────────│───────────────────┘  │
                                             │   servidor HTTP do DSH v bind 127.0.0.1:3080│
                                             │  ┌─────────────────────────────────────────┐│
                                             │  │ (4) HTTP em LOOPBACK — não é rede        ││
                                             │  │  ┌───────────────────────────────────┐   ││
                                             │  │  │ SUBPROCESSO cloudflared           │   ││
                                             │  │  │  tunnel --url http://127.0.0.1:P  │   ││
                                             │  │  │  --metrics 127.0.0.1:M            │   ││
                                             │  │  └─────────────────┬─────────────────┘   ││
                                             │  └────────────────────│─────────────────────┘│
                                             └───────────────────────│──────────────────────┘
                                                                     │ (5) conexão de SAÍDA
                                                                     v    (QUIC/TLS)
                                                          ┌────────────────────────┐
                                                          │  Borda da Cloudflare    │
                                                          │  https://xxx.trycloud… │
                                                          └───────────┬────────────┘
                                                                      │ (6) dono abre o link
                                                                      v
                                                          ┌────────────────────────┐
                                                          │ Browser do celular      │
                                                          │ (7) 401 → senha → Web UI│
                                                          └────────────────────────┘

  Sequência:
   (1) dono manda /ligar no Telegram          (5) cloudflared registra o túnel na borda
   (2) bot recebe por long polling            (6) plugin lê a URL em /quicktunnel do metrics
   (3) bot envia a INTENÇÃO ao plugin (JSONL)     local e devolve ao bot, que envia ao dono
   (4) plugin faz spawn do cloudflared        (7) browser bate no GATE e é desafiado
```

Duas leituras que atravessam o diagrama inteiro:

- **A seta (4) é loopback.** O DSH não muda de bind. O `cloudflared` é só mais um cliente
  em `127.0.0.1`. Confirmado na documentação da Cloudflare: *"cloudflared initiates an
  outbound connection through your firewall from the origin to the Cloudflare global
  network"*.
- **As setas (2) e (5) são de saída.** Nenhum componente deste plano escuta em porta
  pública. O corolário desagradável está na §4: firewall de INPUT deixa de ser proteção.

---

## 3. Componentes e fronteiras

| # | Componente | Onde roda | Confia em | Nunca faz |
| - | ---------- | --------- | --------- | --------- |
| a | Plugin DSH (TypeScript) | Fiber Cordis, dentro do processo `dsh` | Config do `cordis.patch.yml` e nada mais | Ler input da internet diretamente |
| b | Serviço do bot Telegram | Subprocesso `detached`, env por allowlist | Comandos cujo `from.id` está na allowlist | Decidir estado; executar ação; ver o segredo do gate |
| c | Supervisor do `cloudflared` | Módulo dentro de (a), faz `spawn` | `/quicktunnel` do metrics local | Usar scraping de log como fonte primária |
| d | Gate de autenticação HTTP | Módulo dentro de (a) | Credencial + política de exposição | Confiar em `X-Forwarded-*` / `Cf-*` sem modo explícito |
| e | UI/extensão liga-desliga | Rotas `/__guard/*` servidas por (a) | O mesmo gate de (d) | Manter estado próprio |

### (a) Plugin DSH — o núcleo

É o único componente com autoridade. Detém a máquina de estados, a persistência, o gate
HTTP e os dois supervisores de subprocesso. Fronteira dura: **toda decisão de segurança
acontece aqui e só aqui**. O bot não tem lógica de autorização de ação — tem apenas
verificação de identidade de remetente, que é defesa em profundidade e não a principal.

O nome do pacote se mantém `dsh-guarded-bot-orchestrator` (o nome no npm foi verificado
como livre: `https://registry.npmjs.org/dsh-guarded-bot-orchestrator` responde 404).
Renomear nesta fase custa histórico e não compra nada.

### (b) Serviço do bot Telegram

Processo separado que faz long polling contra `api.telegram.org` e traduz mensagens em
comandos estruturados. Reaproveita `createWorkerSupervisor` com duas mudanças: o
`command` deixa de ser `python3 bot_long_polling.py` e passa a ser o runtime Node com um
entrypoint próprio, e o `stdio` passa de `['ignore','pipe','pipe']` para
`['pipe','pipe','pipe']` para abrir o canal de comando.

Biblioteca recomendada: **grammY** (1.45.1 em 17/07/2026, ~3,15M downloads/semana,
suporte a Bot API 10.2 dois dias após o anúncio, tipos nativos com narrowing por filter
query, plugin oficial de auto-retry que lê `retry_after` do 429). `telegraf` está
efetivamente morto (último release fev/2024, último commit jan/2025, sem suporte a Bot
API 8/9/10). `node-telegram-bot-api` v2.0.0 (16/08/2026) é uma reescrita em TypeScript
com zero dependências de runtime — tecnicamente atraente, mas tinha três dias de idade
no momento da pesquisa; reavaliar em ~6 meses, não adotar agora num componente que
liga e desliga exposição.

Fronteira dura: **o bot não tem o segredo do gate**. `buildWorkerEnv` já corta tudo que
não está na `WORKER_ENV_ALLOWLIST` e injeta só `TELEGRAM_BOT_TOKEN`. Essa propriedade
precisa sobreviver intacta, porque o bot é literalmente um consumidor de input arbitrário
da internet. A `WORKER_ENV_ALLOWLIST` atual é orientada a Python (`PYTHONHOME`,
`PYTHONPATH`, `PYTHONUNBUFFERED`, …); com o worker em Node, essas chaves deixam de ser
necessárias e as de Node (`NODE_OPTIONS` em particular) **não** devem ser adicionadas —
`NODE_OPTIONS` permite injetar `--require`, ou seja, carga de código arbitrário no filho.

### (c) Supervisor do `cloudflared`

Segunda instância do mesmo padrão de supervisão, com um conceito de prontidão diferente:
o worker do bot está pronto quando nasce; o `cloudflared` só está pronto quando a URL
existe. Isso exige um passo de *readiness* que o supervisor atual não tem (§7).

Três regras de kill que a implementação precisa respeitar, com as ressalvas que a
pesquisa produziu:

1. `spawn` sempre com `detached: true`, porque é isso que torna o filho líder de um novo
   grupo e sessão (`setsid(2)`, documentado). Só se faz `process.kill(-pid, …)` em PID
   que **nós** criamos com `detached: true`. Fazer isso num filho não-detached é errado
   por dois motivos: normalmente falha com `ESRCH` (o `pid` não é um `pgid`), e no caso
   patológico pode acertar um **grupo alheio** se o número coincidir com um `pgid`
   existente por reúso de PID.
2. A afirmação de que "`child.kill()` nunca basta quando há shell no meio" foi **refutada
   experimentalmente**: com `shell: '/bin/bash'` o bash aplica a otimização de `exec` do
   último comando e frequentemente não deixa processo intermediário — `child.kill()` mata
   o processo real. Com `shell: true` (que resolve para `/bin/sh`/dash na máquina medida)
   o intermediário existe e o neto sobrevive. Conclusão prática: **não spawnar via shell**
   e usar `detached` + kill de grupo, que é a única técnica que não depende de qual shell
   está instalado.
3. A afirmação de que `process.kill(-process.pid)` mataria o supervisor também é
   **condicional** — só é verdade se o processo do supervisor for líder do próprio grupo.
   Não é razão para evitar kill de grupo; é razão para nunca usar `-process.pid` e sempre
   usar o `pid` do filho detached.

Fronteira dura: no modo *quick tunnel* não toca em configuração da Cloudflare nem escreve
em `~/.cloudflared` (verificado: após duas execuções completas o diretório não foi
criado). No modo *named tunnel*, o plugin **lê** um token de arquivo; nunca o cria nem o
escreve.

### (d) Gate de autenticação HTTP

Já existe e permanece. O que muda é a **política**, não o mecanismo — ver §4. Os detalhes
de entropia do segredo, armazenamento, rate limiting e lockout estão em `02-SEGURANCA.md`.

### (e) UI/extensão liga-desliga

Um conjunto pequeno de rotas registradas pelo próprio plugin:

**Tabela canônica de rotas do plugin — política por rota (normativa; qualquer rota `__*`
que não esteja aqui é bug de revisão).** O prefixo canônico é **`/__guard`**, decidido no
COMMIT PREP 3 de `03-ONDAS.md`. Os nomes `/__mobile` e `/__gate` que circularam em versões
anteriores deste plano estão **mortos** e não podem reaparecer em código, teste ou doc.

| Rota | Método | Política | Quem serve |
| ---- | ------ | -------- | ---------- |
| `/__guard/` | GET | **guardada** (sessão ou Basic) | painel HTML mínimo, sem build, sem CDN |
| `/__guard/api/state` | GET | **guardada** | estado atual em JSON (polling de 2 s do painel) |
| `/__guard/api/login` | POST | **exceção declarada** — é onde a credencial é apresentada; sob rate limit da L5 | emite sessão |
| `/__guard/api/tunnel/start` | POST | **guardada** + CSRF + nonce | pedido idempotente de LIGAR |
| `/__guard/api/tunnel/stop` | POST | **guardada** + CSRF | pedido idempotente de DESLIGAR |
| `/__guard/magic` | GET, POST | **exceção declarada** — ver `02-SEGURANCA.md` §5.3 e §L4-bis; conta para o teto de falhas e tem rate limit próprio | consome o `mk` e emite sessão |
| `/__guard/secret` | GET | **exceção declarada e travada por token de posse de terminal** (não por "origem loopback", que é inerte sob túnel — `02-SEGURANCA.md` §0.2) | exibe o segredo uma única vez |

Só existem **três** exceções ao gate, e as três estão listadas acima com o controle que as
substitui. Nenhuma outra rota do plugin pode nascer fora de `guardedPrefixes`.

**Armadilha concreta de implementação:** essas rotas não podem depender do `ctx.intercept`
do próprio plugin para ficarem protegidas. O intercept envolve registros feitos *depois*
do `apply()` sobre o contexto derivado; registrar as próprias rotas por esse caminho cria
dependência circular frágil e, se o intercept falhar por qualquer motivo, o painel de
controle do túnel fica aberto. O handler dessas rotas precisa invocar o gate
**explicitamente**, chamando as primitivas puras já exportadas (`isTrustedRemote`,
`verifyBasicAuth`) antes de qualquer lógica. Critério de aceite: existe um teste que
remove o intercept e confirma que `POST /__guard/api/tunnel/start` continua devolvendo 401 sem
credencial.

Segunda armadilha: `/__guard/*` precisa estar em `guardedPrefixes` **e** a checagem
explícita precisa existir. Redundância aqui é barata; a falha é catastrófica.

**Terceira armadilha, e é a mais grave — corrigida nesta revisão.** `guardedPrefixes` é uma
política **default-allow**: `routeMayServeGuardedPath()` deixa passar intacta qualquer rota
registrada fora dos prefixos (`src/index.ts:1770`). Isso era defensável em loopback-only e
deixa de ser no instante em que o túnel sobe: toda rota que **qualquer** pacote do DSH
registre fora de `/api` fica pública na internet, e `03-ONDAS.md` T0.4 admite que **não há
como enumerar as rotas já registradas** — ninguém consegue nem auditar o que ficou aberto.

> **Regra normativa (nova):** com `exposure.mode: 'tunnel'`, `alwaysGuarded` é **`true`
> incondicionalmente** e `guardedPrefixes` deixa de decidir. O que decide passa a ser uma
> **allowlist curta e explícita de exceções** — as três rotas `__*` da tabela acima e nada
> mais. `assertValidConfig` recusa o boot se `exposure.mode === 'tunnel'` e
> `alwaysGuarded !== true`. Em `mode: 'loopback'` o comportamento default-allow atual é
> preservado, por compatibilidade.

---

## 4. A tensão central: um plugin feito para travar em loopback, agora usado para expor

Esta seção não é opcional. O plugin foi escrito com a tese explícita — no README, no
`cordis.patch.yml` e no cabeçalho de `src/index.ts` — de que "exposição à rede se faz
sempre por proxy reverso TLS autenticado à frente do loopback, nunca alargando o bind". O
que se pede agora é exposição à rede. Ignorar o conflito seria desonesto; "resolver"
mudando o bind seria pior.

### 4.1 O que NÃO muda

`assertSecureBind` fica exatamente como está: bind travado em `127.0.0.1`, falha ruidosa
no load para `0.0.0.0` / `::` / `*`. O `cloudflared` estabelece conexão de **saída** e se
conecta ao DSH como cliente loopback. Nesse eixo a tese original sobrevive intacta — o
túnel é, tecnicamente, o "proxy reverso TLS à frente do loopback" que o README já
prescrevia. Bind em wildcard continua sendo erro, inclusive com o túnel ligado: o "0.0.0.0
Day" (Oligo, 2024) mostrou sites públicos alcançando serviços em `0.0.0.0` no
macOS/Linux, com exploração observada in the wild.

### 4.2 O que MUDA, e é o ponto crítico

`trustedRemotes: ['127.0.0.1']` **deixa de ser uma fronteira de rede**. Todo o tráfego que
vem da internet pelo túnel chega ao DSH com `req.socket.remoteAddress === '127.0.0.1'`,
porque a última perna é o `cloudflared` local. O controle que hoje devolve 403 a origens
não confiadas passa a devolver 200 para qualquer pessoa que tenha a URL.

E a URL não é segredo. Evidência, com a ressalva honesta que a checagem adversarial
impôs:

- Uma chamada única, gratuita e sem autenticação à API pública do urlscan.io
  (`https://urlscan.io/api/v1/search/?q=page.domain:trycloudflare.com`) devolve
  `total: 10000` e ~73 hostnames distintos de quick tunnel nos primeiros 100 resultados;
  resolvendo DNS desses hostnames, 13 (≈18%) ainda estavam vivos naquele instante. Uma
  lista de alvos ativos, em uma requisição HTTP, sem brute force.
- **Ressalvas verificadas, que corrigem a leitura ingênua:** `total: 10000` é o teto da
  API (a doc do urlscan afirma que a contagem exata só vai até 10.000), não a contagem
  real; a afirmação de que "todos os resultados eram do próprio dia" foi **REFUTADA** (as
  datas se espalham por ~6 dias); e o urlscan **não enumera túneis vivos** — ele indexa
  apenas URLs que alguém submeteu com visibilidade pública (96 de 100 dos resultados
  vieram por `method: api`, majoritariamente feeds de antiphishing).
- A afirmação de que buscas `site:trycloudflare.com` retornam instâncias de quick tunnel
  indexadas por motores de busca **NÃO É REPRODUZÍVEL** e não deve ser usada como
  evidência.

A formulação correta, e a única que se deve escrever no onboarding: **o hostname vira
público no instante em que qualquer scanner, feed de segurança ou cliente o registra, e
não há como impedir isso.** Trate a URL como identificador público desde o segundo zero.

Consequência direta e não negociável: **com o túnel ligado, a senha é a única fronteira
que resta.** O 403 por origem continua existindo e continua útil (barra scans locais e
clientes de outra interface), mas deixa de contar como camada enquanto a exposição está
ativa.

### 4.3 Como o plano resolve: o eixo `exposure`

Introduzir uma chave de configuração explícita, que torna a mudança de modelo de ameaça
um ato deliberado e auditável em vez de efeito colateral:

#### Referência canônica do schema de `Config` — **normativa, completa, com defaults**

Na revisão anterior **não existia** em lugar nenhum um bloco de config completo: `01 §4.3`
mostrava 5 chaves ilustrativas, `03-ONDAS.md` T3.3 dizia só "amplia `Config`", e o default
divergia (`'loopback'` aqui, `'off'` em `04-TESTES.md` TENSAO-003). Este bloco resolve a
divergência e passa a ser **a** referência: `src/config/schema.ts` implementa exatamente
isto, `04-TESTES.md` TENSAO-003 testa exatamente isto, e `cordis.patch.yml` entrega
exatamente isto. Qualquer chave nova exige alterar este bloco primeiro.

```yaml
# --- já existentes, INALTERADAS ---
allowedHosts: ['127.0.0.1']        # allowlist do ENDEREÇO DE BIND. Não é allowlist de Host header
trustedRemotes: ['127.0.0.1']      # allowlist da ORIGEM da conexão. INERTE sob túnel (§4.2)
guardedPrefixes: ['/api', '/__guard']   # default-allow — só decide quando alwaysGuarded=false
deniedPermissions: ['danger-full-access']

# --- novas ---
exposure:
  mode: 'loopback'                 # 'loopback' (default de fábrica) | 'tunnel' — DOIS valores, só
                                   #   loopback → gate + painel, TunnelSupervisor NÃO é instanciado
                                   #   tunnel   → tudo acima + TunnelSupervisor habilitado
                                   # Um terceiro valor 'off' chegou a circular neste documento; ele
                                   # foi removido porque o vocabulário canônico tem dois valores
                                   # (09-DECISOES-CANONICAS.md D5) e porque ele não acrescentava
                                   # capacidade: "nem o painel é registrado" já se obtém com
                                   # mode:'loopback' + control.panel:false, que é a mesma postura
                                   # com uma chave a menos para errar.
  alwaysGuarded: true              # OBRIGATORIAMENTE true quando mode='tunnel' (deny-by-default)
  guardExceptions:                 # allowlist CURTA e explícita — as únicas rotas fora do gate
    - '/__guard/api/login'
    - '/__guard/magic'
    - '/__guard/secret'
  requireStrongSecret: true        # entropia mínima do segredo — ver 02-SEGURANCA.md §4.1
  requireRateLimit: true
  trustEdgeHeaders: false          # só true em named tunnel + Access com validação de JWT
  autoStart: false                 # não abrir túnel sozinho no boot
  allowedRequestHosts: []          # allowlist do cabeçalho Host (anti DNS rebinding, §4.5).
                                   #   vazio = derivado em runtime: 127.0.0.1:<porta>,
                                   #   localhost:<porta> e o hostname do túnel ativo

tunnel:
  provider: 'cloudflared'
  mode: 'quick'                    # 'quick' | 'named'
  binaryPath: null                 # null = procurar no PATH; ENOENT é não-retryable
  metricsHost: '127.0.0.1'
  metricsPort: 0                   # 0 = escolher porta livre e FIXAR com --metrics; nunca o default
  ttlMinutes: 60                   # OBRIGATÓRIO no modo quick. Teto 480 (8 h). 0 é inválido
  readinessTimeoutMs: 30000
  restartBudget: { attempts: 5, windowMs: 600000, healthyUptimeMs: 120000 }
  tokenFile: null                  # modo named. NUNCA --token em argv
  namedHostname: null              # modo named

control:
  stateDir: null                   # null = $XDG_STATE_HOME/dsh-guarded-bot (fallback ~/.local/state/…)
  panel: true                      # registra /__guard
  magicLink: true                  # LIGADO por padrão quando mode='tunnel' — ver 02 §4.4 e §5.3
  sessionIdleMinutes: 60
  sessionAbsoluteHours: 8
  confirmTtlSeconds: 60            # nonce das ações que AUMENTAM exposição

workers:
  bot:
    enabled: false                 # só liga após o pareamento fechar
    command: null                  # preenchido pelo onboarding: runtime Node + worker/telegram-bot.js
    args: []
    tokenSource: 'stateDir'        # 'stateDir' (secrets.env) | 'env' — nunca o .env do projeto
    ownerFromId: null              # gravado pelo pareamento; nunca editado à mão
    ownerChatId: null
```

Regras de validação que `assertValidConfig` passa a impor, todas verificáveis por teste:

- `exposure.mode === 'tunnel'` **e** `alwaysGuarded !== true` → `throw` no load.
- `exposure.mode === 'tunnel'` **e** `tunnel.ttlMinutes` fora de `1..480` → `throw`.
- `exposure.mode === 'tunnel'` **e** segredo ausente/fraco → `throw` (regra 1 abaixo).
- `tunnel.mode === 'named'` sem `tokenFile` → `throw`.
- `trustEdgeHeaders === true` sem `tunnel.mode === 'named'` + validação de JWT → `throw`.
- `guardExceptions` com qualquer entrada fora de `/__guard/` → `throw`.

Bloco resumido, para leitura rápida:

```yaml
exposure:
  mode: 'loopback'          # 'loopback' | 'tunnel'
  alwaysGuarded: true       # deny-by-default; obrigatório em 'tunnel'
  requireStrongSecret: true
  requireRateLimit: true
  trustEdgeHeaders: false
  autoStart: false
```

Regras derivadas, todas verificáveis por teste:

1. `mode: 'tunnel'` sem segredo de alta entropia → **falha no load**, com a mesma
   disciplina *fail loud* de `assertUsableCredential`.
2. `mode: 'loopback'` → `TunnelSupervisor` recusa iniciar; `/ligar` no bot responde com a
   razão e **não** transiciona estado.
3. `trustEdgeHeaders: true` só é aceito quando o modo é *named tunnel* **e** há validação
   do JWT do Cloudflare Access configurada. Motivo: `Cf-Connecting-Ip` e
   `Cf-Access-Jwt-Assertion` são texto que qualquer processo local consegue forjar contra
   `127.0.0.1`; confiar neles sem validar assinatura converte o túnel em via de escalada
   local. A doc da Cloudflare recomenda validar o **header** e não o cookie (o cookie não
   é garantidamente propagado), contra as chaves públicas em
   `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checando `kid`, `iss`,
   `aud` e `exp`.
4. Com `mode: 'tunnel'`, o plugin registra em `logger.warn`, a cada boot, que
   `trustedRemotes` deixou de ser fronteira efetiva. Aviso repetido é melhor que
   administrador contando com um controle que não está funcionando.
5. `mode: 'tunnel'` sem `alwaysGuarded: true` → **falha no load**. Deny-by-default deixa de
   ser opção quando existe uma URL pública apontando para a origem (§3(e)).
6. `mode: 'tunnel'` com `tunnel.ttlMinutes` ausente ou fora de `1..480` → **falha no load**.
   O TTL é o único controle que limita a *duração* da exposição e a versão anterior deste
   plano o exigia em `02-SEGURANCA.md` sem nenhum dono no plano de execução.

### 4.5 DNS rebinding e o cabeçalho `Host` — camada que faltava

`grep -i "rebind\|Host header"` nos oito arquivos da revisão anterior retornava **zero**.
Isso é uma lacuna real, e ela existe **mesmo sem túnel**: com bind em loopback e
`trustedRemotes` aprovando `127.0.0.1`, qualquer site que o dono visite pode, via DNS
rebinding, fazer o browser dele falar com `http://127.0.0.1:3080` — e alcançar toda rota
que ficou fora de `guardedPrefixes` (§3(e)) a partir de uma origem que o plugin considera
confiável. O `README.md` deste repositório já diz, corretamente, que `allowedHosts` **não**
é allowlist de cabeçalho `Host`; faltava alguém ser.

**Controle novo:** o gate valida o cabeçalho `Host` da requisição contra
`exposure.allowedRequestHosts`, que por default é derivado em runtime —
`127.0.0.1:<porta>`, `localhost:<porta>` e, quando o túnel está `READY`, o hostname do
túnel. `Host` ausente, vazio ou fora da lista → **403**, antes de qualquer verificação de
credencial, pela mesma razão pela qual origem não confiada dá 403 antes de 401. O mesmo
vale para o handshake de upgrade.

### 4.4 Riscos herdados que este plano NÃO elimina

Registrados aqui para não se perderem no otimismo:

- A discussão #853 do DSH (RCE não autenticada no plano de controle da Web UI, verificada
  em `0.1.0-rc.6`) e a #1769 (escape do sandbox `bwrap workspace-write`) estão **abertas**.
  O gate deste plugin é mitigação, não correção upstream. Durante o desenvolvimento, não
  trate o sandbox do DSH como fronteira de segurança.
- Uma UI de agente de código exposta é, por construção, execução remota de código com as
  credenciais do dono. O incidente "s1ngularity" (Nx, 26/08/2025) mostrou malware
  invocando agentes de código já instalados com as flags que desligam as travas
  (`--dangerously-skip-permissions`, `--yolo`, `--trust-all-tools`) para varrer `$HOME`
  atrás de `.env`, `id_rsa`, `keystore`: 2.349 credenciais de 1.079 máquinas. É a
  categoria de produto exata deste plano.
- TLS termina na borda da Cloudflare. **Não há criptografia ponta a ponta.** Expor
  código-fonte e prompts por ali é decisão consciente de modelo de confiança e precisa
  estar escrita no onboarding, não escondida.
- O domínio `trycloudflare.com` carrega reputação de malware (campanhas de AsyncRAT,
  Remcos, XWorm distribuídas por quick tunnels desde fev/2024; o ransomware Akira usa
  `cloudflared` como mecanismo de persistência). Consequência prática: redes corporativas
  bloqueiam o domínio, e EDRs tratam `cloudflared` rodando na máquina como sinal. Isso
  não é risco de segurança para o usuário, mas é risco de usabilidade e precisa estar no
  onboarding.

---

## 5. Decisão arquitetural central: o bot dentro ou fora do processo do DSH?

### Opção A — bot in-process (grammY carregado dentro da Fiber, sob `ctx.effect`)

**A favor**

- Zero IPC: o handler do comando chama a máquina de estados diretamente.
- Um só processo para supervisionar; disposer trivial (`bot.stop()` devolvido pelo
  `ctx.effect`).
- Reversibilidade nativa do Cordis: HMR do plugin reinicia o bot sem trabalho extra.
- Sem risco de processo órfão.

**Contra**

- **Raio de dano.** O bot é o único componente que consome input arbitrário da internet.
  In-process, um `throw` não capturado no parser de update ou um vazamento de memória mata
  a Fiber inteira e, no limite, o processo `dsh`. Pior: compartilha `process.env`, o mesmo
  heap e a mesma pilha de módulos do plano de controle. Toda a justificativa de
  `buildWorkerEnv` — a allowlist de ambiente que impede o segredo do gate de chegar a um
  consumidor de internet — **desaparece por construção**, porque não existe como cortar
  `process.env` para um módulo que roda no mesmo processo.
- Supply chain: grammY tem 4 dependências de runtime; in-process, cada uma vira supply
  chain do plano de controle do agente.
- **Disposer síncrono.** O `.d.ts` local documenta que o motor executa disposers em LIFO
  sem intercalar microtasks e trata uma `Promise` devolvida como já concluída — a ordem
  quebra em silêncio. Desligar limpo um long poll de 50 segundos é intrinsecamente
  assíncrono. In-process, ou se aceita um disposer que mente sobre ter terminado, ou se
  aborta a conexão na força.

### Opção B — bot como subprocesso supervisionado (RECOMENDADA)

**A favor**

- Isolamento real de falha e de ambiente. Um crash do bot é um `close` que o supervisor
  trata com backoff; não toca no DSH. `buildWorkerEnv` continua sendo fronteira efetiva
  porque existe uma fronteira de processo para impô-la.
- **Já está construído.** `createWorkerSupervisor` implementa spawn `detached`, tree-kill
  por grupo, caminho unificado de terminação para `exit` e `error` (incluindo o ENOENT que
  emite `error` + `close` e **nunca** `exit`), backoff com jitter somado sobre a base,
  orçamento com reset por uptime saudável e disposer síncrono idempotente. Reescrever isso
  in-process seria jogar fora trabalho já testado.
- O disposer síncrono fica honesto: manda `SIGTERM` ao grupo, agenda o `SIGKILL` e
  retorna. Não há promessa de shutdown gracioso fingindo ser síncrona.
- Long polling do Telegram **não escala horizontalmente**: duas instâncias chamando
  `getUpdates` produzem HTTP 409 (`"Conflict: terminated by other getUpdates request;
  make sure that only one bot instance is running"`), com o servidor matando o long poll
  antigo e ainda aplicando throttle. Um subprocesso sob um supervisor que garante
  "exatamente um filho vivo de cada vez" (a flag `started` já implementa isso) é
  exatamente a topologia correta.

**Contra**

- Precisa de um canal IPC (resolvido abaixo, sem abrir rede nova).
- Dois artefatos para construir e versionar em vez de um.
- Precisa de runtime Node disponível para o filho (já é requisito do DSH).

### Recomendação: **Opção B — subprocesso**, com IPC por JSONL sobre stdio

O modelo de Fibers do Cordis não é argumento a favor de in-process aqui — é o contrário.
O Cordis garante que *o recurso alocado é erradicado em LIFO quando a Fiber morre*, e um
subprocesso sob `ctx.effect` com disposer síncrono cumpre esse contrato tão bem quanto um
objeto em memória, com a vantagem de o recurso ser separável. A parte do contrato que
in-process **não** consegue cumprir é a do ambiente construído por allowlist, que é a
única defesa entre um parser de mensagens da internet e a credencial do plano de controle.

**Onde o código do worker mora, e como ele é lançado.** O worker vive em `worker/`, **no mesmo
pacote npm** — não existe `packages/`, não existe monorepo, não existe binário publicado à parte.
`tsconfig.build.json` compila `src/` **e** `worker/`, e o `argv` do `spawn` resolve
`dist/worker/telegram-bot.js` **relativo a `import.meta.url`**, nunca por `cwd` (o `cwd` de um
plugin carregado por um host é o do host, não o do pacote). O `files` do `package.json` continua
sendo só `dist`, e `dist/worker/` vai junto no tarball. Isto precisa estar escrito aqui porque a
alternativa que circulava — spawnar um `.ts` de dentro de `node_modules` — é **impossível**: o
Node recusa type stripping ali (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`).

**Onde a allowlist de identidade do Telegram mora:** em `worker/auth/allowlist.ts`, no processo do
worker. **Onde o nonce de confirmação mora:** em `src/control/confirm.ts`, no **host**. Os dois não
podem trocar de lado. O worker é o processo que fala com a internet; um nonce validado lá dentro
não é um controle, é uma variável. O worker apenas transporta o nonce opaco dentro do
`callback_data`, e `callback_data` nunca é prova de autorização.

**Canal IPC: JSONL bidirecional sobre `stdin`/`stdout` do filho.** Sem socket, sem porta,
sem arquivo. `stdio` passa a `['pipe','pipe','pipe']` e o protocolo é uma linha JSON por
mensagem:

```
plugin → bot    {"v":1,"type":"state","state":"READY","url":"https://x.trycloudflare.com","seq":42}
bot    → plugin {"v":1,"type":"intent","intent":"tunnel.up","requestId":"01J...","from":123456789}
plugin → bot    {"v":1,"type":"ack","requestId":"01J...","result":"accepted","state":"STARTING"}
plugin → bot    {"v":1,"type":"error","requestId":"01J...","code":"EXPOSURE_DISABLED"}
```

Quatro propriedades que esse canal dá de graça:

1. **Não abre superfície nova.** Um socket HTTP local de controle seria mais uma porta
   para guardar e mais um caminho para auditar; o pipe só existe entre pai e filho.
2. **Dead-man's switch.** Se o processo `dsh` for morto com `SIGKILL`, o `stdin` do filho
   fecha; o bot detecta EOF e termina sozinho. É a única defesa que sobrevive a um
   `SIGKILL` no supervisor, já que `detached` + `kill(-pid)` no disposer depende do
   disposer chegar a rodar. Reparenting, aliás, **não é necessariamente para o PID 1**:
   na máquina medida o órfão foi adotado por `systemd --user` (subreaper), o que só
   reforça que não se pode contar com o init para limpar.
3. **Segredos continuam fora do Telegram.** O que atravessa o canal é uma *intenção*
   (`tunnel.up`), nunca uma credencial. O FAQ oficial da Telegram é literal: *"any bot
   should be treated as a stranger — don't give them your passwords, Telegram codes or
   bank account numbers"*. Chats com bot não são E2E, ficam armazenados nos servidores da
   Telegram e passam por análise automatizada; e não existe autodestruição para bots
   (`message_auto_delete_time` é somente leitura na Bot API, e `deleteMessage` só funciona
   em mensagens com menos de 48 h). Ou seja: "apago depois" não é controle de segurança.
4. **Backpressure explícito.** JSONL de linha única permite detectar linha malformada e
   descartar sem derrubar o canal — que é o comportamento certo quando a outra ponta é um
   processo que pode ter sido reiniciado no meio de uma escrita.

Disciplina obrigatória decorrente: hoje o `stdout` do filho vai para `logger.debug` linha
a linha. Ao virar canal de protocolo, o bot escreve **exclusivamente** JSONL em `stdout`
e todo log humano vai para `stderr`. Regra de uma linha, mas se violada o parser do pai
passa a ver ruído. O teste de contrato correspondente está em `04-TESTES.md`.

### 5.1 Nota sobre o modelo de ameaça do token do bot (correção de uma premissa comum)

Circula a ideia de que "quem tem o token do bot contorna completamente a allowlist de
`from.id`". Isso foi **REFUTADO** e a formulação correta importa para a arquitetura:

- O token autentica chamadas **saindo** para a API do Telegram. A ação destrutiva é
  disparada por update **entrando**. No desenho de long polling adotado aqui, o bot não
  expõe endpoint HTTP nenhum — o portador do token não tem para onde POSTar um update
  forjado. E bots não veem mensagens de outros bots, então o `sendMessage` do atacante não
  volta como update.
- O que o vazamento realmente dá, e é grave: personificação do bot, **roubo da fila** via
  `getUpdates` (o consumidor que confirma o offset apaga do servidor — o dono legítimo
  nunca vê aqueles comandos), sequestro/exfiltração via `setWebhook`, e DoS por 409.
  Confidencialidade e disponibilidade, não execução.
- O caminho residual real é **deputado confuso**: com o token, o atacante manda, como o
  bot, um teclado inline cujo `callback_data` é um comando destrutivo; se o **dono**
  clicar, o `callback_query` chega com `from.id` da allowlist e passa. A mitigação
  arquitetural é confirmação em duas etapas com token efêmero gerado no servidor e TTL —
  nunca tratar `callback_data` como prova de autorização, porque é fornecido pelo cliente
  (limite de 64 **bytes**, e um cliente modificado envia o que quiser).

Consequência de design: a allowlist checa **`from.id`** (o usuário) **e** `chat.id`, com
falha fechada quando `message.from` está ausente (channel posts). Nunca por `username`,
que é mutável e sequestrável.

---

## 6. Máquina de estados

Fonte única da verdade: um objeto `SystemState` detido pelo plugin, com número de
sequência monotônico. Bot e UI são **projeções**; nenhum dos dois mantém estado próprio
além do último `seq` que viu.

> **Vocabulário congelado (correção desta revisão).** Circulavam **dois** conjuntos de
> nomes — `DESLIGADO/INICIANDO/ONLINE/DEGRADADO/DESLIGANDO` aqui e em `04-TESTES.md` §5.5,
> `STOPPED/STARTING/READY/STOPPING/FAILED` em `03-ONDAS.md` §8/§10 — e não era só tradução:
> `DEGRADADO` re-tentava sozinho com backoff, `FAILED` exigia `reset()` humano. São
> semânticas diferentes e a divergência é bug de plano, não de idioma.
>
> **Decisão:** o enum de código, de protocolo IPC e de teste é **um só, em inglês, com seis
> estados**, congelado no COMMIT PREP 3 (`src/contracts/tunnel.ts`):
>
> `STOPPED | STARTING | READY | DEGRADED | STOPPING | FAILED`
>
> `DEGRADED` = falhou **e** ainda há orçamento de tentativas: re-tenta sozinho com backoff.
> `FAILED` = terminal: orçamento esgotado ou erro não-retryable (`ENOENT`, `EACCES`,
> config inválida); **só sai com `reset()` humano**, nunca sozinho. Os nomes em português
> continuam existindo **apenas como rótulo de UI** (`STOPPED`→"desligado",
> `STARTING`→"ligando", `READY`→"online", `DEGRADED`→"instável, tentando de novo",
> `STOPPING`→"desligando", `FAILED`→"falhou — precisa de ação sua"). Nenhum código, teste
> ou payload IPC usa o rótulo.

```
                       ┌──────────────────────────────────────────────┐
                       │                                              │
                       v                                              │
                ┌─────────────┐   up (bot|UI)     ┌────────────────┐   │
                │   STOPPED   │──────────────────>│    STARTING    │   │
                └─────────────┘                   └───────┬────────┘   │
                       ^                                  │            │
                       │                    URL em        │            │
       disposer da     │                    /quicktunnel  │            │
       Fiber /         │                    + probe local │            │
       down concluído  │                                  v            │
                ┌──────┴──────┐   down (bot|UI)   ┌────────────────┐   │
                │  STOPPING   │<──────────────────│     READY      │   │
                └─────────────┘                   └───────┬────────┘   │
                       ^                                  │            │
                       │ down                             │ cloudflared│
                       │                                  │ caiu       │
                       │                                  v            │
                       │                          ┌────────────────┐   │
                       └──────────────────────────│    DEGRADED    │───┘
                                                  └────────────────┘
                                          backoff → STARTING
                                          orçamento esgotado → FAILED (terminal, exige reset())
```

### Transições, gatilhos e efeitos

| De | Para | Quem dispara | Pré-condição | Efeito |
| -- | ---- | ------------ | ------------ | ------ |
| STOPPED | STARTING | bot, UI | `exposure.mode === 'tunnel'`; segredo forte válido; **probe fail-closed de 4 superfícies passou** (`02-SEGURANCA.md` §L1) | `spawn` do `cloudflared`; inicia o readiness poll; arma o timer de TTL |
| STARTING | READY | interno | URL obtida em `/quicktunnel` **e** probe local em `127.0.0.1:<porta>` responde | registra a origem do túnel na allowlist de `Origin`; difunde `state` com a URL; bot avisa o dono |
| STARTING | DEGRADED | falha | timeout de readiness (≥30 s) ou `close` do processo | conta a tentativa; agenda retry com backoff |
| READY | DEGRADED | falha | `close` / `error` do `cloudflared` | invalida as sessões emitidas para o túnel; idem |
| DEGRADED | STARTING | interno | orçamento de tentativas não esgotado | novo `spawn` |
| DEGRADED | FAILED | interno | orçamento esgotado (`exhausted`) | erro terminal no log; notifica o dono; **sem retry até `reset()` humano** |
| STOPPED / STARTING / DEGRADED | FAILED | interno | erro não-retryable (`ENOENT`, `EACCES`, config inválida) | mensagem acionável; sem retry |
| READY / STARTING / DEGRADED | STOPPING | bot, UI, disposer, **TTL expirado** | — | invalida sessões; `SIGTERM` ao grupo → janela de graça → `SIGKILL` |
| STOPPING | STOPPED | interno | processo confirmado morto | difunde estado final; desregistra a origem da allowlist de `Origin` |
| FAILED | STOPPED | bot, UI | `reset()` explícito do dono | zera o orçamento; nada mais |

Erros classificados como **não-retryable** saem do loop imediatamente em vez de consumir
orçamento: `ENOENT` (binário `cloudflared` ausente ou fora do `PATH`), `EACCES` (sem
permissão de execução) e configuração inválida. Esses vão direto para `FAILED` com uma
mensagem acionável ao dono ("cloudflared não encontrado; instale por
`pkg.cloudflare.com`"), porque tentar de novo nunca vai funcionar.

Gatilhos que **não** existem de propósito:

- Não há "ligar automaticamente ao subir o DSH" por padrão. Um túnel que abre sozinho a
  cada boot é um túnel que fica aberto sem ninguém saber. Existe `exposure.autoStart`,
  desligado por padrão, para quem quiser assumir o risco conscientemente.
- Não há caminho para "desligar o processo DSH inteiro" (§9.4).

### O que é persistido entre reinícios

Arquivo único e **com um único nome em todo o plano** — `state.json`, em
`$XDG_STATE_HOME/dsh-guarded-bot/` (fallback `~/.local/state/dsh-guarded-bot/`), diretório
`0700`, arquivo `0600`, **fora do workspace do agente**. Os nomes concorrentes que
circulavam (`mobile-gateway.json` aqui, `state.json` em `02-SEGURANCA.md` §8.1) estavam em
conflito; **vale o de `02-SEGURANCA.md` §8.1** e este documento foi corrigido. O único
outro arquivo é `secrets.env` (token do bot), no mesmo diretório e com o mesmo modo.

```jsonc
{
  "version": 1,
  "desiredState": "STOPPED",       // INTENÇÃO do operador, não estado observado
  "exposureMode": "tunnel",
  "secretDigest": "<hex 64>",      // sha256 — NUNCA o segredo em claro
  "secretCreatedAt": "<iso8601>",
  "sessions": { "<sid_hash>": { "exp": 0, "createdAt": 0, "uaHash": "…" } },
  "pairing": { "closed": true, "ownerFromId": 0, "ownerChatId": 0 },
  "restrictedMode": { "active": false, "since": null },  // persiste entre reinícios (§6.3 de 02)
  "tunnelOrphanSuspected": false,  // escrito ANTES de qualquer teardown; lido no boot
  "lastError": { "code": "ENOENT", "at": "2026-08-19T21:00:00Z" },
  "failureBudget": { "attempts": 0, "windowStartedAt": "…" },
  "updatedAt": "…"
}
```

**Dono único do writer.** Este arquivo tem **um** módulo dono, `src/state/**`, entregue por
**T2.5** (`03-ONDAS.md` §7). `SecretStore` (T2.1), `SessionStore` (T2.2) e o modo restrito
(T2.3) **não escrevem no arquivo**: consomem o contrato `StateStore`, congelado no COMMIT
PREP 2. Três donos para um writer era o conflito de propriedade mais perigoso da Onda 2.

Persiste-se a **intenção**, não o estado observado. Ao subir, o plugin lê `desiredState` e,
se for `READY` **e** `exposure.autoStart` estiver ativo, tenta reconciliar; caso contrário sobe em
`STOPPED` e diz por quê. (Os dois valores legais de `desiredState` são `READY` e `STOPPED`, em
inglês, como todo o resto do enum — ver o vocabulário congelado no §6.) A URL do quick tunnel **não é persistida**: é diferente a cada
arranque, e um valor velho em disco só produz links mortos entregues com confiança.

Escrita atômica obrigatória: arquivo temporário no mesmo diretório + `fsync` + `rename`.
Isso não é zelo genérico — a discussão #441 do DSH documenta que o próprio carregador de
perfis reescreve YAML sem rename atômico e que arranques concorrentes leem arquivos
truncados. É um bug conhecido do hospedeiro que não se deve replicar.

**NÃO CONFIRMADO — spike obrigatório (S9, T0.1).** Qual é o caminho canônico de diretório de
estado por plugin no DSH, e se existe API do host para isso. Na revisão anterior isto estava
declarado e **não roteado**: nenhum spike da Onda 0 tinha a resposta na entrega. Agora **T0.1
possui explicitamente** essa pergunta (`03-ONDAS.md` §5). Enquanto S9 não fechar, o caminho é
`$XDG_STATE_HOME/dsh-guarded-bot/` com fallback `~/.local/state/dsh-guarded-bot/`, sobrescrito
por `control.stateDir` na config — **nunca** derivado de `cwd` do perfil, porque `cwd` do
perfil pode ser o workspace que o agente lê (`02-SEGURANCA.md` §2.4).

---

## 7. Como o link do túnel é obtido e propagado

### 7.1 Obtenção — endpoint, não scraping de log

A forma correta é o metrics server local do `cloudflared`:

```
GET http://127.0.0.1:<metricsPort>/quicktunnel
→ 200  {"hostname":"forbes-mines-prostores-easier.trycloudflare.com"}
```

Confirmado empiricamente (cloudflared 2026.7.3, duas execuções independentes, HTTP 200).
Quatro ressalvas que a implementação precisa respeitar:

1. **Devolve o hostname sem esquema.** É preciso prefixar `https://`. Precisa de teste,
   porque é o erro que se comete uma vez e se descobre no celular.
2. **Esse endpoint NÃO está documentado** na página oficial de métricas da Cloudflare, que
   só menciona `/metrics`. É comportamento verificado, não contrato publicado — pode
   sumir numa versão futura. Daí o fallback existir.
3. **A porta de métricas precisa ser fixada** com `--metrics 127.0.0.1:<porta>`. No
   2026.7.3 o `--help` declara o default como `localhost:0` (porta aleatória) com fallback
   na faixa 20241–20245, enquanto a doc afirma a faixa. Não confiar no default.
4. **Bind do metrics em `127.0.0.1` explicitamente.** É um endpoint sem autenticação que
   revela a URL do túnel e o estado das conexões.

**Fallback (regex em `stderr`)**, usado só se `/quicktunnel` não responder dentro do
timeout: a URL sai **exclusivamente em `stderr`** — medido, com `stdout` em 0 bytes nas
duas execuções — dentro de uma caixa ASCII. Padrão funcional:
`https://[-a-z0-9]+\.trycloudflare\.com`. Nota: `--output json` **não** ajuda, porque a
URL continua embutida na caixa ASCII dentro do campo `message`.

**Timing:** entre lançar e a URL ficar disponível mediram-se 6–7 segundos. O polling deve
ter timeout generoso (≥30 s) e correr contra o evento `close` do filho — se o processo
morrer durante o warmup, aborta-se o wait imediatamente em vez de esperar o timeout
inteiro. Endpoints auxiliares confirmados no mesmo metrics server: `/ready` (JSON com
`readyConnections`) e `/healthcheck` (texto `OK`); a raiz devolve 404.

**Duas coisas diferentes, que a versão anterior deste documento confundia: o probe e o
readiness.** Confundi-las é exatamente o que expôs o DSH real do usuário publicamente por ~40 s
durante a pesquisa, e a diferença é de natureza:

| | **Probe fail-closed** | **Readiness** |
| --- | --- | --- |
| Pergunta que responde | *o gate está armado?* | *a URL do túnel já é utilizável?* |
| Quando roda | **ANTES** do `spawn` do `cloudflared` — é pré-condição da transição `STOPPED → STARTING` | **DEPOIS** que o túnel subiu, antes de `STARTING → READY` |
| Critério | **quatro** sondas anônimas contra `127.0.0.1:<porta>`, **todas** têm que devolver `401` | hostname obtido **e** a origem responde |
| Falha significa | túnel **não sobe**, estado vai para `FAILED`, mensagem ao dono nomeia a sonda | mata o `cloudflared` e reporta timeout |
| Dono | **T3.1** (`src/tunnel/probe.ts`) | **T3.2** (`src/tunnel/readiness.ts`) |

**As quatro sondas do probe** (especificação normativa em `02-SEGURANCA.md` §L1): (1) `GET /`,
o fallback da SPA, servido pelo `registerFallback` do `@deepseek-ai/dsh-host-frontend-static`;
(2) `POST /api/<rpc de leitura>` com corpo vazio, que vem de **outro** registro — provar `/` não
prova `/api`; (3) `GET /` com `Upgrade: websocket`, que cobre o `registerUpgrade`; (4)
`GET /__guard/probe-canary-<aleatório>`, um caminho **fora** de `guardedPrefixes`, que prova que a
política é default-deny — se responder `404` sem passar pelo gate, o default-allow ainda está
valendo. O modo de falha que isto cobre é **ordem de carregamento**, e `ctx.intercept` só envolve
registros feitos **depois** do `apply()`.

Dizer apenas "o probe local responde" — como este documento dizia — não cobre nenhum desses
casos: "responde" e "responde 401 a quem não tem credencial" são afirmações diferentes.

**Readiness, então, é a segunda perna e continua existindo:** a promoção para `READY` exige
(i) hostname obtido e (ii) probe local bem-sucedido contra `127.0.0.1:<porta do DSH>`. Sem (ii),
o bot entrega ao dono um link que abre e devolve erro de origem.

### 7.2 Propagação até o Telegram

```
TunnelSupervisor obtém hostname
  └→ StateMachine.transition(READY, { url })         [seq++]
       ├→ BotBridge escreve {"type":"state",...} no stdin do filho
       │    └→ bot chama editMessageText na mensagem de estado do chat do dono
       └→ UI recebe no próximo GET /__guard/api/state
```

O bot **não faz polling** do estado: recebe push pelo pipe. O painel HTTP faz polling
curto (2 s) por simplicidade — não vale um WebSocket para um painel de dois botões, e um
WebSocket a mais é mais uma superfície para guardar.

Detalhes de UX confirmados na doc do Telegram:

- Preferir `editMessageText` sobre uma mensagem de estado fixa a cada transição, em vez de
  mandar mensagem nova — é a recomendação explícita da doc e evita encher o chat. Limite:
  1–4096 caracteres.
- `answerCallbackQuery` é **obrigatório** após cada toque em botão inline; sem ele o
  cliente mostra barra de progresso indefinidamente. `text` até 200 caracteres.
- Usar **inline keyboard**, não reply keyboard: reply keyboard só manda texto puro,
  indistinguível de digitação, sem payload.
- **NÃO CONFIRMADO — spike obrigatório (S10, T0.3):** `InlineKeyboardButton.style` com os
  valores `"success"` / `"danger"` / `"primary"`. É a **única** afirmação de forma de API do
  Telegram neste plano sem citação literal nem âncora — todas as outras de `08 §2.1` trazem
  trecho colado. Ela estava congelada como asserção de teste (`04-TESTES.md` TG-029) e como
  entrega de T5.2, o que é exatamente o erro que a Onda 0 existe para não repetir.
  **Enquanto S10 não colar o trecho da doc, o desenho de fallback é obrigatório e é o
  default:** rótulo textual com emoji (`🟢 Ligar` / `🔴 Desligar`), que funciona em qualquer
  versão da Bot API. Se S10 confirmar, `style` vira enfeite opcional, nunca requisito.
- No boot, `drop_pending_updates` para descartar a fila. Updates pendentes ficam no
  servidor por até 24 h; sem isso, um DSH que ficou desligado o dia inteiro processa uma
  avalanche de comandos velhos ao voltar — perigoso num bot que liga e desliga exposição.
- Rate limits: 1 msg/s no mesmo chat, ~30 msg/s de broadcast. Irrelevante para um bot de
  um dono, mas 429 traz `parameters.retry_after` e precisa ser respeitado; o plugin
  oficial de auto-retry do grammY já faz isso.

---

## 8. Quick Tunnel vs Named Tunnel

### 8.1 Correção de uma premissa que circula

A doc oficial da Cloudflare afirma literalmente *"Quick Tunnels do not support
Server-Sent Events (SSE)"*, e é tentador concluir que isso inviabiliza um harness de LLM.
A pesquisa **refutou a conclusão por teste ao vivo**: num quick tunnel real, um `POST` com
`Accept: text/event-stream` chegou em streaming genuíno, com eventos espaçados exatamente
no timing da origem (0,47 s / 0,97 s / 1,47 s …), reproduzido duas vezes; o que ficou
buferizado foi o caminho `GET`, consistente com o issue `cloudflare/cloudflared#1449`.
Como streaming de token em API compatível com OpenAI/DeepSeek é `POST`, o caso que
funciona é precisamente o caso de uso. E há um segundo motivo pelo qual a questão é
discutível aqui: o próprio DSH migrou o canal de telemetria de SSE para um **WebSocket
dedicado** (o pool de ~6 conexões HTTP/1.1 por origem no browser se esgotava), e
WebSockets passam normalmente por quick tunnel.

Logo, o argumento contra quick tunnel **não é técnico, é operacional**: teto de 200
requisições em voo (HTTP 429 acima disso), sem SLA, hostname aleatório a cada arranque,
nenhuma autenticação no nível do túnel, e — o mais relevante — impossibilidade de colocar
Cloudflare Access na frente, porque Access exige `zone_id`/domínio com DNS na Cloudflare.

### 8.2 Recomendação por cenário

| Cenário | Modo | Por quê |
| ------- | ---- | ------- |
| Primeira vez, onboarding, "quero ver funcionando agora" | **Quick tunnel** | Zero configuração, zero conta, zero estado em disco (verificado: `~/.cloudflared` não é criado). URL em 6–7 s |
| Uso pessoal esporádico, sessões curtas, desligado ao fim | **Quick tunnel** | Montar named tunnel não se paga; senha forte + rate limit é a fronteira |
| Uso recorrente, várias sessões por semana, URL memorizável | **Named tunnel** | Hostname estável, sem o teto de 200 requisições em voo |
| Quer autenticação **antes** de o tráfego tocar na máquina | **Named tunnel + Access** | Access avalia políticas na borda, deny-by-default. One-time PIN por e-mail não exige IdP nenhum e serve bem para acesso pessoal por celular |
| Exposição prolongada, ou mais de uma pessoa | **Named tunnel + Access**, e reavaliar se isso deveria ser exposto | A categoria de produto é RCE-as-a-service |

O plugin suporta os dois. O default é `quick`, porque é o que o onboarding consegue
concluir sem exigir um domínio do usuário — e a documentação precisa dizer em voz alta
que a Cloudflare classifica quick tunnels como *"intended for testing and development
only"*, sem SLA.

**Regra independente do modo:** a senha da aplicação nunca é dispensada por existir Access
na frente. O modo de falha comum é política mal configurada ou rota de bypass (a ação
`Bypass` do Access, aliás, desliga tudo **e não gera log**). Três camadas independentes
— túnel sem porta aberta, Access na borda, gate na origem — só valem se nenhuma for
desligada por confiar nas outras.

### 8.3 Notas operacionais do `cloudflared`

- Instalar preferencialmente pelo repositório apt assinado (`pkg.cloudflare.com`, chave
  `cloudflare-main.gpg`), que dá verificação de assinatura automática. Binário solto: as
  release notes do GitHub publicam o sha256, mas **não existe** arquivo `.sha256` por
  asset (é issue aberta).
- O próprio `cloudflared` registra o checksum no log de arranque, o que permite auditar o
  binário em execução sem re-hashear. Verificado que o valor logado bate com o
  `sha256sum` real e com o publicado no GitHub.
- **Nunca** `--loglevel debug` em produção: registra URLs, métodos e **todos** os
  cabeçalhos de requisição e resposta, incluindo os que transportam credenciais.
- Preferir `--token-file` a `--token` no modo named: token em `argv` é legível por
  qualquer processo local em `/proc/<pid>/cmdline`. É a mesma razão pela qual
  `TELEGRAM_BOT_TOKEN` já entra por ambiente e não por argumento.
- `SIGTERM` basta para shutdown limpo: medido em ~2 s, com a URL pública passando a
  devolver 530 e a porta de métricas recusando conexão imediatamente. Não fica registro
  órfão na borda. Por isso o disposer do túnel usa `SIGTERM` primeiro, e não `SIGKILL`
  direto como o supervisor atual do bot faz.

---

## 9. Ligar/desligar nas duas superfícies, sem divergir de estado

### 9.1 Fonte única da verdade

A `StateMachine` do plugin. Bot e UI **não têm estado**: ambos enviam intenções e recebem
projeções carimbadas com `seq`. Uma projeção com `seq` menor que a última vista é
descartada — o que resolve o reordenamento entre o push do pipe e o polling HTTP.

### 9.2 Idempotência

Todo comando carrega um `requestId` (ULID gerado pelo emissor). A máquina de estados
mantém uma janela dos últimos N `requestId` processados; um repetido devolve o mesmo `ack`
sem re-executar. Isso cobre o caso real do Telegram: o usuário aperta duas vezes o botão
porque a rede está lenta.

A semântica é idempotente **por estado alvo**, não por ação:

| Comando | Estado atual | Resultado |
| ------- | ------------ | --------- |
| `tunnel.up` | `STOPPED` | transiciona para `STARTING` |
| `tunnel.up` | `STARTING` | `accepted`, sem nova transição; devolve o estado em curso |
| `tunnel.up` | `READY` | `noop`, devolve a URL corrente |
| `tunnel.up` | `DEGRADED` | `accepted`, sem nova transição: o supervisor já está re-tentando com backoff e um segundo `up` não acelera nada |
| `tunnel.up` | `STOPPING` | **`rejected`** com código `SHUTDOWN_IN_PROGRESS`; o dono reenvia depois. **Não** é enfileirado para executar ao fim do shutdown — enfileirar reabriria a exposição que alguém acabou de mandar fechar, e é justamente o que quem aperta "desligar" **não** quer. `04-TESTES.md` `CTL-007` dizia o contrário ("intenção enfileirada; ao concluir, reconcilia para `STARTING`") e é o caso de teste que muda |
| `tunnel.up` | `FAILED` | `rejected`; `FAILED` é terminal e só sai por `reset()` humano |
| `tunnel.up` | qualquer, com **modo restrito ativo** | **`rejected`** com código `RESTRICTED_MODE`. Sem esta linha, o teto de 100 falhas (`02-SEGURANCA.md` §6.1) é revertido pelo comando seguinte e o controle vira decorativo |
| `tunnel.down` | `STOPPED` | `noop` |
| `tunnel.down` | `STARTING` / `READY` / `DEGRADED` | transiciona para `STOPPING` |
| `tunnel.down` | `STOPPING` | `accepted`, sem nova transição |
| `tunnel.down` | `FAILED` | `noop` — não há o que derrubar; o `reset()` é outro comando |

### 9.3 Comandos simultâneos

A `StateMachine` processa comandos numa **fila serializada de um slot** dentro do event
loop do Node. Não há paralelismo real a defender, mas há reentrância. A regra: uma
transição em curso não é interrompida por comando novo; o comando novo é avaliado contra
o estado que a transição vai produzir.

Caso concreto — `up` do bot e `down` da UI chegam com 5 ms de diferença, estado `STOPPED`:

1. `up` entra primeiro → estado vira `STARTING`, `spawn` disparado, `seq=10`.
2. `down` entra → alvo válido a partir de `STARTING` → estado vira `STOPPING`, `seq=11`,
   `SIGTERM` ao grupo.
3. O readiness poll do passo 1 vê `close` e **não** promove para `READY`, porque a promoção
   verifica que o `seq` da transição que a originou ainda é o corrente. Sem essa
   verificação, uma resolução tardia ressuscita um estado já revogado. É o mesmo padrão da
   re-verificação de `disposed` imediatamente antes de agendar, que o supervisor atual já
   faz e que deve ser replicada aqui.
4. Ambas as superfícies convergem para `STOPPED` com `seq=12`. O bot mostra ao dono que o
   pedido foi processado e que o resultado final foi "desligado", com a razão.

Critério de aceite: teste determinístico que injeta os dois comandos no mesmo tick e
verifica que não sobra nenhum processo `cloudflared` vivo nem nenhum timer pendente.

### 9.4 O que "desligar o server" significa — desambiguação obrigatória

O pedido original diz "ligar e desligar o server". São três coisas distintas:

| Alvo | Viável pelo bot? | Decisão |
| ---- | ---------------- | ------- |
| O **túnel** (a exposição) | Sim | **É este o alvo.** Ligar/desligar = expor/parar de expor |
| O **bot** | Parcialmente | é o que `/emergencia` faz na parte de worker; só o painel ou o disposer podem religar. **Não existe** comando chamado `/parar_bot` — a lista canônica de comandos é `/ligar`, `/desligar`, `/status`, `/acessar`, `/rotacionar`, `/parear <código>`, `/emergencia`, e nenhum outro nome pode aparecer em código, teste ou doc |
| O **processo DSH inteiro** | Não, com segurança | Fora de escopo nesta fase |

Justificativa da terceira linha: o bot roda como filho do DSH. Matar o pai mata o filho, e
depois não sobra ninguém para ouvir o comando de religar. Fazer isso exigiria um
supervisor externo (unit de usuário do systemd ou equivalente), que é uma peça de
infraestrutura diferente, com modelo de segurança próprio, e que passaria a ser o
componente com maior privilégio do sistema. `03-ONDAS.md` trata isso como item
explicitamente adiado, não como esquecimento.

Em contrapartida, existe um comando destrutivo que **é** implementado: `/emergencia` —
desliga o túnel, rotaciona o segredo do gate e invalida sessões. Por ser destrutivo, exige
confirmação em duas etapas com token efêmero gerado no servidor e com TTL, nunca confiando
no `callback_data` como prova (§5.1).

### 9.5 Onboarding como sub-máquina, não como texto solto

O requisito "ensinar o usuário a conectar o Telegram" é uma sub-máquina de estados dentro
do plugin, não um README. Estados: `SEM_TOKEN` → `TOKEN_INVALIDO` → `TOKEN_OK_SEM_DONO` →
`PRONTO`. A detecção de "já está conectado?" é objetiva e verificável em cada estado:

| Estado | Como o plugin detecta | O que a UI/CLI mostra |
| ------ | --------------------- | --------------------- |
| `SEM_TOKEN` | config sem `worker.token` | passo a passo do BotFather: `/newbot`, nome, username terminando em `bot` (imutável) |
| `TOKEN_INVALIDO` | `getMe` falha | mostra o erro cru da API e o link para `/token` do BotFather (regenera e revoga o antigo) |
| `TOKEN_OK_SEM_DONO` | `getMe` OK, sem `pairing.closed` no `state.json` | exibe **só no terminal/painel local** um **código de pareamento de 6 dígitos** com TTL de 5 min e instrui o dono a mandar `/parear 123456` no chat (bot não pode iniciar conversa). O `getUpdates` é apenas o **transporte** que traz essa mensagem; `from.id` e `chat.id` são lidos **do update que carrega o código correto** |
| `PRONTO` | `getMe` OK + `ownerId` presente | mostra o username do bot e o estado do túnel |

**Conflito resolvido nesta revisão.** A versão anterior deste documento descrevia o
onboarding como "primeiro `/start` que chegar vira o dono", lendo `chat.id` cru de
`getUpdates`, enquanto `02-SEGURANCA.md` §7.2 exigia **código de pareamento de 6 dígitos**.
Eram dois desenhos mutuamente exclusivos para o mesmo requisito, e o de `02` é o correto:
"o primeiro que der `/start` vence" é uma **corrida que o atacante pode ganhar**, sobretudo
se o username do bot for previsível. O código de pareamento amarra a identidade do Telegram
à **posse do terminal**, que é a raiz de confiança real deste sistema. Vale `02 §7.2`
integralmente: TTL 5 min, uso único, `pairing.closed = true` permanente após sucesso,
reabertura só por `--reset-pairing` executado **na máquina**.

Regra de fronteira: o onboarding **nunca** pede ao usuário que envie a senha do gate pelo
Telegram, e a própria UI de onboarding roda atrás do gate. Detalhes de texto e de
tratamento do segredo em `02-SEGURANCA.md`.

#### Link mágico de uso único — o caminho do celular

Este documento omitia o mecanismo inteiro, o que deixava a arquitetura sem resposta para a
pergunta que é o produto: **como o dono, que está fora de casa, entra?** A senha permanente
apareceu uma vez no stdout de um terminal, tem 52 caracteres em base32, e **nunca** pode
trafegar pelo Telegram. Sem um terceiro caminho, o comportamento previsível do usuário real é
colar a senha no chat — exatamente o que o plano proíbe. O mecanismo é o de
`02-SEGURANCA.md` §5.3 e a decisão de default é a de `09-DECISOES-CANONICAS.md` D3.

```
Dono no celular:  /acessar
                     │
Plugin (local):      ├─ verifica from.id ∈ ALLOWLIST  E  chat.id ∈ ALLOWLIST
                     ├─ verifica que o túnel está READY (senão, oferece /ligar)
                     ├─ mk = randomBytes(16)              # 128 bits, base64url
                     ├─ guarda sha256(mk) SÓ EM MEMÓRIA { exp: now+120s, usado: false }
                     └─ envia (disable_web_page_preview: true):
                          https://<host-do-tunel>/__guard/magic#<mk>
                                                          ↑
                                        FRAGMENTO — nunca query string
Dono clica:          GET /__guard/magic   →  página INERTE: HTML estático que lê
                                             location.hash e espera um clique explícito
                     POST /__guard/magic { mk }  →  valida (timingSafeEqual sobre digests),
                                             marca usado, emite __Host-dsh_sid, redireciona
                                             e dispara ALERTA de sessão nova no Telegram
```

**Três controles obrigatórios, e nenhum é opcional:**

1. **`GET` é inerte.** Ele não consome nada. Se o `GET` consumisse, o *link preview* do próprio
   Telegram, ou qualquer scanner de antiphishing que veja a mensagem, queimaria o `mk` antes de o
   dono tocar na tela — e o dono receberia "link já usado" sem ter usado.
2. **O `mk` viaja no fragmento (`#`).** Fragmento não é enviado ao servidor nem propagado em
   `Referer`, logo não entra em log de servidor nem em log de proxy.
3. **Consumo sem clique detectável** não emite sessão, não queima o `mk`, e registra
   `magic.crawler-suspect` no audit log.

**Default:** `control.magicLink` é **`true`** quando `exposure.mode: 'tunnel'` e **`false`** em
`mode: 'loopback'`. O que existe é **opt-out**, não opt-in. Com o opt-out ligado, o caminho para o
celular passa a ser o **QR code ASCII** impresso pelo `bin/dsh-guard-setup` junto com a senha,
lido antes de sair de casa.

**O que o `mk` é e o que ele não é.** Ele é um bearer de 128 bits, TTL 120 s, uso único, que vive
**só em memória do processo** (some no restart) e está sob o mesmo rate limit e o mesmo teto de
falhas do login. Ele **não** é o segredo permanente, e o invariante testado (`SEC-14`) é sobre o
segredo permanente, não sobre o `mk` — essa distinção precisa estar clara para quem for
implementar, porque um teste que proíba *qualquer* credencial no payload do Telegram proibiria o
próprio mecanismo.

**Reconhecimento honesto, que pertence ao modelo de ameaça e não à seção de features:** com o
magic link ligado, **quem controla o canal do Telegram tem uma raiz de autenticação equivalente à
senha** — `/acessar` emite sessão sem que ninguém digite o segredo. A allowlist de `from.id`/
`chat.id` não é "defesa em profundidade" nesse desenho; ela **é** a segunda raiz de confiança. É
por isso que o pareamento por código de 6 dígitos (§9.5) não é higiene: ganhar a corrida do
pareamento equivale a ter a senha.

**Onde o token do bot é gravado — divergência resolvida.** `$XDG_STATE_HOME/dsh-guarded-bot/secrets.env`
(`0600`, diretório `0700`, **fora do workspace**), como manda `02-SEGURANCA.md` §8.1, **ou**
variável de ambiente do processo do DSH. **Nunca** no `.env` do projeto: o `.env` do projeto
está dentro do workspace que o agente lê, e prompt injection é premissa operacional deste
plano (`02-SEGURANCA.md` §2.4), não risco residual. `04-TESTES.md` TG-067/TG-068 foram
corrigidos para asserir esse caminho.

---

## 10. Mapa de serviços e eventos Cordis

### 10.1 Serviços injetados

```ts
export const inject = ['webServer', 'subprocess', 'logger']
```

É a lista atual do `src/index.ts`. **Aviso de verificação obrigatória:** a pesquisa
verificada contra os tarballs reais do npm indica que:

- o serviço do servidor HTTP se chama **`ctx.httpServer`**, classe `HttpServerService`, do
  pacote `@deepseek-ai/dsh-host-webserver` — o typings real diz
  `interface Context { httpServer: HttpServerService }`, e **não existe** símbolo
  `WebServer` no pacote. `WebRoute` existe e está correto;
- o `SubprocessService` vive em **`@deepseek-ai/dsh-subprocess`** (implementação local em
  `@deepseek-ai/dsh-subprocess-local`), e **`@deepseek-ai/dsh-host-subprocess` devolve
  HTTP 404** no npm;
- a assinatura real é **`spawn(spec: SubprocessSpawnSpec): SubprocessHandle`** — objeto
  único com `argv: readonly string[]`, `cwd: string`, `stdio: SubprocessStdio`,
  `graceMs: number` obrigatórios e `signal?: AbortSignal` — e **não**
  `spawn(cmd, args, opts)`. Não há migração "por cima": as chamadas precisam ser
  reescritas;
- o dono do fallback de `dist` é `@deepseek-ai/dsh-host-frontend-static`, não
  `dsh-host-frontend`.

Os `.d.ts` locais em `types/` foram escritos a partir dos markdowns e herdaram os nomes
errados. **A Onda 0 de `03-ONDAS.md` resolve isso contra os artefatos reais antes de
qualquer código novo** — `git clone` do repositório ou download dos tarballs npm, que já
vêm com `.d.ts` e README por pacote. Toda a arquitetura acima é agnóstica ao nome; muda
`import` e `inject`, não o desenho.

Segundo alerta de compatibilidade: todo o ecossistema está em `0.0.1-rc` / `0.1.0-rc` e o
próprio README do DSH avisa "developer preview, expect breaking changes". Pinar versões
exatas e assumir retrabalho.

### 10.2 Eventos declarados por este plugin (module augmentation)

Os dois já existentes permanecem:

```ts
'http/auth-check'(req: IncomingMessage, next: () => Promise<boolean>): Promise<boolean>
'security/permission-elevate'(command: string, next: () => Promise<boolean>): Promise<boolean>
```

> **Correção obrigatória de leitura.** Chamar esses dois de "já existentes" é enganoso e
> precisa parar. **Ambos são declarados por *module augmentation* deste plugin.**
> `http/auth-check` é a cascata do próprio plugin e funciona porque o próprio plugin a
> dispara. `security/permission-elevate` só produz efeito se **o host emitir** — e o
> `README.md` deste repositório já documenta, por escrito, que **nenhum componente
> documentado do DSH o emite** (a busca nos markdowns-fonte devolve zero ocorrências).
> Consequência: **o veto I4 é decoração enquanto ninguém emitir o evento**, e I4 era a
> defesa que `02-SEGURANCA.md` §2.4 vendia contra o padrão CVE-2025-53773.
> **NÃO CONFIRMADO — spike obrigatório (S11, T0.1):** existe algum ponto no DSH real que
> emita `security/permission-elevate`? Se não, o hook fica como defesa em profundidade
> pronta para o dia em que passe a existir, **e nenhum documento deste plano pode contá-lo
> como camada ativa** — nem a §3 de `02-SEGURANCA.md`, nem a §2.4, nem o README.

Três novos:

**Dono declarado:** a *module augmentation* dos três eventos abaixo é entrega de **T5.1**
(`03-ONDAS.md` §10), no arquivo `src/control/events.ts`. Na revisão anterior nenhuma
sub-tarefa a possuía, e `04-TESTES.md` CTL-030/CTL-036 testavam eventos que ninguém tinha
sido mandado escrever. O prefixo acompanha a decisão de rota: **`guard/`**, não `mobile/`.

```ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** @mode parallel — difusão de estado. Nenhum assinante pode vetar. */
    'guard/state-changed'(snapshot: StateSnapshot): Promise<void>

    /** @mode waterfall — around-middleware sobre comandos de controle.
     *  Retornar false sem chamar next() veta o comando. */
    'guard/command'(cmd: ControlIntent, next: () => Promise<boolean>): Promise<boolean>

    /** @mode waterfall — permite a outro plugin substituir a política de entrega
     *  do link (encurtador, canal alternativo, marca d'água). */
    'guard/tunnel-url'(url: string, next: () => Promise<string>): Promise<string>
  }
}
```

Escolha de modo, justificada: difusão de estado é `parallel` porque um assinante lento não
pode bloquear a máquina de estados e nenhum deles tem legitimidade para vetar um fato
consumado. Comandos são `waterfall` porque a semântica desejada é exatamente a de veto — o
primeiro ouvinte que responde sem invocar `next()` corta a cascata. Isso herda a
propriedade já documentada no README do repositório: num `waterfall` ganha o **primeiro**
ouvinte, ou seja, outro plugin registrado antes pode aprovar um comando que este vetaria.
O `next` terminal repete a política, mantendo o comportamento fail-closed quando não há
ouvinte nenhum.

As APIs do Cordis usadas aqui foram confirmadas no `.d.ts` do pacote real
`@deepseek-ai/cordis@4.0.1`: `intercept(name: string, config: any): this`,
`waterfall`, `parallel`, `effect`, `on`, o tipo `DispatchMode` e a classe `Fiber` com
disposers e HMR.

### 10.3 Recursos alocados e ordem de reversão

Ordem de alocação em `apply()`, deliberada — disposers rodam em **LIFO**, logo o último
alocado é o primeiro a morrer:

| # | Recurso | Alocação | Disposer |
| - | ------- | -------- | -------- |
| 1 | Ouvinte `security/permission-elevate` | `ctx.effect(() => ctx.on(...))` | remove a assinatura |
| 2 | Ouvinte `http/auth-check` | `ctx.effect(() => ctx.on(...))` | remove a assinatura |
| 3 | Intercept do serviço de servidor HTTP | `ctx.intercept('<serviço>', {...})` | o contexto derivado se desfaz sozinho |
| 4 | Rotas `/__guard/*` | `ctx.effect(() => composeDisposers(register(...)))` | desregistra todas as rotas |
| 5 | `StateMachine` + persistência | `ctx.effect(() => ...)` | marca `tunnelOrphanSuspected`, flush final do estado, para o writer |
| 6 | `TunnelSupervisor` (cloudflared) | `ctx.effect(() => ...)` | **teardown duro e confirmado** — ver a regra abaixo; limpa timers |
| 7 | `BotSupervisor` + `BotBridge` | `ctx.effect(() => supervisor.dispose)` | fecha `stdin` (dispara o EOF do dead-man's switch), tree-kill, limpa timers |

> ### A janela de 2 segundos com túnel vivo e gate já removido — corrigida
>
> A composição anterior era **insegura e a crítica adversarial está certa**. Em LIFO o
> túnel (#6) morre antes do intercept (#3), mas o disposer do túnel era declarado
> **síncrono** — "manda `SIGTERM`, agenda o `SIGKILL` e **retorna**" — e o `SIGTERM` do
> `cloudflared` leva ~2 s (medido, §8.3). O intercept é desfeito **no mesmo tick**, e
> `04-TESTES.md` LIFE-007 prova o efeito: *"após dispose, requisição a rota guardada passa
> **sem** gate"*. Num HMR do plugin ou num recarregamento de config, isso publica
> `/api/commands/execute` **sem credencial** por ~2 s numa URL que scanners já conhecem.
> Não é possível ter as três coisas ao mesmo tempo: disposer síncrono + ordem LIFO + morte
> confiável. **Regra normativa nova, que escolhe qual das três cede:**
>
> 1. **O disposer do túnel é síncrono e *duro*.** Quando o estado é `READY`/`STARTING`, o
>    caminho de disposer **não** usa `SIGTERM` com timer: aplica `SIGKILL` ao **grupo**
>    (`process.kill(-pid, 'SIGKILL')`) e **confirma** a morte com um laço limitado de
>    `process.kill(pid, 0)` até `ESRCH` (teto de ~50 ms, sem `await`). Só então retorna.
>    O `SIGTERM` gracioso continua existindo — mas **só no caminho de `stop()` iniciado pelo
>    dono**, que é assíncrono, tem estado `STOPPING` e não corre contra disposer nenhum.
> 2. **Antes de tudo, o disposer marca `tunnelOrphanSuspected: true` no `state.json`**
>    (escrita atômica, síncrona). Se o `SIGKILL` não pegar, o **boot seguinte** reapa o
>    órfão antes de qualquer outra inicialização — ver a §9 de `02-SEGURANCA.md`.
> 3. **LIFE-007 muda de asserção.** "Após dispose a rota guardada passa sem gate" só pode
>    ser asserido com `exposure.mode: 'loopback'`. Com `exposure.mode: 'tunnel'` a asserção
>    correta é: **após dispose não existe processo `cloudflared` vivo** — logo não existe
>    caminho de fora para a rota desguardada. `04-TESTES.md` §5.6 foi corrigido.

Regras que a implementação precisa manter, todas já respeitadas pelo código atual:

- **Todo disposer é síncrono.** O `.d.ts` local avisa que o compilador não consegue
  impedir um disposer `async` (bivariância de retorno `void`), mas que o motor trata uma
  `Promise` como já concluída e a ordem LIFO quebra em silêncio. Para o `cloudflared` isso
  **não** significa "manda o sinal e retorna": significa `SIGKILL` no grupo + confirmação
  por `kill(pid, 0)` em laço limitado, como fixado no quadro acima. Um disposer que retorna
  antes de o recurso morrer é, neste sistema, uma janela de exposição pública.
- **Todo registro devolve o disposer nativo.** Engolir o disposer devolvido por
  `register` / `registerFallback` / `registerUpgrade` torna a barreira impossível de
  desmontar.
- **Nenhum `await` de rede dentro de ouvinte de evento.** `ctx.parallel` espera o retorno
  exaustivo dos assinantes e `ctx.waterfall` bloqueia a cascata. Reagendamento é
  fire-and-forget via `setTimeout`, com o handle guardado para o `clearTimeout` do
  disposer — exatamente o padrão que o supervisor atual já implementa e documenta.
- **Tree-kill sem a guarda `!child.killed`.** O `abort()` chama `child.kill()` de forma
  síncrona, então `killed` já é `true` na linha seguinte; a guarda torna o tree-kill
  código morto e deixa netos órfãos. Está medido e documentado no repositório; não
  "corrigir" de volta.
- **Evento terminal é `'close'`, não `'exit'`.** No caso ENOENT (binário ausente) a
  sequência medida é `error → close`, e `'exit'` **nunca** dispara. Um supervisor que
  espera por `'exit'` trava para sempre no modo de falha mais comum — que é exatamente o
  caso do `cloudflared` não instalado.

---

## 11. O que se reaproveita do plugin existente

Item a item. Nada aqui é reescrito do zero.

### 11.1 Mantém-se sem alteração

| Símbolo em `src/index.ts` | Por que continua válido |
| ------------------------- | ----------------------- |
| `verifyBasicAuth` | Comparação em tempo constante sobre digests SHA-256 de comprimento fixo (evita o `RangeError` do `timingSafeEqual` com buffers de tamanhos diferentes, que vazaria o comprimento); esquema case-insensitive conforme RFC 7235 §2.1 |
| `normalizeRemoteAddress` | Colapso de `::ffff:` e `::1`; continua necessário com o túnel |
| `isTrustedRemote` | Semântica fail-closed (lista vazia nega tudo). O **código** se mantém; o **peso** que ele tem some (§4.2). **Correção:** ele também **não** protege a LAN, porque `assertSecureBind` trava o bind em `127.0.0.1` e nenhum host da LAN chega a abrir o socket. É código morto em todos os modos, mantido por higiene e por defesa contra um bind futuro mal configurado — **nenhuma mensagem, log ou doc pode listá-lo como proteção** |
| `canonicalRequestPath`, `isGuardedPath`, `routeMayServeGuardedPath` | Neutralização de percent-encoding iterado, `\`, `//`, `.`/`..` e caixa; distinção descendente/ancestral. É o miolo anti-evasão e fica ainda mais crítico com exposição. **MANTÉM o código, MUDA a política:** `routeMayServeGuardedPath` é default-**allow** e, sob túnel, isso é default-**open para a internet** — ver §3(e), "terceira armadilha". Com `exposure.mode: 'tunnel'`, `alwaysGuarded: true` é obrigatório e a decisão passa a ser por allowlist de exceções |
| `requestsDeniedPermission`, `canonicalizePermissionToken` | Tokenização endurecida do veto de permissões |
| `computeBackoffDelay` | Jitter somado por cima da base, nunca subtraído; contrato `base ≤ atraso ≤ min(base*1.5, max)` |
| `assertSecureBind`, `WILDCARD_BIND_HOSTS` | O bind continua travado em loopback. É a peça que **não** muda apesar de o objetivo ser expor |
| `assertValidConfig` e os `assert*` auxiliares | Disciplina *fail loud at load*; ganham novas asserções, não novo estilo |
| `assertUsableCredential` + `PLACEHOLDER_CREDENTIAL_PARTS` | Impede a credencial `undefined:undefined`, derivável por qualquer pessoa |
| `denyUntrustedOrigin`, `challengeBasicAuth`, `denyUpgrade` | Escrita direta em socket cru, com CRLF explícito no caminho de upgrade |
| `createGuardedHandler`, `createGuardedUpgradeHandler` | Incluindo a decisão de **não consumir o corpo** da requisição |
| Interceptação tripla `register` + `registerFallback` + `registerUpgrade` | As três continuam necessárias; a de upgrade ainda mais com o túnel — WebSocket sem validação de Origin é CWE-1385, a classe de bug que gerou CVE-2023-26114 (code-server, CVSS 9.3) e CVE-2025-52882 (extensões IDE do Claude Code) |
| `nodeScheduler`, `Scheduler`, `SupervisorDeps` | Injeção de dependências que torna o supervisor testável de forma determinística |
| `buildWorkerEnv` + `WORKER_ENV_ALLOWLIST` | A fronteira que impede o segredo do gate de chegar ao consumidor de internet. É a razão técnica da decisão da §5 |

### 11.2 Muda (evolução, não reescrita)

| O quê | De | Para |
| ----- | -- | ---- |
| `Config` | Objeto plano com um `worker` | Acrescenta `exposure`, `tunnel`, `control`; `worker` vira `workers.bot` |
| `worker.command` | `python3 bot_long_polling.py` | Entrypoint Node (grammY), mesmo formato de spawn |
| `WORKER_ENV_ALLOWLIST` | Chaves de Python (`PYTHONHOME`, `PYTHONPATH`, …) | Chaves mínimas de Node; **`NODE_OPTIONS` fica de fora** (permite `--require`, ou seja, carga de código arbitrário no filho) |
| `stdio` do worker | `['ignore','pipe','pipe']` | `['pipe','pipe','pipe']` — abre o canal de comando |
| `onStdout` | Log em `logger.debug` | Parser JSONL por linha; log humano do filho migra para `stderr` |
| `createWorkerSupervisor` | Um supervisor, sem readiness | Parametrizado, com hook opcional de readiness (exigido pelo `cloudflared`) e classificação de erro não-retryable (`ENOENT`, `EACCES`) |
| Disposer do supervisor | `abort()` + `SIGKILL` no grupo | `SIGTERM` no grupo → graça → `SIGKILL`. O `cloudflared` sai limpo em ~2 s com `SIGTERM` e libera o registro na borda; `SIGKILL` direto é desnecessariamente brutal |
| Avisos de arranque | 4 avisos (`trustedRemotes` vazio, `guardedPrefixes` vazio, `deniedPermissions` vazio, ordem de carregamento) | Acrescenta o aviso de `exposure.mode === 'tunnel'` (§4.3, regra 4) |
| `exhausted` | Estado terminal só do bot | Passa a existir também no túnel, alimentando `DEGRADED` → `FAILED` (orçamento esgotado é terminal e só sai por `reset()` humano; ir para `STOPPED` sozinho apagaria a evidência de que algo falhou) |
| `cordis.patch.yml` | Perfil único que registra o plugin | Acrescenta as chaves de `exposure`/`tunnel`; a decisão de manter isso como Camada 2 (Profile) e **não** declarar `dsh.bundle.patch` está documentada na chave `//dsh` do `package.json` e é revisitada em `07-COMUNIDADE.md` |

### 11.3 É novo

- `StateMachine` + `StateSnapshot` + persistência atômica com `rename`.
- `TunnelSupervisor` com readiness por `/quicktunnel` e fallback por regex em `stderr`.
- `BotBridge` (codec JSONL, janela de `requestId`, sequenciação por `seq`).
- Rotas `/__guard/*` e o painel HTML sem build.
- Pacote/entrypoint do bot em Node + grammY, com allowlist por `from.id` **e** `chat.id`.
- Rate limiting e lockout no gate, obrigatórios quando `exposure.mode === 'tunnel'`.
- Sub-máquina de onboarding (§9.5).
- Confirmação em duas etapas com token efêmero para comandos destrutivos.

---

## 12. Pontos NÃO CONFIRMADOS que este documento assume

Declarados para que as ondas de execução os tratem como verificação, e não como fato.

1. **Nomes de serviço, de pacote e assinatura de `spawn`** (§10.1). Os `.d.ts` locais
   declaram `ctx.webServer` / `WebServer` / `@deepseek-ai/dsh-host-subprocess`. A
   verificação contra o npm indica `ctx.httpServer` / `HttpServerService` /
   `@deepseek-ai/dsh-subprocess`, e que `@deepseek-ai/dsh-host-subprocess` devolve 404.
   **Ainda NÃO CONFIRMADO por inspeção direta neste repositório.**
2. **`registerUpgrade`.** É usado pelo plugin atual e declarado no `.d.ts` local, mas a
   pesquisa só confirmou `WebRoute` como tipo real do pacote publicado. Se
   `registerUpgrade` não existir na distribuição instalada, a guarda de WebSocket precisa
   de outro ponto de enganche — e isso é bloqueador de segurança, não detalhe.
   **Plano B escrito (faltava, e a crítica está certa em apontar):** sem ponto de enganche
   no handshake, `exposure.mode: 'tunnel'` é **proibido** — `assertValidConfig` recusa o
   boot com mensagem acionável, e o modo `loopback` segue funcionando. Não se abre túnel
   sobre um WebSocket desguardado: é literalmente CWE-1385, a classe de CVE-2023-26114
   (code-server, CVSS 9.3) e CVE-2025-52882 (extensões IDE do Claude Code). Isso vira
   **gatilho obrigatório de replanejamento** em `03-ONDAS.md` §13.3, não uma nota.
3. **Diretório de estado por plugin.** Assume-se um caminho gravável e estável.
   **NÃO CONFIRMADO** qual é o canônico nem se o DSH oferece API para isso.
   **Roteado:** spike **S9**, entrega de **T0.1** (é ela quem lê os `.d.ts` reais do host),
   consumido por T2.5. Se a resposta for "não existe API do host", o default XDG fica e o
   código **documenta** que a escolha é do plugin, não contrato do hospedeiro.
4. **`/quicktunnel`.** Verificado empiricamente no `cloudflared` 2026.7.3, mas **não
   documentado** na página oficial de métricas. É a razão de existir o fallback.
5. **Limite de 50 usuários do plano Zero Trust gratuito.** Reportado consistentemente por
   fontes terceiras, **NÃO CONFIRMADO** em documentação oficial atual da Cloudflare (as
   páginas de seat management, users e FAQ não citam o número; o único documento hospedado
   pela Cloudflare é um PDF de pricing de Q4 2022). Não deve entrar em promessa nenhuma
   ao usuário.
6. **Argon2id vs hash rápido para o segredo do gate.** A leitura de que o ASVS 5.0 §6.5.2
   autoriza hash rápido para qualquer token de ≥112 bits foi **REFUTADA**: a citação é
   real, mas o escopo do requisito é *lookup secrets* (códigos de recuperação de MFA), e a
   norma é **silente** sobre tokens de sessão/API em geral. A decisão final de KDF fica em
   `02-SEGURANCA.md`, com essa ressalva explícita — não como se a norma decidisse por nós.
7. **Benchmarks do `jcode` e o pacote `pi2dsh`**, citados nos markdowns-fonte: **NÃO
   CONFIRMADOS** por nenhuma fonte primária. Não são usados neste plano.

8. **`SubprocessSpawnSpec` não declara `env`, nem `detached`, nem `pid` no
   `SubprocessHandle`.** **NÃO CONFIRMADO — spike obrigatório (S1, ampliado), e é
   bloqueador.** A assinatura verificada é
   `spawn(spec): SubprocessHandle` com `argv`, `cwd`, `stdio`, `graceMs` obrigatórios e
   `signal?`. Se não houver campo `env`, o filho **herda `process.env` inteiro** — e
   `buildWorkerEnv()`, que a §5 chama de "a única defesa entre um parser de mensagens da
   internet e a credencial do plano de controle", **desaparece em silêncio**. Se não houver
   `detached` nem `pid`, `process.kill(-pid)` não existe e o `cloudflared` órfão deixa de
   ser risco residual (§11.7 de `02`) para virar comportamento normal. Plano B, obrigatório
   e escrito: **o plugin passa a usar `node:child_process` diretamente** para os dois filhos
   (é código do próprio plugin, dentro do processo do DSH, e não depende do serviço do
   host); se nem isso for possível no ambiente de execução do DSH,
   `exposure.mode: 'tunnel'` e `workers.bot.enabled` são **proibidos** no load. E o
   `graceMs` obrigatório significa que o serviço do DSH **já faz** seu próprio
   SIGTERM→SIGKILL: S1 tem de medir se ele colide com o do supervisor.

9. **`ctx.intercept` sobre o serviço HTTP real nunca foi observado funcionando.** O
   `README.md` deste repositório afirma reprodução em laboratório do comportamento do gate
   (401 com ordem certa, 200 com ordem errada), enquanto `02-SEGURANCA.md` §12.6 afirma que
   o `src/index.ts` atual **não compila** contra os pacotes reais e que "hoje o gate não
   existe em runtime". **As duas não podem ser verdade ao mesmo tempo.** Leitura correta: a
   reprodução ocorreu contra os **stubs locais**, que compilam; contra os pacotes reais o
   mecanismo é **não verificado**. Como `ctx.intercept` é a base de tudo, isto vira o
   **spike S0**, o primeiro de todos, na entrega de T0.1 — não uma nota de errata.

10. **`crypto.argon2()` / `argon2Sync()` nativos desde o Node v24.7.0.** Citado como fato em
    `02-SEGURANCA.md` §4.2 e `08` §3.1, **sem URL com âncora**. Como a decisão do plano é
    *não* usar Argon2 hoje, é inofensivo agora — mas é obrigação futura ("no dia em que o
    usuário escolher a senha"). **NÃO CONFIRMADO;** verificar antes de qualquer entrega que
    dependa dele.

11. **Superfície de CLI do DSH (`dsh plugin add`, `dsh plugin --profile web add <pkg>`).**
    É critério de aceite de T1.1 e T1.3, num projeto cuja tese de abertura é "a camada de
    API dos markdowns está contaminada", e **nenhum spike da Onda 0 a cobria**. Mesmo risco
    dos nomes de serviço, sem a mesma verificação. **NÃO CONFIRMADO — roteado a T0.4.**

12. **`Secure` e prefixo `__Host-` sobre `http://127.0.0.1`.** O painel local roda sem TLS.
    Chrome e Firefox toleram `Secure` em localhost; Safari historicamente não. Não havia
    NÃO CONFIRMADO registrado, e o painel local é o caminho de recuperação de
    `02-SEGURANCA.md` §11.2. **NÃO CONFIRMADO — roteado a T2.2**, com plano B: sobre
    loopback sem TLS, o cookie cai para `dsh_sid` com `Path=/__guard`, `HttpOnly`,
    `SameSite=Lax` e **sem** `Secure`; sobre o túnel (sempre HTTPS) vale `__Host-dsh_sid`
    completo. A escolha é feita por requisição, a partir do esquema efetivo, e **nunca** a
    partir de `X-Forwarded-Proto`, que é forjável.

---

## 13. Referências citadas

**DeepSeek Harness**

- Repositório: <https://github.com/deepseek-ai/deepseek-harness>
- Discussão #853 — RCE não autenticada no plano de controle da Web UI:
  <https://github.com/deepseek-ai/deepseek-harness/discussions/853>
- Discussão #1769 — escape do sandbox `bwrap workspace-write`:
  <https://github.com/deepseek-ai/deepseek-harness/discussions/1769>
- Discussão #441 — reescrita não atômica do `cordis.yml` no arranque:
  <https://github.com/deepseek-ai/deepseek-harness/discussions/441>
- Cordis upstream: <https://github.com/cordiverse/cordis>

**Cloudflare**

- TryCloudflare (quick tunnels, limites, aviso "testing and development only"):
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>
- Políticas do Access (Allow/Block/Bypass/Service Auth, deny-by-default):
  <https://developers.cloudflare.com/cloudflare-one/policies/access/>
- Métricas do túnel (documenta `/metrics`; **não** documenta `/quicktunnel`):
  <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/>
- Downloads e repositório apt assinado: <https://pkg.cloudflare.com/>
- `cloudflare/cloudflared` issue #1449 — buffering de SSE em `GET`, mas não em `POST`:
  <https://github.com/cloudflare/cloudflared/issues/1449>

**Telegram**

- Bot API (`getUpdates`, 409, `answerCallbackQuery`, `editMessageText`, `deleteMessage`,
  `callback_data`): <https://core.telegram.org/bots/api>
- Features do BotFather — *"Keep your token secure… it can be used by anyone to control
  your bot"*: <https://core.telegram.org/bots/features#botfather>
- FAQ — *"any bot should be treated as a stranger — don't give them your passwords"*:
  <https://core.telegram.org/bots/faq>
- Criptografia (cloud chats vs secret chats): <https://telegram.org/faq#q-so-how-do-you-encrypt-data>
- grammY: <https://grammy.dev/guide/errors>

**Node.js e processos**

- `child_process` — `detached`, netos não terminados ao matar o pai, `'close'` vs `'exit'`:
  <https://nodejs.org/api/child_process.html>
- `crypto` — `randomBytes`, `timingSafeEqual`, `argon2` (Node ≥ 24.7.0):
  <https://nodejs.org/api/crypto.html>

**Exposição e ameaça**

- urlscan.io API (busca pública de `page.domain:trycloudflare.com`):
  <https://urlscan.io/docs/api>
- Proofpoint — abuso de TryCloudflare para distribuir RATs:
  <https://www.proofpoint.com/us/blog/threat-insight/threat-actor-abuses-cloudflare-tunnels-deliver-rats>
- Arctic Wolf — Akira usando `cloudflared` como persistência:
  <https://arcticwolf.com/resources/blog/smash-and-grab-aggressive-akira-campaign-targets-sonicwall-vpns/>
- OWASP ASVS 5.0 (V6 Authentication, V7 Session, V11 Cryptography, V13 Configuration):
  <https://github.com/OWASP/ASVS>
- NIST SP 800-63B rev.4 (rate limiting, sessão, CSRF): <https://pages.nist.gov/800-63-4/sp800-63b.html>

---

## 14. Correções aplicadas após a revisão adversarial e de completude

Registradas aqui para que nenhuma leitura futura reintroduza o desenho antigo achando que
está corrigindo um esquecimento.

| # | O que estava errado | Onde foi corrigido |
| - | ------------------- | ------------------ |
| 1 | Três prefixos de rota concorrentes (`/__mobile`, `/__guard`, `/__gate`) | §3(e) — tabela canônica única sob `/__guard`, com política por rota |
| 2 | `guardedPrefixes` default-**allow** virando default-open para a internet sob túnel | §3(e) "terceira armadilha" + §4.3 (`alwaysGuarded` obrigatório) + §11.1 |
| 3 | Janela de ~2 s com túnel vivo e gate já removido (dispose/HMR) | §10.3 — disposer duro e confirmado, `tunnelOrphanSuspected`, LIFE-007 reescrito |
| 4 | Dois vocabulários de máquina de estados, com semânticas diferentes | §6 — enum único de seis estados, `DEGRADED` ≠ `FAILED` |
| 5 | Dois nomes para o arquivo de estado e nenhum dono do writer | §6 — `state.json` único, dono `src/state/**` em T2.5 |
| 6 | Onboarding por "primeiro `/start` vence" contra pareamento de 6 dígitos | §9.5 — vale o pareamento; `getUpdates` é só transporte |
| 7 | Token do bot no `.env` do projeto contra `secrets.env` fora do workspace | §9.5 — vale `secrets.env`, com a razão (prompt injection) |
| 8 | `mobile/*` sem dono e sem *module augmentation* declarada | §10.2 — renomeados para `guard/*`, dono T5.1 |
| 9 | `security/permission-elevate` tratado como camada ativa | §10.2 — ninguém emite; é decoração até S11 dizer o contrário |
| 10 | Ausência de schema canônico de `Config` e default divergente | §4.3 — bloco completo e normativo, default `exposure.mode: 'loopback'`, com **dois** valores legais (`loopback \| tunnel`); `04-TESTES.md` TENSAO-003, que diz `off`, é o caso que muda |
| 11 | DNS rebinding e cabeçalho `Host` sem nenhuma menção no plano | §4.5 — camada nova, 403 antes de 401 |
| 12 | `IPC` com `"type":"cmd"` contra o contrato congelado `intent` | §5 — exemplos corrigidos para `intent` |
| 13 | `InlineKeyboardButton.style` como fato | §7.2 — NÃO CONFIRMADO, spike S10, fallback textual é o default |
| 14 | `registerUpgrade` sem plano B | §12 item 2 — sem enganche, `mode: 'tunnel'` é proibido |
| 15 | `SubprocessSpawnSpec` sem `env`/`detached`/`pid` tratado como detalhe | §12 item 8 — bloqueador, com plano B |
| 16 | `trustedRemotes` creditado como proteção de LAN | §11.1 — não protege; o bind já impede o socket |
