# 08 — Pesquisa e Fontes

Dossiê de evidências que sustenta todo o plano (arquivos `01` a `07`). Nenhuma decisão
de arquitetura, número, flag, endpoint ou nome de pacote deve entrar no código sem
ter uma linha aqui.

**Data do levantamento:** 2026-08-19. Todo dado de versão, contagem de estrelas,
disponibilidade de nome no npm e convite de Discord tem validade curta — revalide
antes de usar em documento permanente.

**Regra de uso deste documento:**

1. Se uma afirmação **não aparece aqui**, ela não foi verificada — trate como suposição
   e abra spike (§9).
2. Se aparece em **Claims refutadas**, ela **não pode** ser usada como justificativa
   técnica em PR, README, post de divulgação ou comentário de código — ainda que
   apareça nos 4 markdowns de `/home/ondokai/Documents/deepseek-harness`.
3. Revisor adversarial tem o **dever** de rejeitar PR que use claim refutada e o
   **direito** de rejeitar número sem fonte.

**Legenda de confiança:**

| Nível | Significado |
|---|---|
| **Alta** | Fonte primária lida no raw (doc oficial, `.d.ts`, código-fonte) **ou** medição local reproduzida |
| **Média** | Fonte oficial parcial, ou terceiro consistente, ou medição única |
| **Baixa** | Terceiro isolado, doc desatualizada, ou alegação não reproduzível |
| **NÃO CONFIRMADO** | Tentou-se verificar e não se conseguiu. Vira spike, nunca premissa |

---

## 0. Veredito do recon: o DeepSeek Harness é REAL

> ## ✅ CONFIRMADO POR HTTP DIRETO, NÃO POR RESUMO DE MODELO
>
> O DeepSeek Harness **existe**, é **MIT**, e recebeu push no mesmo dia da pesquisa.
> **Não é alucinação.** O projeto pode ser construído.
>
> **Mas:** os 4 markdowns em `/home/ondokai/Documents/deepseek-harness` são prosa
> gerada por LLM sobre um projeto real. Eles **acertam a arquitetura e erram a API**.
> O código de exemplo deles **não compila**. Esse é o pior tipo de fonte: a
> credibilidade macro esconde os erros micro.

### 0.1 Evidências de existência (nível macro) — todas HTTP 200

| Evidência | Detalhe | Confiança |
|---|---|---|
| Repositório | `GET https://api.github.com/repos/deepseek-ai/deepseek-harness` → **HTTP 200**. `id=1333065091`, `description="DeepSeek Harness: Everything is a Plugin."`, `stargazers_count=166821`, `forks=17790`, `created_at=2026-08-13T11:56:32Z`, `pushed_at=2026-08-19T15:37:57Z`, `license=MIT`, `default_branch=master`, `homepage=https://deepseek.com/harness`, topics `ai-agents`/`cordis`/`dsh`/`dsh-plugin` | **Alta** |
| README upstream | `raw.githubusercontent.com/.../master/README.md`: confirma *"built on Cordis"* com link para `github.com/cordiverse/cordis`, cita o paper *"A Programming Paradigm for Spatiotemporal Composability"*, install `npx @deepseek-ai/dsh web` na porta **127.0.0.1:3080**, build por **pnpm**, status **"developer preview"** com breaking changes esperadas | **Alta** |
| npm — Cordis vendorizado | `@deepseek-ai/cordis` HTTP 200, latest **4.0.1**, `repository=git+https://github.com/deepseek-ai/deepseek-harness.git` com `directory=vendor/cordis`. É um Cordis **vendorizado dentro do monorepo do DSH**, não o `cordis` upstream | **Alta** |
| npm — pacotes do host | `@deepseek-ai/dsh-host-webserver` HTTP 200 (latest `0.0.1-rc.1`, next `0.1.0-rc.8`); `@deepseek-ai/cordis-plugin-include` HTTP 200 (`1.0.6`); `@deepseek-ai/dsh` HTTP 200 (`0.1.0-rc.7`) | **Alta** |
| Cordis é anterior e independente | `api.github.com/repos/shigma/cordis` redireciona para `cordiverse/cordis`, HTTP 200, criado **2022-05-17**, **6.382** estrelas, description literal *"Meta-Framework of Spatiotemporal Composability"*. Koishi (`koishijs/koishi`, mesmo autor) 6.031 estrelas. `packages/core/src/context.ts` L71-76 já tem `intercept(name, config)`. A homepage do `cordiverse/cordis` hoje aponta para `https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer` | **Alta** |
| APIs do Cordis | Lidas nos `.d.ts` reais de `@deepseek-ai/cordis@4.0.1`: `context.d.ts:99` `intercept(name: string, config: any): this`; `events.d.ts:25` `DispatchMode` com os cinco modos (`emit`, `parallel`, `serial`, `bail`, `waterfall`); `events.d.ts:77` `waterfall`; `events.d.ts:35` `parallel`; `utils.d.ts:27` `effect`; `fiber.d.ts` inteiro (classe `Fiber`, ciclo de vida, disposers, `internal/update` waterfall, HMR); `reflect.d.ts` define `Service`/`Property`; `inject` como `Dict<any>` resolvido por fiber | **Alta** |
| Ecossistema npm | Amostra literal do registry: `dsh-base`, `dsh-app-boot`, `dsh-web-app`, `dsh-headless`, `dsh-sandbox`, `dsh-sandbox-local`, `dsh-subagent`, `dsh-tool-subagent`, `dsh-mcp-client`, `dsh-user-approval`, `dsh-permission-presets`, `dsh-compaction`, `dsh-session-persistence`, `dsh-plan-mode`, `dsh-client-hmr`, `dsh-host-apiproxy`, `dsh-host-frontend-static`, `dsh-host-directory-picker`, `dsh-llm-deepseek`, `node-addon-landlock-run-linux-x64`. Confirma perfis/bundles, capability seams, sandbox ortogonal a approval, subagentes | **Alta** |
| Discussões de segurança | Todas HTTP 200 com título coerente: **#853** *"Security: unauthenticated local/remote code execution via the dsh web UI control plane (verified on 0.1.0-rc.6)"*; **#1769** *"[Security] bwrap workspace-write sandbox is escapable via mount -o remount,rw"*; **#3144** *"Sandbox denials are invisible to the model when the confined program rewrites the kernel error"*; **#441** *"[Bug] Profile cordis.yml is rewritten non-atomically on every boot"*. Também 200: #2678, #1390, #570. **Única inexistente: #176929 → HTTP 404** | **Alta** |

### 0.2 O problema real: a camada de API dos markdowns está contaminada

Quatro erros concretos, cada um suficiente para quebrar o build:

| # | O que os docs dizem | O que existe de verdade | Como corrigir |
|---|---|---|---|
| E1 | `import type { SubprocessService } from '@deepseek-ai/dsh-host-subprocess'` (doc *"Plugin Cordis DeepSeek Harness.md"*, linha 98) | **`@deepseek-ai/dsh-host-subprocess` → HTTP 404.** O serviço real vive em `@deepseek-ai/dsh-subprocess` (200); implementação local em `@deepseek-ai/dsh-subprocess-local` (200, depende de `node-pty`). O typings confirma `declare module '@deepseek-ai/cordis' { interface Context { subprocess: SubprocessService } }` | Trocar o import. O **conceito** `ctx.subprocess` está certo; o **pacote** está errado |
| E2 | `ctx.webServer`, tipo `WebServer`, `export const inject = ['webServer']`, `ctx.intercept('webServer', …)` (linhas 8/25/29/39) | Tarball real de `@deepseek-ai/dsh-host-webserver`: `interface Context { httpServer: HttpServerService }`. **Não existe símbolo `WebServer` no pacote.** `WebRoute` existe e está correto | `inject: ['httpServer']`, `ctx.intercept('httpServer', …)`, tipo `HttpServerService` |
| E3 | `ctx.subprocess.spawn('python3', ['bot_long_polling.py'], {...})` (linha 111, estilo `child_process`) | Assinatura real: `abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle` — **um único objeto** com campos obrigatórios `argv: readonly string[]`, `cwd: string`, `stdio: SubprocessStdio`, `graceMs: number` e `signal?: AbortSignal`. Existe também `abstract spawnTerminal(spec): Promise<SubprocessTerminalHandle>` | Reescrever toda chamada para `spawn({ argv: [cmd, ...args], cwd, stdio, graceMs, signal })`. **Não há migração "por cima"** — os quatro primeiros campos são obrigatórios |
| E4 | `dsh-host-frontend` | `@deepseek-ai/dsh-host-frontend` → **404**. O real é `@deepseek-ai/dsh-host-frontend-static` (200), que o README do webserver confirma como dono do fallback de `dist` (*"the SPA dist server dsh-frontend-static is the shipped owner"*) | Corrigir o nome |

### 0.3 Implicação prática — o que muda no plano

1. **Pare de usar os markdowns como fonte de API.** Use-os só no nível conceitual —
   plugins, perfis/bundles, capability seams, waterfall pre-execute/execute, sandbox
   ortogonal a approval, log append-only. Essa camada bateu com o código.
2. **Onda 0 é bloqueante:** `git clone https://github.com/deepseek-ai/deepseek-harness`
   (ou baixar os tarballs npm, que já vêm com `.d.ts` e README por pacote — foi assim que
   a pesquisa verificou tudo) e validar **cada símbolo** contra os `lib/types/*.d.ts`
   reais. Entregáveis: **`docs/spikes/api-dsh.md`** (a transcrição verificada, com a saída bruta
   colada) **+** o teste de contrato **`test/contract/dsh-types.test.ts`**.

   **Dois nomes que estavam divergindo e ficam alinhados aqui:**
   - O artefato de verdade da API é **`docs/spikes/api-dsh.md`** — é o caminho que o critério de
     aceite executável da Onda 0 verifica (`test -s docs/spikes/api-dsh.md`,
     `09-DECISOES-CANONICAS.md` §D25 item 17). O nome `docs/VERIFIED-API.md`, usado em revisões
     anteriores deste documento, **está morto**; onde ele ainda aparecer, leia
     `docs/spikes/api-dsh.md`.
   - O arquivo de teste de contrato é **`test/contract/dsh-types.test.ts`** (layout canônico de
     `09-DECISOES-CANONICAS.md` §D1), não `dsh-typings.test.ts`.

   O que **não** muda é a razão de nada disso morar em `types/`: esse diretório passa a ser
   **gerado** por `scripts/fetch-dsh-types.mjs` e marcado `linguist-generated=true`
   (`06-REPO-E-CI.md` §11.1); pôr prosa escrita à mão dentro de uma árvore gerada garante que ela
   seja apagada no primeiro `pnpm run types:fetch`.
3. **O plugin existente já está quebrado em pelo menos E1–E4.** O plano corrige, não
   reescreve.
4. **Compatibilidade:** todo o ecossistema está em `0.0.1-rc` / `0.1.0-rc` e o README
   avisa *"developer preview, expect breaking changes"*. **Pinne versões exatas** e
   assuma retrabalho.
5. **Segurança real, não teórica:** as discussions **#853** (RCE não autenticado no
   control plane da web UI, verificado em 0.1.0-rc.6) e **#1769** (escape do sandbox
   bwrap workspace-write) são vulnerabilidades **confirmadas e abertas**. Consequências
   diretas: (a) não trate o sandbox do DSH como fronteira de segurança durante o
   desenvolvimento; (b) o `dsh web` **não pode** ser exposto sem o portão do plugin — é
   exatamente o cenário da #853.
