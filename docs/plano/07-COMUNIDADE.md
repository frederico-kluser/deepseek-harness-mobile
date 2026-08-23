# 07 — Comunidade: lançamento, divulgação e sustentação

> Documento do **plano**. Não contém implementação. Define o que é publicado, em que ordem, por
> qual canal, com qual texto, sob qual critério de aceite verificável, e com qual resposta já
> escrita para as críticas de segurança que **vão** vir. Documentos irmãos em `docs/plano/`
> cobrem arquitetura, segurança, ondas, testes, qualidade de código e repositório/CI; este
> documento assume que aquilo existe e trata do que acontece *depois* de existir.
>
> Revisão desta rodada: incorpora o dossiê de pesquisa **verificada**, incluindo três alegações
> que foram **refutadas** e que estavam sendo usadas como fato na versão anterior deste arquivo
> (§3.1, §9.2, §9.3). Alegação refutada não pode aparecer em material público — nem aqui.

---

## 0. A pergunta que este documento responde

O pedido foi: *"como vamos provar isso pra comunidade"*. "Provar" tem dois sentidos, e os dois
importam:

1. **Provar que funciona** — artefatos verificáveis: GIF de 20s, exemplo mínimo que roda no CI,
   entrada instalável pelo caminho oficial, teste que qualquer pessoa reproduz em dois minutos.
2. **Provar que é defensável** — este projeto expõe um agente com shell à internet. A primeira
   resposta técnica no Hacker News não será "legal"; será *"você acabou de publicar um
   RCE-as-a-service"*. A §9 existe para que essa resposta já esteja escrita, com números
   verificados, **antes** do lançamento.

**Regra dura:** se o item 2 não estiver pronto, não se lança. Uma thread mal respondida sobre
segurança, em um projeto cujo argumento central é segurança, é dano permanente.

---

## 1. Posicionamento

### 1.1 Uma frase

> **`dsh-guarded-bot-orchestrator` permite usar o seu próprio DeepSeek Harness pelo celular — a (hoje: dsh-guard-messenger)
> Web UI inteira, para codificar de verdade — sem nunca alargar o bind para fora do loopback: o
> túnel termina em `127.0.0.1`, a senha é gerada pela máquina, e você liga e desliga o acesso
> pelo Telegram.**

### 1.2 Para quem

