# ARCHITECTURE.md — costuras Cordis usadas e mapa de módulos

Este documento descreve a arquitetura deste plugin: as **costuras do Cordis** que ele usa,
a ordem em que `apply()` instala as peças, e onde cada decisão vive no código. É para quem
vai contribuir ou auditar. Para o comportamento do produto, ver os docs de usuário.

## 1. Costuras Cordis usadas

Este plugin é um plugin Cordis v4 com `inject = [webServer, subprocess]`
(`src/index.ts:365`). No Cordis v4 estas são as costuras relevantes:

| Costura | Uso neste plugin | Onde |
| --- | --- | --- |
| `inject` | Declara os serviços de que precisa (`webServer`, `subprocess`) | `src/index.ts:365` |
| `ctx.effect()` | Ciclo de vida atómico: tudo o que é registado tem um disposer síncrono, erradicado em LIFO | `src/index.ts` (disposers) |
| `ctx.waterfall(http/auth-check, …)` | Avaliação da credencial na cascata de auth | `src/http/session-auth.ts` |
| `ctx.on(security/permission-elevate, …)` | Veto de elevações proibidas (defesa em profundidade) | `src/index.ts:606-622` |
| `ctx.get(webServer)` → `node:http.Server` | Trocar o dono do despacho para instalar a barreira | `src/dsh/adapter.ts` |

> **Nota sobre `ctx.intercept`:** a superfície `ctx.intercept` foi medida e refutada como
> mecanismo de envolver métodos do `webServer` — é fusão de config e inerte para este caso.
> A barreira delega a decisão a `src/http/intercept.ts` e não depende da ordem de
> carregamento: toma o despacho no `node:http.Server` (ponto por onde TODA requisição passa)
> e devolve um disposer que restaura os handlers originais.

Os comentários de topo de `src/index.ts:12-48` explicam a ordem dos `ctx.effect`: os
disposers correm em LIFO, e a barreira levanta **por último** — não fica uma janela em que o
plano de controlo responde sem credencial enquanto o worker ainda está vivo.

## 2. O que `apply()` instala (na ordem)

1. **Endurecimento do plano de controlo** — valida o bind (loopback obrigatório, fail loud
   at load), instala o veto de `danger-full-access` e o ouvinte estrutural de auth.
2. **Barreira HTTP** — `installAuthBarrier` troca o dono do despacho; `createGuardedHandler` e
   `createGuardedUpgradeHandler` decidem por camadas (origem → Host → sessão/chave no link).
3. **Túnel** — supervisors, probe fail-closed, discovery, TTL, pidfile/varredura de órfão; o
   controlador serializa a máquina de estados do túnel (ligar/desligar).
4. **Worker de mensageria** — o supervisor a instanciar o boot genérico
   (`dist/worker/telegram-bot.js`), por provedor (`config.worker.provider`, default
   `telegram`), com ambiente de allowlist e o rótulo `DSH_GUARD_PROVIDER`.
5. **Painel + UI** — rotas `/__guard/*` e a superfície de UI contribuída, ambos montados em
   produção (`src/index.ts:957-1005`).

Há uma única fonte de verdade para o estado persistido: o `StateStore`
(`src/state/store.ts`), único writer do `state.json` (escrita atómica, `0600`).
O `state.json` vive em `~/.dsh/guarded-bot/state.json` (ou `$DSH_HOME/guarded-bot/`).

## 3. A barreira HTTP e a ordem das verificações

O acesso segue o modelo expose-port: **o DSH abre direto no loopback** (sem login) e
quem autentica é o **proxy dedicado do túnel**. O portão do proxy decide na ordem
(contrato — reverter dá regressão de segurança):

    origem da conexão (L2/L3) · `trustedRemotes`
        │  403 fora da lista
        ▼
    nome pedido (L2.5) · `Host` anti-DNS-rebinding
        │  403 fora (byte a byte igual ao anterior)
        ▼
    isenção?  (rotas pré-sessão do painel, quando houver)
        │
        ▼
    sessão/chave no link (L3) · cookie de sessão OU `?key=<token>`  →  401 sem/inválida
        │
        ▼
    autorizado → encaminha (por túnel, reescreve o Host p/ trycloudflare)

Os dois `403` são byte a byte iguais. O `401` do túnel é **texto puro sem desafio de
login (o header de desafio do navegador foi removido — sem popup)**, e o acesso local abre
direto, sem
passar por esta barreira. A chave no link é **reutilizável** e guardada só como digest;
quando válida é trocada por uma **sessão** e o navegador recebe um 302 para a URL limpa
(sem `?key=`) (`src/http/gate.ts`, `src/session/link-token.ts`). A `?key=` viaja na query
— visível a intermediários — e é revogada por `/rotacionar` (chave nova + sessões
inválidas) ou ao derrubar o túnel.

## 4. Mapa de módulos (uma frase por ficheiro, pelo conteúdo)

### Raiz e contratos

- `src/index.ts` — raiz de composição: `name`, `inject`, `apply`. Fia módulos, não implementa regra.
- `src/brand.ts` — tipos *branded* (SessionId, Nonce, SecretDigest) e construtores validadores.
- `src/errors.ts` — hierarquia de erro tipada e códigos estáveis.
- `src/contracts/**` — interfaces congeladas em COMMIT PREP (auth, state, tunnel, ipc, control). Leitura livre, escrita proibida.
- `src/dsh/adapter.ts` — o ÚNICO ficheiro que toca a API do DSH; resolve o `node:http.Server`.

### Config e estado

- `src/config/{schema,assert,bind}.ts` — forma da `Config`, validação rigorosa e bind seguro (fail loud).
- `src/state/{store,schema,paths}.ts` — persistência atómica do `state.json`, schema versionado e resolução de caminhos.