6. **Ignore no planejamento:** a tabela de benchmarks do `jcode` (~14 ms de boot, "245x
   mais rápido que Claude Code", ~212 MB por sessão) e o pacote `pi2dsh`. Vêm
   exclusivamente de fontes terceiras não verificáveis (`pasqualepillitteri.it`,
   `dshbase.com`, `dshplugin.store`, `coddykit.com`, `explainx.ai`, `grigio.org`,
   `deepakness.com`). **NÃO CONFIRMADOS.** Nada no npm nem no repo oficial corrobora.

### 0.4 Plano B — se, ao clonar, a API divergir de novo

O DSH ser real não garante que a API de hoje seja a de amanhã (tudo em rc). Gatilhos e
respostas:

| Gatilho | Resposta |
|---|---|
| `ctx.httpServer` não existe na versão instalada | Parar a onda. Reabrir spike L1. Não improvisar nome de serviço |
| **`registerUpgrade` não existe** em `HttpServerService` | **BLOQUEIO DE EXPOSIÇÃO, não replanejamento.** Sem ele o handshake de WebSocket não passa pelo gate, e o downlink do DSH é WebSocket (`src/index.ts:935`): a UI ficaria alcançável **sem credencial** por quem falasse WS direto. Regra: enquanto L1 não confirmar `registerUpgrade` (ou um equivalente), **`exposure.mode` só pode ser `off`** — o túnel não sobe. Plano B, nesta ordem: (1) interceptar o `'upgrade'` do servidor HTTP subjacente se o serviço expuser o `http.Server`; (2) **proxy reverso local** entre o `cloudflared` e o `127.0.0.1:3080`, que guarda o upgrade porque vê o socket cru (mesmo fallback do último item desta tabela). Nunca: expor com o upgrade sem gate |
| `spawn(spec)` mudou de forma | Isolar em `src/host/subprocess-adapter.ts` — **uma** função nossa chamando a API do host, para o blast radius de uma breaking change ser um arquivo |
| Pacote `@deepseek-ai/*` sai do ar / muda de nome | Pinar versão exata no `package.json` + lockfile commitado; `pnpm` com `minimumReleaseAge` já dá um dia de folga |
| A API real não permite interceptar o registro de rotas | **Fallback arquitetural:** o portão deixa de ser plugin in-process e vira **proxy reverso local** entre o `cloudflared` e `127.0.0.1:3080`. Perde-se elegância, mantém-se a propriedade de segurança. Isto precisa ser decidido na Onda 0, não na Onda 3 |
| Nada disso funciona | O projeto ainda entrega valor como **serviço externo** (bot + túnel + gate) sem ser plugin DSH. É degradação de escopo, não fracasso |

---

## 1. Cloudflare Tunnel

Metodologia: além da doc oficial, o `cloudflared` **2026.7.3** já instalado na máquina
(`/home/ondokai/.local/bin/cloudflared`) foi **executado**. Itens marcados "medido"
foram observados, não lidos.

> **Aviso operacional que vale mais que qualquer parágrafo teórico:** durante o teste,
> a porta 3080 já estava ocupada pelo DSH real (pid 3080915). O origin de teste em
> Python não conseguiu bindar e o quick tunnel **expôs o Harness real, publicamente e
> sem autenticação, por ~40 segundos** (URL `forbes-mines-prostores-easier.trycloudflare.com`).
> Tudo foi derrubado depois. Isso é o risco concreto:
> `--url http://localhost:3080` publica **o que estiver ali**, sem perguntar nada.

### 1.1 Claims confirmadas

| Claim | Fonte | Confiança |
|---|---|---|
| O metrics server local expõe **`GET /quicktunnel`** → `{"hostname":"forbes-mines-prostores-easier.trycloudflare.com"}` (HTTP 200). É a forma correta de extrair a URL programaticamente, **sem regex de log**. Retorna o hostname **sem esquema** — prefixe `https://`. **Este endpoint não é documentado** na página oficial de métricas, que só menciona `/metrics` | Medido local (curl em `127.0.0.1:20241` e `:20242`, duas execuções). Página que **não** o documenta: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/ | **Alta** (medido) |
| A URL sai em **STDERR**, nunca em stdout. Em duas execuções o stdout ficou com **0 bytes**. Script que captura só stdout **nunca** vê a URL. Formato: caixa ASCII `INF \|  https://xxx.trycloudflare.com   \|`. Regex de fallback: `https://[-a-z0-9]+\.trycloudflare\.com` | Medido (`>out.txt 2>err.txt`; `wc -c out.txt == 0`) | **Alta** (medido) |
| `--output json` (global, antes do subcomando) emite `{"level","message","time"}` por linha, **mas a URL continua embutida na caixa ASCII dentro de `message`** — JSON **não** simplifica a extração. Por isso `/quicktunnel` vence | Medido | **Alta** |
| Quick Tunnels são explicitamente inadequados a produção. Verbatim: *"Quick Tunnels are intended for testing and development only. For production use, create a remotely-managed tunnel."* e *"We don't guarantee any SLA or uptime of TryCloudflare…"*. O binário também imprime o aviso no startup | https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/ | **Alta** |
| Shutdown limpo: `SIGTERM`/`SIGINT` param de aceitar novas requisições, esperam as em voo e encerram. `--grace-period` default **30 s**; segundo sinal corta na hora. Medido: saída em **~2 s** sem requisições em voo; logs `Tunnel server stopped` / `Metrics server stopped`; **imediatamente depois a URL pública retornou HTTP 530** e a porta de métricas passou a recusar conexão. **Matar o processo basta — não fica órfão no edge** | Medido | **Alta** (medido) |
| O binário **loga o próprio checksum** no startup (`Version 2026.7.3 (Checksum 9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17)`), idêntico ao `sha256sum` do arquivo e ao publicado na release do GitHub. Permite auditar o binário em execução sem re-hashear. **Não há arquivo `.sha256` por asset** (issue aberta) — parseie as release notes ou use o repo apt assinado | Medido + release do GitHub | **Alta** (medido) |
| Quick tunnel **não deixa estado local**: após duas execuções completas e teardown, `~/.cloudflared` **não foi criado** (sem `cert.pem`, sem credenciais JSON). Ao contrário do named tunnel | Medido (`ls -la ~/.cloudflared` → inexistente) | **Alta** (medido) |
| Métricas expõe também `/ready` (`{"status":200,"readyConnections":1,"connectorId":"…"}`) e `/healthcheck` (texto `OK`); a raiz `/` retorna 404. Existe o subcomando **`cloudflared tunnel ready`**, que chama `/ready` e converte em exit code — útil para gating em script | Medido + `cloudflared tunnel --help` | **Alta** |
| Tempo entre lançar e a URL ficar disponível: **6–7 s** nas duas medições. Automação deve fazer polling com timeout **≥ 30 s**. A própria mensagem avisa *"it may take some time to be reachable"* | Medido (timestamps de 2 execuções) | **Alta** |
| Instalação Linux assinada: chave `https://pkg.cloudflare.com/cloudflare-main.gpg` e repo `deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main` — dá verificação de assinatura automática, preferível ao binário solto | https://pkg.cloudflare.com/ + https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/ | **Alta** |
| A Cloudflare declara reservar-se o direito de **investigar o uso de Tunnels** por violação dos Online Services Terms of Use; quick tunnels sem conta estão sujeitos a esses termos. O aviso é impresso pelo binário em todo startup | Medido (startup) + https://www.cloudflare.com/website-terms/ | **Alta** |
| Um usuário do Zero Trust ocupa **um único seat** independentemente de quantas aplicações acessa ou de quantos logins faz | https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/ | **Alta** |

### 1.2 Claim REFUTADA — a mais importante desta área

> **REFUTADA:** *"Quick Tunnels não suportam Server-Sent Events (SSE), logo um harness de
> LLM que faz streaming de tokens não funciona sob quick tunnel."*

**A citação é real; a conclusão é falsa.** Detalhe da refutação, feita por teste ao vivo
e não por leitura:

1. **Citação confirmada.** A doc lista 3 limites — 200 requisições in-flight, HTTP 429, e
   literalmente *"Quick Tunnels do not support Server-Sent Events (SSE)."*
   (https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
2. **Refutação empírica.** `cloudflared` 2026.7.3 local, quick tunnel real
   (`https://take-achieving-subjects-figured.trycloudflare.com`), origem Python servindo
   `text/event-stream` (1 evento a cada 0,5 s, chunked, flush explícito):
   - **`POST /v1/chat/completions`** (`Accept: text/event-stream`) → **chegou em streaming
     real**: 0,47 / 0,97 / 1,47 / 1,99 / 2,47 / 2,97 / 3,47 / 3,97 / 4,47 s `[DONE]`.
     Espaçamento de 0,5 s = timing exato da origem. Headers: `content-type: text/event-stream`,
     `server: cloudflare`, HTTP/2 200. Reproduzido 2×.
   - **`GET /sse`** (mesma origem, mesmo túnel) → **tudo bufferizado**: os 9 eventos
     despejados juntos em 4,10 s, só depois de o servidor fechar.
3. **Diagnóstico:** a frase da doc é simplificação exagerada de um **bug de buffering do
   edge específico de `GET`**. Bate com `cloudflare/cloudflared` **issue #1449** (aberto
   12/abr/2025, sem resposta de staff): *"POST → events are streamed correctly in
   real-time; GET → none delivered until the server closes"*.
4. **Por que mata a alegação:** streaming de token de LLM é **POST**. `/v1/chat/completions`
   com `stream:true` é POST devolvendo `text/event-stream` — precisamente o caso que
   **funciona**.
5. **Premissa duplamente errada neste repo:** o harness **nem usa SSE no downlink**.
   `src/index.ts:935` documenta que o DSH **já migrou** a telemetria de SSE para um
   **WebSocket dedicado** (motivo: o limite de ~6 conexões HTTP/1.1 por origem no browser
   esgotava o pool). WebSocket passa normalmente por quick tunnel.

**Ressalvas honestas — limites reais que continuam valendo (e que são os argumentos
legítimos contra quick tunnel em produção):** teto de **200 requisições concorrentes** →
429; **sem SLA**; **hostname novo a cada restart**; **sem nenhuma autenticação no nível do
túnel**.

> **Uso no plano:** nunca escreva "SSE não funciona no quick tunnel". Escreva "quick tunnel
> não tem auth na borda, não tem SLA e troca de hostname a cada restart".

### 1.3 Named tunnels e Cloudflare Access (para quem tem domínio)

- **Named tunnel** exige conta Cloudflare **+ domínio com a Cloudflare como autoridade
  DNS** — bloqueador se você não tem domínio lá.
  *Locally-managed*: `cloudflared tunnel login` (gera `~/.cloudflared/cert.pem`) →
  `tunnel create <NOME>` (gera `~/.cloudflared/<UUID>.json`) → `config.yml` com
  `tunnel`/`credentials-file`/`ingress` → `tunnel route dns <NOME> host.exemplo.com` →
  `tunnel run <NOME>`.
  *Remotely-managed* (recomendado pela Cloudflare para produção): token único,
  `cloudflared service install <TOKEN>`, config no dashboard.
  **Prefira `--token-file`/`TUNNEL_TOKEN_FILE` a `--token`/`TUNNEL_TOKEN`** — token em
  `argv` vaza no `ps`.
- **Cloudflare Access** autentica **na borda**, antes de tocar a máquina. Deny-by-default:
  *"All Access applications are deny by default"*. Ações: Allow / Block / Bypass /
  Service Auth. Ordem de avaliação: Service Auth e Bypass primeiro, depois Block/Allow
  top-to-bottom, primeira correspondência decide. **Cuidado: `Bypass` desliga tudo e não
  loga.** (https://developers.cloudflare.com/cloudflare-one/policies/access/)
- **One-time PIN** não exige IdP: PIN por e-mail, expira em 10 min, e **só é enviado se o
  e-mail já casa com uma policy** (usuário bloqueado não recebe nada). É o caminho ideal
  para acesso pessoal/mobile.
- **Service Tokens**: par `CF-Access-Client-Id` / `CF-Access-Client-Secret` em headers,
  para automação sem browser; exige policy com ação **Service Auth**; duração configurável
  (ex.: `8760h`); secret mostrado **uma única vez**.
- **Valide o JWT na origem.** O Access injeta `Cf-Access-Jwt-Assertion` (e cookie
  `CF_Authorization` no browser), assinado por par de chaves único da conta, chaves
  públicas em `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Validar `kid`,
  `iss`, `aud`, `exp`. **A doc recomenda validar o header, não o cookie** (*"the cookie is
  not guaranteed to be passed"*). Alternativa: ativar "Protect with Access" no próprio
  túnel para o `cloudflared` validar.
- **Armadilha crítica:** Access **não** protege se alguém alcançar a origem direto, e
  **Access não pode ser colocado na frente de um quick tunnel** (exige `zone_id`/domínio).
  Num quick tunnel, **toda a autenticação tem que estar dentro da aplicação**.

### 1.4 Riscos e alternativas (contexto, confiança variável)

- O túnel **ignora o firewall** — é conexão de saída. Não há porta aberta, mas também não
  há proteção de rede. Regra de INPUT do `ufw`/`iptables` dá falsa sensação de segurança.
- **TLS termina na borda da Cloudflare** — arquitetonicamente eles conseguem ver o texto
  claro (é o que permite WAF/Access/cache). **Não é E2E.** Para código-fonte e prompts,
  isso é decisão consciente de modelo de confiança.
- **`--loglevel debug` loga URLs, métodos e todos os headers** de request/response — vaza
  tokens. Nunca em produção.
- **Alternativas** (fontes **terceiras**, confiança **Média**): ngrok free tem cap de
  1 GB/mês, 3 endpoints, interstitial no browser e sem domínio custom, mas **suporta
  OAuth (até 5 MAU) e Basic Auth via Traffic Policy no plano free** — auth de borda que o
  quick tunnel não tem. Tailscale Funnel só HTTPS em 443/8443/10000. `bore` é
  minimalista/self-hosted (TCP puro, sem TLS/auth próprios).
  Fontes: https://pinggy.io/blog/best_ngrok_alternatives/ ,
  https://insights.nomadlab.cc/blog/2026/04/tailscale-vs-cloudflare-tunnel-vs-ngrok-2026 ,
  https://ngrok.com/docs/guides/identity-aware-proxy/securing-with-oauth
- **NÃO CONFIRMADO:** limite de **50 usuários** do Zero Trust free. Reportado de forma
  consistente por terceiros e por um PDF de pricing hospedado pela Cloudflare de **Q4
  2022** (desatualizado); as páginas atuais de seat-management, users e FAQ **não citam o
  número**. Tratar como provável, não verificado.
  (https://www.cloudflare.com/static/3fb3993535599c90e3fb6b64f2c11d67/Cloudflare_Zero_Trust_Pricing___Plans__Q4_2022__.pdf)
- **NÃO CONFIRMADO:** não existe página oficial de "rate limits" de quick tunnel além da
  própria página TryCloudflare.

---

## 2. Telegram Bot

Versão corrente: **Bot API 10.2 (14/jul/2026)**. Fontes primárias: HTML bruto de
`core.telegram.org/bots/api` (837 KB parseados localmente), `bots/features`, `bots/faq`,
`telegram.org/faq`, `telegram.org/privacy`, e o **código-fonte oficial do servidor**
(`tdlib/telegram-bot-api`: `Client.cpp`, `Client.h`, `ClientManager.cpp`).

### 2.1 Claims confirmadas

| Claim | Fonte | Confiança |
|---|---|---|
| **O token é equivalente a senha de controle total:** *"Keep your token secure and store it safely, it can be used by anyone to control your bot."* Não há segundo fator, escopo de permissão, rotação automática nem allowlist de IP na API pública | https://core.telegram.org/bots/features#botfather | **Alta** |
| **Chats com bots NÃO são E2E.** *"Server-client encryption is used in Cloud Chats (private and group chats), Secret Chats use an additional layer of client-client encryption."* Chat com bot é cloud chat | https://telegram.org/faq#q-so-how-do-you-encrypt-data | **Alta** |
| A Telegram **armazena** as mensagens de cloud chats: *"Armazenamos mensagens, fotos, vídeos e documentos de seus chats em nuvem em nossos servidores"* (§3.3.1) e roda **análise automatizada** sobre elas para anti-spam/phishing (§5.3) | https://telegram.org/privacy#3-3-1-chats-em-nuvem | **Alta** |
| **Secret Chats não existem para bots** — o `Chat.type` da Bot API só admite `private`/`group`/`supergroup`/`channel`; não há método nem tipo de secret chat. Logo **nenhuma conversa com bot pode ser E2E** | https://core.telegram.org/bots/api | **Alta** |
| **Mensagens autodestrutivas não existem para bots.** `message_auto_delete_time` é **somente leitura** (aparece em `ChatFullInfo` e no service message `MessageAutoDeleteTimerChanged`); **não há método `setChatMessageAutoDeleteTime`** (doc inteira grepada). `has_protected_content` impede encaminhar, **não** impede ler nem screenshot | https://core.telegram.org/bots/api | **Alta** |
| `deleteMessage` só funciona em mensagem com **menos de 48 horas** — "apago depois" não é mitigação confiável. Em chat privado o bot pode apagar as próprias e as recebidas. `deleteMessages` apaga **1–100** por chamada e ignora silenciosamente as não encontradas | https://core.telegram.org/bots/api#deletemessages | **Alta** |
| `getUpdates` e `setWebhook` são **mutuamente exclusivos**: `getUpdates` com webhook ativo → **HTTP 409** *"Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first"* (`Client.cpp:16784`) | https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Client.cpp | **Alta** |
| **Duas instâncias fazendo polling → HTTP 409** *"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"* (`Client.cpp:17356`). O servidor **mata o long-poll antigo** e faz throttle: `fail_query_conflict` só retorna 409 imediato **1× a cada 3 s** (`Client.cpp:17362-17368`). **Long polling não escala horizontalmente sem líder eleito** — 2 réplicas = flapping infinito | `Client.cpp` | **Alta** |
| `getUpdates.timeout` é **clampado em 50 s** pelo servidor (`LONG_POLL_MAX_TIMEOUT = 50`, `Client.h:1704`); `limit` 1–100 (default 100); `offset` confirma updates (offset negativo pega os últimos N e **esquece todos os anteriores**) | `Client.h` + https://core.telegram.org/bots/api#getupdates | **Alta** |
| `allowed_updates`: lista vazia = todos **exceto** `chat_member`, `message_reaction`, `message_reaction_count`. **Se omitido, mantém a configuração anterior** (estado no servidor — pegadinha). Updates pendentes ficam no servidor por no máximo **24 horas**; `drop_pending_updates: true` descarta a fila | https://core.telegram.org/bots/api#getupdates | **Alta** |
| **A API não oferece allowlist.** A doc joga a responsabilidade no backend: *"Your backend should always verify that received commands are valid and that the user was authorized to use them regardless of scope."* | https://core.telegram.org/bots/features | **Alta** |
| **`callback_data` é client-supplied** (1–64 **bytes**). Cliente modificado pode mandar qualquer string. Nunca use `callback_data` como prova de autorização — revalide `from.id` sempre | https://core.telegram.org/bots/api#inlinekeyboardbutton | **Alta** |
| `answerCallbackQuery` é **obrigatório**: *"Telegram clients will display a progress bar until you call answerCallbackQuery"*. `text` 0–200 chars; `show_alert`; `cache_time` | https://core.telegram.org/bots/api#answercallbackquery | **Alta** |
| **O FAQ oficial manda literalmente não mandar segredo a bot:** *"any bot should be treated as a stranger — don't give them your passwords, Telegram codes or bank account numbers, even if they ask nicely."* | https://core.telegram.org/bots/faq | **Alta** |
| Estrutura do token (do fonte do servidor): `<user_id>:<segredo>`, `user_id > 0` e `< 2^54`, total ≤ 80 chars, sem `/`, não começa com `0`. **O token vaza o ID numérico do bot** — não é opaco | `tdlib/telegram-bot-api` | **Alta** |

### 2.2 Claim REFUTADA

> **REFUTADA como generalização:** *"Quem possui o token contorna COMPLETAMENTE qualquer
> allowlist de `chat_id`/`from.id`, logo vazamento de token = capacidade de acionar as
> ações destrutivas do bot."*

1. **A fonte não diz isso.** https://core.telegram.org/bots/api#making-requests só define
   *"Each bot is given a unique authentication token"* e o formato da URL. Zero menção a
   allowlist, `chat_id` ou disparo de ação no backend. A premissa ("age como o bot") está
   lá; o "logo" não.
2. **Erro de direção.** O token autentica chamadas **saindo** para a API; a ação destrutiva
   é disparada por update **entrando**. No desenho long-polling (o do plano, **C-POLL**)
   **não existe endpoint HTTP do bot** — o portador do token não tem para onde POSTar um
   update forjado com `chat.id`/`from.id` da allowlist. E a doc fecha o loop interno:
   *"bots will not be able to see messages from other bots regardless of mode"*
   (https://core.telegram.org/bots/faq) — o `sendMessage` do atacante não volta como update.
3. **O que o vazamento realmente dá** (grave, mas outro eixo): personificação do bot;
   **roubo da fila de updates** via `getUpdates` (*"Only one consumer receives each update"*,
   https://core.telegram.org/bots/webhooks) — o dono legítimo nunca vê aqueles comandos;
   sequestro/exfiltração via `setWebhook`; DoS por 409; `logOut`/`close`. Ou seja:
   **confidencialidade + disponibilidade, não execução**.
4. **A conclusão só vale sob precondição de deploy**, não pela doc: webhook com URL
   derivada do token e **sem** `secret_token` nem filtro de IP (`149.154.160.0/20`,
   `91.108.4.0/22`). O `#setwebhook` atual empurra `secret_token` / header
   `X-Telegram-Bot-Api-Secret-Token`, não o truque antigo de "token no path" — sinal de que
   a alegação está calcada em prática desatualizada.
5. **Ressalva que sobrevive (e vira requisito):** com o token dá para mandar, **como o
   bot**, um inline keyboard cujo `callback_data` é comando destrutivo; se o **dono**
   clicar, o `callback_query` chega com `from.id`/`chat.id` da allowlist e **passa**. Isso é
   *deputado confuso* exigindo ação do usuário legítimo — mitigado por **C-CONFIRM**
   (confirmação em 2 etapas com token efêmero server-side + TTL), não é "contorna
   completamente". Correção registrada em `docs/plano/02-SEGURANCA.md` **§7.3 e §12.2** — a
   referência antiga a "§3.6.2" apontava para uma seção que **não existe** naquele arquivo (as
   subseções de §3 são L0–L8), e foi corrigida nesta revisão.

### 2.3 Onboarding mínimo (7 passos) — o que o plugin vai ensinar

1. Abrir `t.me/BotFather` → `/newbot`.
2. Nome de exibição (mutável) e **username** (5–32 chars, `A-Za-z0-9_`, **tem que terminar
   em `bot`**, **imutável para sempre**).
3. BotFather devolve o token `<bot_user_id>:<segredo>` (exemplo oficial:
   `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`).
4. Testar: `curl https://api.telegram.org/bot<TOKEN>/getMe` — método oficial de validação
   de token (https://core.telegram.org/bots/api#getme).
5. **O dono manda `/start` para o bot** — obrigatório, bot não inicia conversa.
6. Descobrir o `chat_id`: `curl https://api.telegram.org/bot<TOKEN>/getUpdates` →
   `result[].message.chat.id`. Alternativa oficial de UI: `KeyboardButtonRequestUsers` →
   service message `users_shared` (https://core.telegram.org/bots/api#usersshared).
7. Gravar `TELEGRAM_BOT_TOKEN` e `TELEGRAM_OWNER_CHAT_ID` fora do git, `chmod 600`.

**Opcional:** `setMyCommands` via API (versionável, com scopes e i18n) em vez de
`/setcommands` no BotFather. **`/setprivacy` é irrelevante para bot de ops em DM** — todo
bot recebe *"All messages from private chats"* independentemente do privacy mode; deixe o
padrão (ligado), que é o mais seguro.

**Regra de allowlist (armadilha real):** cheque **`from.id`, não só `chat.id`**.
`callback_query` chega com `callback_query.from` — em grupo, **qualquer membro** pode
apertar o botão. `message.from` é **opcional** (ausente em channel posts) → ausência = negar.
Valide nos **dois eixos** (`from.id` **E** `chat.id`), fail-closed, por **ID numérico**
(username é mutável e sequestrável). `Chat.id`/`User.id` têm até **52 bits significativos**
— nunca `int32`; em JS `number` (double) é seguro.

**Botões:** use **inline keyboard**, não reply keyboard.

> ### ⛔ AVISO INEQUÍVOCO — o parágrafo abaixo descreve uma CLAIM REBAIXADA
>
> **`InlineKeyboardButton.style` é NÃO CONFIRMADO e é PROIBIDO como requisito de entrega ou como
> caso de teste.** Ver o fato **#15** da §8 (rebaixado) e a lacuna **L19** da §9. Esta linha era a
> única da tabela de fatos **sem URL de fonte primária** — "Bot API 10.x" é rótulo, não citação —, e
> mesmo assim foi transformada em requisito de entrega (`03-ONDAS.md` T5.2) e em caso de teste
> (`04-TESTES.md` TG-029). Isso viola a **regra 1** deste documento: sem fonte, vira spike, nunca
> premissa.
>
> **Enquanto o spike da Onda 0 não fechar lendo `https://core.telegram.org/bots/api#inlinekeyboardbutton`
> no raw**, a diferenciação visual do botão é feita **no texto** (`✅ Ligar` / `⛔ Desligar`), que
> funciona em qualquer versão da Bot API. Qualquer documento do plano que afirme o contrário está
> errado, e é o documento que muda — não este aviso.

`InlineKeyboardButton.style` aceita
`"danger"` (vermelho), `"success"` (verde), `"primary"` (azul) — "Ligar" → `success`,
"Desligar" → `danger`. Atualize estado com **`editMessageText`** (1–4096 chars) em vez de
mandar mensagem nova e apagar.

**Rate limits oficiais** (https://core.telegram.org/bots/faq): 1 msg/s por chat, 20 msgs/min
por grupo, ~30 msgs/s em broadcast; estouro → **HTTP 429** com `parameters.retry_after`.
Para bot de 1 dono é irrelevante na prática, mas trate 429 mesmo assim (retry cego amplifica).

### 2.4 Escolha de biblioteca — **grammY** (dados de 19/ago/2026)

| | **grammY** | **telegraf** | **node-telegram-bot-api** |
|---|---|---|---|
| Última versão | **1.45.1** (17/jul/2026) | 4.16.3 (**29/fev/2024**) | **2.0.0** (16/ago/2026) |
| Último commit | 15/ago/2026 | **10/jan/2025** (bump Snyk) | 18/ago/2026 |
| Downloads/semana | **3.146.000** | 392.842 | 195.839 |
| Deps de runtime | 4 | 8 | **0** |
| Bot API 10.2 | **sim** (2 dias após o release) | **não** | sim |
| Node mínimo | ^12.20 \|\| >=14.13.1 | ^12.20 \|\| >=14.13.1 | **>=18** |

**Veredito: grammY.** 8× os downloads do telegraf, release mensal, tipagem TS com narrowing
por filter query (`bot.on("callback_query:data")`), plugin **auto-retry** que trata 429 lendo
`retry_after` (`maxRetryAttempts`/`maxDelaySeconds`), e `bot.catch` com `GrammyError`/`HttpError`
(https://grammy.dev/guide/errors).
**telegraf está morto na prática** (último release fev/2024; não suporta Bot API 8, 9 nem 10) —
não comece nada novo nele.
**`node-telegram-bot-api` v2** é legítimo (reescrita TS, **zero deps de runtime**), mas tinha
**três dias de idade** na data da pesquisa — risco de bug de juventude não compensa num bot que
liga/desliga servidor. Reavaliar em ~6 meses.
Tamanhos (unpacked): grammy 1.378.680 B, ntba 1.179.594 B, telegraf 689.218 B
(https://registry.npmjs.org/grammy). `@grammyjs/types` 4.0.0 (15/jul/2026) vs `@telegraf/types`
9.2.1 (21/set/2025) — mais evidência da defasagem.

### 2.5 Riscos que mudam o plano (ordenados)

1. Token = root do bot → auditoria fora do Telegram, C-CONFIRM em ação destrutiva, rate
   limit próprio.
2. Nada é E2E e a Telegram varre cloud chats → **zero segredos em mensagem**, e o guia
   precisa dizer isso ao usuário em letras garrafais.
3. 409 em polling duplicado mata HA/multi-réplica ingênua.
4. Sem allowlist o bot é público — requisito de dia zero, não hardening.
5. Sem autodestruição e com `deleteMessage` limitado a 48 h, "apagar depois" é higiene
   cosmética, não controle de segurança.
6. `drop_pending_updates` no boot evita que 24 h de comandos represados executem de uma vez.
7. Escolha de lib é irreversível na prática depois da base escrita.

---

## 3. Autenticação e segurança web

Fontes primárias: OWASP Cheat Sheet Series, OWASP ASVS 5.0, NIST SP 800-63B rev.3 e rev.4,
RFCs 9106/7617/4648, docs oficiais Node.js e Cloudflare, OWASP GenAI, CWE-208, paper
Crosby/Wallach.

### 3.1 Claims confirmadas

| Claim | Fonte | Confiança |
|---|---|---|
| **ASVS 11.5.1 (L2):** todo valor aleatório destinado a ser não-adivinhável vem de **CSPRNG** e tem **≥128 bits de entropia**; explicitamente *"Note that UUIDs do not respect this condition"* | https://github.com/OWASP/ASVS/blob/master/5.0/en/0x20-V11-Cryptography.md | **Alta** |
| **ASVS 7.2.3 (L2):** reference tokens de sessão são únicos, gerados por CSPRNG e com **≥128 bits de entropia** | https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md | **Alta** |
| **NIST SP 800-63B-4 §3.2.2:** *"the verifier SHALL limit consecutive failed authentication attempts using a specific authenticator on a single subscriber account to no more than 100"*; e sugere backoff crescente *"(e.g., 30 seconds up to an hour)"* + bot-detection challenge | https://pages.nist.gov/800-63-4/sp800-63b.html | **Alta** |
| `crypto.randomBytes` *"Generates cryptographically strong pseudorandom data"*; a versão assíncrona usa o threadpool do libuv e a chamada *"will not complete until there is sufficient entropy available"* — pode **bloquear logo após o boot** | https://nodejs.org/api/crypto.html | **Alta** |
| `crypto.timingSafeEqual(a,b)` compara *"using a constant-time algorithm"* e **lança erro se os buffers tiverem tamanhos diferentes** (o próprio comprimento vaza) → compare **digests de tamanho fixo** (SHA-256 = 32 bytes), nunca tokens crus. A doc avisa: *"Use of crypto.timingSafeEqual does not guarantee that the surrounding code is timing-safe"* | https://nodejs.org/api/crypto.html | **Alta** |
| **`crypto.argon2()` / `crypto.argon2Sync()` são built-in no Node desde v24.7.0** (`crypto.json`, `meta.added = v24.7.0`). Antes: só `scrypt`/`scryptSync` nativos. **Não existe bcrypt nativo** | doc oficial Node | **Alta** |
| **RFC 7617:** Basic *"is not considered to be a secure method of user authentication unless used in conjunction with some external secure system such as TLS"* e *"SHOULD NOT be used (without enhancements such as HTTPS) to protect sensitive or valuable information"* | https://www.rfc-editor.org/rfc/rfc7617 | **Alta** |
| **RFC 4648:** base32 = 5 bits/char (A-Z, 2-7; sem 0/1/8/9; case-insensitive), base64 = 6 bits/char, hex = 4 bits/char. **128 bits = 26 chars base32 = 22 base64 = 32 hex** | https://www.rfc-editor.org/rfc/rfc4648.html | **Alta** |
| **Parâmetros OWASP 2026** (= ASVS 5.0 Apêndice C): Argon2id mínimo **19 MiB, t=2, p=1** (equivalentes: 47104/t=1, 19456/t=2, 12288/t=3, 9216/t=4, 7168/t=5); scrypt N=2^17, r=8, p=1; bcrypt só legado, work factor ≥10, **limite de 72 bytes**; PBKDF2 só para FIPS (HMAC-SHA-256 com 600.000 iterações). Salt: NIST ≥32 bits; Node recomenda ≥16 bytes | OWASP Password Storage Cheat Sheet | **Alta** |
| **RFC 9106** (spec do Argon2) recomenda parâmetros **bem mais pesados** que o OWASP: 1ª opção t=1, p=4, m=2^21 (2 GiB); 2ª opção t=3, p=4, m=2^16 (64 MiB); salt 128 bits, tag 256 bits. O OWASP é o piso pragmático; o RFC é o ideal | https://www.rfc-editor.org/rfc/rfc9106 | **Alta** |
| **NIST 63B-4 §5.1.1 (normativo):** *"POST/PUT content SHALL contain a session identifier that the RP SHALL verify to protect against CSRF"*; cookies de sessão **SHALL** ser Secure-only, **SHOULD** HttpOnly, **SHOULD** `__Host-` + `Path=/`, **SHOULD** `SameSite=Lax` ou `Strict`, **SHALL** conter só string opaca; sessão autenticada **SHALL NOT** cair para http | https://pages.nist.gov/800-63-4/sp800-63b.html | **Alta** |
| **Autenticação por `Authorization: Bearer` não é vulnerável a CSRF** (o browser não envia o header automaticamente cross-site). Mas *"XSS can defeat all CSRF mitigation techniques"*. Double-submit ingênuo está **desaconselhado**; `SameSite` sozinho não basta | OWASP CSRF Cheat Sheet | **Alta** |
| **ASVS 11.2.4 (L3):** *"all cryptographic operations are constant-time, with no short-circuit operations in comparisons, calculations, or returns"* | https://github.com/OWASP/ASVS/blob/master/5.0/en/0x20-V11-Cryptography.md | **Alta** |
| Ataque de timing remoto é real: Crosby/Wallach (ACM TISSEC 2009) mediram eventos com **15–100 µs** de precisão pela internet e **100 ns** em LAN. CWE-208 (*Observable Timing Discrepancy*) cobre exatamente isso | Crosby & Wallach, ACM TISSEC 2009 | **Alta** |
| **fail2ban defaults oficiais:** `maxretry = 5`, `findtime = 10m`, `bantime = 10m`. O README adverte: *"Though Fail2Ban is able to reduce the rate of incorrect authentication attempts, it cannot eliminate the risk presented by weak authentication."* | https://github.com/fail2ban/fail2ban/blob/master/config/jail.conf e /README.md | **Alta** |
| **ASVS 13.4.2/13.4.3/13.4.5/13.4.6:** produção sem modo debug, sem directory listing, sem endpoints de doc/monitoramento expostos, sem versão de backend exposta. **13.3.1** exige secrets manager; **13.2.3 / 6.3.2** proíbem credenciais default | https://github.com/OWASP/ASVS/blob/master/5.0/en/0x22-V13-Configuration.md | **Alta** |
| **HSTS:** `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (usar `86400` durante rollout); a diretiva `preload` tem *"PERMANENT CONSEQUENCES"* | https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html | **Alta** |
| Mensagem de erro **genérica e idêntica** para usuário inexistente, senha errada ou conta bloqueada (*"Login failed; Invalid user ID or password"*), e **todos os lockouts logados e revisados** | https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html | **Alta** |
| **NIST 63B-4 timeouts:** AAL1 overall ≤30 dias; **AAL2 overall ≤24 h, inatividade ≤1 h**; AAL3 ≤12 h / 15 min. E: *"Browser cookies do not satisfy this requirement except as short-term secrets for session maintenance (not authentication)"* | https://pages.nist.gov/800-63-4/sp800-63b.html | **Alta** |
| **NIST 63B-4 proíbe** regras de composição (*"SHALL NOT impose other composition rules"*) e rotação periódica (*"SHALL NOT require subscribers to change passwords periodically"*) — só forçar troca com evidência de comprometimento | https://pages.nist.gov/800-63-4/sp800-63b.html | **Alta** |
| **OWASP Blocking Brute Force** avisa que lockout puro *"is insufficient for stopping brute-force attacks"* e cria DoS trivial. **Com um único usuário, lockout de conta = auto-DoS total.** Preferir delay progressivo + bloqueio por IP + CAPTCHA. O contador deve ser associado à **conta**, não só ao IP (rotação de IP burla) | OWASP Authentication / Blocking Brute Force Cheat Sheets | **Alta** |
| **OWASP LLM06:2025 (Excessive Agency)** descreve exatamente o risco de UI de agente exposta (excessive functionality/permissions/autonomy) e recomenda **human-in-the-loop** para ações de alto impacto, minimizar extensões, executar no contexto do usuário, mediação completa e rate limiting. **ASVS 8.4.2 (L3)** exige múltiplas camadas em interface administrativa, *"ensuring that network location or trusted endpoints are not the sole factors for authorization"* | OWASP GenAI / ASVS 5.0 | **Alta** |

### 3.2 Claim REFUTADA — e ela muda como justificamos a decisão de hashing

> **REFUTADA (a inferência, não a citação):** *"ASVS 5.0 §6.5.2 diz que segredo com ≥112
> bits de entropia pode usar hash padrão; logo, para um token de 128 bits gerado por
> CSPRNG, SHA-256 + comparação em tempo constante é suficiente e Argon2id NÃO é exigido."*

- **A citação é verbatim e confere** (tag v5.0.0, `5.0/en/0x15-V6-Authentication.md`, L105):
  *"…lookup secrets with less than 112 bits of entropy (19 random alphanumeric characters or
  34 random digits) are hashed with an approved password storage hashing algorithm that
  incorporates a 32-bit random salt. A standard hash function can be used if the secret has
  112 bits of entropy or more."* Nível L2.
- **O que cai é a segunda metade.** O requisito 6.5.2 está em **"V6.5 General Multi-factor
  authentication requirements"** e seu escopo textual é **exclusivamente `lookup secrets`** —
  códigos de recuperação/backup de MFA pré-gerados (espelha NIST SP 800-63B §5.1.2.2). **Não
  é** requisito sobre tokens de API/sessão em geral.
- **Nada na ASVS 5.0 estende esse limiar a tokens genéricos:** 11.4.2 exige KDF lento apenas
  para **passwords**; 7.2.3 exige 128 bits de entropia via CSPRNG para reference tokens mas
  **não diz nada sobre a forma de armazenamento**; 11.5.1 só trata de geração. **A norma é
  silente** para o nosso caso.
- **Detalhes que também não estavam na norma:** 6.5.2 **não menciona Argon2id** (os algoritmos
  vêm do Apêndice C) nem "comparação em tempo constante" (isso é 11.2.4). O limiar é sobre
  **entropia**, não comprimento — token com prefixo/estrutura ou derivado de fonte não-CSPRNG
  **não qualifica**. E **13.3.1 (L2)** continua exigindo cofre de segredos para chaves de API e
  seeds de token no backend, então "SHA-256 basta" não encerra o assunto.

**Consequência prática obrigatória para o plano:**

1. A decisão "token gerado por máquina → SHA-256 + `timingSafeEqual` + rate limit" **pode**
   ser adotada, mas precisa virar **ADR com argumento próprio** (2^128 torna o ataque offline
   inviável; Argon2id de 19–46 MiB por tentativa vira vetor de **DoS de CPU/memória** — o
   próprio OWASP alerta que work factor alto demais *"could be used by an attacker to carry
   out a denial of service attack by exhausting the server's CPU"*).
2. **Proibido** citar ASVS 6.5.2 como fundamento. Quem citar, o revisor rejeita.
3. **Se em algum momento o usuário puder escolher a senha**, Argon2id passa a ser
   obrigatório (m=19456, t=2, p=1, ou equivalente do Apêndice C; `crypto.argon2` nativo se
   Node ≥ 24.7.0).
4. Guardar **apenas** `sha256(token)` em disco (`0600`), nunca o token; comparar sobre os 32
   bytes do digest.

### 3.3 Recomendação sintetizada (herdada da pesquisa)

1. Gerar `crypto.randomBytes(32)` (256 bits); exibir **uma única vez** em base32 sem padding
   (52 chars) ou base64url (43 chars). Base32 é melhor para digitar/ditar/QR (sem `0/O`,
   `l/1`, sem `+/`, sem case).
   *Nota de trade-off:* passphrase EFF (lista longa, **7776 palavras verificadas por
   download** = 12,925 bits/palavra; mínimo recomendado 6 palavras ≈ 77,5 bits) é ótima para
   memorização humana e **cara em bits** — precisaria de 10 palavras para 128 bits. Para
   segredo de máquina colado num gerenciador, base32/base64 é estritamente melhor.
2. Persistir **só** `sha256(token)` (hex), permissão `0600`; comparar com `timingSafeEqual`.
3. Trocar Basic Auth por `POST /login` → cookie `__Host-sid` (128 bits CSPRNG, `Secure`,
   `HttpOnly`, `SameSite=Strict`) **ou** bearer no header (imune a CSRF). Se cookie, exigir
   token anti-CSRF em toda mutação (NIST SHALL).
   *Por que sair do Basic mesmo sobre TLS:* (i) não há logout padronizado — o browser
   re-envia a credencial até fechar; (ii) a credencial completa trafega em **cada** request
   (superfície de log/proxy/crash-dump); (iii) prompt nativo é ruim em PWA/mobile e não
   permite backoff com UX; (iv) não há rotação/invalidação por sessão.
4. Rate limit: delay exponencial a partir da 5ª falha por IP (1 s, 2 s, 4 s…), ban de IP após
   ~15, teto de **100 falhas** por conta (NIST), log de tudo, **nunca lockout permanente da
   única conta** (sem caminho de recovery = brick).
5. Expor via túnel (zero portas abertas) + Access na frente **quando houver domínio** +
   validar `Cf-Access-Jwt-Assertion` na origem. **A senha da aplicação nunca é removida por
   haver Access na frente** — misconfig de policy e rota de bypass são o modo de falha comum.
6. TLS 1.2/1.3 apenas, HSTS, sem debug, sem listagem, headers de segurança, e
   human-in-the-loop para ações destrutivas do agente (LLM06).

---

## 4. Gestão de processos Node

Verificado contra a doc oficial **e reproduzido empiricamente no Node v24.15.0 / Linux 6.18**
desta máquina.

### 4.1 Claims confirmadas

| Claim | Fonte | Confiança |
|---|---|---|
| `spawn('sh',['-c','sleep 300 & wait'])` + `child.kill('SIGTERM')` deixa o **neto vivo** (verificado com `process.kill(grandchildPid, 0)` que não lança). Com `detached:true` + `process.kill(-child.pid,'SIGTERM')`, o neto **morre** | Medido (`scratchpad/t3.mjs`) + https://nodejs.org/api/child_process.html | **Alta** (medido) |
| Doc de `options.detached`: *"On non-Windows platforms, if options.detached is set to true, the child process will be made the leader of a new process group and session. See setsid(2)"* — é isso que torna `process.kill(-pid)` viável | https://nodejs.org/api/child_process.html | **Alta** |
| `detached:true` + stdio **herdado** não desprende de verdade: *"If the parent process' stdio is inherited, the child process will remain attached to the controlling terminal"*. Para serviço de longa duração use `stdio:['ignore','pipe','pipe']` (pipes funcionam; o que prende é `inherit`). E `detached:true` **sem `unref()`** faz o pai esperar o filho | https://nodejs.org/api/child_process.html | **Alta** |
| **`'close'` é o único evento terminal universal.** Doc: `'close'` *"will always emit after 'exit' was already emitted, or 'error' if the child process failed to spawn"*. **Medido:** sucesso → `spawn → exit → close`; **ENOENT → `error → close`, e `'exit'` NUNCA dispara** (`child.pid === undefined`, `child.killed === false`, `child.exitCode === -2`, `close` recebe `(-2, null)`) | https://nodejs.org/api/child_process.html + medido | **Alta** (medido) |
| `'spawn'` **não é readiness**: *"The 'spawn' event will fire regardless of whether an error occurs within the spawned process… if `bash some-command` spawns successfully, the 'spawn' event will fire, though bash may fail to spawn some-command. This caveat also applies when using `{ shell: true }`"* | https://nodejs.org/api/child_process.html | **Alta** |
| `AbortController` no `spawn`: `controller.abort()` chama `child.kill(killSignal)` **sincronamente**; logo após `ac.abort()`, `child.killed === true` e o `'error'` (AbortError, `code: 'ABORT_ERR'`, `err.cause` = a `reason`) **já foi emitido**. `'exit'`/`'close'` vêm depois | `lib/child_process.js` + medido | **Alta** (medido) |
| **AbortError só é emitido se `child.kill()` retornar `true`** (PR #37325). Se o processo já saiu, `kill` retorna `false` e **não há AbortError** | `lib/child_process.js` | **Alta** |
| **Assimetria perigosa:** se o `signal` **já estava abortado** no `spawn()`, o kill é adiado para `process.nextTick` — medido `killed === false` logo após o `spawn()`. **O processo É criado e só então morto.** Não conte com "signal abortado ⇒ nada roda" | Medido | **Alta** (medido) |
| **Node não deixa zumbis dos filhos que ele mesmo spawnou** — libuv registra `SIGCHLD` e faz `waitpid`. Medido: `true` spawnado, 500 ms, sem listener, sem estado `Z`, `exitCode === 0`. **Ressalva do libuv:** *"libuv will only reap child processes that it knows about — first level children that it directly spawned"* — netos reparentados para o **seu** processo (só se você for PID 1 ou subreaper) **não** são colhidos (libuv issue #4179) | doc libuv + medido | **Alta** |
| **Órfãos:** *"Child processes may continue running after the parent exits regardless of whether they are detached or not"*. Se o supervisor morre por `SIGKILL`, os filhos sobrevivem — medido. **Reparenting não é necessariamente para PID 1**: no teste o órfão foi adotado por **PID 1830 = `systemd --user`** (subreaper). Desde Linux 3.4, `prctl(PR_SET_CHILD_SUBREAPER)` faz o ancestral marcado mais próximo adotar | https://nodejs.org/api/child_process.html + medido | **Alta** (medido) |
| **Windows:** *"where POSIX signals do not exist, the signal argument will be ignored except for 'SIGKILL', 'SIGTERM', 'SIGINT' and 'SIGQUIT', and the process will always be killed forcefully and abruptly (similar to 'SIGKILL')"*. Árvore: `taskkill /PID <pid> /T /F` (`/t` = *"Ends the specified process and any child processes started by it"*, `/f` = forçado) | https://nodejs.org/api/child_process.html + Microsoft Learn | **Alta** |
| `execa`: `killSignal` default `SIGTERM`, **`forceKillAfterDelay` default 5000 ms** (escala SIGTERM→SIGKILL), `cleanup` default `true`, `cancelSignal` (AbortSignal), e **`killDescendants`** (default `false`) que no Unix *"spawns the subprocess in its own process group, then sends the signal to that group"* — a técnica correta, já embalada. `cleanup` **não** funciona se o processo atual morrer por SIGKILL e não se aplica a subprocessos `detached` | doc execa | **Alta** |
| `tree-kill`: win32 → `taskkill /pid X /T /F`; darwin → `pgrep -P`; linux → `ps -o pid --no-headers --ppid`. É **enumeração por snapshot**, inerentemente racy (processo criado entre enumerar e matar escapa). Grupo POSIX **não tem essa race** — o kernel resolve no momento do sinal | https://github.com/pkrumins/node-tree-kill | **Alta** |

### 4.2 Claims REFUTADAS (duas — ambas por contra-exemplo medido)

> **REFUTADA (a conclusão):** *"A doc do Node diz que filhos de filhos não são terminados ao
> matar o pai no Linux; portanto `child.kill()` NUNCA é suficiente quando há shell
> intermediário."*

- **A citação confere** (verbatim, sob `subprocess.kill([signal])`,
  https://nodejs.org/api/child_process.html): *"On Linux, child processes of child processes
  will not be terminated when attempting to kill their parent. This is likely to happen when
  running a new process in a shell or with the use of the `shell` option of `ChildProcess`."*
- **O "NUNCA" é falso.** Contra-exemplo reproduzido (Node v24.15.0, `scratchpad/t3.mjs`): com
  `spawn(cmd, { shell: '/bin/bash' })`, o **bash aplica a otimização de exec do último
  comando e não deixa processo intermediário** — `ps -p child.pid` mostra `sleep`, não `bash`,
  sem filhos, e `child.kill()` mata o processo real. Isso valeu inclusive para
  `'true; sleep N'` (dois comandos).
- **É dependente do shell:** no mesmo host, `shell:true` usa `/bin/sh` (dash aqui), o dash
  **forkou** (`/bin/sh -c sleep N` com filho `sleep N`) e o `sleep` sobreviveu ao
  `child.kill()`. Aí a advertência vale.
- **Ressalvas:** o doc diz "On Linux", mas o mesmo ocorre em macOS/BSD (é reparenting POSIX,
  não específico de Linux). A solução (`detached:true` + `process.kill(-child.pid)`) funciona —
  mas é `process.kill` no grupo, **não** `child.kill()`.
- **Formulação segura para o plano:** *"`child.kill()` pode não bastar quando o shell
  permanece como processo intermediário; se o shell fizer exec, basta."* Como não controlamos
  qual shell, **o desenho continua sendo grupo próprio + `kill(-pid)`**.

> **REFUTADA (parcialmente):** *"Filho sem `detached` sempre herda o PGID do pai;
> `process.kill(-child.pid, 0)` num filho não-detached falha com ESRCH; e
> `process.kill(-process.pid)` mataria o próprio supervisor."*

- **O núcleo bate** (medido, `t7.mjs`): não-detached PGID = 2629717 (= PGID do supervisor);
  detached PGID = SID = próprio PID; `kill(-nd.pid, 0)` → ESRCH.
- **Falso 1 — "mataria o próprio supervisor".** No mesmo output o supervisor tem PID 2629795
  e **PGID 2629717**, ou seja **não é líder de grupo**: `process.kill(-process.pid, 0)` → ESRCH
  ("would NOT kill the supervisor"). Só vira suicídio quando o supervisor **é** líder de grupo
  (reproduzido sob `setsid node` → `kill(-process.pid, 0)` OK). É **condicional**, não medido
  como universal.
- **Falso 2 — "sem detached herda o PGID"** só vale **no instante do fork**. Contra-exemplo
  medido: `spawn('setsid', ['sleep','5'])` com `detached:false` → filho PID 2651491,
  **PGID 2651491, SID 2651491**, e `process.kill(-2651491, 0)` **teve sucesso**. Qualquer filho
  que chame `setsid()`/`setpgid()` (`setsid`, `sudo`, `ssh`, `tmux`/`screen`, shell com job
  control) quebra a premissa.
- **Corolário perigoso:** `kill(-child.pid)` num filho **não-detached** pode **não** dar ESRCH e
  **acertar um grupo alheio** se o PID coincidir com um PGID existente (**PID reuse**).
- **Atribuição de fonte errada:** https://nodejs.org/api/child_process.html só documenta a
  metade `detached`. Não diz nada sobre herança de PGID, `kill` com pid negativo ou ESRCH —
  isso é POSIX `fork(2)`/`kill(2)`.
- **Consequências para o código:** (a) **sempre** `detached:true` no que formos matar por
  grupo; (b) **nunca** usar ESRCH como prova de que "não há grupo"; (c) **nunca** chamar
  `process.kill(-process.pid, …)`; (d) guardar `child.pid` imediatamente e envolver todo kill
  em `try/catch`.

### 4.3 Backoff, readiness e esqueleto recomendado

**Backoff** (Marc Brooker / AWS Architecture Blog — confiança **Média**, fonte de blog):
`No Jitter: min(cap, base*2**attempt)`; **Full Jitter**: `random(0, min(cap, base*2**attempt))`;
Equal Jitter; **Decorrelated Jitter**: `min(cap, random(base, sleep*3))`. Conclusão do artigo:
sem jitter é ruim nas duas métricas; "Equal Jitter" é o pior dos jitterados; "Full Jitter" faz
menos trabalho. **Recomendação:** Full Jitter, `base=250 ms`, `cap=30 s`, e **reset da contagem
só após uptime saudável mínimo (~60 s)** — senão um serviço que morre aos 5 minutos reinicia
para sempre com backoff zerado. Mais **restart budget** em janela deslizante (ex.: máx. 5
restarts em 10 min) → abre o circuito.

**Quando desistir:** `ENOENT` (binário inexistente), `EACCES`, exit code determinístico de
config inválida (ex.: 78/`EX_CONFIG`), e falha que ocorre **antes** do readiness em todas as
tentativas. Retry só faz sentido para falha depois de "ficou READY pelo menos uma vez".

**Circuit breaker:** `opossum` é o padrão de facto (CLOSED → OPEN após `errorThresholdPercentage`
→ `resetTimeout` → HALF_OPEN → uma tentativa). Para supervisão de processo local, provavelmente
**não vale a dependência** — a máquina de estados é trivial e você quer acoplá-la ao orçamento de
restart, não a chamadas de função (https://github.com/nodeshift/opossum).

**Readiness — três sinais, em ordem de confiabilidade:** (1) evento `'spawn'` (só diz que o
`execve` deu certo; com `shell:true` nem isso); (2) parsear stdout por linha sentinela (frágil:
buffering, mudança de mensagem, linha partida entre chunks — exige acumular buffer); (3)
**polling ativo do endpoint** — único sinal que prova que o socket aceita conexão **e** a app
responde. `wait-on`: *"For http(s) resources wait-on will check that the requests are returning
2XX (success) to HEAD or GET requests"*; suporta `tcp:host:port`.
**Porta aberta ≠ app pronta** (pode ter feito `listen()` antes de conectar no banco). Prefira
`/healthz`. E **corra o polling contra o `'close'` do filho**: se o processo morrer no warmup,
aborte o wait na hora (AbortController abortado no `'close'`) em vez de esperar o timeout.
Timeout de readiness separado do timeout de request; poll fixo 50–200 ms, não exponencial.

**Esqueleto:**

1. `spawn(cmd, args, { detached: true, stdio: ['ignore','pipe','pipe'], signal })` — guardar
   `child.pid` **imediatamente**.
2. Ouvir **`'close'`** como terminal; `'error'` só para classificar; `'exit'` como informação.
3. Readiness = poll `/healthz` com `AbortController` abortado no `'close'`.
4. Shutdown = `process.kill(-pid,'SIGTERM')` → graça (5 s) → `process.kill(-pid,'SIGKILL')`;
   Windows: `taskkill /PID <pid> /T /F`. Tudo em `try/catch` por causa de ESRCH.
5. Restart com Full Jitter + orçamento + lista de não-retryable.
6. Handlers de `SIGINT`/`SIGTERM` no supervisor fazendo teardown do grupo; e um **pipe herdado
   como dead-man's switch** no filho (quando o stdin pipe do pai fecha, o filho se mata) — é o
   mecanismo mais barato que sobrevive a `SIGKILL` no supervisor.

**Bibliotecas — veredito:** `execa` **provavelmente sim** (`killDescendants` + `forceKillAfterDelay`
cobrem ~90% do que escreveríamos à mão); `tree-kill` **só para Windows** ou para matar PID que
não spawnamos; `pidusage` **sim se houver guarda de recursos** (mede **outro** processo; medir o
**grupo inteiro**, senão um `sh -c` esconde o consumo); `wait-on` sim para readiness; `opossum`
provavelmente não.

**Outros fatos:** Windows **Job Object** com `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` é a alternativa
kernel-enforced e **sem race** ao `taskkill` (o PostgreSQL adotou para não deixar backends órfãos)
— **o Node não expõe; exige addon nativo**
(https://www.postgresql.org/message-id/CA%2BhUKGLVBGE2KkzLaDkKX9t7%3Dt2BvjtOLXef5NnMv4cAZyoz7w%40mail.gmail.com).
**libuv #1911:** chamar `uv_close` no handle antes de o filho sair desregistra o `SIGCHLD` daquele
filho e nunca faz `waitpid` → **zumbi permanente**
(https://github.com/libuv/libuv/issues/1911).
Se o Node rodar como **PID 1** em container, use `docker run --init` / `tini` / `dumb-init`.

---

## 5. Qualidade de código TS/Node

### 5.1 Claims confirmadas

| Claim | Fonte | Confiança |
|---|---|---|
| **TypeScript 7.0 GA em 08/07/2026**, port nativo em Go, speedups típicos de **8× a 12×** (VS Code: 125,7 s → 10,6 s) | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ | **Alta** |
| **TS 7.0 não tem API programática** — ela só chega no **7.1**. Ferramentas que dependem da API (**typescript-eslint, ts-jest, ts-morph**, tooling de Vue/Svelte/Astro/MDX/Angular) precisam continuar no TS **6.0** | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ | **Alta** |
| Instalação lado-a-lado recomendada pela Microsoft: `"typescript": "npm:@typescript/typescript6@^6.0.0"` (binário `tsc6` + reexporta a API 6.0) junto de um alias para o TS 7 | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0-rc/ | **Alta** |
| **typescript-eslint suporta TypeScript `>=4.8.4 <6.1.0`** — **TS 7 fora**. ESLint suportado: `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0` | https://typescript-eslint.io/users/dependency-versions | **Alta** |
| `npm audit signatures` verifica assinaturas do registry (ECDSA-SHA2-NISTP256) e attestations de provenance; `--audit-level` define o nível mínimo para exit code ≠ 0 | https://docs.npmjs.com/cli/v11/commands/npm-audit | **Alta** |
| **Rulesets e branch protection coexistem** — todas as regras aplicáveis são aplicadas em conjunto; branch protection **não** está deprecado | https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets | **Alta** |
| Vitest 4 estabilizou o Browser Mode, separou providers (`@vitest/browser-playwright`, `-webdriverio`, `-preview`), adicionou `toMatchScreenshot`, `toBeInViewport`, `expect.schemaMatching` e removeu o reporter `basic` | https://vitest.dev/blog/vitest-4 | **Alta** |
| Biome v2.5: ~500 regras, code fixes em plugins GritQL, watcher, reporter concise; v2.4 trouxe formatação de CSS/GraphQL embutidos e 15 regras de a11y HTML | https://biomejs.dev/blog/ | **Alta** |
| Changesets: 3 passos (changeset no PR → `changeset version` → `changeset publish`), suporta workspaces pnpm/yarn/npm e faz bump de dependências dos pacotes alterados | https://github.com/changesets/changesets/blob/main/docs/intro-to-using-changesets.md | **Alta** |
| `actions/setup-node` suporta cache npm/yarn/pnpm (v6.10+); `node-version-file` aceita `package.json`, `mise.toml`, `.nvmrc`, `.node-version`, `.tool-versions` | https://github.com/actions/setup-node | **Alta** |
| `actions/attest-build-provenance` está na **v4** e agora é wrapper de `actions/attest`; gera attestations SLSA in-toto assinadas via Sigstore | https://github.com/actions/attest-build-provenance | **Alta** |
| pnpm oferece `trustPolicy` (com `no-downgrade`), `trustPolicyExclude` e `trustPolicyIgnoreAfter`, que trabalham com provenance e verificação de publisher para bloquear instalação quando a confiança cai | https://pnpm.io/supply-chain-security | **Alta** |
| **Versões latest em 19/08/2026:** typescript 7.0.2, eslint 10.8.1, vitest 4.1.11, oxlint 1.79.0, @biomejs/biome 2.5.9, @changesets/cli 3.0.1, semantic-release 25.0.9, @stryker-mutator/core 10.0.0, typedoc 0.28.20, c8 12.0.0, publint 0.3.24, @arethetypeswrong/cli 0.18.5, npm 12.0.2, pnpm 11.22.0 | https://registry.npmjs.org/typescript (e demais) | **Alta na data** |

**Sem claims refutadas nesta área.**

### 5.2 Contexto que orienta as decisões (síntese da pesquisa)

- **Defaults mudaram em TS 6.0/7.0:** `strict:true` por padrão, `module:esnext`,
  `target:es2025`, `types:[]` (precisa listar `"node"` explicitamente), `rootDir:"."` (quebra
  layouts `src/`); **removidos** `target:es5`, `--outFile`, `--baseUrl`, `module` amd/umd/systemjs,
  `moduleResolution` classic/node10; `esModuleInterop`/`allowSyntheticDefaultImports` passam a
  ser sempre `true`. **Recomendação: começar em TS 6.0**, rodar `tsc7` só para typecheck em CI,
  migrar de vez quando o 7.1 sair.
- **Módulos:** `require(ESM)` desflagado desde Node 20.19/22.12/23.0. Node 20 **EOL em
  30/04/2026**; v22 em maintenance até 30/04/2027; **v24 é Active LTS**; v26 vira LTS em
  28/10/2026. Portanto **ESM-only (`"type":"module"`) é o default correto** para pacote novo —
  evitando top-level await no grafo síncrono (`ERR_REQUIRE_ASYNC_MODULE`). No `exports`:
  **`types` sempre primeiro, `default` sempre por último**, do mais específico ao menos.
  Validar com **`publint`** + **`attw --pack .`** no CI. `module:"node20"` fixa semântica
  estável; `nodenext` é flutuante. `verbatimModuleSyntax` é obrigatório para rodar `.ts`
  nativamente no Node (sem enums, namespaces com runtime, parameter properties, decorators ou
  `paths`).
- **Testes:** `node:test` é estável desde Node 20 (snapshot estável no 23.4; mocking completo;
  reporters spec/tap/dot/junit/lcov; `--test-rerun-failures`; thresholds via
  `--test-coverage-lines/branches/functions`). Só a **coleta** de cobertura
  (`--experimental-test-coverage`) e o watch seguem experimentais. Para lib Node pura sem DOM,
  `node:test` = **zero dependências e zero superfície de supply chain**. Vitest 4 quando
  precisar de browser mode/DX. Jest não tem argumento técnico para projeto novo. Thresholds
  sugeridos: lines/functions 90%, branches 80–85%, com ratchet. Stryker 10: defaults
  `high:80`, `low:60`, `break:null` (só quebra se você setar) — ative `break` só depois de
  estabilizar, em job nightly.
- **Lint:** ESLint v10 (fev/2026) **removeu `.eslintrc`** — só flat config, Node ≥20.19.
  `oxlint` 1.79: 865+ regras, "50–100× mais rápido" (número oficial do projeto), type-aware via
  `tsgo`, usado por Kibana, Sentry, Renovate, Preact. Estratégia: oxlint/Biome como gate rápido
  + ESLint só para as regras type-aware que faltarem (lembrando o teto TS <6.1).
- **CI:** jobs separados de lint, typecheck, test, build, publint/attw. **Matriz canônica deste
  projeto: 24 e 26 (Linux) + 24 (macOS) — Node 22 fica FORA**, porque o pacote declara
  `engines: node >=24` e testar num runtime que o próprio manifesto recusa não é cobertura, é
  ruído (decidido em `06-REPO-E-CI.md` §6.2, que é o dono do `ci.yml`; propagado para `04`, `07`
  e para a lacuna L15).
  **`pnpm/setup@v2` substitui `actions/setup-node` + `pnpm/action-setup`** (este deprecado, só
  para pnpm ≤10). `permissions: {}` no topo e mínimo por job (`id-token: write` só no publish).
- **Publicação npm mudou em 12 meses:** tokens classic **permanentemente revogados em
  09/12/2025**; granular tokens com vida máxima de **90 dias**; `npm login` dá sessão de 2 h;
  2FA ligado por padrão em pacote novo. **Trusted Publishing (OIDC)** é o caminho: GitHub
  Actions/GitLab/CircleCI (runners cloud; self-hosted não), npm CLI **≥11.5.1**,
  `permissions: id-token: write`, campo `repository` batendo com o repo, config **por pacote**.
  Provenance é automática no GHA/GitLab sob trusted publishing (não no CircleCI) — vários
  relatos ainda exigem `--provenance`/`NPM_CONFIG_PROVENANCE=true`. **Staged publishing**
  (`npm stage publish` → `list/view/download` → `approve` com 2FA; npm ≥11.15.0, Node ≥22.14.0)
  permite CI publicar e humano aprovar. Desde **28/07/2026** há **malware scanning no publish**
  (atraso típico ~5 min, até 15+ em pico) — automação precisa de retry.
- **Supply chain:** npm v12 não roda lifecycle scripts de dependências nem node-gyp implícito
  sem allowlist (`npm approve-scripts --allow-scripts-pending`); git deps exigem `--allow-git`;
  URLs remotas `--allow-remote`. pnpm 11: `minimumReleaseAge` default **1440 min**,
  `blockExoticSubdeps: true`, `allowBuilds` explícito, Node 22+, ESM puro, `.npmrc` só para
  auth/registry (config vai para `pnpm-workspace.yaml`). Lockfile commitado + install frozen em
  CI. SBOM nativo: `npm sbom --sbom-format cyclonedx`. **OpenSSF Scorecard**: 23 checks
  (Branch-Protection, Token-Permissions, Pinned-Dependencies, Signed-Releases,
  Dangerous-Workflow…), action oficial + badge via `api.scorecard.dev`. Pin de actions por SHA
  pontua em Pinned-Dependencies.
- **Docs:** TypeDoc 0.28.20 é o padrão para API reference (HTML + JSON, plugin markdown).
  README que converte: badges de CI/npm/Scorecard, install em 1 linha, exemplo executável em 5
  linhas acima da dobra, seção "why/when not to use", link para API docs. **Exemplos executáveis
  viram testes** (rodar os snippets do README no CI).

### 5.3 NÃO CONFIRMADO nesta área

- Suporte oficial do **Stryker a `node:test`** como runner (docs listam jest/mocha/vitest/
  jasmine/karma/cucumber/tap, **não** `node:test`). Consequência já decidida: mutation testing roda
  em **job noturno não bloqueante** e o runner do projeto **continua sendo `node:test`** — não se
  introduz Vitest "só para o núcleo puro" (`09-DECISOES-CANONICAS.md` §D16).
- **"Type stripping estável no Node 25.2, flag removida no 26."** Esta afirmação circula em
  `04-TESTES.md` §3.1 e em `06-REPO-E-CI.md` §6.2 e **não está registrada em lugar nenhum deste
  documento** — nem em §5.1, nem em §5.2, nem na tabela de fatos §8. Pela regra 1, é **suposição**.
  Ela foi removida do texto normativo dos dois arquivos (`09-DECISOES-CANONICAS.md` §D24 item 6) e
  **não pode** ser usada como justificativa para a matriz de Node: a única razão escrita da matriz é
  `engines: node >=24`. Fecha no spike da Onda 0, medindo no runtime exato do CI.
- Percentual oficial de compatibilidade Prettier do **Biome**.
- Documentação oficial do **Changesets sobre provenance/OIDC**.
- Suporte do **TypeDoc ao TypeScript 7**.
- Dados públicos de adoção comparando **Changesets vs semantic-release** (a escolha é de
  processo: decisão humana explícita vs. inferida do commit).

---

## 6. Divulgação para a comunidade

### 6.1 A arquitetura de descoberta tem um portão único — e não é a topic

> **Linha de lastro (número único e citável).** A contagem de estrelas da `awesome-dsh-plugin`
> foi lida **duas vezes em 2026-08-19**, com resultados **10.021** e **10.026**. Não há erro:
> é a variação natural de um repositório vivo entre duas leituras. **Número canônico para
> qualquer material público: "~10 mil estrelas"**. Citar `10.021` ou `10.026` como se fosse
> medida estável é exatamente o tipo de número que um comentarista refuta em cinco minutos
> (`07-COMUNIDADE.md` §10, regra do lastro).

Cadeia real: **awesome-dsh-plugin** (registro curado, ~1.650 plugins, ~10 mil★) →
`awesome-dsh-plugin.com/plugins.json` → **dsh-market** (market visual dentro do DSH, npm
`dshmarket`, ~82k downloads/semana).

| Claim | Fonte | Confiança |
|---|---|---|
| O market oficial **restringe instalações às fontes listadas no registro curado**: *"Installs are restricted to sources listed in the curated awesome-dsh-plugin registry — anything else is rejected"*. **Entrar na awesome-list é o portão de instalabilidade in-app**, não um "nice to have" | https://raw.githubusercontent.com/dsh-market/dsh-market/main/README.md | **Alta** |
| O CI da awesome-list roda 3 checks e o **primeiro lê `dsh.bundle`** do `package.json` (raiz ou subpacote em `packages/`·`plugins/`·`apps/`): *"Declaring only `dsh.client` fails here."* | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md | **Alta** |
| A awesome-list exige, **com verificação automática**, repositório com **≥1 dia de idade** e **≥10 commits**: *"The repo is at least 1 day old and has 10 or more commits. This is checked automatically."* Constantes no código: `MIN_AGE_DAYS = 1`, `MIN_COMMITS = 10` (`check-submission.mjs` L21-22) | contributing.md + https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/scripts/check-submission.mjs | **Alta** |
| A **topic `dsh-plugin`** é obrigatória (a awesome-list exige) mas entrega ~zero descoberta sozinha: já tem ~8.398 repositórios, com os primeiros lugares ocupados por projetos de 12k–167k estrelas. A página oficial `deepseek.com/harness` aponta "Community Plugins" para `github.com/topics/dsh-plugin` | deepseek.com/harness + github.com/topics/dsh-plugin | **Alta** |

**Canal de maior sinal:** a categoria oficial **"Show Your Plugins!"** do Discussions upstream,
com guidelines fixadas (**#2004**): título `DSH | Project Name | One-line description`,
screenshots/GIF/vídeo de demo + explicação da integração, **um projeto por thread**, proibida
promoção não relacionada e post duplicado. É o único canal cujo público é 100% usuário de DSH.

**Calibração de expectativa** (do `plugins.json` inteiro): **mediana de 2 estrelas** por plugin,
p90 = 15, p99 = 710. Só **38% publicam no npm**; entre esses, mediana de **514 downloads/semana**.
Metas realistas: **15 estrelas já é p90**; **1.000 downloads/semana já é ~p75**.
Show HN (fonte **não reacessível**, ver L10): mediana de 2 pontos, 50 pontos = top 6%,
~1,4 estrela por upvote, 92% do impacto em 48 h, ~200 Show HN concorrentes por dia; melhor
janela medida segunda 00:00 UTC (10,8% de chance de 50+), pior quinta 06:00 UTC (2,6%).
**Tratar como estimativa, nunca como meta contratual.**

**Concorrência direta já listada:** `dsh-webui-auth` (7★) faz *"WebUI authentication enforced at
the HTTP/transport layer: four-layer login gate (resources, plugin bundles, /api, WebSocket)"* —
cobre quase exatamente a nossa função #1. A regra da lista é *"whoever got here first keeps the
slot — but that is a tiebreaker, not tenure (…) the rule is whichever is better"*. A submissão
precisa articular diferenciais **verificáveis**: interceptação do handshake de upgrade de
WebSocket, allowlist do endereço de **bind** (distinta de `trustedRemotes`), **403 antes de
401**, recusa de `danger-full-access`, e o worker sob `ctx.effect()` com ambiente construído por
allowlist.

**Narrativa de lançamento pronta e verificável:** a discussion **#853** é relatório público de
vulnerabilidade real (o `dsh web` expõe 60+ métodos RPC sem autenticação), postada publicamente
justamente porque o upstream **não tem SECURITY.md, CONTRIBUTING.md (ambos 404) nem Private
Vulnerability Reporting**. Publicar SECURITY.md e ligar PVR neste repo é diferencial concreto.

**Install de uma linha:** o padrão canônico das 1.650 entradas é
`dsh plugin --profile web add <pkg-npm>` ou `… add github:owner/repo`. Publicar no npm encurta e
pula o passo `allowBuilds` do pnpm ≥10. Alternativa oficial: campo `tarball:` apontando `.tgz`
https em GitHub Release. **O nome npm `dsh-guarded-bot-orchestrator` estava LIVRE** (HTTP 404 em (hoje: dsh-guard-messenger)
2026-08-19) — vale reservar.

### 6.2 Claim REFUTADA

> **REFUTADA (o trilema):** *"O `package.json` omite `dsh.bundle.patch` deliberadamente; como
> está, o repo reprova no check #1 e portanto nunca aparece no dsh-market. É preciso decidir
> entre (a) declarar um patch mínimo distinto, (b) declarar o mesmo arquivo e aceitar a dupla
> camada, ou (c) abrir mão da awesome-list e do market."*

**Parcialmente verdadeira, mas o núcleo decisório é falso — é um falso trilema.**

- **Confirmado:** os repos existem (awesome-dsh-plugin ~10 mil★ — ver a linha de lastro em §6.1 —, dsh-market 1.242★);
  `contributing.md` L135 lista `dsh.bundle` como check #1 e o exemplo L59 marca
  `"bundle": { "patch": "./cordis.patch.yml" }  // ← required / 必須`. O `package.json` local
  **não tem chave `dsh` alguma**, então reprova mesmo.
- **Refutação 1 (decisiva) — o gate NÃO exige `.patch`.** O código que decide é
  `scripts/check-submission.mjs`: `if (dsh.bundle) return { ok: true }` (L193) e
  `if (dsh.bundle) { … return { ok: true, at: p } }` (L153). Ele **nunca lê `dsh.bundle.patch`**
  e nunca verifica se o arquivo apontado existe. **`"dsh": { "bundle": {} }` é truthy e passa.**
  Existe portanto uma **opção (d)** que a alegação omite: declarar `dsh.bundle` **sem** a
  subchave `patch`, satisfazendo o check #1 e preservando a arquitetura de verdade única. O
  "← required" do `contributing.md` é **prosa, não o gate**.
- **Refutação 2 — o check #1 não é o motivo de "nunca aparecer no market".**
  `MIN_AGE_DAYS = 1` e `MIN_COMMITS = 10` também reprovam hoje (7 commits, primeiro commit no
  mesmo dia). Resolver o manifesto **não** faz a entrada aparecer.
- **Gotcha sobre a opção (b):** apontar o **mesmo** arquivo é **ativamente perigoso hoje**, não
  só "dupla camada": `cordis.patch.yml` L170 tem
  `id: '<ID-DA-ENTRADA-DO-SERVIDOR-WEB-NESTA-INSTALACAO>'` (placeholder). Pelo README
  (L166-171), id que não casa **deixa de ser whole-entry replace e vira insert** → segunda
  instância do servidor web → conflito de rota → **boot rejeitado**. Esse — e não a "dupla
  verdade" — é o obstáculo real, e é problema de design do placeholder.
- **Bloqueios adicionais:** as **keywords do npm não incluem `dsh-plugin`** (1.909 pacotes usam)
  e **não há campo `repository`** — sem ele o registro npm não é vinculado à entrada e o market
  não mostra downloads. `peerDependencies` em `@deepseek-ai/*` é recomendado, não obrigatório.

Fontes: `.../blob/main/scripts/check-submission.mjs`, `.../blob/main/.github/workflows/pr-gate.yml`,
`.../blob/main/contributing.md`.

### 6.3 Ética, regras de canal e o que afunda um lançamento

| Regra | Fonte | Confiança |
|---|---|---|
| HN proíbe explicitamente solicitar votos (*"Don't solicit upvotes, comments, or submissions"*) e usar o site primariamente para promoção; Show HN rejeita blog posts e sign-up pages. Diretriz de título: *"please use the original title, unless it is misleading or linkbait; don't editorialize"*. Segunda chance é via **second-chance pool** (`hn@ycombinator.com`), nunca deletar-e-repostar | https://news.ycombinator.com/newsguidelines.html | **Alta** |
| Product Hunt: horário recomendado **12:01 AM Pacific**, mas *"the best day to launch is the day on which you're most prepared"*; **proibido pedir upvote** (*"you cannot ask people directly to upvote your product. Instead, ask them to visit and comment"*); **contas de empresa proibidas** (makers lançam de conta pessoal); relançamento permitido a cada iteração significativa; plataforma 100% gratuita | https://www.producthunt.com/launch | **Alta** |
| A awesome-list **rejeita superlativos** e verifica cada número da descrição contra o código: *"Overstating is the one thing that gets an otherwise-good plugin sent back"* | contributing.md | **Alta** |
| GitHub topics: máx. **20 por repo**, ≤50 chars, só minúsculas/números/hífens; só admins adicionam; nomes de topic são sempre públicos | https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics | **Alta** |
| Community profile mede README, CODE_OF_CONDUCT, LICENSE, CONTRIBUTING, política de segurança e templates. Templates em `.github/ISSUE_TEMPLATE` com frontmatter válido (`name:`+`about:` para `.md`; `name:`+`description:` para forms `.yml`) | https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/about-community-profiles-for-public-repositories | **Alta** |
| Contributor Covenant **2.1** é a versão corrente, tem placeholder `[INSERT CONTACT METHOD]` que **deve** ser preenchido, e exige a linha de atribuição | https://www.contributor-covenant.org/version/2/1/code_of_conduct/ + https://opensource.guide/starting-a-project/ | **Alta** |
| O guia oficial de open source: o README responde *"What does this project do? Why is this project useful? How do I get started? Where can I get more help?"*; o CONTRIBUTING explica reportar bug, sugerir feature, montar ambiente e rodar testes | https://opensource.guide/starting-a-project/ | **Alta** |
| Métricas: `GET https://api.npmjs.org/downloads/point/{period}[/{package}]` e `/range/…`; máx. **18 meses** de histórico, dados desde 2015-01-10, lote de 128 pacotes/365 dias **sem suporte a scoped**; por versão só últimos 7 dias via `/versions/{package}/last-week`; processamento diário logo após meia-noite UTC | https://github.com/npm/registry/blob/main/docs/download-counts.md | **Alta** |
| Badge de downloads: `/badges/npm-downloads/:interval/:packageName`, `:interval` ∈ `dw`/`dm`/`dy`/`d18m`, com suporte a scoped | https://shields.io/badges/npm-downloads | **Alta** |
| Licença: o upstream é **MIT** (`spdx_id: "MIT"`); este plugin também. Trocar para Apache-2.0 ganharia a concessão de patente do §3 (relevante num componente de segurança) ao custo do §4 (NOTICE + aviso de arquivos modificados). **A awesome-list não exige licença específica** | https://api.github.com/repos/deepseek-ai/deepseek-harness | **Alta** |
| Existe Discord oficial linkado no README upstream (`https://discord.gg/Ycq5dCaS4`, ~27.961 membros). **O convite expira em 2026-09-12T04:01:33Z** — não embutir em doc permanente sem revalidar | README upstream + API do Discord | **Alta (expira)** |

**NÃO CONFIRMADO nesta área:** regras oficiais de **r/programming, r/node e r/selfhosted**
(Reddit retornou **403 em todas as rotas**, inclusive `/about/rules.json` e old.reddit.com), a
**Reddiquette** oficial (403), o estudo **asof.app** sobre sobrevivência de Show HN
(ECONNREFUSED), e política explícita de autopromoção no **Code of Conduct do dev.to** (não existe
seção sobre isso). **Qualquer post no Reddit exige um humano logado ler as regras antes.**

---

## 7. Riscos de expor o agente

Esta é a área que justifica a **tensão central** do projeto (plugin travado em loopback vs.
desejo de expor).

### 7.1 Claim confirmada — a base do modelo de ameaça

| Claim | Fonte | Confiança |
|---|---|---|
| Doc oficial (atualizada 2026-04-20), verbatim: *"Quick Tunnels are intended for testing and development only. For production use, create a remotely-managed tunnel."* e *"Free tunnels are meant to be used for testing and development, not for deploying a production website."* A página **não descreve nenhuma camada de autenticação** | https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/ | **Alta** |
| Dos hostnames de quick tunnel obtidos do urlscan.io numa única chamada, **13 (18%) ainda resolviam em DNS naquele instante** — lista de alvos **ativos** sem brute force. Hostnames inexistentes **não resolvem** (`http=000`, sem registro): **o DNS funciona como oráculo de liveness**, barateando qualquer varredura | https://urlscan.io/api/v1/search/?q=page.domain%3Atrycloudflare.com&size=100 + resolução DNS local | **Alta** (medido) |

### 7.2 Claim REFORMULADA — o que o urlscan.io realmente prova

> **Núcleo confirmado, evidências corrigidas.** A query
> `https://urlscan.io/api/v1/search/?q=page.domain:trycloudflare.com` responde **HTTP 200 sem
> API key**, com `total: 10000`, `has_more: true`, headers `x-rate-limit-scope: ip-address`,
> `x-rate-limit-limit: 30`/min, devolvendo **73 hostnames distintos** em 100 resultados.
> **Busca pública, sem autenticação, retornando hostnames de quick tunnel: verdadeiro.**

Três correções que precisam entrar no plano:

1. **"Todos datados do próprio dia" é FALSO.** As datas (`task.time`) espalham-se por 6 dias:
   18/08 = 31, 19/08 = 21, 17/08 = 15, 16/08 = 14, 15/08 = 14, 14/08 = 5. **Só 21% são do dia.**
   A ordenação default é por score, não por data, e a URL não passa `&sort=date`.
2. **`total=10000` não é evidência de volume** — é teto do Elasticsearch. A doc oficial:
   *"The API search will only indicate an exact count of results up to 10,000 results in the
   total property"*.
3. **urlscan NÃO enumera tunnels vivos** — só indexa URLs que **alguém submeteu** com
   `visibility: public`. Nos 100 resultados, **96 vieram por `method: api`** e **100/100
   `visibility: public`**: é majoritariamente feed automatizado de segurança/antiphishing
   (várias amostras são phishing). Um quick tunnel que ninguém submeteu **não aparece ali**.

**Formulação correta para o plano:** *"o hostname vira público assim que qualquer scanner ou
feed o vê"* — **não** *"hostnames de quick tunnel são enumeráveis"*. A conclusão prática
(**a URL do túnel não é credencial**) fica **reforçada**, mas a justificativa muda.

Precedente que sustenta a doutrina: o **urlscan.io vazou massivamente** links de reset de senha,
convites, API keys e invoices porque ferramentas de segurança submetiam URLs com visibilidade
`public` por padrão (Positive Security, 2022). O mesmo mecanismo indexa tunnels hoje.

### 7.3 Claim REFUTADA — indexação por motor de busca

> **REFUTADA:** *"URLs de quick tunnel são indexadas por motores de busca:
> `site:trycloudflare.com` retornou `unless-caused-floyd-flexibility.trycloudflare.com`,
> vivo, mesmo servindo `robots.txt: Disallow: /`."*

1. **O `robots.txt` está mal citado — e é a citação errada que cria o "gotcha".** O arquivo real
   (HTTP 200, 58 bytes) é:
   ```
   User-agent: *
   Disallow: /
   Allow: /auth/
   Allow: /api/docs/
   ```
   A origem **libera explicitamente** `/auth/` e `/api/docs/` (ambos 200). É o `robots.txt`
   default do CVAT. Não é caso de "robots.txt não impediu a indexação".
2. **A proveniência não é reproduzível.** Busca independente `site:trycloudflare.com` devolveu 14
   hits, **todos** em `trycloudflare.com` / `try.cloudflare.com` / `developers.cloudflare.com` —
   **zero** subdomínios aleatórios. Busca por frase exata do hostname: zero hits.
   Contra-checagens: urlscan `page.domain:"unless-caused-floyd-flexibility.trycloudflare.com"` →
   `{"results":[],"total":0}`; Wayback → `archived_snapshots: {}`. (Google/Bing/DDG/Mojeek
   bloquearam por bot, então não é prova negativa absoluta — mas **não há uma evidência
   positiva**.)
3. **O que sobrevive, e é grave:** o host **está mesmo vivo e exposto** — HTTP/2 200,
   `server: cloudflare`, `cf-ray: a2dc59e53cc44ae9-GRU`, `<title>Open-H Surgical Annotation
   Project</title>`, CVAT-UI; e **`/api/server/about` responde SEM auth**
   (`{"name":"Open-H Surgical Annotation Project","version":"2.61.1", …}`). **Exposição real, com
   vetor de descoberta desconhecido.**
4. **O princípio geral continua certo, mas com outra fonte:** o Google Search Central diz
   *"it is not a mechanism for keeping a web page out of Google"* e *"A page that's disallowed in
   robots.txt can still be indexed if linked to from other sites"*. Também confirmado que a
   Cloudflare **não injeta `X-Robots-Tag`** no quick tunnel, e que a doc do TryCloudflare é
   **silenciosa sobre indexação**.

**Ação aplicada nesta revisão:** este item foi **rebaixado de "Alta (medido)" para "Baixa / não
reproduzível"** e movido de *claims confirmadas* para *claims refutadas*. A generalização "URLs de
quick tunnel são indexadas por motores de busca" **não pode ser usada** no plano.

### 7.4 Fatos operacionais de risco (contexto, todos com fonte nomeada)

- **Cloudflare Access não pode ser colocado na frente de um quick tunnel** (exige `zone_id`/
  domínio com DNS na Cloudflare). Num quick tunnel, **toda a autenticação está na aplicação** —
  sem rede de proteção. **Confiança: Alta.**
- **O túnel fura o firewall local:** *"cloudflared initiates an outbound connection through your
  firewall from the origin to the Cloudflare global network"*. Regras de INPUT dão falsa sensação
  de segurança.
- **Velocidade de descoberta e exploração:** Unit 42 (320 honeypots, jul-ago/2021) — **80%
  comprometidos em 24 h, 100% em uma semana**; um ator comprometeu **96% de 80 honeypots Postgres
  em ~30 segundos**; **85% dos IPs atacantes apareceram em um único dia** (bloqueio por IP é
  inútil). Palo Alto/Cortex Xpanse: todo o espaço IPv4 varrido em **<45 minutos**, scanning por
  CVE nova em **~15 minutos**. Censys detecta serviço novo em **~12,3 h de média** (5,7 h mediana)
  vs Shodan ~76,5 h. Campanha contra **ComfyUI** (Censys, abr/2026): scanner Python com 500
  conexões concorrentes **a cada 3-4 horas**, 105.210 IPs num ciclo, 624 instâncias vivas, 214
  vulneráveis, **97 exploits bem-sucedidos**.
- **Precedentes da nossa categoria:** Jupyter exposto → **Qubitstrike** (rootkit + roubo de
  credenciais AWS/GCP) e **Panamorfi** (DDoS via `mineping.jar`, C2 em canal do Discord —
  https://www.aquasec.com/blog/panamorfi-a-new-discord-ddos-campaign/). **Ollama** exposto →
  Cisco achou 1.139 endpoints no Shodan em 10 minutos, **214 sem autenticação**; CVE-2024-37032
  ("Probllama") dá RCE não autenticado, e instalações Docker eram piores porque a API sobe como
  root e faz bind em **todas as interfaces**. Docker API 2375 e Redis 6379 abertos = cryptojacking
  clássico. **DeepSeek deixou um ClickHouse público** em `oauth2callback.deepseek.com:9000` com
  >1M linhas de log, histórico de chat e secret keys (Wiz, jan/2025).
- **Por que um agente de código é alvo premium — e já aconteceu:** no ataque de supply chain
  **"s1ngularity" ao Nx (26/08/2025)**, o malware **weaponizou os agentes de código já instalados**,
  invocando-os com as flags que desligam as travas:
  `claude --dangerously-skip-permissions -p [PROMPT]`, `gemini --yolo -p [PROMPT]`,
  `q chat --trust-all-tools --no-interactive [PROMPT]`. O prompt varria recursivamente `$HOME`,
  `.config`, `.ethereum`, `/etc` procurando `.env`, `id_rsa`, `keystore`, `wallet`, `*.key`,
  `secrets.json`. Resultado: **2.349 credenciais de 1.079 máquinas**, >1.000 tokens GitHub
  válidos, ~20.000 arquivos vazados para >1.400 repositórios `s1ngularity-repository`.
- **Prompt injection não é teórico e não tem defesa confiável:** **CVE-2025-53773** (GitHub
  Copilot) — injeção escondida em Unicode invisível faz o agente escrever
  `"chat.tools.autoApprove": true` no próprio `.vscode/settings.json`, **auto-elevando
  privilégios** até RCE. Cursor: **CVE-2025-54135** (dotfiles sem aprovação) e **CVE-2025-49150**
  (RCE via MCP). Roo Code: **CVE-2025-53097**. Survey de 78 estudos (**arXiv 2601.17548**): 42
  técnicas em 5 categorias, **>85% de sucesso contra defesas estado-da-arte** com estratégias
  adaptativas, e a maioria das 18 defesas avaliadas fica **abaixo de 50%** de mitigação. A
  Anthropic é honesta: *"no system is completely immune to all attacks"*.
- **A classe de bug que fulmina exatamente este design — WebSocket sem validação de Origin
  (CWE-1385):** `code-server` < 4.10.1 = **CVE-2023-26114, CVSS 9.3**. Claude Code IDE extensions
  0.2.116–1.0.23 = **CVE-2025-52882** (qualquer página web abria WebSocket para o servidor local
  e lia arquivos arbitrários). Mesma família: Vitest, webpack-dev-server, Gitpod, Next.js HMR.
  **Allowlist de Origin não é opcional — é o controle que impede o ataque mais provável.**
  No mesmo espírito, o **"0.0.0.0 Day"** (Oligo, 2024) mostrou sites públicos alcançando serviços
  em `0.0.0.0` no macOS/Linux driblando a Private Network Access do Chromium, **com exploração
  observada in the wild**. Bind em `0.0.0.0` é risco mesmo sem túnel.
- **Economia do ataque — LLMjacking** (Sysdig, desde mai/2024): chaves de LLM roubadas viram
  serviço via reverse proxies (uma ORP com **55 chaves DeepSeek distintas**); DeepSeek-R1 saiu em
  20/01/2025 e **já estava sendo abusado no dia seguinte**.
- **Reputação do domínio:** desde fev/2024 atacantes abusam do TryCloudflare para tunnels
  descartáveis distribuindo AsyncRAT, GuLoader, Remcos, VenomRAT, XWorm, PureLogs Stealer
  (https://www.proofpoint.com/us/blog/threat-insight/threat-actor-abuses-cloudflare-tunnels-deliver-rats).
  O ransomware **Akira usa `cloudflared` como persistência**, instalado como serviço em
  `C:\ProgramData\ssh`
  (https://arcticwolf.com/resources/blog/smash-and-grab-aggressive-akira-campaign-targets-sonicwall-vpns/).
  **Consequência prática:** muitas redes corporativas bloqueiam ou monitoram `trycloudflare.com`,
  há regras Sigma públicas para detectar `cloudflared`, e **o padrão técnico que vamos usar é
  assinatura de comprometimento em EDR**. Isso precisa estar no README, para o usuário não ser
  pego de surpresa no trabalho.
- **Mitigações com respaldo primário:** `code-server` (doc oficial Coder): *"Never expose
  code-server directly to the internet without some form of authentication and encryption,
  otherwise someone can take over your machine via the terminal"* — default
  `bind-addr: 127.0.0.1:8080`, `auth: password`, rate limit de **2 tentativas/min + 12/hora**.
  Jupyter: token ligado por padrão desde 4.3; desabilitar auth é *"NOT RECOMMENDED"*.
  Anthropic: sandbox com isolamento de filesystem e rede em nível de kernel (**reduziu 84% dos
  prompts** internamente), working-directory boundary, `permissions.deny`, hooks `ConfigChange`
  para auditar mudança de config em sessão, dev containers, OpenTelemetry.

### 7.5 Recomendação derivada

Trate a URL do túnel como **público conhecido desde o segundo zero**; exija autenticação forte
dentro da app (token de alta entropia + rate limit + lockout); valide `Origin`/`Host` com
allowlist estrita **em HTTP e em WebSocket**; nunca `0.0.0.0`; rode o agente em sandbox/container
com egress allowlist; kill switch e **TTL curto** no túnel; log de toda requisição com alerta no
primeiro acesso não reconhecido; e assuma prompt injection como **certeza operacional**, não como
risco residual.

**NÃO CONFIRMADO:** não há pesquisa publicada sobre **brute-force de subdomínios
`trycloudflare.com`**, e **não foi possível acessar o crt.sh** (502/404) para checar Certificate
Transparency. Registrado como lacuna, não como ausência de risco.

---

## 8. Fatos operacionais que o implementador vai precisar

| # | Fato / comando / limite | Fonte | Confiança |
|---|---|---|---|
| 1 | `GET http://127.0.0.1:<metrics>/quicktunnel` → `{"hostname":"….trycloudflare.com"}` (**sem esquema**). Fazer **polling**, não regex de log | Medido, cloudflared 2026.7.3 | Alta |
| 2 | `cloudflared tunnel --url http://localhost:3080 --metrics 127.0.0.1:20241 --pidfile <path>` — **pinne a porta de métricas**; o default no 2026.7.3 é `localhost:0` (aleatória), com fallback 20241–20245 | `cloudflared --help` | Alta |
| 3 | A URL sai em **stderr**; stdout fica com **0 bytes**. Regex fallback: `https://[-a-z0-9]+\.trycloudflare\.com` | Medido | Alta |
| 4 | Tempo até a URL: **6–7 s**. Timeout de espera **≥30 s** | Medido (2 execuções) | Alta |
| 5 | `SIGTERM` no cloudflared → saída em **~2 s**; a URL pública passa a **HTTP 530** imediatamente. `--grace-period` default **30 s**; segundo sinal corta na hora | Medido | Alta |
| 6 | `cloudflared tunnel ready` chama `/ready` e converte em exit code; `/healthcheck` devolve `OK`; `/` devolve 404 | `cloudflared tunnel --help` + medido | Alta |
| 7 | Quick tunnel: **200 requisições in-flight** → **HTTP 429** acima; **sem SLA**; **sem auth**; hostname novo a cada restart | https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/ | Alta |
| 8 | **Cloudflare Access não funciona sobre quick tunnel** (exige `zone_id`/domínio) | Doc Cloudflare Access | Alta |
| 9 | Access injeta JWT em `Cf-Access-Jwt-Assertion`; chaves em `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`; validar `kid`,`iss`,`aud`,`exp`; **validar o header, não o cookie** | https://developers.cloudflare.com/cloudflare-one/policies/access/ | Alta |
| 10 | Instalação assinada: repo apt `pkg.cloudflare.com` com `cloudflare-main.gpg`; o binário loga o próprio checksum no startup | https://pkg.cloudflare.com/ + medido | Alta |
| 11 | Telegram: `getUpdates` aceita `offset`, `limit` (1–100), `timeout` (o servidor clampa em 50 s) e `allowed_updates` (`["message","callback_query"]`) | https://core.telegram.org/bots/api#getupdates + `Client.h:1704` | Alta |
| 11-b | **CORREÇÃO (D9): `drop_pending_updates` NÃO é parâmetro de `getUpdates`.** Ele é parâmetro de `setWebhook` e de `deleteWebhook`. Descartar a fila no boot em modo long polling faz-se com **`deleteWebhook(drop_pending_updates: true)`** antes do primeiro `getUpdates` (o que também garante que nenhum webhook residual esteja registado). Alternativa sem `deleteWebhook`: um `getUpdates` com `offset: -1` e confirmação do `update_id` retornado. Quem procurar a flag dentro da chamada de `getUpdates` vai procurar no lugar errado | https://core.telegram.org/bots/api#deletewebhook | **Alta** |
| 12 | Polling duplicado → **HTTP 409** *"Conflict: terminated by other getUpdates request…"*; throttle de 1 resposta imediata a cada 3 s | `Client.cpp:17356`, `17362-17368` | Alta |
| 13 | Updates pendentes expiram no servidor em **24 horas** | https://core.telegram.org/bots/api#getupdates | Alta |
| 14 | `callback_data`: **1–64 bytes**; `answerCallbackQuery.text`: 0–200 chars; `sendMessage`/`editMessageText`: 1–4096 chars | https://core.telegram.org/bots/api#sendmessage | Alta |
| 15 | ~~`InlineKeyboardButton.style`: `"danger"`/`"success"`/`"primary"`~~ — **REBAIXADO NESTA REVISÃO para NÃO CONFIRMADO (D10).** Esta linha era a única da tabela **sem URL de fonte** ("Bot API 10.x" é rótulo, não citação): nenhuma página de `core.telegram.org/bots/api` foi lida no raw para ela. **PROIBIDO** usá-la como requisito de entrega ou como caso de teste. Ver lacuna **L19** | — (sem fonte primária) | **NÃO CONFIRMADO** |
| 16 | `deleteMessage` só **< 48 horas**; `deleteMessages` 1–100 por chamada, ignora silenciosamente as não encontradas | https://core.telegram.org/bots/api#deletemessages | Alta |
| 17 | Rate limits: **1 msg/s** por chat, **20/min** por grupo, **~30/s** broadcast; 429 traz `parameters.retry_after` | https://core.telegram.org/bots/faq | Alta |
| 18 | Webhook (se algum dia for usado): só HTTPS, portas **443/80/88/8443**; `max_connections` 1–100 (default **40**); `secret_token` 1–256 `[A-Za-z0-9_-]` no header `X-Telegram-Bot-Api-Secret-Token`, **comparado em tempo constante**; IPs 149.154.160.0/20 e 91.108.4.0/22 | https://core.telegram.org/bots/api#setwebhook | Alta |
| 19 | `Chat.id`/`User.id`: até **52 bits significativos** — nunca `int32`; `number` de JS é seguro | https://core.telegram.org/bots/api | Alta |
| 20 | `getMe` valida o token; `BotCommand.command` 1–32 chars `[a-z0-9_]`, `description` 1–256 | https://core.telegram.org/bots/api#getme | Alta |
| 21 | grammY **1.45.1**; plugin auto-retry (`maxRetryAttempts`/`maxDelaySeconds`); `bot.catch` + `GrammyError`/`HttpError`; `errorBoundary` por escopo | https://registry.npmjs.org/grammy + https://grammy.dev/guide/errors | Alta |
| 22 | Segredo: **≥128 bits** de CSPRNG (ASVS 11.5.1 / 7.2.3). `randomBytes(16)` = 128 bits; `randomBytes(32)` = 256 bits | https://github.com/OWASP/ASVS/blob/master/5.0/en/0x20-V11-Cryptography.md | Alta |
| 23 | Codificação: base32 5 bits/char (**128 bits = 26 chars**), base64 6 bits/char (22), hex 4 (32). Base32 é o melhor para digitar/ditar/QR | https://www.rfc-editor.org/rfc/rfc4648.html | Alta |
| 24 | `crypto.timingSafeEqual` **lança** se os buffers tiverem tamanhos diferentes → comparar **digests SHA-256 de 32 bytes**, nunca tokens crus | https://nodejs.org/api/crypto.html | Alta |
| 25 | `crypto.argon2()` / `argon2Sync()` **built-in desde Node v24.7.0**; antes só `scrypt`. **Não há bcrypt nativo** | doc Node (`crypto.json`, `meta.added`) | Alta |
| 26 | Se houver senha escolhida por humano: Argon2id **m=19456 (19 MiB), t=2, p=1** (ou equivalentes do Apêndice C); salt ≥16 bytes | OWASP Password Storage / ASVS 5.0 Apêndice C | Alta |
| 27 | Limite de tentativas: **≤100 consecutivas por conta** (NIST **SHALL**); backoff sugerido *"30 seconds up to an hour"*; **nunca lockout permanente da única conta** | https://pages.nist.gov/800-63-4/sp800-63b.html | Alta |
| 28 | fail2ban defaults: `maxretry=5`, `findtime=10m`, `bantime=10m` | https://github.com/fail2ban/fail2ban/blob/master/config/jail.conf | Alta |
| 29 | Cookie de sessão: `__Host-` + `Secure` + `HttpOnly` + `SameSite=Strict` + `Path=/`, valor opaco; POST/PUT **SHALL** ter proteção CSRF | https://pages.nist.gov/800-63-4/sp800-63b.html §5.1.1 | Alta |
| 30 | `Authorization: Bearer` **não é vulnerável a CSRF** (o browser não envia cross-site automaticamente) — mas XSS derrota qualquer mitigação de CSRF | OWASP CSRF Cheat Sheet | Alta |
| 31 | HSTS: `max-age=63072000; includeSubDomains; preload` (86400 no rollout); `preload` tem consequências permanentes | https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html | Alta |
| 32 | Reautenticação AAL2: overall **≤24 h**, inatividade **≤1 h** | https://pages.nist.gov/800-63-4/sp800-63b.html | Alta |
| 33 | `spawn(cmd, args, { detached:true, stdio:['ignore','pipe','pipe'] })` + `process.kill(-child.pid,'SIGTERM')` → mata a árvore. `stdio:'inherit'` mantém o filho preso ao terminal controlador | https://nodejs.org/api/child_process.html + medido | Alta |
| 34 | **`'close'` é o único evento terminal universal.** ENOENT → `error → close`, **sem `'exit'`**; `exitCode === -2`, `pid === undefined` | Medido (Node v24.15.0) | Alta |
| 35 | AbortSignal **já abortado** no `spawn()` → kill adiado para `process.nextTick`; **o processo É criado** | Medido | Alta |
| 36 | AbortError só é emitido se `child.kill()` retornar `true` (PR #37325); `err.cause` = a `reason` | `lib/child_process.js` + medido | Alta |
| 37 | **Nunca** `process.kill(-process.pid, …)`; **nunca** usar ESRCH como prova de ausência de grupo (filho pode ter chamado `setsid`; há risco de PID reuse) | Medido (contra-exemplos `t7.mjs`) | Alta |
| 38 | Windows: `taskkill /PID <pid> /T /F`; `signal` ignorado exceto SIGKILL/SIGTERM/SIGINT/SIGQUIT | Microsoft Learn + https://nodejs.org/api/child_process.html | Alta |
| 39 | Backoff **Full Jitter**: `sleep = random(0, min(cap, base * 2**attempt))`, `base=250 ms`, `cap=30 s`; reset só após ~60 s de uptime saudável; orçamento em janela deslizante | AWS Architecture Blog (Marc Brooker) | Média |
| 40 | `execa`: `forceKillAfterDelay` default **5000 ms**; `killDescendants` cria process group e sinaliza o grupo (Unix) | Doc execa | Alta |
| 41 | Não-retryable: `ENOENT`, `EACCES`, exit code determinístico de config inválida (ex.: 78/`EX_CONFIG`) | Pesquisa | Média |
| 42 | Readiness: polling de `/healthz` com `AbortController` **abortado no `'close'` do filho**; poll fixo **50–200 ms**; timeout de warmup separado do de request | `wait-on` + pesquisa | Alta |
| 43 | `dsh plugin --profile web add <pkg-npm>` (ou `add github:owner/repo`) é o install canônico das 1.650 entradas | https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md | Alta |
| 44 | awesome-list: repo **≥1 dia** e **≥10 commits** (`MIN_AGE_DAYS`/`MIN_COMMITS` no `check-submission.mjs`); check #1 aceita **`dsh.bundle` truthy**, mesmo `{}` | `scripts/check-submission.mjs` L21-22, L153, L193 | Alta |
| 45 | Trusted publishing npm: CLI **≥11.5.1**, `permissions: id-token: write`, campo `repository` batendo com o repo, config **por pacote** em `npmjs.com/package/<nome>/access` | Docs npm | Alta |
| 46 | Staged publishing: `npm stage publish` → `list/view/download` → `approve` com 2FA; npm CLI ≥11.15.0, Node ≥22.14.0 | Docs npm | Alta |
| 47 | pnpm 11: `minimumReleaseAge` default **1440 min**, `blockExoticSubdeps: true`, `allowBuilds` explícito, Node 22+, `.npmrc` só auth/registry | https://pnpm.io/supply-chain-security | Alta |
| 48 | `pnpm/setup@v2` substitui `actions/setup-node` + `pnpm/action-setup` (deprecado para pnpm ≤10) | Docs pnpm / GitHub | Alta |
| 49 | Métricas npm: `GET https://api.npmjs.org/downloads/point/last-week/<pkg>`; lote **não** suporta scoped; máx. 18 meses | https://github.com/npm/registry/blob/main/docs/download-counts.md | Alta |
| 50 | Nome npm `dsh-guarded-bot-orchestrator` **livre** (HTTP 404 em 2026-08-19) | https://registry.npmjs.org/dsh-guarded-bot-orchestrator | Alta (na data) |
| 51 | Pacotes reais: `@deepseek-ai/dsh-subprocess`, `@deepseek-ai/dsh-subprocess-local`, `@deepseek-ai/dsh-host-webserver`, `@deepseek-ai/dsh-host-frontend-static`, `@deepseek-ai/cordis@4.0.1` | npm HTTP 200 | Alta |
| 52 | Serviço real: **`ctx.httpServer`** (classe `HttpServerService`). **`ctx.webServer` / tipo `WebServer` não existem.** `WebRoute` existe | typings do tarball `dsh-host-webserver` | Alta |
| 53 | `subprocess.spawn(spec)` — **objeto único** com `argv`, `cwd`, `stdio`, `graceMs` **obrigatórios** e `signal?`. Também `spawnTerminal(spec): Promise<SubprocessTerminalHandle>` | typings `dsh-subprocess` | Alta |
| 54 | `npx @deepseek-ai/dsh web` sobe em **127.0.0.1:3080** | README upstream | Alta |
| 55 | APIs do Cordis confirmadas: `ctx.intercept(name, config)`, `ctx.waterfall`, `ctx.parallel`, `ctx.effect`, `inject`, `Service`, `Fiber` (com disposers e HMR) | `.d.ts` de `@deepseek-ai/cordis@4.0.1` | Alta |

---

## 9. Lacunas — o que vira SPIKE

Cada item aqui é suposição não verificada. **Nenhuma onda pode assumir que estes pontos são
verdade.** Spike = tarefa curta, com entregável escrito, antes ou no início da onda afetada.

| # | Lacuna | Onda afetada | Como fechar |
|---|---|---|---|
| **L1** | **Assinaturas reais de `HttpServerService`** (`register`, `registerFallback`, `registerUpgrade`, `host`/`port`). A pesquisa confirmou o **nome** do serviço e o tipo `WebRoute`, **não** a superfície completa. **`registerUpgrade` é bloqueador de segurança, não detalhe**: sem ele, o handshake de WebSocket fica sem gate e o produto perde a camada que quase todo gate esquece — se ele não existir, a Onda 3 não pode subir túnel nenhum até haver plano B escrito | Onda 0 / auth | Baixar o tarball de `@deepseek-ai/dsh-host-webserver`, extrair `lib/types/*.d.ts`, transcrever para `docs/spikes/api-dsh.md` |
| **L2** | **Forma exata de `SubprocessStdio` e `SubprocessHandle`** — quais métodos de kill/wait existem; se `graceMs` já implementa escalonamento SIGTERM→SIGKILL | Onda de supervisor | Idem, tarball de `@deepseek-ai/dsh-subprocess` |
| **L3** | **Se `ctx.subprocess` já faz tree-kill.** O comentário em `src/index.ts:1026` afirma que sim; **NÃO CONFIRMADO** | Onda de supervisor | Ler `.d.ts` + README de `dsh-subprocess-local`; se ambíguo, teste empírico com neto `sh -c 'sleep 300 & wait'` |
| **L4** | **Semântica real das 4 camadas do `cordis.patch.yml`** e o efeito de declarar `dsh.bundle` sem `patch` (opção (d) do §6.2) num DSH real | Empacotamento / divulgação | Clonar o repo e ler `docs/user/develop/basic/publish.md` inteiro; testar a instalação por market numa cópia descartável |
| **L5** | **Limite de 50 usuários do Zero Trust free** — só em terceiros e em PDF de Q4 2022 | Túnel/Access | Checar a página de planos **logado** na conta |
| **L6** | **Rate limits oficiais do quick tunnel** além da página TryCloudflare — não existe página de "rate limits" | Túnel | Medir concorrência empiricamente; assumir 200 in-flight como teto |
| **L7** | **Brute-force de subdomínios `trycloudflare.com`** — sem pesquisa publicada; **crt.sh inacessível** (502/404) para checar Certificate Transparency | Threat model | Tentar crt.sh de novo; independentemente, tratar a URL como pública |
| **L8** | **Vetor de descoberta do host CVAT exposto** (§7.3) — o host está vivo e sem auth em `/api/server/about`, mas **não foi achado por motor de busca**. Não sabemos como URLs desse tipo circulam | Threat model | Investigar feeds/scanners; enquanto não souber, assumir o pior caso |
| **L9** | **Regras oficiais de r/programming, r/node, r/selfhosted** — Reddit devolveu **403 em todas as rotas** (inclusive `/about/rules.json`); Reddiquette também 403 | Divulgação | **Um humano logado lê as regras antes de qualquer post** |
| **L10** | **Estudo asof.app sobre Show HN** — ECONNREFUSED. Todos os números de Show HN vêm dele | Divulgação | Tratar como estimativa, nunca como meta |
| **L11** | **Política de autopromoção no CoC do dev.to** — não existe seção sobre isso | Divulgação | Ler os termos completos ou não usar o canal |
| **L12** | **Benchmarks do `jcode` e o pacote `pi2dsh`** — fontes exclusivamente terceiras, **NÃO CONFIRMADOS** | Nenhuma (excluir) | Não usar. Se alguém insistir, exigir reprodução local |
| **L13** | **Ferramentas de qualidade:** Stryker com `node:test`, compatibilidade Prettier do Biome, provenance/OIDC no Changesets, TypeDoc no TS 7, adoção Changesets vs semantic-release | Qualidade/CI | Ler a doc oficial de cada uma antes de escolher; ter fallback (Stryker em job nightly opcional) |
| **L14** | **Flag exata da `CreateProcess` usada por `detached:true` no Windows** — a doc só diz *"will have its own console window"* | Supervisor (se Windows entrar no escopo) | Se Windows não for suportado, documentar como não-suportado e fechar por escopo |
| **L15** | **Comportamento de `child_process` fora do v24.15.0** — todas as medições foram feitas nele; a leitura de fonte foi no branch v22.x. Como a matriz canônica é **24/26 + macOS 24** (Node 22 fora, `engines >=24`), a lacuna real é **o Node 26** e o **darwin** | Supervisor / matriz de CI | Rodar a suíte inteira na matriz 24/26 + macOS 24 e comparar os invariantes de `E2E-001…014` com os medidos no v24.15.0 |
| **L16** | **Qual shell o host usa ao spawnar** (bash faz exec do último comando e não deixa intermediário; dash forka) — muda se `child.kill()` basta | Supervisor | Não depender: sempre grupo próprio + `kill(-pid)`. Teste de regressão com os dois shells |
| **L17** | **Justificativa normativa do esquema de hashing** — ASVS é **silente** para tokens gerados por máquina (§3.2) | Auth | Escrever ADR com argumento próprio de entropia + DoS; **proibido citar ASVS 6.5.2** |
| **L18** | **Convite do Discord oficial expira em 2026-09-12T04:01:33Z** | Divulgação | Revalidar antes de embutir em doc permanente |
| **L19** | **`InlineKeyboardButton.style`** (`"success"`/`"danger"`/`"primary"`). Era o fato #15 da §8 com confiança "Alta" e **sem URL** — a única linha da tabela nessas condições. Foi usado como **requisito de entrega** (`03` T5.2) e como **caso de teste** (`04` TG-029), o que viola a regra 1 deste documento | Telegram / liga-desliga | Ler `https://core.telegram.org/bots/api#inlinekeyboardbutton` no raw e procurar o campo. **Se não existir** (hipótese de trabalho): a diferenciação visual do botão passa a ser feita **no texto** (`✅ Ligar` / `⛔ Desligar`), que é suportado em qualquer versão da Bot API, e `TG-029` vira asserção sobre o texto. Enquanto o spike não fechar, **nenhuma sub-tarefa pode entregar `style`** |
| **L20** | **Estabilidade do type stripping nativo por versão de Node** — a afirmação "estável no 25.2, flag removida no 26", usada em `04` §3.1 e em `06` §6.2, **não consta deste dossiê**. Ela não foi medida nem lida em doc oficial | Testes / CI | Rodar `node --version && node --experimental-strip-types --help` e a suíte inteira em 24 e 26. **Enquanto não fechar, ela não pode ser argumento para nada** — em particular, a exclusão do Node 22 da matriz apoia-se **apenas** em `engines: node >=24`, que é fato do próprio `package.json` e basta sozinho |
| **L21** | **Como o DSH carrega este plugin** (`src/` sob `tsx/esm`, `src/` sob type stripping nativo, ou `dist/`) **e** a existência da flag `rewriteRelativeImportExtensions` na versão pinada do TypeScript. As duas juntas decidem a extensão dos imports relativos (`./x.ts` vs `./x.js`), e escolher errado quebra o boot com `ERR_MODULE_NOT_FOUND` — não com erro de compilação | **Onda 0, bloqueia o fatiamento** (`05-QUALIDADE-CODIGO.md` §3.4) | Ler o carregador de plugin no monorepo clonado; rodar `tsc --help \| grep -i rewriteRelative` na versão exata. Fallback já decidido: compilar antes de testar e rodar a suíte sobre `dist/` |
| **L22** | **Diretório de estado canônico por plugin.** `01-ARQUITETURA.md` §12.3 marca isto NÃO CONFIRMADO e, mesmo assim, `02-SEGURANCA.md` fixa `$XDG_STATE_HOME/dsh-guarded-bot/` e `01` §6 fixa outro nome de arquivo. Não é nenhum dos spikes S1–S6 de `03-ONDAS.md`: **ninguém tem a tarefa de descobrir** | Onda 0 / persistência | Procurar no `.d.ts` do host por algo como `ctx.baseDir`/`ctx.stateDir`. **Se não existir**, o caminho é nosso e a decisão é: `${XDG_STATE_HOME:-$HOME/.local/state}/dsh-guarded-bot/` com `state.json` (0600) e `secrets.env` (0600), criado com `mkdir -p` a 0700. Um único arquivo, um único nome, um único dono |
| **L23** | ~~**Nosso próprio cliente da Bot API** (decisão de dependência zero)~~ — **HIPÓTESE NÃO ADOTADA. Deixa de ser lacuna.** A decisão canônica (`09-DECISOES-CANONICAS.md` §D23) é: **grammY é dependência de runtime**, `"dependencies": { "grammy": "1.45.1" }`, versão exata, carregada **apenas** pelo processo `worker/`. Cinco documentos do plano já desenham contra a API do grammY (plugin de auto-retry lendo `retry_after`, `bot.catch` com `GrammyError`/`HttpError`, `apiRoot` para o dublê, `bot.start({ drop_pending_updates })`); trocar isso por um cliente artesanal na Onda 4 seria reescrever a parte mais chata da integração para preservar um slogan. **A frase "zero dependência de runtime" sai do README, de `06-REPO-E-CI.md` §9.2/§10 e de todo material de divulgação**, no mesmo commit em que a dependência entra. Um cliente próprio, se um dia for feito, é onda própria — não uma lacuna pendente deste documento | Telegram | Nada a fechar. Registrado aqui para que ninguém reabra a discussão achando que é pergunta em aberto |
| **L24** | **`crypto.argon2()` nativo (Node ≥24.7.0)** — lido no `crypto.json`/`meta.added`, confiança Alta, mas **nunca executado** nesta máquina. Só importa no caminho "senha escolhida por humano", que hoje é desaconselhado | Auth (caminho secundário) | `node -e "console.log(typeof require('node:crypto').argon2)"` na versão do CI, antes de qualquer código que dependa dele |

---

## 10. Nível de confiança por área

| Área | Confiança | Por quê | O que faria subir |
|---|---|---|---|
| **Existência do DSH (macro)** | **Alta** | HTTP 200 direto na API do GitHub e no npm; README, typings e discussions lidos | Nada — está verificado |
| **API do DSH (micro)** | **Baixa** | 4 erros concretos já encontrados (pacote 404, serviço com outro nome, assinatura errada, nome de frontend errado); tudo em `rc` | **L1–L3**: clonar, extrair `.d.ts`, escrever `docs/spikes/api-dsh.md` + `test/contract/dsh-types.test.ts` |
| **Cordis (`intercept`/`waterfall`/`effect`/Fiber)** | **Alta** | Lidos nos `.d.ts` reais do `@deepseek-ai/cordis@4.0.1` e no fonte upstream | Pinar a versão exata e adicionar teste de contrato |
| **Cloudflare Tunnel (mecânica)** | **Alta** | Executado localmente: `/quicktunnel`, stderr, shutdown, checksum, tempo de subida, teste de SSE | Repetir a medição na versão que o CI instalar |
| **Cloudflare (limites e Access)** | **Média** | Doc oficial confirma o essencial; falta página de rate limits e o número de seats do free | L5, L6 |
| **Telegram Bot API** | **Alta** | Fontes primárias + código-fonte do servidor oficial (`Client.cpp`/`Client.h`) | Nada crítico; validar `getMe` no primeiro boot |
| **Escolha de lib Telegram (grammY)** | **Alta** | Registry npm na data + docs oficiais da lib | Reavaliar `node-telegram-bot-api` v2 em ~6 meses |
| **Auth / OWASP / NIST** | **Alta** para as normas, **Média** para a decisão de hashing | ASVS 5.0 e NIST 63B-4 lidos no raw; mas a norma **não cobre** o caso do token gerado por máquina | **L17** (ADR próprio). E **não** citar ASVS 6.5.2 |
| **Gestão de processos Node** | **Alta** | Reproduzido empiricamente, incluindo os contra-exemplos que refutaram duas claims | L15 (matriz 22/24/26), L16 (shell) |
| **Qualidade / CI / publicação** | **Média-alta** | Versões e mudanças de política confirmadas no registry e nos blogs oficiais; ecossistema mudando rápido | L13; revalidar versões no dia em que o CI for escrito |
| **Divulgação / awesome-list / market** | **Média** | Regras e o **código** do CI da awesome-list lidos; mas duas claims sobre elas já foram refutadas — o material é sutil | L4 (ler `publish.md` inteiro e testar o market), L9–L11 |
| **Riscos de exposição** | **Média-alta** | CVEs, incidentes e doc oficial com fonte nomeada; a mecânica de urlscan foi medida — mas **duas** evidências da revisão anterior caíram (§7.2, §7.3) | L7, L8; e manter o threat model escrito no repo |

---

## 11. Correções desta revisão (delta) — o que mudou e o que precisa propagar

Esta revisão do dossiê incorporou uma rodada de verificação adversarial que **derrubou
evidências antes tidas como medidas**. O que mudou:

| # | Mudança | Onde estava | Ação |
|---|---|---|---|
| D1 | "URLs de quick tunnel são indexadas por motores de busca" → **REFUTADA** (`robots.txt` mal citado, proveniência não reproduzível) | Era claim confirmada "Alta (medido)" em §7.1 | Rebaixada para **Baixa / não reproduzível** e movida para §7.3. **Não usar** |
| D2 | Evidência do urlscan corrigida: **não** são "todos do próprio dia" (6 dias, 21% do dia), `total=10000` é teto, e urlscan **só indexa o que foi submetido** | §7.1 | Reformulada em §7.2. Conclusão ("a URL não é credencial") **permanece**, com nova justificativa |
| D3 | "`child.kill()` NUNCA basta com shell" → **REFUTADA** (bash faz exec e não deixa intermediário; dash forka) | §4 | §4.2. O desenho (grupo + `kill(-pid)`) **não muda**; a justificativa sim |
| D4 | "`process.kill(-process.pid)` mataria o supervisor" e "sem `detached` sempre herda o PGID" → **REFUTADAS** (condicional a ser líder de grupo; `setsid`/`sudo`/`ssh` quebram a premissa; risco de PID reuse) | §4 | §4.2 + fato operacional #37 |
| D5 | Inferência a partir do ASVS **6.5.2** → **REFUTADA** (escopo é `lookup secrets` de MFA; a norma é silente sobre tokens) | §3 | §3.2 + spike **L17** (ADR próprio). Proibido citar 6.5.2 |
| D6 | "Token do bot contorna COMPLETAMENTE a allowlist" → **REFUTADA** como generalização (direção do fluxo; long polling não tem endpoint forjável) | §2 | §2.2. Sobrevive o caso do inline keyboard → exige **C-CONFIRM**. Já refletido em `02-SEGURANCA.md` §7.3 e §12.2 (a referência anterior, "§3.6.2", **não existe** naquele arquivo — corrigida nesta revisão) |
| D7 | Trilema do `dsh.bundle` → **REFUTADO** (existe a opção (d): `dsh.bundle` truthy sem `patch`; e o bloqueio real hoje é idade/commits) | §6 | §6.2 + spike **L4** |
| D8 | "Quick tunnel não suporta SSE" → mantida como **REFUTADA** (POST faz streaming; o DSH usa WebSocket no downlink) | §1.2 | Sem mudança. Continua proibido usar SSE como argumento |

**Propagação necessária para os arquivos irmãos** (verificar antes de fechar o plano):

- `07-COMUNIDADE.md` — a linha sobre SSE já está correta; conferir se não há afirmação de
  indexação por motor de busca.
- `02-SEGURANCA.md` — §7.3/§12.2 já corrigidos (token vs. allowlist); conferir se o texto sobre
  hashing não cita ASVS 6.5.2 como fundamento (D5).
- `04-TESTES.md` — o teste manual contra o edge continua válido; a motivação muda de "SSE" para
  "buffering de `GET`".
- `01-ARQUITETURA.md` — checar as referências a `#1449` e ao WebSocket (estão coerentes).

---

## 12. Como este documento é usado nas ondas

1. **Onda 0 — verificação de API (bloqueante).** Fecha L1, L2, L3, L4. Entrega
   `docs/spikes/api-dsh.md` e `test/contract/dsh-types.test.ts` (com `CONTRACT-001…009` verdes) e
   corrige os erros E1–E4 da §0.2 no código existente. **Nenhuma feature nova antes disso.**
2. **Ondas de feature.** Todo PR que tocar em túnel, Telegram, auth ou supervisor **cita a linha
   da tabela §8** que justifica o número/flag usado. Sem linha, abre spike.
3. **Divulgação.** Só começa depois de fechados L4 e L9 e de o repo cumprir ≥10 commits e ≥1 dia
   (§6.1). **Não é uma "onda"**: por decisão canônica (`09-DECISOES-CANONICAS.md` §D20), o único
   plano de execução é `03-ONDAS.md`; a Onda 7 entrega o **material** de divulgação (T7.3/T7.4) e a
   publicação em si é ação humana **pós-T7.4**, porque depende de terceiros (pessoas instalando,
   mantenedores de registro aceitando PR, moderação de fórum).
4. **Revisão adversarial.** O revisor rejeita qualquer afirmação que não esteja aqui e **deve**
   rejeitar qualquer uso das claims refutadas (§1.2, §2.2, §3.2, §4.2, §6.2, §7.2, §7.3).
5. **Manutenção.** Toda claim nova entra com fonte e nível de confiança. Toda claim derrubada vai
   para a seção de refutadas **com o motivo**, nunca é apagada — o histórico de erro é o que
   impede o plano de reintroduzir a mesma suposição.

### 12.1 Onde os outros documentos ainda afirmam o que este documento não sustenta

Lista curta e literal, para revisão adversarial. **Onde houver divergência, este documento e
`09-DECISOES-CANONICAS.md` vencem, e o outro arquivo é que muda.**

| Afirmação encontrada em outro documento | Status aqui | Onde está a correção |
| --- | --- | --- |
| `InlineKeyboardButton.style` (`success`/`danger`/`primary`) como recurso disponível | **NÃO CONFIRMADO** (fato #15 rebaixado, **L19**) | `04-TESTES.md` TG-029 é `skip` até o spike; `03-ONDAS.md` T5.2 não pode entregar o campo |
| "Type stripping estável no 25.2, flag removida no 26" como razão da matriz de Node | **Não registrado aqui — suposição** (§5.3) | Removido de `04-TESTES.md` §3.1 e de `06-REPO-E-CI.md` §6.2; a razão da matriz é `engines: >=24` |
| "Zero dependências de runtime" | **Falso após D23** (L23) | `06-REPO-E-CI.md` §9.2/§10 e README: **uma** dependência (`grammy`) |
| Matriz de Node `22/24/26` | **Superada** (§5.2) | `24` (ubuntu), `26` (ubuntu), `24` (macOS); 22 fora |
| "Access não cobre quick tunnel" tratado como *sem citação oficial* | **Fato de Confiança Alta**, com doc da Cloudflare (§1.3, §7.4, fato #8) | `04-TESTES.md` §14 item 5 corrigido: pode ser usado como base de L0 |
| Thresholds de cobertura do `node:test` como "não confirmados" | **Estáveis** por CLI; só a *coleta* é experimental (§5.2) | `05-QUALIDADE-CODIGO.md` §12 item 7 removido |
| `ctx.webServer` / `WebServer` / `@deepseek-ai/dsh-host-subprocess` / `spawn(cmd,args,opts)` / `dsh-host-frontend` como forma correta | **REFUTADOS** (§0.2, E1–E4) | Só podem aparecer em coluna "errado" de tabela de correção, jamais como prescrição |
| Contagem de hostnames de quick tunnel do urlscan | **73** (§7.2 é o ledger) | `02-SEGURANCA.md` §2.2 corrige `72` → `73` |
| Número absoluto de estrelas da awesome-list em material público | **Proibido**: usa-se "~10 mil ★, medido em `<data>`", com **uma** linha de medição (§6.1) | `07-COMUNIDADE.md` §7.1 alinhado |
