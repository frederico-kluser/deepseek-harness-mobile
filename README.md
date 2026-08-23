# dsh-guarded-bot-orchestrator

[![CI](https://img.shields.io/github/actions/workflow/status/frederico-kluser/deepseek-harness-mobile/ci.yml)](https://github.com/frederico-kluser/deepseek-harness-mobile/actions)
[![npm version](https://img.shields.io/npm/v/dsh-guarded-bot-orchestrator)](https://www.npmjs.com/package/dsh-guarded-bot-orchestrator)
[![npm downloads](https://img.shields.io/npm/dm/dsh-guarded-bot-orchestrator)](https://www.npmjs.com/package/dsh-guarded-bot-orchestrator)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/frederico-kluser/deepseek-harness-mobile)](https://securityscorecards.dev/)

**Usa o teu próprio DeepSeek Harness pelo celular — a Web UI inteira, para codificar de verdade — sem nunca alargar o bind para fora do loopback: o túnel termina em `127.0.0.1`, a senha é gerada pela máquina, e ligas e desligas o acesso pelo Telegram.**

![Demo](docs/assets/demo.gif)

## Instalação (uma linha)

```sh
dsh plugin --profile web add dsh-guarded-bot-orchestrator
```

## Modelo de ameaça, em 5 linhas — antes de qualquer feature

> Este plugin expõe, por escolha, um agente que executa código na tua máquina. Antes de continuares, lê isto:
>
> 1. **O TLS termina na borda da Cloudflare.** O texto claro (prompts, código, respostas) passa por um terceiro — é o que permite WAF/Access/cache. Não é ponta-a-ponta.
> 2. **A URL do túnel é pública e não é segredo.** Quem protege é a credencial, não a obscuridade do endereço.
> 3. **Cloudflare Access não pode ficar na frente de um *quick tunnel*.** Sobre `*.trycloudflare.com` toda a autenticação tem de estar dentro da aplicação.
> 4. **O *quick tunnel* não tem SLA** — é "intended for testing and development only".
> 5. **Isto não é "seguro por padrão sem pensar".** Reduzimos a superfície, autenticamos e demos-te o botão de desligar; não eliminámos a categoria do risco.
>
> Detalhe e o que cada mitigação faz: [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Modelo de segurança (o que o código garante de facto)

Leitura honesta das garantias — cada linha aponta para o código que a cumpre; nada aqui é
"seguro por padrão sem pensar", é redução de superfície e autenticação.

| Propriedade | Como |
| --- | --- |
| **O bind nunca é alargado** | `assertSecureBind` recusa `0.0.0.0`/`::` **no carregamento**, com falha ruidosa (`src/config/bind.ts`) |
| **Toda a superfície HTTP exige credencial** | `/api`, o fallback da SPA e o handshake de WebSocket passam pelo mesmo portão (`src/http/gate.ts`) |
| **Origem e Host vêm primeiro** | `trustedRemotes` (403 sem credencial) e `Host` byte-a-byte contra DNS rebinding, antes da credencial — ordem é contrato (`src/http/gate.ts:15`, `src/http/host-header.ts`) |
| **Senha gerada, nunca guardada em claro** | CSPRNG 256 bits, apresentada uma única vez (texto + QR); em disco fica só o digest SHA-256, ficheiro `0600` (`src/secret/*`) |
| **Senha permanente nunca passa por canal remoto** | a senha permanente é entregue **local** (terminal/QR) ou por token de uso único no stdout; o que viaja pelo Telegram é só o **link de acesso com `mk` de uso único**, por decisão explícita do dono (invariante SEC-14) |
| **Força bruta tem teto** | a 5ª falha começa a atrasar; 100 falhas acumuladas derrubam a exposição (modo restrito), só o loopback passa e o reiniciar não o contorna (`src/ratelimit/**`) |
| **Comparação de segredo em tempo constante** | digest em tempo constante, com prova estatística na suíte (`src/http/auth-basic.ts`, `test/security/timing-constante.test.ts`) |
| **`danger-full-access` vetado** | elevação proibida recusada como defesa em profundidade (`src/permissions/deny.ts`) |
| **Só o dono pareado comanda o bot** | allowlist de `from.id` do Telegram (`worker/auth/allowlist.ts`) |
| **O que NÃO se garante** | o TLS termina na borda da Cloudflare (texto claro passa por lá); a URL do túnel não é segredo; *prompt injection* continua aceite — decisões de desenho em [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) §4 |
## A tensão central, dita por nós antes que digam por nós

O projeto foi construído para **travar** o DSH em loopback. Este plugin também o **expõe** pela internet. Parece contradição — e a formulação honesta é esta:

> O bind **continua** em `127.0.0.1`. O que muda é que passa a existir um processo filho supervisionado (`cloudflared`) que leva o tráfego da borda da Cloudflare até esse loopback. Não é o mesmo que `--host 0.0.0.0`: o socket local nunca é alargado, a exposição é **opt-in**, efémera e revogável em um comando; e a barreira de autenticação continua no processo, no mesmo lugar, a proteger `/api`, o fallback da SPA e o handshake de WebSocket.
>
> O que **não** muda: a superfície de ataque lógica cresce. Antes, um atacante precisava de acesso à máquina; agora precisa da senha. Trocámos "inalcançável" por "alcançável e autenticado". Essa troca é reversível a qualquer momento pelo botão de desligar.

Quem não aceitar esta troca deve usar Tailscale ou SSH — e dizemo-lo com mais calma em [`docs/TUNNEL.md`](docs/TUNNEL.md) e na secção "Quando NÃO usar" abaixo.

## O que faz (e porquê)

1. **Guarda o plano de controlo HTTP.** Exige credencial em `/api`, no fallback da SPA e no handshake de WebSocket; recusa endereços de bind fora do loopback no carregamento; e recusa permissões proibidas (`danger-full-access`). Resolve a superfície da discussão upstream [#853](https://github.com/deepseek-ai/deepseek-harness/discussions/853).
2. **Gera a senha pela máquina** (CSPRNG, 256 bits) e entrega-a **uma única vez** no terminal (texto + QR). Em disco fica só o digest. A senha permanente **nunca** passa por canal remoto — o que pode atravessar o Telegram é um **link de acesso de uso único** (via bot), por decisão do dono.
3. **Suba um túnel efémero** para acederes pelo celular, com TTL que o derruba sozinho e um *probe fail-closed* que impede um túnel "nu" (sem portão atrás).
4. **Ligar/desligar pelo Telegram ou painel** — o botão de matar na mão.

### Telegram: botão da UI e link automático

Na UI do DSH há o **botão do Telegram** (`/__guard-ui`), com estado **OFFLINE/ONLINE**
fiel ao runtime:
- **OFFLINE** → o clique mostra as instruções de conexão: criar o bot no `@BotFather`,
  `dsh-guard-setup --pedir-token`, `--parear`, enviar `/parear <código>`; quem segue
  esse passo a passo de facto coloca o bot **online**;
- **ONLINE** → mostra dicas de uso.

Depois de pareado (`docs/ONBOARDING-TELEGRAM.md`), os comandos de controlo do bot:

| Comando | O que faz |
| --- | --- |
| `/ligar` | Sobe o túnel e, quando fica READY, **envia automaticamente** o link de acesso autenticado |
| `/desligar` | Derruba o túnel |
| `/acessar` | (Re)envia o link de acesso de uso único |
| `/status` · `/rotacionar` · `/emergencia` | estado, rotação do segredo, kill switch |

O link enviado no `/ligar` é
`https://<url-pública>/__guard/magic#mk=<token-de-uso-único>`: o `mk` é de **uso
único** e expira; quem abre entra **sem digitar senha** e a sessão continua no
navegador via cookie. **Não é a senha permanente** — o segredo permanente só sai
da máquina pelo caminho local (terminal/QR), como rege o `SEC-14`.

Cada promessa destas aponta para a linha de código que a cumpre: ver [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Como flui um pedido (arquitetura em 8 linhas)

```
Telemóvel (navegador)
   │  abre https://<subdomínio>.trycloudflare.com/?key=<senha>   (lê o QR do terminal)
   ▼
❨ Cloudflare edge ❩   TLS → HTTP/2 → WebSocket ; o TLS termina AQUI (texto claro passa pela borda)
   ▼
cloudflared — quick tunnel (conexão de saída apenas, sem conta, sem SLA)
   ▼  http://127.0.0.1:3080   (o túnel termina no loopback; o socket local NÃO é alargado)
plugin (portão)
   │  exige credencial em /api, no fallback da SPA e no handshake de WebSocket
   │  403 origem/ Host fora da allowlist · 401 sem credencial · 200 com sessão
   ▼
DeepSeek Harness Web UI — bind travado em 127.0.0.1 (nunca 0.0.0.0)
```

O que o diagrama esconde e é decisivo: a senha é **gerada pela máquina** (CSPRNG, 256 bits) e
entregue **uma única vez** em texto + QR; em disco fica só o digest. A recusa de bind fora do
loopback acontece **no carregamento**, com falha ruidosa — ver o mapa de módulos em
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Quickstart (5 comandos)

```sh
# 1. instala o plugin (uma linha; ativa o manifesto de Bundle automaticamente)
dsh plugin --profile web add dsh-guarded-bot-orchestrator

# 2. corre o DSH
dsh web

# 3. no terminal: guarda a senha que apareceu UMA vez
#    (se quiseres, segue docs/ONBOARDING-TELEGRAM.md para ligar o bot)

# 4. confirma que o portão está ativo (tem de dar 401)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3080/api/commands/execute

# 5. para desligar/desinstalar
dsh plugin remove dsh-guarded-bot-orchestrator
```

[`examples/minimal`](examples/minimal/) é um exemplo mínimo instalável com o critério de aceite documentado (401 sem credencial / 200 com credencial / nenhum processo no fim).

## Quando NÃO usar isto

- **Time / multiusuário.** É um plugin de dono único: uma allowlist de `from.id` do Telegram e uma credencial. Não há RBAC nem auditoria multi-tenant.
- **Produção / uptime.** O *quick tunnel* é, nas palavras da própria Cloudflare, "intended for testing and development only" e "We don't guarantee any SLA or uptime".
- **Quem precisa de compliance.** O TLS termina na borda da Cloudflare; o texto claro passa por lá. Não é E2E.
- **Quem quer "seguro por padrão sem pensar".** Isto não existe aqui. Estás a expor um agente com shell; o plugin reduz superfície e entrega o kill switch, não elimina a categoria.
- **Máquina corporativa.** `trycloudflare.com` tem reputação de malware documentada e muitas redes/EDRs bloqueiam ou sinalizam `cloudflared`.

## Alternativas (comparação honesta)

Nenhuma alternativa é apresentada como ruim; várias são melhores em vários eixos. O valor está na combinação, não em vencer item a item.

| Alternativa | O que faz melhor | O que custa | Quando escolher **em vez** deste plugin |
| --- | --- | --- | --- |
| **Tailscale (+ Funnel)** | Rede privada real (WireGuard), identidade por dispositivo | Instalar cliente no celular e conta | **Quase sempre, se aceitas instalar o cliente** |
| **ngrok** | Ergonomia imediata; auth na borda no plano free (o quick tunnel não tem) | Limites free; URL muda | Quando queres auth **de borda** hoje |
| **SSH + tmux** | Sem superfície HTTP nova, E2E de verdade | Não é a Web UI; código no celular é castigo | Quando só precisas de ver log e matar processo |
| **code-server / VS Code tunnels** | Editor completo no browser | Não é o DSH; roda em paralelo | Quando o objetivo é editar ficheiro, não conduzir o agente |
| **`dsh-webui-auth`** | Autenticação da WebUI no transporte | Só autentica; sem túnel, sem bot, sem liga/desliga | **Se só queres autenticação, usa ele** |
| **Named tunnel + Cloudflare Access** | Auth **antes** de chegar à tua máquina | Exige domínio com DNS na Cloudflare | Sempre que tiveres domínio (caminho superior) |
| **Nada (loopback puro)** | Risco zero de exposição | Não usas do celular | Sempre que não precisares mesmo |

Em suma: isto **não é "mais um túnel"** — é o fluxo completo de um dono só (onboarding → senha → túnel efémero → link no celular → botão de desligar), com o bind travado em loopback.

## Compatibilidade

Faixa suportada do upstream `@deepseek-ai/dsh`: **`0.1.0-rc.7 .. 0.1.1-rc.1`** (política N/N-1). A tabela completa — versão do plugin × faixa de rc × status — está em [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md), que é **gerado** de `dsh-compat.yml` (nunca editado à mão).

> Atenção ao registry: a tag `latest` dos subpacotes `@deepseek-ai/dsh-*` aponta para a publicação **mais antiga**, não para a mais recente. Fixa a versão explicitamente.

## Validação end-to-end (o que a suíte prova de verdade)

Matriz de alto nível a partir das suítes **reais** do repo — `test/e2e/**`, `test/security/**`, `test/integration/**`
— referidas por ficheiro. São verificações que o CI corre, não promessas; o detalhe de cada nível e como correr
está em [`docs/TESTING.md`](docs/TESTING.md).

| Check | Expected | Onde está verificado |
| --- | --- | --- |
| `curl` sem credencial a `/api/commands/execute` | `401` (o portão dispara; o despacho original **não** é alcançado) | `test/integration/http/barreira.test.ts` + a ordem origem → `Host` → credencial em `test/security/panel-exemptions.test.ts` |
| Com sessão válida (cookie) ou Basic Auth | `200`, resposta vem do despacho original | `test/e2e/tunnel-cycle.test.ts` |
| Pedido pela URL do túnel sem credencial | `401` com `WWW-Authenticate`; após `stop`, o mesmo pedido devolve `403` e o direto ao loopback `401` | `test/e2e/tunnel-cycle.test.ts` (discriminador 401/403) |
| Handshake de WebSocket de origem estranha (ex.: `https://evil.com`) | recusado — allowlist exata de `Origin` (CWE-1385) | `test/security/websocket-origin.test.ts` |
| Rota contornada (`/..//api`, `%2e`, barras duplicadas, `/__guard/API/login`) | uniforme `401/403/404`, nunca pass-through | `test/security/path-bypass.test.ts` (ADV-001..020) |
| `Host` que não é o publicado / DNS rebinding | `403` no perímetro, byte-a-byte | `test/security/host-header.test.ts`, `test/e2e/tunnel-cycle.test.ts` |
| 100.ª falha de força bruta | modo restrito acende, **persiste** após reinício, credencial pelo túnel negada e a do loopback passa | `test/security/nist-ceiling.test.ts` |
| Segredo a vazar (logs, respostas, frames IPC, payloads do Telegram, env, state) | canário por valor falha se vazar | `test/security/secret-leak-canary.test.ts` (ADV-050..059) |
| A comparação de segredo vaza tempo? | prova estatística de tempo constante | `test/security/timing-constante.test.ts` |
| Ciclo completo do túnel com processos reais | start → READY → 401/200 pela URL → stop → 403, **sem processo órfão** | `test/e2e/tunnel-cycle.test.ts` (T6.1) |

Honestidade sobre o que esta matriz **não** é: o e2e usa um *fake-cloudflared* e uma borda
falsa — **nenhum byte sai de `127.0.0.1` no CI**, por construção. A re-confirmação **através** da borda
e da rede reais é a suíte `test/live/**` (`DSH_GUARD_LIVE_TESTS=1`), opt-in e fora do gate —
ver `docs/TESTING.md` §5.

## Desinstalar e reverter

```sh
dsh plugin remove dsh-guarded-bot-orchestrator
```

Deixa zero processos remanescentes e a Web UI volta ao comportamento original. Para apagar também a senha, o pareamento e o estado local: remove `~/.dsh/guarded-bot`. Detalhe em [`docs/INSTALL.md`](docs/INSTALL.md).

## Docs

- [`docs/INSTALL.md`](docs/INSTALL.md) — instalação passo a passo
- [`docs/ONBOARDING-TELEGRAM.md`](docs/ONBOARDING-TELEGRAM.md) — conectar o bot e parear
- [`docs/EXPOSURE.md`](docs/EXPOSURE.md) — o que muda quando o túnel sobe
- [`docs/TUNNEL.md`](docs/TUNNEL.md) — quick vs named, TTL, modelo de ameaça do transporte
- [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) — atacante, mitigação, o que não mitiga
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — sintoma → causa → o que fazer
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — costuras Cordis e mapa de módulos
- [`docs/TESTING.md`](docs/TESTING.md) — como rodar cada nível de teste

## Contribuir e reportar

- Encontraste uma vulnerabilidade? **Não abras issue pública.** Lê [`SECURITY.md`](SECURITY.md) e usa o canal privado lá descrito (Private Vulnerability Reporting ou e-mail).
- Queres contribuir? [`CONTRIBUTING.md`](CONTRIBUTING.md) tem o ambiente em quatro comandos, os níveis de teste e o que nunca é aceite num PR.
- Código de conduta: [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Licença MIT — [`LICENSE`](LICENSE). O DeepSeek Harness a montante também é MIT.