| Perfil | Dor concreta | Por que este plugin |
| --- | --- | --- |
| Dev solo que roda DSH na workstation de casa | Sai de casa, o agente continua rodando, e não há como acompanhar nem redirecionar | Não exige VPN, domínio próprio, nginx nem cliente no celular |
| Dev que já rodou `dsh web --host 0.0.0.0` "só por 10 minutos" | Expôs o control plane sem autenticação — é a discussão upstream [#853](https://github.com/deepseek-ai/deepseek-harness/discussions/853), *"unauthenticated local/remote code execution via the dsh web UI control plane (verified on 0.1.0-rc.6)"* | O plugin torna esse erro impossível: bind fora da allowlist **falha no load**, ruidosamente |
| Quem já usa Telegram para notificação de build/deploy | Tem o hábito, falta o controle | Liga/desliga e recebe o link pelo mesmo canal |

### 1.3 Para quem **não** é (dizer isto em voz alta, no README, acima da lista de features)

- **Time / multiusuário.** É um plugin de dono único: uma allowlist de `from.id` do Telegram e
  uma credencial. Não há RBAC nem auditoria multi-tenant.
- **Produção / uptime.** O quick tunnel é, nas palavras da própria Cloudflare, *"intended for
  testing and development only"* e *"We don't guarantee any SLA or uptime"*
  ([docs oficiais](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)).
- **Quem precisa de compliance.** O TLS termina na borda da Cloudflare; arquitetonicamente o
  texto claro passa por lá — é o que permite WAF/Access/cache. Não é E2E.
- **Quem quer "seguro por padrão sem pensar".** Isso não existe aqui. Você está expondo um agente
  com shell. O plugin reduz superfície e entrega o botão de desligar; não elimina a categoria.
- **Máquina corporativa.** Ver §9.7: `trycloudflare.com` tem reputação de malware documentada e
  muitas redes/EDRs bloqueiam ou sinalizam `cloudflared`.

### 1.4 A tensão central — dita por nós antes que digam por nós

O plugin existente foi construído para **travar** o DSH em loopback. O pedido agora é **expor** o
DSH pela internet. Parece contradição, e a comunidade vai apontar em minutos. A formulação
honesta, que precisa estar no README e no primeiro parágrafo de todo anúncio:

> O bind **continua** em `127.0.0.1`. O que muda é que passa a existir um processo filho
> supervisionado (`cloudflared`) que leva o tráfego da borda da Cloudflare até esse loopback. Não
> é o mesmo que `--host 0.0.0.0`: o socket local nunca é alargado, a exposição é **opt-in**,
> efêmera e revogável em um comando; e a barreira de autenticação continua no processo, no
> mesmo lugar, valendo para `/api`, para o fallback da SPA e para o handshake de WebSocket.
>
> O que **não** muda: a superfície de ataque lógica cresce. Antes, um atacante precisava de
> acesso à máquina; agora precisa da senha. Trocamos "inalcançável" por "alcançável e
> autenticado". Essa troca é a decisão do projeto, e ela é reversível a qualquer momento pelo
> comando de desligar.

Quem não aceitar essa troca deve usar Tailscale ou SSH — e o README diz isso, com link.

---

## 2. Concorrentes e alternativas — comparação honesta

Regra desta seção: **nenhuma alternativa é apresentada como ruim.** Várias são melhores que este
plugin em vários eixos. O valor está na combinação específica, não em vencer item a item. Este
quadro vai **no README**, não só aqui.

| Alternativa | O que faz melhor | O que custa | Quando escolher **em vez** deste plugin |
| --- | --- | --- | --- |
| **Tailscale (+ Funnel)** | Rede privada real, WireGuard, identidade por dispositivo, URL estável. Modelo de segurança estritamente superior | Instalar cliente no celular e conta. Funnel só serve HTTPS em 443/8443/10000 *(fonte terceira — §14)*. Não dá link para um dispositivo sem o app | **Quase sempre, se você aceita instalar o cliente.** Dizer isso no README, com essas palavras |
| **ngrok** | Ergonomia imediata e — diferença material — **OAuth e Basic Auth na borda no plano free**, algo que o quick tunnel não oferece | Free: ~1GB/mês, 3 endpoints, interstitial de browser, sem domínio custom *(fonte terceira — §14)*. URL muda | Quando você quer auth **de borda** hoje e não tem domínio na Cloudflare |
| **SSH + tmux** | Sem superfície HTTP nova, E2E de verdade, auditável | Não é a Web UI. Codificar em terminal no celular é castigo. Exige porta SSH exposta ou VPN | Quando você só precisa ver log e matar processo |
| **code-server / VS Code tunnels** | Editor completo no browser, projeto maduro | Não é o DSH: roda em paralelo e duplica estado. Histórico próprio de CVE grave (CVE-2023-26114, WebSocket sem validação de `Origin`, CVSS 9.3) | Quando o objetivo é editar arquivo, não conduzir o agente |
| **`dsh-webui-auth`** (plugin já listado, ~7★) | Faz autenticação da WebUI *"enforced at the HTTP/transport layer: four-layer login gate (resources, plugin bundles, /api, WebSocket)"* — **cobre boa parte da função de auth deste plugin** | Só autentica. Não abre túnel, não gera senha, não tem bot, não liga/desliga | **Se você só quer autenticação, use ele.** Dizer isso explicitamente é o que separa comparação honesta de marketing |
| **Named tunnel + Cloudflare Access** | Auth **antes** de chegar na sua máquina, One-time PIN por e-mail sem IdP, deny-by-default | Exige conta e **domínio com DNS na Cloudflare** | Sempre que você tiver domínio. É o caminho superior e está no nosso roadmap |
| **Nada (rodar `dsh web` só local)** | Risco zero de exposição | Você não usa do celular | Sempre que você não precisar mesmo |

### 2.1 A frase que resume a diferença (usar no anúncio)

> Isto não é "mais um túnel". É o **fluxo completo de um dono só**: onboarding do Telegram →
> senha gerada → túnel efêmero → link no celular → botão de desligar. Cada peça existe separada,
> e melhor, em outro lugar; o que não existia era a peça montada, com o bind travado em loopback
> e o kill switch no bolso.

**Precedência na awesome-list.** A regra publicada é *"whoever got here first keeps the slot —
but that is a tiebreaker, not tenure (...) the rule is whichever is better"*. Como o
`dsh-webui-auth` já ocupa o nicho de auth, a submissão precisa articular diferenciais
**verificáveis**, não adjetivos:

- interceptação do handshake de **WebSocket upgrade** (`registerUpgrade`), não só de rotas HTTP;
- allowlist do endereço de **bind**, distinta de `trustedRemotes` (allowlist de **origem**);
- **403 antes de 401** (origem não confiável não chega a ver o desafio de credencial);
- recusa de `danger-full-access` no load;
- worker de longa duração sob `ctx.effect()` com ambiente construído por **allowlist** de
  variáveis — segredos do control plane nunca chegam ao binário que consome input da internet;
- ciclo de vida do túnel (abrir/fechar) como operação de primeira classe, com tree-kill real.

---

## 3. Bloqueios duros — nada é divulgado antes disto

Estes não são "nice to have". Sem eles o plugin **não é instalável pelo caminho oficial** e
qualquer post gera tráfego para uma página que não converte.

| # | Bloqueio | Estado verificado hoje | Efeito se ignorado |
| --- | --- | --- | --- |
| **B0** | **O código não compila contra a API real do DSH** | `src/index.ts` importa `@deepseek-ai/dsh-host-subprocess` (**HTTP 404 no npm**), injeta `['webServer', …]` e chama `ctx.subprocess.spawn(cmd, args, opts)`. O serviço real é `ctx.httpServer` (classe `HttpServerService`, pacote `@deepseek-ai/dsh-host-webserver`); o subprocesso real é `@deepseek-ai/dsh-subprocess` com assinatura `spawn(spec: SubprocessSpawnSpec): SubprocessHandle` | **Fatal.** Publicar um pacote cujos imports não resolvem é o pior primeiro contato possível. Ver §3.1 |
| **B1** | **`dsh.bundle` no `package.json`** — gate de submissão da awesome-list | Ausente, por decisão documentada na chave `//dsh` | Sem isso, o PR reprova e o plugin não entra no `dsh-market`. Ver §3.2 |
| **B2** | **Idade e histórico do repositório** — CI exige `MIN_AGE_DAYS = 1` e `MIN_COMMITS = 10`, checados automaticamente | 7 commits, primeiro commit em 2026-08-19, **sem remote git** | PR reprova automaticamente |
| **B3** | Campo `repository` no `package.json` | Ausente | Registro npm não é vinculado à entrada; o market não mostra downloads |
| **B4** | Keyword `dsh-plugin` no npm | Ausente (hoje: `deepseek-harness`, `dsh`, `cordis`, `cordis-plugin`) | 1.909 pacotes usam essa keyword; é um eixo real de busca no registry |
| **B5** | Nome npm reservado | `dsh-guarded-bot-orchestrator` → HTTP 404 no registry (**livre**) | Risco de name-squatting entre o anúncio e a publicação |
| **B6** | `SECURITY.md` + Private Vulnerability Reporting | Ausentes | Ver §3.3 — aqui é diferencial competitivo, não burocracia |

### 3.1 B0 — a fonte da API estava contaminada (e isso vira ativo de credibilidade)

O dossiê verificou, baixando tarballs do npm e lendo os `.d.ts` reais, que os markdowns usados
como fonte acertam a **arquitetura** e erram a **API**. Concretamente, quatro erros que hoje
estão no código:

| No código hoje | Real (verificado no `.d.ts` do pacote) |
| --- | --- |
| `import … from '@deepseek-ai/dsh-host-subprocess'` | Pacote **não existe** (404). É `@deepseek-ai/dsh-subprocess` (+ `@deepseek-ai/dsh-subprocess-local` para a implementação) |
| `inject = ['webServer', …]`, `ctx.webServer`, tipo `WebServer` | `interface Context { httpServer: HttpServerService }` — o inject vira `['httpServer', …]` e `ctx.intercept('webServer', …)` vira `ctx.intercept('httpServer', …)`. O tipo `WebRoute` existe e está correto |
| `ctx.subprocess.spawn(cmd, args, opts)` | `abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle` — objeto único com `argv`, `cwd`, `stdio`, `graceMs` obrigatórios |
| `dsh-host-frontend` | `@deepseek-ai/dsh-host-frontend-static` |

**Consequência para este documento:** B0 bloqueia **todas** as fases. Nada de npm, nada de
awesome-list, nada de Show HN antes de o plugin importar e rodar contra os pacotes reais.

**Consequência positiva, que é material de lançamento:** o README pode declarar, com verdade
verificável, uma coisa que quase nenhum plugin do ecossistema declara:

> Todos os símbolos usados por este plugin foram validados contra os arquivos `lib/types/*.d.ts`
> dos pacotes `@deepseek-ai/*` publicados no npm, versão a versão, e não contra documentação em
> prosa. A versão exata testada está em `docs/COMPATIBILITY.md` (arquivo **gerado** por CI).

Isso é um diferencial concreto num ecossistema inteiro em `0.0.1-rc`/`0.1.0-rc`, cujo próprio
README upstream avisa *"developer preview, expect breaking changes"*.

### 3.2 B1 — a decisão sobre `dsh.bundle` (corrigindo a versão anterior deste arquivo)

**A versão anterior deste documento afirmava que o gate exige `dsh.bundle.patch`. Isso foi
refutado.** O que decide o PR é `scripts/check-submission.mjs` da `awesome-dsh-plugin`, e o
código lê apenas a presença da chave:

```js
if (dsh.bundle) return { ok: true }          // ~L193
if (dsh.bundle) { /* … */ return { ok: true, at: p } }   // ~L153
```

Ele **nunca** lê `dsh.bundle.patch` e **nunca** verifica se o arquivo apontado existe. O
`"bundle": { "patch": "./cordis.patch.yml" }  // ← required` do `contributing.md` é prosa, não é
o gate. Logo existem quatro caminhos, e não três:

| Opção | O que é | Avaliação |
| --- | --- | --- |
| **(a)** `dsh.bundle.patch` apontando para um patch mínimo distinto | Duas verdades, mas separadas | Custo de manutenção real; possível, não preferido |
| **(b)** `dsh.bundle.patch` apontando para o **mesmo** `cordis.patch.yml` | **Perigoso hoje.** O manifesto contém `id: '<ID-DA-ENTRADA-DO-SERVIDOR-WEB-NESTA-INSTALACAO>'` — um placeholder. Se o `id` não casar, o *whole-entry replace* vira *insert*, nasce uma segunda instância do servidor web e o boot quebra por conflito de rota | **Descartar** enquanto o placeholder existir |
| **(c)** Abrir mão da awesome-list | Perde o market e o canal nº 1 | Descartar |
| **(d)** `"dsh": { "bundle": {} }` | Objeto vazio é *truthy* em JS: **passa o check** sem registrar nenhuma camada e sem criar dupla verdade | **Candidato preferido**, com a ressalva abaixo |

**Ressalva honesta sobre (d), a levantar antes de submeter:** passar no CI não é o mesmo que
funcionar. Não foi verificado o que `dsh plugin --profile <p> add <pkg>` faz com um `bundle`
vazio — se instala silenciosamente sem ativar camada, o usuário instala e nada acontece, o que é
pior do que reprovar no CI. **NÃO CONFIRMADO.** Além disso, um mantenedor humano pode reprovar
(d) na revisão mesmo com o CI verde. Ação: testar (d) localmente contra o `dsh` real e, se o
comportamento for ruim, cair em (a) com um patch mínimo dedicado.

**Dependência registrada:** enquanto B1 não for resolvido no documento de empacotamento, os
canais §7.1 e §7.2 estão bloqueados e, por consequência, as fases Beta e Público.

### 3.3 B6 — `SECURITY.md` como diferencial competitivo

O repositório upstream **não tem** `SECURITY.md` nem `CONTRIBUTING.md` (ambos 404) e não tem
Private Vulnerability Reporting ligado. Foi exatamente por isso que a #853 — um RCE não
autenticado real — foi divulgada **publicamente**. Publicar `SECURITY.md` e ligar o PVR aqui:

- dá canal de disclosure coordenado para quem achar bug **neste** plugin (e vão achar);
- é argumento de credibilidade concreto no anúncio;
- pontua no community profile checklist do GitHub e no OpenSSF Scorecard.

Conteúdo mínimo: escopo (o que é vulnerabilidade **deste** plugin vs. do DSH vs. da Cloudflare),
canal (PVR), SLA declarado e realista (§13) e — o mais importante — uma lista explícita de
**não-vulnerabilidades**:

- "a URL do túnel não é tratada como segredo pelo design" (§9.2);
- "o TLS termina na Cloudflare, por construção";
- "prompt injection contra o agente é risco aceito e documentado, não resolvido";
- "o quick tunnel não tem SLA e o hostname muda a cada restart".

---

## 4. Artefatos de lançamento — checklist com critério de aceite

Cada item tem critério **verificável**. Nada entra em "pronto" por opinião.

### 4.1 GIF de demo de 20 segundos (artefato nº 1)

O guideline fixado da categoria "Show Your Plugins!" do Discussions upstream (#2004) **exige**
screenshot/GIF/vídeo de demo mais explicação da integração. É também o que converte no HN.

**Roteiro (20s, sem áudio, legendas queimadas):**

| t | Tela | Legenda |
| --- | --- | --- |
| 0–3s | Terminal: `dsh` rodando; `curl` a `/api` sem credencial devolvendo `401` | "bind travado em 127.0.0.1" |
| 3–7s | Celular: chat do Telegram, `/ligar` | "liga pelo bot" |
| 7–11s | Bot responde com o link; senha aparece **no terminal**, não no chat | "link efêmero — a senha não passa pelo Telegram" |
| 11–16s | Chrome/Safari mobile: desafio de senha → Web UI do DSH carregada, prompt sendo digitado | "a Web UI inteira, no celular" |
| 16–20s | Telegram: `/desligar` → o link no browser passa a falhar | "kill switch no bolso" |

**Critérios de aceite:**

- [ ] ≤ 20s, ≤ 4 MB, loop limpo, legível em thumbnail de celular
- [ ] **Nenhum segredo em frame nenhum** — token do bot, senha, hostname real do túnel. Usar
      valores descartáveis e **rotacionar tudo** depois de gravar (inclui `/token` no BotFather)
- [ ] Passa no "teste do mudo": entende-se sem ler o README
- [ ] Hospedado no próprio repo (`docs/assets/demo.gif`), não em serviço terceiro que expira
- [ ] O segundo 0–3s mostra o `401` — a prova de que o gate existe é o primeiro frame

### 4.2 README

O guia oficial de open source pede que o README responda quatro perguntas: *"What does this
project do? Why is this project useful? How do I get started? Where can I get more help?"*

**Estrutura obrigatória, nesta ordem:**

1. Título + a frase de §1.1 + **quatro** badges: CI, npm version, npm downloads, OpenSSF Scorecard.
   **Sem badge de licença** — o GitHub já a exibe na barra lateral e o `LICENSE` está na raiz
   (decisão canônica 09 §D22; a autoridade sobre badges é `06-REPO-E-CI.md` §4.5)
2. **GIF, acima da dobra**
3. Install em uma linha: `dsh plugin --profile web add dsh-guarded-bot-orchestrator`
   (formato canônico das ~1.650 entradas da awesome-list; alternativa `add github:owner/repo`)
4. **"Modelo de ameaça em 5 linhas"**, *antes* de qualquer lista de features. Quem lê isso e
   desiste é um usuário que você não queria ter
5. A tensão de §1.4, com essas palavras
6. Quickstart de 5 comandos, executável, testado no CI (§4.4)
7. **"Quando NÃO usar isto"** (§1.3) e **"Alternativas"** (§2) — no README, com links
8. Compatibilidade: contra qual versão exata de `@deepseek-ai/dsh*` foi testado (§3.1)
9. Como desinstalar e reverter — crítico para confiança em plugin de segurança
10. Links para `SECURITY.md`, `CONTRIBUTING.md`, Discussions

**Critério de aceite:** alguém que nunca ouviu falar de DSH entende, em 60 segundos, o que é,
para quem é e qual o risco. Testar com uma pessoa real na fase Alpha (§6.1).

### 4.3 Docs separadas (`docs/`)

Os nomes abaixo são os **canônicos de 09 §D5**. Nenhum outro nome de arquivo de documentação pode
aparecer em material público, em link do README ou em resposta de issue — nome de doc que muda entre
documentos vira link quebrado no dia do anúncio.

- `docs/ONBOARDING-TELEGRAM.md` — o guia de conectar o Telegram: BotFather, e depois o **pareamento
  por código de 6 dígitos** exibido só no terminal (`/parear <código>`; `/start` **não** pareia
  ninguém). Traz a advertência literal do FAQ oficial: *"any bot should be treated as a stranger —
  don't give them your passwords, Telegram codes or bank account numbers, even if they ask nicely"*,
  e a explicação de por que **a senha nunca trafega pelo Telegram** (chat de bot é cloud chat, não é
  E2E; a Telegram armazena e analisa mensagens de cloud chat; não existe autodestruição para bots e
  `deleteMessage` só funciona em mensagens com menos de 48 h). O que **pode** chegar pelo chat é o
  **link mágico de uso único** (TTL 120 s, uso único), e o doc diz a diferença com todas as letras
- `docs/THREAT-MODEL.md` — modelo de ameaça completo: o que o plugin garante e o que não garante
- `docs/EXPOSURE.md` — o que muda no instante em que o túnel sobe (`trustedRemotes` fica inerte, a
  credencial vira a única barreira, a URL não é segredo, o TTL do túnel é o limite da janela)
  — juntos, estes dois substituem o antigo `docs/seguranca.md`
- `docs/TUNNEL.md` — quick tunnel vs. named tunnel + Access; por que o segundo é o caminho de
  quem tem domínio; o **TTL obrigatório** (default 60 min, teto 480); e o fato de que **Access não
  se aplica a quick tunnel** (exige zona/DNS na Cloudflare), portanto no quick tunnel *toda* a
  autenticação é da aplicação
- `docs/TROUBLESHOOTING.md` — erros reais: ordem de carregamento errada (`curl` devolve `200` em
  vez de `401`), `409 Conflict` por duas instâncias fazendo long polling, túnel demorando 6–7 s
  para ficar disponível (medido), processo `cloudflared` órfão
- `docs/COMPATIBILITY.md` — matriz de versões testadas. **É gerada** por
  `scripts/gen-compat-table.mjs` a partir do resultado do workflow `dsh-compat.yml`. O ritual mensal
  (§13.6) **roda o workflow**; editar este arquivo à mão é violação (09 §D5)
- `docs/INSTALL.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md` — completam a casca definida em
  `06-REPO-E-CI.md` §2
- `docs/PROIBIDO.md` — a lista do §10 deste documento, no lugar canônico (não `docs/divulgacao/`)

### 4.4 Exemplo mínimo executável

Diretório `examples/minimal/` com o menor conjunto que sobe tudo, **e que roda no CI**. Não é
vitrine, é teste: exemplo que não roda no CI apodrece em duas semanas.

**Critério de aceite:** job `example-smoke` que sobe o exemplo, faz `curl` sem credencial
(espera `401`), com credencial (espera `200`), derruba e verifica que **nada ficou órfão**
(`pgrep cloudflared` vazio, `pgrep -f <worker>` vazio).

**Donos, para o exemplo não ficar sem endereço (09 §D22):** o diretório `examples/minimal/` é
entrega de **T7.3**; o job `example-smoke` é entrega de **T7.2** e **não** é required check até a
Onda 7 — um exemplo quebrado não pode travar PR de código antes de o exemplo existir. O diretório
consta da árvore de `06-REPO-E-CI.md` §2.

### 4.5 Vídeo curto (opcional, fase Público)

2–3 minutos, narrado, cobrindo o que não cabe no GIF: o modelo de ameaça e o "por que loopback
continua loopback". Só vale a pena se a fase Beta mostrar que a objeção de segurança está
dominando as conversas — nesse caso um vídeo respondendo isso vale mais que dez comentários.

### 4.6 Higiene de repositório (community profile do GitHub)

- [ ] `LICENSE` — MIT, alinhado com o upstream (que é MIT). Não há exigência de licença na
      awesome-list; trocar para Apache-2.0 traria a concessão de patente do §3 ao custo das
      condições do §4 (NOTICE + aviso de arquivos modificados). Decisão: **manter MIT**
- [ ] `CONTRIBUTING.md` — como reportar bug, sugerir feature, montar ambiente e **rodar os testes**
- [ ] `CODE_OF_CONDUCT.md` — Contributor Covenant 2.1, com `[INSERT CONTACT METHOD]`
      **preenchido** e a linha de atribuição obrigatória mantida
- [ ] `SECURITY.md` + PVR ligado (§3.3)
- [ ] Templates em `.github/ISSUE_TEMPLATE` com frontmatter válido (`name:`/`about:` para `.md`;
      `name:`/`description:` para issue forms `.yml`)
- [ ] Topics: `dsh-plugin`, `dsh`, `cordis`, `deepseek-harness`, `telegram-bot`,
      `cloudflare-tunnel`, `self-hosted` (máx. 20 topics, ≤50 chars, minúsculas/dígitos/hífen;
      só admins podem adicionar; nomes de topic são sempre públicos)

---

## 5. Onde este documento entra no plano de ondas

**Este documento NÃO define ondas.** A autoridade de sequenciamento é
[`03-ONDAS.md`](03-ONDAS.md), o único plano de execução consumido pelo `deep-orchestrator`
(decisão canônica 09 §D20). As fases `C0–C9` da versão anterior concorriam com as Ondas 0–7 de 03 e
com as ondas `R0–R4` de `06-REPO-E-CI.md` — três sequenciamentos incompatíveis para o mesmo
trabalho. O conteúdo continua valendo; muda **onde** cada peça acontece, e **quem** a executa.

| Fase antiga | Passa a ser | Gate de saída (inalterado) |
| --- | --- | --- |
| **C0** — desbloqueio de API (correção de B0, §3.1) | **Onda 0, T0.1** | `pnpm build` verde contra os pacotes `@deepseek-ai/*` **reais**; `docs/COMPATIBILITY.md` com versões exatas |
| **C1** — higiene de repo (§4.6 + `repository` + keyword `dsh-plugin`) | **Onda 1, T1.4** (junto com R0 de 06) | community profile 100%; `npm pkg get repository` não vazio |
| **C2** — reserva do nome no npm | **Onda 1, T1.4** | Reservar **cedo** (09 §D21): publicar `0.0.1` como stub documentado. `GET https://registry.npmjs.org/dsh-guarded-bot-orchestrator` → 200 |
| **C3** — README + docs + exemplo (§4.2, §4.3, §4.4) | **Onda 7, T7.3** | job `example-smoke` verde; link-checker verde |
| **C4** — GIF de demo | **Onda 7, T7.3** | `docs/assets/demo.gif`; checklist §4.1 completo + auditoria frame a frame por segredo |
| **C5** — Alpha privado (3–5 instalações reais) | **pós-T7.4**, fora do orquestrador | §6.1. Depende de pessoas de fora: não é tarefa de agente |
| **C6** — decidir B1 + submeter à awesome-list | **pós-T7.4**, fora do orquestrador | PR merged; entrada visível em `plugins.json` |
| **C7** — Beta com early adopters | **pós-T7.4**, fora do orquestrador | §6.2 |
| **C8** — Público (Show HN → Bluesky → dev.to → Reddit) | **pós-T7.4**, fora do orquestrador | §6.3 |
| **C9** — sustentação | **pós-T7.4**, ritual mensal (§13.6) | §13 |

> **Por que C5–C9 saem do orquestrador, e isso é uma correção e não uma desistência.** Elas
> dependem de **terceiros**: pessoas instalando numa máquina que não é a sua, mantenedores de um
> registro externo aceitando um PR, moderação de fórum. Nenhuma delas é executável por um agente e
> nenhuma delas tem critério de aceite que um gate de CI consiga avaliar. Enquanto figuravam como
> "ondas", `03-ONDAS.md` §18.2 afirmava que a divulgação era entregue pela Onda 7 — o que era falso,
> porque T7.4 entrega **rascunhos** em `docs/`, não posts publicados. O plano agora diz a verdade:
> a Onda 7 entrega o **material**; a divulgação é ação humana posterior.

> **C6 continua sendo o portão real.** Antes dele o plugin não é instalável pelo market oficial e um
> post viral só gera frustração. Ordem invertida (post antes da lista) é o erro mais caro deste
> plano — e continua sendo, mesmo com as fases fora do orquestrador.

---

## 6. Fases de lançamento

### 6.1 Fase Alpha — privado (C5)

**Quem:** 3 a 5 pessoas, convidadas individualmente. De preferência um dev que já usa DSH, um que
nunca usou, e uma pessoa com perfil de segurança instruída a tentar quebrar.

**Validar antes de sair da fase:**

- [ ] Instalação limpa em **máquina que não é a do autor**, sem intervenção do autor, em ≤10 min
- [ ] Onboarding do Telegram completado por quem nunca criou um bot
- [ ] Fluxo do GIF reproduzido ponta a ponta em **rede móvel real** (4G/5G, não Wi-Fi de casa)
- [ ] Ninguém acessou sem a senha — pedir explicitamente que tentem
- [ ] Desinstalar/reverter deixou a máquina no estado anterior: zero processo órfão
- [ ] Pelo menos uma pessoa leu o README inteiro e disse, sem consultar o autor, **qual é o risco**
- [ ] Uma pessoa reproduziu o `401` do primeiro frame do GIF na própria máquina

**Critério de avanço:** zero itens em aberto. Bug de segurança encontrado na Alpha **reinicia** a
fase depois do fix.

### 6.2 Fase Beta — early adopters (C7)

**Onde:** exclusivamente Discussions do DSH ("Show Your Plugins!") e o Discord oficial. Público
100% usuário de DSH — as pessoas certas para achar bug de integração.

**Validar:**

- [ ] Entrada visível na awesome-list e instalável pelo `dsh-market`
- [ ] ≥10 instalações de terceiros (proxy: downloads npm da semana — §11)
- [ ] ≥3 issues reais de terceiros, **respondidas em ≤48h**
- [ ] Nenhuma issue de segurança aberta sem resposta
- [ ] O erro de ordem de carregamento **não** ocorreu com ninguém; se ocorreu, o instalador
      precisa detectá-lo e falhar antes de ir a público
- [ ] Nenhuma incompatibilidade silenciosa com a rc corrente do DSH

**Critério de avanço:** 2 semanas sem regressão e SLA cumprido. Ir a público com issue de
segurança aberta é como se adquire reputação ruim permanente.

### 6.3 Fase Pública (C8)

Ordem, com espaçamento deliberado:

1. **Dia 0, segunda-feira** — Show HN (janela em §7.3)
2. **Dia 0, +4h** — Bluesky/X, thread curta, GIF como primeiro post
3. **Dia 1–2** — dev.to: artigo técnico longo, **não** anúncio ("por que expor um agente de
   código é difícil"), com o plugin como conclusão
4. **Dia 3+** — Reddit, **depois** de um humano logado ler as regras de cada subreddit (§7.4)
5. **Semana 2** — Product Hunt, apenas se houve tração

**Regra dura:** nunca mais de dois canais no mesmo dia. Cinco posts na mesma hora é o padrão que
qualquer comunidade reconhece como spam.

---

## 7. Canais e as regras de cada um

### 7.1 awesome-dsh-plugin — o portão

**Por que é o canal nº 1, e não a topic do GitHub.** A cadeia real de descoberta é:
`awesome-dsh-plugin` (registro curado, ~1.650 plugins; **~10 mil ★, medido em 19/ago/2026** — ver a
linha única do ledger em `08-PESQUISA-E-FONTES.md` §6) → `awesome-dsh-plugin.com/plugins.json`
→ `dsh-market` (o market visual dentro do DSH, npm `dshmarket`, ~82k downloads/semana). O README
do `dsh-market` diz textualmente: *"installs are restricted to sources listed in the curated
awesome-dsh-plugin registry — anything else is rejected"*. **Fora da lista, o plugin não é
instalável in-app.**

A topic `dsh-plugin` já tem ~8.398 repositórios, com o topo ocupado por projetos de 12k–167k
estrelas. É **obrigatória** (a lista exige) e entrega praticamente **zero** descoberta sozinha.
Não confundir obrigatório com eficaz.

**Reprovações automáticas:**

- repo com <1 dia ou <10 commits (`MIN_AGE_DAYS = 1`, `MIN_COMMITS = 10` em `check-submission.mjs`);
- `package.json` sem a chave `dsh.bundle` (declarar só `dsh.client` reprova);
- **superlativos** — a lista rejeita adjetivos e **verifica cada número da descrição contra o
  código**: *"Overstating is the one thing that gets an otherwise-good plugin sent back"*;
- descrição que promete o que o código não faz.

**Checklist de submissão:**

- [ ] B0–B5 resolvidos
- [ ] Descrição de uma linha, factual, sem adjetivo, com números sustentados pelo código
- [ ] Comando de install exatamente no formato canônico
- [ ] Diferenciais vs. `dsh-webui-auth` articulados e verificáveis (§2.1)
- [ ] Nenhuma afirmação da tabela §14 no texto da entrada

### 7.2 GitHub Discussions do DSH — "Show Your Plugins!"

Canal de maior sinal: público 100% usuário de DSH. Guidelines fixadas (#2004):

| Regra | O que fazer |
| --- | --- |
| Título `DSH \| Project Name \| One-line description` | `DSH \| dsh-guarded-bot-orchestrator \| Use a Web UI do DSH pelo celular sem alargar o bind de loopback` |
| Exige screenshot/GIF/vídeo **e** explicação da integração | O GIF de §4.1 + parágrafo sobre `ctx.intercept`, `ctx.effect` e o waterfall de auth |
| Um projeto por thread | Não misturar projetos |
| Proibida promoção não relacionada e post duplicado | Não repostar; **editar** a thread existente para updates |

### 7.3 Show HN

**Regras oficiais** ([newsguidelines](https://news.ycombinator.com/newsguidelines.html)):

- *"Don't solicit upvotes, comments, or submissions"* — não mandar o link para o grupo pedindo
  voto; é detectado e penaliza a conta;
- *"please use the original title, unless it is misleading or linkbait; don't editorialize"*;
- Show HN **rejeita** blog posts e sign-up pages: tem que ser algo que a pessoa possa rodar;
- post que não pegou tem **second-chance pool** via `hn@ycombinator.com` — nunca deletar-e-repostar.

**Calibração (ordem de grandeza; ver §14 — NÃO CONFIRMADO por fonte pública):** mediana de um
Show HN ≈ 2 pontos; 50 pontos ≈ top 6%; ~1,4 estrela por upvote; ~92% do impacto em 48h; ~200
Show HN concorrentes por dia; melhor janela medida segunda 00:00 UTC (~10,8% de chance de 50+),
pior quinta 06:00 UTC (~2,6%).

**O que afunda, especificamente este projeto:**

1. Título com superlativo ou com "AI-powered". Título factual vence.
2. Não admitir o risco no primeiro parágrafo — o HN fareja omissão de segurança em segundos.
3. Responder crítica de segurança na defensiva (§9).
4. Landing page em vez de repositório.
5. Postar e sumir: é preciso estar disponível nas primeiras 3–4 horas.
6. **Citar um número que um comentarista consegue refutar em 5 minutos.** Ver §9.2 e §10.

**Título proposto:**

> `Show HN: Acesse seu agente de código DSH pelo celular sem alargar o bind de loopback`

### 7.4 Reddit — regras **NÃO CONFIRMADAS**

A pesquisa **não conseguiu** ler as regras oficiais de `r/programming`, `r/node` e `r/selfhosted`
(403 em todas as rotas, inclusive `/about/rules.json` e `old.reddit.com`), nem a Reddiquette
(403 também).

**Portanto:** antes de qualquer post, **um humano logado abre a barra lateral de cada subreddit e
lê as regras**. Não postar por suposição. O padrão conhecido na maioria dos subs técnicos — a
**confirmar**, não assumir — é: histórico de participação antes de autopromoção, flair correto e
declaração de autoria no corpo do post.

`r/selfhosted` é o público mais alinhado (gente que roda serviço em casa e entende túnel).
`r/node` é secundário e só faz sentido com ângulo técnico (supervisão de subprocesso, tree-kill
por grupo de processos, `ctx.effect` e disposers LIFO).

### 7.5 dev.to

Ângulo: **não anunciar, ensinar.** Artigo do tipo *"O que eu aprendi tentando expor um agente de
código à internet com segurança"*, com os números verificados (honeypots comprometidos em 24h;
s1ngularity; CVE-2025-53773) e o plugin como conclusão natural.

**NÃO CONFIRMADO:** o Code of Conduct do dev.to não tem seção sobre autopromoção. Assumir a
convenção geral: declarar autoria, uma publicação por assunto, `canonical_url` apontando para o
repositório se houver duplicata.

### 7.6 Bluesky / X

Thread curta com o GIF como primeiro post — o GIF é o conteúdo, o texto é legenda. Sem hashtag
inflada, sem foguete. Uma pergunta no fim convida resposta melhor que um call-to-action.

### 7.7 Discord / Telegram de comunidades

Existe um **Discord oficial do DeepSeek** linkado no README upstream (~27.961 membros, ~2.150
online na verificação). **Advertência operacional:** o convite verificado **expira em
2026-09-12** — não embutir esse link em documentação permanente sem revalidar. Postar no canal
apropriado (procurar `#showcase` ou equivalente), uma vez, sem repetir, e responder quem
perguntar.

### 7.8 Product Hunt (opcional)

Regras oficiais: lançamento recomendado às **12:01 AM Pacific**, mas *"the best day to launch is
the day on which you're most prepared"*; **proibido pedir upvote** (*"you cannot ask people
directly to upvote your product. Instead, ask them to visit and comment"*); contas de **empresa
são proibidas** (makers lançam de conta pessoal); relançamento permitido *"as often as you have
new significant product iterations available"*; plataforma 100% gratuita. Para um plugin de
nicho o ROI é duvidoso — só fazer se as fases anteriores mostraram tração.

---

## 8. Textos-modelo

### 8.1 Anúncio curto (Show HN / Discussions — ajustar o tom por canal)

```text
Rodo o DeepSeek Harness na workstation de casa. Toda vez que eu saía, o agente ficava
rodando e eu não tinha como acompanhar nem redirecionar. As opções eram alargar o bind
para 0.0.0.0 — que é exatamente o RCE não autenticado da discussão #853 do upstream — ou
não usar.

Este plugin faz o caminho do meio. O bind continua em 127.0.0.1; o plugin falha no load,
ruidosamente, se você tentar alargar. O que muda é que um cloudflared roda como processo
filho supervisionado na mesma máquina e leva o tráfego da borda da Cloudflare até o
loopback. A senha é gerada por CSPRNG (>=128 bits) e nunca trafega pelo Telegram — chat de
bot não é E2E, então o bot só carrega o comando e um token de confirmação opaco. Você liga
e desliga o túnel pelo bot, do celular.

O que eu NÃO estou dizendo: isto não é seguro por padrão só porque tem senha. Você está
expondo um agente com shell. A URL do túnel não deve ser tratada como credencial — ela vira
pública assim que qualquer scanner ou feed a vê (feeds públicos de análise de URL listam
hostnames *.trycloudflare.com de graça e sem autenticação; conferi). O TLS termina na
Cloudflare. Prompt injection contra o agente continua sendo risco aceito, não resolvido.
O modelo de ameaça está no README, antes da lista de features, de propósito.

Se você aceita instalar um cliente no celular, Tailscale é um modelo de segurança melhor
que este. Se você só quer autenticação no DSH e nada mais, existe o dsh-webui-auth, que faz
essa parte. Este plugin é para quem quer o fluxo montado e o botão de desligar no bolso.

MIT. Sou o autor. Feedback de segurança é o que eu mais quero.
```

**Por que este texto funciona:** admite o risco antes que perguntem, cita concorrentes por nome,
declara autoria, não usa superlativo, e a última linha convida exatamente a crítica que viria de
qualquer jeito — o que muda o tom da thread inteira. Note que a frase sobre a URL foi
**reescrita** em relação à versão anterior: diz "vira pública assim que um scanner a vê", não
"é enumerável" (§9.2).

### 8.2 Uma linha para a awesome-list

```text
Expõe a Web UI do DSH por um túnel Cloudflare efêmero sem alargar o bind de loopback:
autenticação sobre /api, fallback da SPA e handshake de WebSocket; senha gerada por CSPRNG;
liga/desliga pelo bot do Telegram.
```

Zero adjetivo. Cada afirmação é verificável no código — que é o critério da lista.

### 8.3 Bluesky / X

```text
Rodo um agente de código em casa e queria usar do celular sem abrir o bind pra 0.0.0.0.

Fiz um plugin: o bind continua em 127.0.0.1, o cloudflared roda como filho supervisionado,
a senha é gerada pela máquina, e o kill switch é um /desligar no Telegram.

O modelo de ameaça está no README antes das features. [GIF]
```

---

## 9. Playbook de resposta a críticas de segurança

**Postura:** as críticas vão vir, são majoritariamente **corretas**, e a resposta certa quase
nunca é "não, você está enganado". É *"sim, e aqui está o número, aqui está o que fizemos, e
aqui está o que continua em aberto"*. Cada resposta abaixo é factual e foi verificada; onde a
verificação falhou, a resposta diz isso.

### 9.1 "Você acabou de publicar um RCE-as-a-service"

Concordo com a categoria de risco: quem passa da senha executa comando no host, lê `~/.ssh`,
`.env` e tokens de nuvem. Por isso a senha tem ≥128 bits de CSPRNG e **não** é escolhida pelo
usuário, o túnel é efêmero e sob demanda, e existe o kill switch. Não estou vendendo isto como
seguro — estou dizendo que a alternativa que as pessoas de fato usam hoje é `--host 0.0.0.0`,
que é estritamente pior, e que a #853 documenta.

### 9.2 "A URL do túnel não é segredo" — **resposta corrigida**

Concordo com a conclusão, e o design **já** assume isso: a URL nunca é tratada como credencial;
a senha é o controle.

Sobre a evidência, sendo preciso — porque a versão anterior deste playbook exagerava e um
comentarista atento derrubaria:

- **Verdadeiro:** a API pública e sem autenticação do urlscan.io responde à consulta
  `page.domain:trycloudflare.com` com resultados reais contendo hostnames `*.trycloudflare.com`.
  Reproduzido duas vezes, em dias distintos.
- **Falso, e não repetir:** que os resultados sejam "todos do próprio dia". Na reprodução, os 100
  primeiros resultados espalhavam-se por **6 dias** (só ~21% eram do dia). A ordenação padrão não
  é por data.
- **Enganoso, e não repetir:** citar `total: 10000` como medida de volume. É o **teto** da API —
  a documentação diz que a busca *"will only indicate an exact count of results up to 10,000
  results in the total property"*.
- **Correção conceitual importante:** o urlscan **não enumera túneis vivos**. Ele indexa URLs que
  alguém **submeteu** com visibilidade pública — na amostra, ~96% via `method: api`, ou seja
  feeds automatizados de antiphishing (várias amostras eram phishing hospedado em quick tunnel).
  A formulação correta é **"o hostname vira público assim que qualquer scanner ou feed o vê"**,
  não "hostnames de quick tunnel são enumeráveis".
- **NÃO CONFIRMADO, e retirado do material público:** que buscadores indexem quick tunnels. A
  busca `site:trycloudflare.com` não reproduziu nenhum subdomínio aleatório; o caso citado antes
  não aparece no urlscan nem no Wayback, e o `robots.txt` daquele host na verdade contém linhas
  `Allow:` explícitas — ou seja, não era exemplo de "robots.txt não impede indexação".

O que **continua sustentado**: uma URL de quick tunnel exposta e viva foi encontrada e
respondia sem autenticação; e o princípio geral do Google Search Central de que `robots.txt`
*"is not a mechanism for keeping a web page out of Google"* é verdadeiro — só não é provado por
aquele caso.

### 9.3 "Quick tunnel não suporta SSE, isso quebra o streaming do LLM"

A documentação da Cloudflare diz literalmente *"Quick Tunnels do not support Server-Sent Events
(SSE)"* — a citação é real. Mas medi ao vivo e a frase é uma simplificação de um bug de
buffering específico de `GET`:

- `POST /v1/chat/completions` com `Accept: text/event-stream` → **streaming real**, eventos a
  0,47s / 0,97s / 1,47s / … (espaçamento idêntico ao da origem), `content-type: text/event-stream`,
  HTTP/2 200, reproduzido duas vezes;
- `GET /sse`, mesma origem e mesmo túnel → tudo bufferizado, entregue só no fechamento. Bate com
  [cloudflared#1449](https://github.com/cloudflare/cloudflared/issues/1449).

Streaming de token de LLM em API compatível com OpenAI/DeepSeek é `POST` — o caso que funciona.
E, neste projeto, a discussão é ainda mais vazia: o DSH já migrou o downlink de telemetria de SSE
para um **WebSocket dedicado**, e WebSocket passa normalmente.

Os limites reais do quick tunnel são outros e eu os documento: **200 requisições em voo** (429
acima disso), sem SLA, hostname novo a cada restart, e nenhuma camada de autenticação.

### 9.4 "Cloudflare vê seu código em texto claro"

Verdade, e é arquitetural: o TLS termina na borda deles — é o que permite WAF, Access e cache.
Não é E2E. Está no README como decisão consciente de modelo de confiança. Quem não aceita deve
usar Tailscale (WireGuard) ou SSH.

### 9.5 "Você fura o firewall do usuário"

Sim. A própria documentação da Cloudflare descreve: *"cloudflared initiates an outbound
connection through your firewall from the origin to the Cloudflare global network"*. Regras de
INPUT do ufw/iptables dão falsa sensação de segurança aqui. É por isso que o túnel é **opt-in
explícito**, efêmero, e o comando de desligar é de primeira classe.

### 9.6 "Bota MFA nisso"

Concordo, e o caminho existe. Precisão que **tem** que ser dita assim, porque o plano mudou de
posição e material público não pode ficar defasado (09 §D6):

- **O transporte de named tunnel está na v0.1.** `tunnel.mode: 'named'` é suportado, com o token
  entregue por `--token-file` (nunca por `--token` em argv, que vaza em `ps`). O que **não** existe
  é onboarding automatizado: conta, domínio e política de Access o usuário configura **fora** do
  plugin.
- **A validação do `Cf-Access-Jwt-Assertion` na origem (`kid`, `iss`, `aud`, `exp`) é roadmap
  v0.2.** Enquanto ela não existir, dizer "temos Access" não é resposta a "bota MFA nisso": Access
  sem validação na origem é bypass à espera de uma rota mal configurada.
- **A senha nunca sai de cena.** Não existe, e não vai existir, flag "tenho Access, dispensa senha".
  As camadas são cumulativas.

Ressalva honesta que continua valendo: **Access não funciona sobre quick tunnel** — exige
zona/domínio com DNS na Cloudflare. Portanto é o modo "quem tem domínio", documentado como o caminho
superior.

### 9.7 "`trycloudflare.com` tem reputação de malware"

Verdade, e vale citar antes que citem: desde 02/2024 há campanhas distribuindo AsyncRAT,
GuLoader, Remcos, VenomRAT e XWorm por quick tunnels descartáveis, e o ransomware Akira usa
`cloudflared` como mecanismo de persistência. Consequência prática, que documento no README:
**muitas redes corporativas bloqueiam o domínio** e o EDR da sua empresa pode sinalizar o
`cloudflared`. Não use isto em máquina corporativa sem falar com a segurança da sua empresa.

### 9.8 "E prompt injection?"

Não resolvido, e não tenho como resolver. Um levantamento de 78 estudos reporta >85% de sucesso
contra defesas estado-da-arte com estratégias adaptativas, com a maioria de 18 defesas avaliadas
abaixo de 50% de mitigação. O precedente concreto é o s1ngularity (Nx, 08/2025): o malware
**weaponizou os agentes já instalados** na máquina (`claude --dangerously-skip-permissions`,
`gemini --yolo`, `q chat --trust-all-tools`) e exfiltrou 2.349 credenciais de 1.079 máquinas. Há
também CVE-2025-53773 (Copilot), em que injeção via caracteres Unicode invisíveis fazia o agente
escrever `"chat.tools.autoApprove": true` na própria configuração.

Meu escopo é a **camada de acesso**; o agente por dentro continua sendo o agente. O que o plugin
promete é: recusar `danger-full-access`, não alargar o bind, e dar o botão de desligar.

### 9.9 "WebSocket sem validação de Origin"

Precedente exato e caro: code-server <4.10.1 (CVE-2023-26114, CVSS 9.3) e as extensões IDE do
Claude Code 0.2.116–1.0.23 (CVE-2025-52882), em que qualquer página web abria WebSocket para o
servidor local e lia arquivos arbitrários. É por isso que o `registerUpgrade` é interceptado — o
handshake passa pela **mesma** barreira que `/api`. Se você achar um bypass aí, é a issue que eu
mais quero receber: use o PVR (§3.3).

### 9.10 "O token do bot vaza tudo"

Parcialmente, e a formulação usual exagera. Quem tem o token personifica o bot, lê e **rouba** a
fila de updates (`getUpdates` confirmado apaga do servidor), e pode sequestrar por `setWebhook`.
O que **não** consegue diretamente, neste desenho, é disparar a ação destrutiva: as ações partem
de updates de **entrada**, o desenho usa long polling (não há endpoint de webhook forjável), e
*"bots will not be able to see messages from other bots regardless of mode"* — a mensagem que o
atacante envia como o bot não volta como update.

A ressalva honesta, que eu mesmo levanto: com o token, o atacante pode enviar **como o bot** um
inline keyboard cujo `callback_data` seja um comando destrutivo; se o **dono** clicar, o
`callback_query` chega com `from.id` da allowlist e passa. É um *confused deputy* que exige ação
do usuário legítimo — mitigado pela confirmação em duas etapas com token efêmero server-side e
TTL. Ainda assim: token vazado é incidente; rotacione com `/token` no BotFather.

### 9.11 Regras de conduta ao responder

1. **Nunca** "isso é fora de escopo" sem dizer qual é o escopo e por quê.
2. **Nunca** discutir se alguém está sendo rude. Responder o conteúdo técnico e parar.
3. Se a crítica achou bug real: agradecer publicamente, **abrir a issue você mesmo**, linkar na
   thread e corrigir. Converte crítico em usuário mais rápido que qualquer argumento.
4. Se você não sabe: *"não sei, vou medir e volto aqui"* — e voltar.
5. Nenhuma resposta pode contradizer o `SECURITY.md`. Se contradisser, o documento é que está
   errado, e a correção do documento vem antes da resposta.
6. **Se um número seu for refutado publicamente, corrija em público, no mesmo dia, e no
   `SECURITY.md`.** Foi o que fizemos internamente em §9.2 antes do lançamento.

---

## 10. Ética

- **Autoria declarada em todo post**, sem exceção: "Sou o autor", na primeira linha ou no
  primeiro parágrafo.
- **Zero astroturfing.** Nenhuma conta secundária, nenhum comentário plantado, nenhum pedido de
  upvote — explicitamente proibido no HN e no Product Hunt, e detectado nos dois.
- **Zero inflação de número.** A awesome-list verifica cada número da descrição contra o código.
  Medição de uma máquina se declara como tal ("medido em uma máquina, Linux 6.18, Node 24").
- **Regra do lastro (nova, e a mais importante).** Nenhum número vai a material público sem
  constar de um *ledger* de verificação com: a alegação, o comando/URL que a produz, a data, e o
  veredito. A pesquisa desta rodada **refutou três alegações** que já estavam escritas neste
  documento como fato (§3.2, §9.2, e a leitura do `robots.txt`). Se acontece na pesquisa interna,
  acontece no anúncio. O ledger fica em `docs/plano/08-PESQUISA-E-FONTES.md` e cada afirmação do
  README aponta para uma linha dele.
- **Nenhum número de terceiro sem verificação.** Especificamente: a tabela de benchmark do
  `jcode` e o pacote `pi2dsh`, que circulam em fontes terceiras, **não foram confirmados** por
  nenhuma fonte primária — **proibido** citar em divulgação.
- **Nada de "produção-ready" ou "enterprise-grade".** O quick tunnel é declaradamente de
  desenvolvimento pela própria Cloudflare; dizer o contrário é mentir.
- **Screenshots e GIFs com dados descartáveis**, com rotação de todo segredo que apareceu em tela.
- **Não usar a #853 como marketing agressivo.** Citar como contexto e motivação, com link, sem
  linguagem de FUD contra o upstream — que é MIT, tem 166k estrelas e é a plataforma da qual este
  plugin depende.

---

## 11. Métricas de adoção

### 11.1 Calibração — o que é sucesso de verdade

Do `plugins.json` inteiro da awesome-list: **mediana de 2 estrelas** por plugin, p90 = 15,
p99 = 710. Apenas 38% publicam no npm; entre esses, a mediana é **514 downloads/semana**.

| Métrica | 30 dias — realista | 90 dias — bom | Referência |
| --- | --- | --- | --- |
| Estrelas | 15 | 50 | 15 já é o p90 do ecossistema |
| Downloads npm/semana | 100 | 500 | 500 ≈ mediana dos que publicam |
| Issues de terceiros | 3 | 15 | sinal de uso real, não de vaidade |
| Instalações via `dsh-market` | — | — | **NÃO CONFIRMADO** se o market expõe esse número |

Metas maiores que isso são fantasia e levam a decisões ruins: postar demais, exagerar na
descrição, brigar em thread.

### 11.2 Como medir, concretamente

- **Downloads npm:** `GET https://api.npmjs.org/downloads/point/last-week/dsh-guarded-bot-orchestrator`
  e `.../downloads/range/YYYY-MM-DD:YYYY-MM-DD/…`. Limites: 18 meses de histórico, dados desde
  2015-01-10, lote até 128 pacotes e 365 dias **sem suporte a pacotes scoped**, dados por versão
  só dos últimos 7 dias (`https://api.npmjs.org/versions/{pkg}/last-week`). Processamento diário
  logo após a meia-noite UTC — não medir antes disso.
- **Badge:** shields.io, padrão `/badges/npm-downloads/:interval/:packageName`, com
  `:interval ∈ {dw, dm, dy, d18m}`.
- **Estrelas / tráfego:** GitHub → Insights → Traffic (retenção de **14 dias** — exportar
  semanalmente ou o dado some).
- **Painel:** um script agendado que grava `data/metrics.csv` semanal (data, estrelas,
  downloads-semana, issues abertas/fechadas, PRs). Sete linhas de dado valem mais que qualquer
  dashboard.

### 11.3 O que **não** medir

Impressões, upvotes, "engajamento". A única métrica que importa: **alguém instalou e continuou
usando na semana seguinte** — proxy: downloads npm não decaindo depois do pico do dia 0.
Lembrando que ~92% do impacto de um Show HN ocorre em 48h; o que sobra na semana 2 é o número
real.

---

## 12. Feedback: triagem, roadmap, decisões

### 12.1 Labels de issue (criar na onda C1)

| Label | Significado | SLA |
| --- | --- | --- |
| `security` | Qualquer suspeita de bypass | Resposta em 24h; nunca fica sem resposta |
| `bug` | Comportamento diverge do documentado | 72h |
| `install` | Falha no caminho de instalação/onboarding | 72h — maior fonte de abandono |
| `compat` | Quebra com uma rc nova do DSH | 72 h; rodar o `dsh-compat.yml` e regenerar `docs/COMPATIBILITY.md` na mesma resposta (o arquivo é gerado, não editado) |
| `docs` | README/docs erradas ou incompletas | 1 semana |
| `good first issue` | Escopo fechado, ≤50 linhas, com arquivo e linha apontados | — |
| `help wanted` | Precisa de hardware/SO que eu não tenho (macOS, Windows) | — |
| `wontfix-by-design` | Fora do modelo de ameaça | Resposta com o **porquê** + link para `SECURITY.md` |

### 12.2 Roadmap público

`ROADMAP.md` no repositório — não GitHub Projects: mais fácil de ler, versionado e diffável — com
três seções: **Agora**, **Próximo**, **Não vamos fazer**. A terceira é a mais valiosa: evita
issue repetida e sinaliza escopo.

Candidatos a "Não vamos fazer": multiusuário/RBAC; substituir o Sandbox do DSH; suporte a Windows
sem alguém que use Windows aparecer (`help wanted`); interface web de administração própria (mais
superfície — exatamente o que se está tentando reduzir).

Candidatos a "Próximo", com valor de sinalização: **validação do JWT do Cloudflare Access na
origem** e onboarding automatizado de named tunnel (§9.6 — o **transporte** named já está na v0.1,
então o roadmap não pode prometer o que já foi entregue nem entregar o que ainda não foi);
detecção automática de ordem de carregamento errada no instalador.

### 12.3 Regra de triagem

Toda issue recebe **primeira resposta** dentro do SLA, mesmo que seja "recebi, olho na sexta".
Silêncio mata projeto de mantenedor único mais rápido que bug.

---

## 13. Manutenção: como não abandonar

O padrão de morte de plugin OSS é conhecido: lançamento, pico, três issues sem resposta, repo
morto em quatro meses. Contramedidas, todas baratas:

1. **SLA declarado e honesto** no README/CONTRIBUTING: *"Projeto de uma pessoa. Segurança:
   resposta em 24h. Demais: até 1 semana. Se eu ficar 30 dias sem responder, considere o projeto
   sem manutenção e faça fork — a licença MIT permite."* Prometer menos e cumprir vale mais que
   prometer suporte que não existe.
2. **`good first issue` de verdade** — não "melhorar docs". Escopo fechado, arquivo e linha
   apontados, critério de aceite escrito. Preparar **três** antes do lançamento público: o pico
   de tráfego é a única janela em que aparecem contribuidores.
3. **Co-mantenedor a partir de 2 PRs merged.** Convite explícito e escalonado (`triage` primeiro,
   `write` depois). Projeto de segurança com bus factor 1 é risco que os usuários herdam.
4. **CI que não apodrece:** Renovate ou Dependabot desde o dia 0, actions pinadas por SHA (também
   pontua em `Pinned-Dependencies` do OpenSSF Scorecard), matriz de Node canônica (09 §D12):
   `ubuntu-latest` × 24, `ubuntu-latest` × 26 e `macos-latest` × 24 — **Node 22 fora**, porque o
   pacote declara `engines: node >=24` e testar abaixo disso é ruído, não cobertura.
5. **Fixar a versão do DSH nos testes.** Todo o ecossistema está em `0.0.1-rc`/`0.1.0-rc` e o
   README upstream avisa *"developer preview, expect breaking changes"*. Declarar no README contra
   qual versão exata o plugin foi testado. Plugin que quebra em silêncio na próxima rc é pior que
   plugin que declara incompatibilidade.
6. **Ritual mensal de 30 minutos (§13.6):** triagem, atualização de deps e **execução do workflow
   `dsh-compat.yml`** — nunca edição manual de `docs/COMPATIBILITY.md`, que é arquivo **gerado**.
   Agendado. Trinta minutos por mês mantêm um projeto vivo por anos.
7. **Critério de arquivamento honesto.** Se o projeto deixar de ser mantido: arquivar com um
   README explicando por quê e apontando alternativas. Repo abandonado e "vivo" é pior que repo
   arquivado — especialmente em segurança.

### 13.6 O ritual mensal, passo a passo

Esta subseção existe porque **três outros pontos deste documento a citam pelo número** (§4.3, §12.3
e o item 6 acima) e ela não existia — link interno quebrado num documento cuja regra nº 1 é não
afirmar o que não se sustenta.

Trinta minutos, uma vez por mês, na mesma data. Nesta ordem:

| # | Passo | Como se verifica que foi feito |
| --- | --- | --- |
| 1 | Triagem das issues abertas por rótulo (§12.1), respondendo primeiro `security`, depois `compat` | Nenhuma issue `security` sem resposta; nenhuma issue com mais de 30 dias sem rótulo |
| 2 | Revisar os PRs do Renovate/Dependabot; `@deepseek-ai/*` **nunca** entra por automerge | Fila de PRs de bump vazia ou com decisão escrita |
| 3 | **Disparar o workflow `dsh-compat.yml`** contra as rc correntes do DSH | Run verde, ou issue `upstream-break` aberta |
| 4 | **Regenerar** `docs/COMPATIBILITY.md` a partir do resultado do passo 3, por `scripts/gen-compat-table.mjs` | `git diff` mostra só o arquivo gerado; **editar esse arquivo à mão é violação** (09 §D5) |
| 5 | Conferir o painel de métricas (§11.2) e anotar a leitura do mês | Linha nova em `data/metrics.csv` |
| 6 | Reler `docs/PROIBIDO.md` antes de escrever qualquer coisa pública no mês | — |
| 7 | Se passaram 30 dias sem resposta a ninguém, aplicar o item 7 acima (arquivar ou pedir ajuda) | — |

Este ritual é **pós-Onda 7** e não é tarefa de agente: é o que substitui a antiga "onda C9" e a
"onda R4" de `06-REPO-E-CI.md` §12 (09 §D20).

---

## 14. Itens **NÃO CONFIRMADOS** (proibidos como fato em material público)

| Item | Status |
| --- | --- |
| Regras oficiais de `r/programming`, `r/node`, `r/selfhosted` e a Reddiquette | **NÃO CONFIRMADO** — 403 em todas as rotas, inclusive `/about/rules.json`. Um humano logado precisa ler antes de postar |
| Política de autopromoção do dev.to | **NÃO CONFIRMADO** — não existe seção sobre isso no Code of Conduct |
| Percentis de Show HN (mediana 2 pontos, 50 = top 6%, 1,4★/upvote, janela de segunda 00:00 UTC) | **NÃO CONFIRMADO** por fonte pública — o estudo citado estava inacessível. Usar como ordem de grandeza, nunca como número citável |
| Indexação de quick tunnels por motores de busca | **NÃO CONFIRMADO / não reproduzível** — ver §9.2. Retirado do anúncio |
| Limite de 50 usuários do Zero Trust free da Cloudflare | **NÃO CONFIRMADO** — só em fontes terceiras e num PDF de pricing de Q4/2022; as páginas oficiais atuais não citam o número |
| Limites do free tier do ngrok (1GB/mês, 3 endpoints) e portas do Tailscale Funnel (443/8443/10000) | **Fonte terceira**, não oficial. Citar como "reportado", nunca como fato |
| Se o `dsh-market` expõe contagem de instalações | **NÃO CONFIRMADO** |
| Comportamento de `dsh plugin add` com `"dsh": { "bundle": {} }` | **NÃO CONFIRMADO** — passa o CI da awesome-list (código lido), mas o efeito na instalação real não foi testado (§3.2) |
| Benchmarks do `jcode` e o pacote `pi2dsh` | **NÃO CONFIRMADO** por nenhuma fonte primária — **proibido** citar |
| Convite do Discord oficial do DeepSeek | Verificado em 19/08/2026, mas **expira em 2026-09-12** — revalidar antes de embutir em doc permanente |
| **"Zero dependências de runtime"** | **PROIBIDO como afirmação** (09 §D23). São **uma**: `grammy`, versão exata, carregada só pelo processo do worker. A frase saiu do README e de todo material público. O argumento honesto — e mais forte, porque é verificável — é "uma dependência de runtime, sem transitivas de rede além do `fetch` nativo" |
| **Estilo de botão do Telegram** (`InlineKeyboardButton.style`, valores `success`/`danger`/`primary`) | **NÃO CONFIRMADO** — entrou no plano como fato de confiança "Alta" sem verificação contra a referência da Bot API. Não pode aparecer em GIF, screenshot legendado, post ou doc como recurso do produto até o spike da Onda 0 fechar |
| **Números absolutos de estrelas** (da awesome-list ou de qualquer repo) | **Proibido em material público como número absoluto.** Usa-se a forma "~10 mil ★, medido em `<data>`", e existe **uma** linha de medição no ledger de `08-PESQUISA-E-FONTES.md` §6 (09 §D24 item 5). Número sem data envelhece e passa a mentir — é a regra do lastro (§10) aplicada a nós mesmos |
| **"Access protege o quick tunnel"** | **Falso e proibido.** Access exige zona/domínio; sobre quick tunnel **toda** a autenticação é da aplicação. Este é um **fato de confiança alta** com documentação da Cloudflare (09 §D24 item 1) — pode ser afirmado na forma negativa acima, nunca na positiva |
| **"O plugin valida o JWT do Cloudflare Access"** | **Falso na v0.1.** O transporte named tunnel está na v0.1; a **validação** do `Cf-Access-Jwt-Assertion` é roadmap v0.2 (§9.6, 09 §D6). Anunciar validação que não existe é o tipo de afirmação que destrói a credibilidade de um projeto de segurança em um comentário |

---

## 15. Definition of Done da onda de comunidade

- [ ] B0–B6 resolvidos (§3), com B0 provado por build verde contra os pacotes reais
- [ ] Todos os artefatos de §4 com critério de aceite cumprido
- [ ] Alpha concluída sem item em aberto (§6.1)
- [ ] Opção de B1 escolhida **após teste local**, não por dedução (§3.2)
- [ ] PR na `awesome-dsh-plugin` merged e entrada visível em `plugins.json`
- [ ] Beta ≥2 semanas sem regressão, SLA cumprido (§6.2)
- [ ] Playbook de §9 revisado por alguém que **não** é o autor
- [ ] Três `good first issue` preparadas e escritas
- [ ] `data/metrics.csv` com a primeira linha coletada
- [ ] Ledger de verificação (§10) fechado: **nenhuma** afirmação de material público sem linha
      correspondente, e **nenhuma** afirmação da tabela §14 em qualquer texto publicado
- [ ] `docs/PROIBIDO.md` existe **no caminho canônico** (não em `docs/divulgacao/`) e contém a
      tabela §14 na íntegra
- [ ] Todo link para documentação usa os nomes canônicos de 09 §D5 (`ONBOARDING-TELEGRAM.md`,
      `THREAT-MODEL.md`, `EXPOSURE.md`, `TUNNEL.md`, `TROUBLESHOOTING.md`, `COMPATIBILITY.md`);
      um link-checker roda no CI e nenhum aponta para os nomes antigos
- [ ] Nenhum texto público diz "zero dependências de runtime", promete validação de JWT do Access,
      ou cita número absoluto de estrelas sem data

> **Onde esta DoD é cobrada.** Os itens que dependem só de artefato (§4, docs, `PROIBIDO.md`,
> ledger, `good first issue`) são cobrados no aceite de **T7.3/T7.4** da Onda 7. Os que dependem de
> terceiros (Alpha, PR na awesome-list, Beta de 2 semanas) são **pós-Onda 7** e não podem constar de
> critério de aceite de onda nenhuma — nenhum gate de CI sabe avaliar "três pessoas instalaram"
> (§5, 09 §D20).