### HTTP / portão

- `src/http/auth-basic.ts` — `verifyBasicAuth`: comparação de digests SHA-256 em tempo constante (ainda aceite pelo proxy como credencial estática, mas não é o caminho documentado de acesso).
- `src/http/origin.ts` — normalização de endereço e permitido de origem confiável.
- `src/http/host-header.ts` — validação do `Host` (anti-DNS rebinding) e reescrita pelo túnel.
- `src/http/path.ts` — caminho canônico e política de prefixo (anti-bypass por normalização).
- `src/http/responses.ts` — corpos de negação idênticos (403/401/404).
- `src/http/gate.ts` — a política do portão (`createGuardedHandler`, `createGuardedUpgradeHandler`).
- `src/http/intercept.ts` — o dono do despacho: toma/restaura handlers e instala a barreira.
- `src/http/session-auth.ts` — pilha de autenticação lazy, identidade, rewrite de túnel.

### Segredo, sessão, rate limit, auditoria

- `src/secret/*` — geração (CSPRNG/base32), store (digest), OTT de uso único, QR.
- `src/session/*` — store de sessão, cookie `__Host-dsh_sid`, e a **chave no link** (`link-token.ts`, quando o acesso é obtido e revogável).
- `src/ratelimit/*` — política, tracker, modo restrito (teto NIST).
- `src/audit/*` — eventos fechados, formato, log append-only, notificação proativa.

### Processos, túnel, controlo

- `src/proc/{supervisor,retry,failure,env,tree-kill,backoff}.ts` — supervisão genérica de subprocesso, backoff, allowlist de env, group-kill.
- `src/tunnel/{supervisor,args,discover,probe,readiness,ttl,pidfile}.ts` — ciclo do `cloudflared`.
- `src/control/{controller,confirm,surface-ipc}.ts` — máquina de estados do túnel, confirmação com nonce, convergência das superfícies.

### Painel e UI

- `src/panel/*` — rotas `/__guard/*`, CSRF, magic, secret, api, html.
- `src/ui-contrib/*` — superfície de UI contribuída ao DSH; `bot-state.ts` deriva o estado OFFLINE/ONLINE do bot de forma **provider-agnóstica** (renomeado de `telegram-state.ts`).

### Worker do bot

O worker é **neutro ao provedor de mensageria** (arquitetura de provedores; o único
fornecedor hoje é o Telegram). O núcleo vive em `worker/surface/**`, os adaptadores
em `worker/providers/**` e o boot genérico em `worker/telegram-bot.ts`.

- `worker/telegram-bot.ts` — entry do processo; **boot genérico por provedor** (nome preservado por D1). Lê `DSH_GUARD_PROVIDER`, monta núcleo + auth + comandos + adaptador + ponte IPC, e devolve os exit codes 0/10–14.
- `worker/ipc.ts` — protocolo JSONL host↔worker (`IPC_PROTOCOL_VERSION`); o worker só importa de `src/` os tipos de `src/contracts/ipc.ts` (§5.5).
- `worker/surface/contract.ts` — o **contrato neutro** da superfície (SurfaceIdentity, SurfaceEvent, SurfaceLimits, ActionRow, SurfaceSender, ProviderAdapter, IntencaoNeutra), self-contained.
- `worker/surface/core.ts` — o **núcleo neutro**: roteador comando→intent (funil pareamento→allowlist, outbox, autolink, pendentes) sobre tipos neutros; re-exporta a lista canónica.
- `worker/surface/{auth,commands}.ts` — allowlist de dois eixos default deny + receptor de pareamento + guard; e os comandos neutros (/ligar… /emergencia) + `COMANDOS_PUBLICADOS`.
- `worker/surface/{ids,tokens,outbox,text,actions}.ts` — normalização de identidade, requestId ULID e token opaco, partição/serialização 1 msg/s, texto de estado e botões de alerta.
- `worker/providers/registry.ts` — tabela fechada de provedores (default `telegram`), `resolverProvedor` fail-closed, `criarSurfaceIpcBridge` (envelope numérico na ponte) e `criarPonteDeNonce`.
- `worker/providers/telegram/**` — **adaptador telegram** (único hoje; dono do grammY): cliente, polling, parse do update, teclado, token, transporte, adapter.
- `worker/lib/*` → só os auxiliares neutros/estruturais do processo (clock, log, redact, erros); os antigos `client/polling/keyboard/token/transport-log/auto-retry/outbox` moveram-se para `worker/providers/telegram/**` e `worker/surface/outbox.ts`.

## 5. Relação com o DSH upstream

- `src/dsh/adapter.ts` é o único ficheiro `@deepseek-ai/*`: isola a superfície do host.
- A compatibilidade com o upstream é verificada por **forma** do serviço, não por string de
  versão: se um símbolo sumir, o plugin **falha no load** com a faixa testada na mensagem.
  Ver `docs/COMPATIBILITY.md` (gerado de `dsh-compat.yml`).

## 6. Notas de honestidade sobre o estado da árvore

- O painel `/__guard/*` e a UI contribuída **estão montados em produção** (linhas
  `src/index.ts:957-1005`), mesmo havendo comentários antigos no ficheiro a dizer o
  contrário. Leia o código, não os comentários, para saber o que está servido.
- O worker é Node (grammY), não Python: resíduos `bot_long_polling.py` do projeto
  pré-plano **não existem** nesta árvore.
- O desacoplamento para provedores é **concluído**: `worker/auth/*`, `worker/commands/*` e
  `worker/lib/{client,polling,keyboard,token,transport-log,auto-retry,outbox}` **foram
  eliminados** — o núcleo neutro vive em `worker/surface/**` e o Telegram específico em
  `worker/providers/telegram/**`. Referências antigas a esses caminhos são código morto.
