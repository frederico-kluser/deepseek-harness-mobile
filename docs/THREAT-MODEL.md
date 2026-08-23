# THREAT-MODEL.md — quem é o atacante, o que ele ganha, o que mitigamos, o que não

> Documento de segurança **para quem instala**. O objetivo é responder, em
> linguagem direta, a três perguntas: contra quem te estamos a proteger, onde
> o desenho **para**, e em que pontos confias em terceiros. Nada aqui é
> marketing; cada mitigação aponta para o código que a implementa.

---

## 1. Que ativo está em jogo

Este plugin é, por construção, o **controlo de acesso de um agente que executa
código na tua máquina**. Quem atravessa a barreira ganha o que o agente tem:
shell, `~/.ssh`, ficheiros `.env`, chaves de API e o código-fonte do que estiver
aberto. Trata-se de um ativo equivalente à tua conta local — não a uma página web.

## 2. A ameaça que este plugin existe para mitigar

A discussão oficial
[#853](https://github.com/deepseek-ai/deepseek-harness/discussions/853)
documenta **execução de código remota não autenticada** no plano de controlo da
UI web do DSH (verificada em `0.1.0-rc.6`): com o servidor a ouvir em `0.0.0.0`,
as rotas RPC sob `/api` respondem a qualquer socket sem credencial, e
`commands/execute` consegue injetar `/permission danger-full-access`, derrubando
o confinamento `workspace-write` do Sandbox (fuga documentada em #1769).

O plugin **não corrige** a vulnerabilidade a montante. Ele torna essas
superfícies **inalcançáveis pela internet** mantendo o *bind* do DSH em
loopback: quem expõe é um **proxy dedicado ao túnel** que autentica tudo o que
chega da borda (`src/tunnel/proxy.ts`), nunca o próprio servidor do DSH.

> **Acesso local é aberto, por desenho.** Em `127.0.0.1` o DSH abre direto, sem
> barreira — o servidor local **não é guardado**. Não há login em lado nenhum.
> A proteção aplica-se à **superfície remota** (o túnel), não ao loopback.

## 3. As camadas de defesa (e o que cada uma bloqueia)

As camadas descrevem o **proxy do túnel** (a superfície remota) e o processo de
acesso. A ordem das verificações é contrato e está no código
(`src/http/gate.ts`); invertê-la é regressão de segurança.

| Camada | O que bloqueia | Onde está |
| --- | --- | --- |
| **L2 — bind em loopback** | o socket do DSH nunca é alargado (`0.0.0.0`/`::` recusados no load); a exposição é o proxy dedicado, não o servidor | `src/config/bind.ts`, `assertSecureBind` |
| **L2.5 — validação de `Host`** | DNS rebinding e pedidos por nome que não é o nosso | `src/http/host-header.ts` |
| **L3 — sessão ou chave no link** | quem é pelo proxy do túnel: sessão (cookie) ou a chave `?key=` no link; fora disso → `401` sem desafio | `src/http/gate.ts`, `src/session/link-token.ts` |
| **L6 — allowlist do Telegram** | só o `from.id` pareado comanda o bot | `worker/auth/allowlist.ts` |
| **L7 — veto de elevação** | `danger-full-access` negada (defesa em profundidade) | `src/permissions/deny.ts` |
| **L8 — kill switch / TTL / auditoria** | `/emergencia`, expiração do túnel, registo de eventos | `src/control/controller.ts`, `src/tunnel/ttl.ts`, `src/audit/**` |

Para não confundir o resultado:

- **`trustedRemotes`** é a allowlist da **origem da conexão** (`req.socket.remoteAddress`).
- **`allowedHosts`** é a allowlist do **endereço de bind** — a interface local onde se escuta.
- A superfície do túnel **só aceita por sessão ou chave no link**; o loopback abre sem barreira.

### 3.1 O 401 do portão é sem desafio

Quando a sessão é inválida e não há `?key=` válida, a resposta é um **401 em
texto puro, sem desafio de login** (`src/http/responses.ts`, `denyUnauthorized`).
Não aparece **popup de login** — o formulário de credenciais foi removido. Quem
abre a URL do túnel sem a chave vê o 401; **não lhe é pedida senha em lado nenhum**.

## 4. O que **não** mitigamos — e em quem confias

Estes pontos são **do desenho**, não falhas por corrigir. O `SECURITY.md` dá-os
como "não-vulnerabilidades": um relato sobre eles será fechado como conhecido.

### 4.1 O TLS termina na borda da Cloudflare

Quando usas um túnel `trycloudflare.com`, a conexão browser→Cloudflare é TLS,
mas o TLS **termina na borda da Cloudflare**: arquitetonicamente, o texto claro
(prompts, trechos de código, respostas do LLM, sessões) passa por um terceiro,
e a Cloudflare pode vê-lo. É exatamente isso que permite WAF, Access e cache
(`docs/plano/02-SEGURANCA.md §2.5`, `SECURITY.md` secção 5). **Não é
ponta-a-ponta** e nunca foi apresentado como tal. Para quem tem um domínio na
Cloudflare, o caminho de segurança estritamente superior é o *named tunnel* +
Cloudflare Access (ver `docs/TUNNEL.md`).

### 4.2 A URL do túnel não é segredo

Hostnames `*.trycloudflare.com` são descobríveis por amostragem pública, e uma
amostragem real devolveu dezenas de hostnames vivos. A URL é um **endereço, não
uma credencial**; quem protege é a **chave no link**, **não** a obscuridade do
nome (`SECURITY.md` secção 5).

### 4.3 Cloudflare Access não pode ficar na frente de um *quick tunnel*

O *quick tunnel* não tem domínio próprio na Cloudflare, e o Access exige
`zone_id`/domínio. Sobre recursos com `*.trycloudflare.com`, **toda a
autenticação tem de estar dentro da aplicação** (`docs/plano/08-PESQUISA-E-FONTES.md
§§1.3 e 7.4`, confiança **Alta**). O *named tunnel* + Access é o modo com
autenticação **antes** de chegar à tua máquina.

### 4.4 O *quick tunnel* não tem SLA

É comportamento documentado do produto: *"intended for testing and development
only"* e *"We don't guarantee any SLA or uptime"*
([docs oficiais](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)).
O hostname muda a cada reinício; o túnel tem um TTL que o derruba
automaticamente (default 60 min, `docs/TUNNEL.md §5`).

### 4.5 *Prompt injection* contra o agente é risco aceite

Quem tem sessão ou chave válida conduz o agente. O plugin controla **quem entra**,
não **o que é pedido** depois de entrar. Não resolvemos *prompt injection*.

### 4.6 O `X-Forwarded-*` é forjável do lado de fora

Sem uma borda de confiança, um cliente pode enviar `X-Forwarded-For` e
`X-Forwarded-Proto` à vontade. Por isso o plugin parte de `trustEdgeHeaders:
false` (não acredita em header nenhum da borda por padrão) e a identidade usada
pelo rate limit colapsa sob o túnel para uma identidade só (caso global).
Decisão em `docs/plano/02-SEGURANCA.md §5.4` e `src/config/schema.ts:343-380`.

## 5. A chave no link — o que viaja, o que é reutilizável, o que se revoga

O modelo novo (expose-port) **não pede senha a ninguém**. O acesso pelo túnel
entra por **sessão** ou pela **chave no link**:

- **A chave é gerada pela máquina** (CSPRNG, 256 bits, base32) e viaja **no
  link que o bot envia**: `https://<url-pública>/?key=<token>`. Em disco fica
  apenas um **digest** (SHA-256), nunca a chave (`src/session/link-token.ts`).
- **A chave é reutilizável até ser revogada** — não é de uso único. O mesmo link
  pode autenticar mais do que uma sessão. Ela deixa de valer apenas quando
  `/rotacionar` gera uma chave nova (e invalida as sessões), quando o túnel é
  derrubado (`/desligar`, `/emergencia`) ou ao desparear
  (`src/session/link-token.ts:17-22,141`, `src/control/surface-ipc.ts`).
- Quem recebe o link abre `?key=<token>`; a chave válida é **trocada por uma
  sessão** e o navegador é redirecionado (302) para a **URL limpa** (sem `?key=`),
  para que a chave saia do endereço assim que a sessão existe
  (`src/http/gate.ts`, `stripKeyParam`).
- A verificação é **em tempo constante** sobre o digest (`constantTimeContains`),
  e o token redige-se em `JSON.stringify`/`util.inspect` — nenhuma mensagem do
  módulo expõe o valor em claro (`src/session/link-token.ts`).

### 5.1 Riscos honestos deste desenho (trade assumido pelo dono)

- **Quem tiver o link acede** — enquanto a chave não for rotacionada. Um `mk`
  de uso único (desenho antigo) não existe aqui: reutilizável é a decisão, e
  o dono assume o custo de **rotacionar** (`/rotacionar`) para revogar.
- A `?key=` **viaja em query string** — visível a intermediários no caminho
  (proxies, logs, histórico, referer). O portão loga apenas a **URL limpa** (sem
  a chave) para não a publicar nos logs (`src/http/gate.ts`, HIGH #2), mas o
  valor em si percorre a query como em qualquer *expose-port*. **Este trade é
  assumido pelo dono**, igual ao modelo expose-port; para menos exposição em
  query, rotaciona-se cedo ou não se usa túnel.
- **A "senha permanente" do desenho antigo deixou de ser usada para acesso.**
  Não há instrução nenhuma (nem prompt, nem formulário, nem chat) a pedir que
  alguém digite uma senha: o acesso remoto é por **sessão ou chave no link**, e
  o acesso local abre direto.

## 6. Rate limit e o modo restrito

O proxy do túnel protege a chave e as sessões contra força bruta:

- 4 falhas em 1 min de um mesmo identificador: sem atraso.
- **5ª falha**: atraso de 1 s; 6ª/7ª/8ª → 2 s/4 s/8 s (progressão com teto).
- Ban progressivo; **o `401` é byte-a-byte idêntico** em todos os casos — nunca
  há sinal de que o identificador está banido (não há `429` no caminho de auth).
- **Teto NIST**: 100 falhas acumuladas → **modo restrito**: o túnel é derrubado,
  só o loopback passa, o estado é persistido e o reiniciar do DSH não o contorna
  (`src/ratelimit/**`, `02-SEGURANCA.md §6.1`). Em modo restrito a chave no link
  **não autentica pelo túnel** (`src/http/gate.ts`, verificação de `restricted`).
- A saída do modo restrito é **local** (na máquina); nenhum caminho remoto o
  desativa.

## 7. Riscos que **não** estão no nosso escopo

- Vulnerabilidades do DSH a montante — reporta a `deepseek-ai/deepseek-harness`;
- vulnerabilidades do `cloudflared`/rede Cloudflare — reporta à Cloudflare;
- vulnerabilidades da Bot API do Telegram — reporta à Telegram.
- Dependências de terceiros sem caminho de exploração **através** deste plugin.

## 8. Dependências e o que o worker pode ver

O **host** (este plugin) tem **uma** dependência de runtime direta
(`grammy@1.45.1`), que é carregada **só pelo worker**, não pelo host. O `grammY`
leva `node-fetch@2` **transitivo** — a pilha HTTP do worker inclui
`node-fetch@2`, e é bom saber que existe (decisão D23,
`docs/plano/09-DECISOES-CANONICAS.md`).

O worker de long-polling não herda `process.env` inteiro: o plugin monta um
ambiente a partir de uma **allowlist** (`src/proc/env.ts:25-47`) mais o token do
bot. Efeito prático: mesmo que o worker (um binário de terceiros que consome
input da internet) seja comprometido, os segredos do plano de controlo não estão
no `/proc/<pid>/environ` dele para serem lidos.

## 9. A linha de cima, honesta

Este problema não tem solução "seguro por padrão sem pensar". Estás a expor um
agente com shell ao mundo, por escolha, num túnel efémero. No loopback abre
direto; pelo túnel, só entra quem tem **sessão ou a chave no link**. O plugin
reduz a superfície, autentica a borda por chave e sessão, limita a janela (TTL),
permite **rotacionar** a chave e entrega um botão de desligar. Não elimina a
categoria do risco.

- Se queres "inalcançável de verdade", não uses túnel nenhum (loopback puro).
- Se queres rede privada real, usa Tailscale (instala um cliente no celular).
- Se tens um domínio na Cloudflare, o *named tunnel* + Access é o caminho
  superior (o plugin suporta *named* como transporte: `docs/TUNNEL.md §6`).

> **Números e factos deste documento** correspondem a fontes verificadas:
> a discussão #853 (fonte primária do GitHub), a doc da Cloudflare (TryCloudflare,
> Access), a doc da Bot API do Telegram e `docs/plano/08-PESQUISA-E-FONTES.md §8`
> (tabela de factos com confiança e data). Nenhum número citado aqui está em
> `docs/PROIBIDO.md`.