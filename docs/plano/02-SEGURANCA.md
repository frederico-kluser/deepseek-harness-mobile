# 02 — Segurança: modelo de ameaças e controles

> **Escopo deste arquivo.** Este é o documento normativo de segurança do plugin
> `dsh-guarded-bot-orchestrator` na sua nova missão: guiar o onboarding do Telegram,
> abrir um túnel Cloudflare para o DeepSeek Harness (DSH) e permitir ligar/desligar o
> servidor pelo bot e pela UI. Os outros arquivos do plano (`01-ARQUITETURA.md`,
> `03-ONDAS.md`, `04-TESTES.md`) **dependem** deste: nenhuma onda pode ser considerada
> concluída se violar uma invariante declarada aqui.
>
> **Regra de citação usada neste arquivo.** Toda afirmação factual traz fonte. Quando a
> pesquisa não conseguiu confirmar algo, está escrito **NÃO CONFIRMADO** em maiúsculas,
> no lugar exato. Quando uma afirmação que circulava sobre este projeto foi **refutada**
> por verificação empírica, ela está na §12 (Errata) e **não pode ser reintroduzida** em
> nenhum arquivo do plano nem em comentário de código.

---

## Índice

| § | Assunto |
|---|---|
| 0 | A tensão central, dita de frente |
| 1 | Por que este alvo vale muito |
| 2 | Modelo de ameaças (tabela principal + notas) |
| 3 | Camadas de defesa, em ordem, com o que cada uma NÃO pega |
| 4 | Geração, armazenamento, rotação e entrega da senha |
| 5 | A pergunta incômoda: é seguro mandar a senha pelo Telegram? |
| 6 | Força bruta: rate limit, backoff, lockout, alerta |
| 7 | Allowlist de `chat_id`: o controle crítico do canal de comando |
| 8 | Higiene de segredos |
| 9 | Modos de falha — todos DEVEM ser fail-safe |
| 10 | Checklist de aceite (o revisor usa isto) |
| 11 | Risco residual — o que continua perigoso |
| 12 | Errata: afirmações refutadas que NÃO podem ser usadas |
| 13 | Fontes, com grau de confiança |

---

## 0. A tensão central, dita de frente

O plugin que já existe em `src/index.ts` (1836 linhas) foi construído com **uma tese
única**: o plano de controle do DSH não pode sair de `127.0.0.1`. Ele implementa isso com
quatro invariantes:

| # | Invariante | Onde está hoje |
|---|---|---|
| I1 | Bind travado em loopback, com `throw` no `apply()` se o host for wildcard ou não estiver na allowlist | `assertSecureBind()` (src/index.ts:1311) |
| I2 | Origem do socket precisa estar em `trustedRemotes`; lista vazia nega tudo (fail-closed) | `isTrustedRemote()` (src/index.ts:244) |
| I3 | Credencial obrigatória em `/api`, no fallback da Web UI e no handshake de WebSocket | `verifyBasicAuth()`, `createGuardedHandler()`, `createGuardedUpgradeHandler()` |
| I4 | Veto de elevação para `danger-full-access` | ouvinte `security/permission-elevate` (src/index.ts:1678) |

O pedido novo é o **oposto declarado** de I1 e I2: publicar essa mesma UI na internet.
Fingir que não há conflito produziria um plano perigoso. Então vamos nomear o conflito.

### 0.1. O que sobrevive intacto: o bind

`cloudflared` **não precisa** que o DSH escute em `0.0.0.0`. Ele roda na mesma máquina e
faz uma conexão de **saída** para a borda da Cloudflare, entregando o tráfego em
`http://127.0.0.1:3080`. Documentação oficial, texto literal:

> "cloudflared initiates an outbound connection through your firewall from the origin to
> the Cloudflare global network"
> — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/>

Consequência: **I1 permanece exatamente como está**. `assertSecureBind()` não muda uma
linha. `allowedHosts: ['127.0.0.1']` continua sendo a configuração correta, e continua
sendo motivo de recusa de boot. Isto é uma vitória de desenho, não um acidente: o túnel é
o único componente que fala com a internet, e ele fala por fora do servidor.

### 0.2. O que morre como controle: a allowlist de origem

`trustedRemotes` compara `req.socket.remoteAddress`. Com o túnel ativo, **todo** tráfego
— o seu do celular, e o do varredor que achou a URL — chega ao DSH com
`remoteAddress = 127.0.0.1`, porque quem abre o socket é o `cloudflared` local.

> **I2 deixa de discriminar qualquer coisa no momento em que o túnel sobe.**
> Ela não fica "mais fraca". Ela fica **inerte**: passa a aprovar 100% do tráfego que
> chega, incluindo o hostil.

Isto tem que estar escrito no README, no log de arranque em modo túnel e no comentário da
função. Um controle inerte que *parece* ativo é pior que um controle ausente, porque
consome o orçamento de atenção do operador.

**Correção desta revisão — o "valor residual" de `trustedRemotes` era ficção.** A versão
anterior deste documento dizia que ele "ainda impede que outro host da LAN fale direto com
a porta 3080". **Não impede, e nunca impediu:** com `assertSecureBind` travando o bind em
`127.0.0.1` (L2), nenhum host da LAN consegue **sequer abrir o socket** — a conexão morre
no kernel, muito antes de `isTrustedRemote` rodar. `trustedRemotes` é código morto em
**todos** os modos. Ele fica no repositório por dois motivos honestos e nenhum a mais:
(a) é a rede de segurança caso alguém, um dia, altere o bind; (b) apagá-lo seria uma
regressão de endurecimento sem ganho. **Nenhuma mensagem, log, README ou linha deste plano
pode listá-lo como proteção contra nada.** Manter a narrativa de "higiene de rede local"
reintroduziria exatamente o "controle inerte que parece ativo" que esta seção condena.

**Inventário obrigatório: todos os pontos do plano que usavam "origem loopback" como prova
de presença local.** Cada um foi corrigido; a lista fica aqui para que nenhum volte.

| Ponto | O que assumia | O que virou |
| ----- | ------------- | ----------- |
| `/__gate/secret` (§4.4, caminho 2) | "acessível só de loopback" ⇒ só quem está na máquina vê | **Rota morta.** Substituída por `/__guard/secret` travada por **token de uso único impresso no stdout do terminal** — prova de posse do terminal, não de origem. Ver §4.4 |
| **Modo restrito** (§6.1) | "passa a aceitar só de loopback" | Impossível de implementar: o gate não distingue os dois. Redesenhado em §6.1 sem depender de origem |
| **T9 / L3** (§2.1, §3) | `trustedRemotes` "ainda funciona" contra o vizinho de LAN | Quem protege T9 é **L2 (o bind)**, sozinho. L3 não participa |
| **Log de auditoria** (§L8) | `ip_normalizado` tem valor forense | Sob túnel é sempre `127.0.0.1`. Campo mantido, valor declarado inútil no Modo A (§6.1) |
| **Rate limit por IP** (§6.1) | contadores por IP discriminam clientes | Inaplicável no Modo A. Política reescrita em §6.1 |

### 0.3. O que deixa de valer: o firewall do usuário

Regras de INPUT (`ufw`, `iptables -A INPUT`) não veem nada do que o túnel faz, porque o
túnel é tráfego de saída. Um usuário que rodou `ufw default deny incoming` vai continuar
achando que está protegido. **Ele não está.** Isto vai no onboarding, em texto explícito,
antes de abrir o primeiro túnel.

### 0.4. A resolução: o gate de credencial deixa de ser defesa em profundidade e vira a defesa

Hoje, no desenho loopback-only, o Basic Auth é a segunda barreira depois de I1+I2. Em
modo túnel ele é **a primeira e essencialmente a única** barreira do lado da aplicação —
com Cloudflare Access na frente **apenas no Modo B** (§3, L0). Isso reclassifica a
credencial: ela deixa de poder ser `ADMIN_USER`/`ADMIN_PASS` escolhidos por humano
(que é o que o `cordis.patch.yml` atual faz, linha 238) e passa a ser um segredo gerado
por CSPRNG com ≥128 bits (§4).

### 0.5. Dois modos, com posturas de segurança diferentes e rotuladas

O plano **não** oferece um modo só. Oferece dois, e o bot diz qual está ativo em toda
mensagem de status:

| | **Modo A — Quick tunnel** | **Modo B — Named tunnel + Access** |
|---|---|---|
| Pré-requisito | nenhum (sem conta Cloudflare) | conta Cloudflare + domínio com DNS na Cloudflare |
| Hostname | aleatório, muda a cada restart | estável, seu domínio |
| Auth na borda | **nenhuma** | Cloudflare Access (One-time PIN por e-mail) |
| Auth na aplicação | obrigatória (única barreira) | obrigatória (segunda barreira) |
| TTL do túnel | **obrigatório**, default 60 min | opcional |
| Uso recomendado | sessão pontual, "preciso agora" | uso recorrente |
| Postura | aceitável com disciplina | recomendada |

O detalhe que fecha a questão e que precisa estar no plano desde o dia zero:
**Cloudflare Access não pode ser colocado na frente de um quick tunnel**, porque uma
política de Access se prende a uma aplicação com `zone_id`/domínio administrado na
Cloudflare (<https://developers.cloudflare.com/cloudflare-one/policies/access/>). Logo,
no Modo A **toda** a autenticação está dentro da sua aplicação. Não há rede de proteção.

E a própria Cloudflare é explícita sobre o Modo A (texto literal, página atualizada em
2026-04-20):

> "Quick Tunnels are intended for testing and development only. For production use,
> create a remotely-managed tunnel."
> "We don't guarantee any SLA or uptime of TryCloudflare"
> — <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>

Limite operacional confirmado na mesma página: **200 requisições em voo**, acima disso
HTTP 429. Para um usuário só, com um navegador, isso não é um problema prático — mas
entra no plano como motivo para não recomendar Modo A permanentemente.

---

## 1. Por que este alvo vale muito

Um agente de código exposto **não é um site**. É, por construção, **RCE-as-a-service**:
quem passa da senha executa comandos no host, com o UID do usuário. O que está atrás
dessa senha:

| Ativo | Por que o atacante quer | Onde está na máquina |
|---|---|---|
| Shell com UID do usuário | pivô, persistência, mineração, ransomware | o próprio agente executa comandos |
| Chave de API do LLM | revenda imediata via reverse proxy (LLMjacking) | `.env`, keychain, config do DSH |
| Código-fonte privado | espionagem, extorsão | o workspace inteiro |
| Credenciais de nuvem | escalada para a conta AWS/GCP | `~/.aws`, `~/.config/gcloud` |
| Chaves SSH e tokens do GitHub | supply chain para os repositórios do usuário | `~/.ssh`, `~/.config/gh` |
| Carteiras cripto | roubo direto | `~/.ethereum`, `keystore`, `wallet` |

### 1.1. Já aconteceu, com agentes de código, com estas mesmas flags

No ataque de supply chain **"s1ngularity"** ao pacote `nx` (26/08/2025), o malware não
escreveu um stealer próprio: ele **weaponizou os agentes de código já instalados na
máquina**, invocando-os com as flags que desligam as travas —
`claude --dangerously-skip-permissions -p [PROMPT]`, `gemini --yolo -p [PROMPT]`,
`q chat --trust-all-tools --no-interactive [PROMPT]`. O prompt mandava varrer `$HOME`,
`.config`, `.ethereum`, `/etc` atrás de `.env`, `id_rsa`, `keystore`, `wallet`, `*.key`,
`secrets.json`. Resultado: **2.349 credenciais de 1.079 máquinas, mais de 1.000 tokens
GitHub válidos, ~20.000 arquivos**, exfiltrados para mais de 1.400 repositórios
`s1ngularity-repository`.
*(Fonte: dossiê de pesquisa, §riscos-expor-agente — sem URL primária verificada no dossiê;
tratar o número exato como reportado, não como medido por nós.)*

A lição não é "cuidado com npm". É: **o agente é a arma preferida do atacante porque já
tem todas as permissões que ele quer.** Nós vamos publicar um agente na internet.

### 1.2. Precedentes exatos da nossa categoria de produto

| Produto exposto | O que aconteceu |
|---|---|
| Jupyter Notebook | Campanha **Qubitstrike** (rootkit + roubo de credenciais AWS/GCP) e **Panamorfi** (DDoS via `mineping.jar`, C2 em canal do Discord), ambas atacando exclusivamente notebooks expostos e mal configurados — <https://www.aquasec.com/blog/panamorfi-a-new-discord-ddos-campaign/> |
| Ollama | Cisco encontrou 1.139 endpoints no Shodan em 10 minutos; 214 respondiam **sem autenticação**. CVE-2024-37032 ("Probllama") dá RCE não autenticado; instalações Docker eram piores porque a API sobe como root e faz bind em todas as interfaces |
| code-server | CVE-2023-26114, **CVSS 9.3**: WebSocket sem validação de `Origin` em versões < 4.10.1 |
| Claude Code IDE extension | CVE-2025-52882 (0.2.116–1.0.23): qualquer página web maliciosa abria WebSocket para o servidor local da extensão e lia arquivos arbitrários |
| GitHub Copilot | CVE-2025-53773: injeção escondida em caracteres Unicode invisíveis faz o agente escrever `"chat.tools.autoApprove": true` no próprio `.vscode/settings.json` — **auto-elevação de privilégio editando a própria config**, culminando em RCE |
| ComfyUI | Campanha ativa (Censys, abr/2026) com scanner de 500 conexões concorrentes rodando **a cada 3–4 horas** sobre AWS/GCP/Oracle: 105.210 IPs por ciclo, 624 instâncias vivas, 214 vulneráveis, **97 exploits bem-sucedidos** |
| DeepSeek (a própria) | ClickHouse público em `oauth2callback.deepseek.com:9000` com >1M linhas de log, histórico de chat e secret keys (Wiz, jan/2025) |

*(CVEs e campanhas acima: dossiê §riscos-expor-agente. As CVE-IDs são verificáveis no NVD;
os números de campanha vêm dos relatórios citados no dossiê, sem re-verificação nossa.)*

O padrão CWE-1385 (WebSocket sem validação de `Origin`) aparece **duas vezes** nessa
lista, nos dois produtos mais parecidos com o nosso. É por isso que
`createGuardedUpgradeHandler()` — que já existe no plugin e guarda o handshake **inteiro,
sem olhar `guardedPrefixes`** — é uma das peças que o plano proíbe de tocar.

### 1.3. Você tem horas, não semanas

| Medição | Número | Fonte |
|---|---|---|
| Honeypots comprometidos em 24h | 80% (100% em uma semana) | Unit 42, 320 honeypots, jul–ago/2021 |
| Honeypots Postgres tomados por um único ator | 96% de 80, em **~30 segundos** | Unit 42 |
| IPs atacantes que aparecem em um único dia | 85% — **bloquear por IP é inútil** | Unit 42 |
| Varredura completa do espaço IPv4 | **< 45 minutos** | Palo Alto / Cortex Xpanse |
| Varredura por CVE nova | ~15 minutos após publicação | Palo Alto / Cortex Xpanse |
| Detecção de serviço novo pelo Censys | média 12,3h / mediana 5,7h (Shodan: ~76,5h) | Censys |

*(Todos do dossiê §riscos-expor-agente; sem URL primária no dossiê para os números da
Unit 42 e do Censys. Trate como ordem de grandeza confiável, não como medição nossa.)*

Nada disso depende de você "ser importante". Depende de a porta existir.

### 1.4. A vulnerabilidade que este plugin fecha — e que o túnel reabre se errarmos

A discussão oficial **#853** do repositório do DSH
(<https://github.com/deepseek-ai/deepseek-harness/discussions/853>) é um relatório público
de RCE **não autenticado** no plano de controle da Web UI, verificado em `0.1.0-rc.6`: a
sub-estação `/api` responde a sockets sem credencial nenhuma, e entre suas mais de 60
rotas RPC está `commands/execute`. A discussão **#1769** documenta que o sandbox `bwrap`
em modo `workspace-write` é **escapável** via `mount -o remount,rw`, com escritas
persistindo no filesystem do host. A **#3144** documenta que negações de sandbox ficam
**invisíveis para o modelo** quando o programa confinado reescreve o erro do kernel.

Conclusão operacional, que atravessa o documento inteiro:

> **O sandbox do DSH não é uma fronteira de segurança neste plano.** Ele é redução de
> ruído. A fronteira é a credencial. Se a credencial cair, o sandbox não segura.

---

## 2. Modelo de ameaças

### 2.1. Tabela principal

Ordem: da ameaça mais provável para a menos provável. "Controle" aponta para a camada da §3.

| # | Ator | Capacidade | Ativo alvo | Vetor | Impacto | Controle |
|---|---|---|---|---|---|---|
| T1 | **Varredor automatizado** (botnet, scanner comercial, feed de segurança) | zero conhecimento prévio; enumeração e feeds públicos; volume industrial | a URL do túnel | `page.domain:trycloudflare.com` no urlscan.io; DNS como oráculo de liveness; crawlers de feeds antiphishing | descobre que existe um serviço vivo; tenta credencial default e CVEs conhecidas | L4 (credencial CSPRNG), L5 (rate limit), L1 (TTL do túnel) |
| T2 | **Quem descobre a URL** (vazou de um print, de um log, de um feed, de um histórico de navegador) | consegue falar HTTP com o DSH | Web UI + `/api` + WebSocket | requisição direta ao hostname | **nenhum**, se e somente se L4 estiver correto; **total** se L4 falhar | L4, L5, L0 (Modo B), L8 (alerta) |
| T3 | **Prompt injection** via conteúdo lido pelo agente (README de dependência, issue, página web, resposta de API) | escreve texto que o agente lê como instrução | o agente, de dentro | o agente lê conteúdo hostil durante trabalho legítimo | exfiltração de segredos, auto-elevação de permissão, escrita em config | L7 (veto de elevação), L6 (confirmação humana), **e nada mais — ver §2.4** |
| T4 | **Atacante que compromete o bot do Telegram** = alguém que consegue enviar update com `from.id` da allowlist (conta do dono tomada, SIM swap, sessão roubada) | fala como o dono no canal de comando | ligar/desligar servidor, abrir túnel, emitir link de acesso | mensagem/botão legítimo no chat | controle do ciclo de vida do serviço e emissão de credencial de acesso | L6 (allowlist `from.id` **e** `chat.id`), L6.2 (confirmação 2-etapas com nonce server-side) |
| T5 | **Atacante que rouba o token do bot** (`TELEGRAM_BOT_TOKEN`) | fala **como o bot** para a API do Telegram | fila de updates, mensagens, e — por deputado confuso — as ações | `getUpdates` roubando a fila; `setWebhook` exfiltrando; `sendMessage` com teclado inline malicioso | perda de confidencialidade e disponibilidade do canal; execução **somente se o dono clicar** | L6.3 (nonce assinado server-side), rotação via `/token`, §8 |
| T6 | **Pessoa com acesso físico ao celular** do usuário (desbloqueado, ou emprestado) | lê o histórico inteiro do chat com o bot | qualquer segredo que já tenha passado por lá; os botões de comando | abrir o Telegram e rolar a conversa | acesso permanente se a senha estiver no histórico | §5 (senha **nunca** no chat), L6.2 (confirmação), TTL do link mágico |
| T7 | **Cloudflare, como intermediário** | vê o texto claro de todo o tráfego | prompts, código-fonte, respostas do LLM, a própria credencial em cada request | terminação de TLS na borda (arquitetural, não é falha) | comprometimento de confidencialidade perante um terceiro | **nenhum controle técnico** — é decisão de modelo de confiança, §2.5 |
| T8 | **Outro processo local** no mesmo host (dependência maliciosa, extensão de navegador, script npm) | executa com o mesmo UID | arquivo de segredo, `/proc/<pid>/cmdline`, `127.0.0.1:3080` | lê `~/.config/...`; conecta direto na porta | acesso total sem passar pelo túnel | §8 (0600, token por `env` e nunca por argv), L4 (a porta continua exigindo credencial) |
| T9 | **Vizinho de rede local** (café, coworking, casa compartilhada) | mesma LAN | porta 3080 | conexão direta ao IP local | bloqueado por **I1 (bind loopback), sozinho** — a conexão nem chega a abrir socket, logo I2 nunca roda e **não** participa da defesa (§0.2) | **L2** |
| T11 | **Site hostil no browser do dono** (DNS rebinding, ou simplesmente uma aba aberta) | executa JS no browser da vítima; rebinda um hostname que ele controla para `127.0.0.1` | rotas que ficaram fora de `guardedPrefixes`, `/__guard/secret`, e todo o `/api` se a ordem de carregamento estiver errada | `fetch('http://seu-dominio-rebindado:3080/…')` a partir de uma aba qualquer | acesso ao plano de controle **sem túnel nenhum**, com origem que o plugin considera confiável | **L2.5 (validação de `Host`)**, L4, e a allowlist de exceções de §L4-bis |
| T10 | **Operador cansado** (o próprio usuário) | permissões totais | tudo | deixa o túnel aberto de madrugada; cola a senha num chat; aceita um `danger-full-access` sem ler | exposição prolongada e silenciosa | L1 (TTL obrigatório), L8 (kill switch + relatório periódico no bot) |

### 2.2. A URL do túnel **não é um segredo** — verificado

Este é o ponto que derruba o desenho ingênuo ("ninguém vai adivinhar essa URL"). Medição
feita durante a pesquisa, em 2026-08-19:

Uma única chamada **gratuita e sem autenticação** à API pública do urlscan.io —
`https://urlscan.io/api/v1/search/?q=page.domain%3Atrycloudflare.com&size=100` — retornou
`total: 10000` (que é o **teto** da API, não a contagem real) e, nos primeiros 100
resultados, **73 hostnames distintos** de quick tunnels (o ledger de `08-PESQUISA-E-FONTES.md` §7.2 é a
fonte única deste número; versões anteriores deste documento diziam 72). Resolvendo esses 73 em DNS,
**13 (18%) ainda estavam vivos naquele instante**. Uma lista de alvos ativos, obtida em
uma requisição HTTP, sem brute force.

Dois ajustes de honestidade que a §12 detalha e que precisam viajar junto desse número:

1. O urlscan **não enumera** túneis: ele indexa URLs que alguém **submeteu** com
   `visibility: public` — na amostra, 96/100 vieram por `method: api`, ou seja, feeds
   automatizados de segurança/antiphishing. A formulação correta é: **o hostname vira
   público no instante em que qualquer scanner, feed ou ferramenta o vê** — não que
   túneis sejam enumeráveis à vontade.
2. Hostnames inexistentes **não resolvem** em DNS. Isso torna o DNS um oráculo de
   liveness barato, que baixa ainda mais o custo de varrer uma lista obtida de feeds.

Contexto que piora: desde fev/2024 há campanhas ativas abusando do TryCloudflare para
distribuir AsyncRAT, GuLoader, Remcos, VenomRAT, XWorm e PureLogs Stealer
(<https://www.proofpoint.com/us/blog/threat-insight/threat-actor-abuses-cloudflare-tunnels-deliver-rats>),
e o ransomware **Akira** usa `cloudflared` como mecanismo de persistência, rodando
`cloudflared.exe tunnel run --token [...]` a partir de controladores de domínio
(<https://arcticwolf.com/resources/blog/smash-and-grab-aggressive-akira-campaign-targets-sonicwall-vpns/>).

**Duas consequências para o plano:**
- O domínio `trycloudflare.com` carrega reputação de malware. Redes corporativas o
  bloqueiam, e há regras Sigma públicas detectando `cloudflared`. Se o usuário estiver
  numa rede gerenciada, isto pode disparar um alerta de EDR **contra ele**. Vai no
  onboarding.
- Trate a URL como **público conhecido desde o segundo zero**. Ela não entra em nenhum
  cálculo de segurança. Não é credencial, não é fator, não é atenuante.

> **NÃO CONFIRMADO:** que URLs de quick tunnel sejam **indexadas por motores de busca**.
> A tentativa de reproduzir `site:trycloudflare.com` retornou apenas páginas da própria
> Cloudflare, zero subdomínios aleatórios. Ver §12.4. O risco de descoberta é real, mas
> pela via de feeds/scanners, não pela via de busca.

### 2.3. Sandbox não é fronteira

Repetindo com ênfase porque é o erro mais fácil de cometer ao ler `01-ARQUITETURA.md`:
o confinamento `workspace-write` do DSH é **escapável** (#1769), e as negações são
**invisíveis para o modelo** (#3144). O plano usa o sandbox como camada L7 de redução de
dano, e em nenhum ponto o trata como substituto de L4.

### 2.4. Prompt injection: assuma como certeza operacional, não como risco residual

Survey de 78 estudos (arXiv 2601.17548): 42 técnicas em 5 categorias, com taxa de sucesso
**acima de 85% contra defesas estado-da-arte** quando o atacante adapta a estratégia; a
maioria das 18 defesas avaliadas fica **abaixo de 50%** de mitigação. A própria Anthropic
documenta que "no system is completely immune to all attacks" e recomenda VMs para
interagir com serviços externos.

Para este plano isso significa três coisas concretas, não um parágrafo de disclaimer:

1. **Nenhum segredo deste plugin pode estar num lugar que o agente leia por acidente.**
   O arquivo de estado (§8) fica fora do workspace, com `0600`, e o worker recebe
   ambiente por allowlist (`buildWorkerEnv`, src/index.ts:621) — nunca `process.env`
   inteiro.
2. **O veto de elevação (I4) fica.** É defesa em profundidade contra exatamente o padrão
   do CVE-2025-53773: o agente sendo convencido a elevar a si mesmo.
3. **Ações que aumentam exposição exigem confirmação humana fora do canal do agente.**
   O agente não abre túnel. O agente não emite link de acesso. O agente não rotaciona
   senha. Essas três operações só nascem de um comando do dono no bot ou na UI local,
   com o handshake da §7.

### 2.5. Cloudflare como intermediário (T7): decisão explícita, sem controle técnico

O TLS termina na borda da Cloudflare. É isso que permite WAF, Access e cache — não é
falha, é a arquitetura. Consequência: **não é fim-a-fim**. Prompts, trechos de código,
respostas do LLM e a própria credencial (que no Basic Auth vai em **cada** requisição)
passam em texto claro por um terceiro.

Não existe mitigação técnica dentro deste plano. Existe uma decisão, que o onboarding
apresenta ao usuário **antes** do primeiro túnel, com resposta obrigatória:

> Ao usar o túnel, você aceita que a Cloudflare pode, arquitetonicamente, ver o conteúdo
> do que trafega — incluindo seu código e seus prompts. Se isso é inaceitável para este
> repositório, **não use o túnel**: use uma VPN ponto-a-ponto (Tailscale/WireGuard) ou
> SSH port-forward, que não têm essa propriedade.

Não escondemos isso numa nota de rodapé. É a §2 do guia.

Uma nota adicional de higiene: `--loglevel debug` do `cloudflared` **loga URLs, métodos e
todos os headers de requisição e resposta**, o que inclui o header `Authorization`. O
plugin **nunca** deve subir o `cloudflared` em `debug`, e o modo verboso do onboarding
tem que ser explicitamente incapaz de ativá-lo.

---

## 3. Camadas de defesa, em ordem

Ordem = do mais externo (mais longe da máquina) ao mais interno. Cada camada declara
**o que pega** e **o que não pega**. A honestidade sobre o "não pega" é o que impede o
plano de virar teatro.

```
internet
   │
   ├─ L0  Cloudflare Access .......... só no Modo B; ausente no Modo A
   ├─ L1  cloudflared (processo+TTL) . superfície e janela de exposição
   │        └── loopback 127.0.0.1:3080
   ├─ L2  bind loopback .............. INALTERADO (assertSecureBind)
   ├─ L2.5 validação de cabeçalho Host  anti DNS rebinding (T11) — camada NOVA
   ├─ L3  trustedRemotes ............. INERTE em TODOS os modos (§0.2) — não conte com ela
   ├─ L4  portão de credencial ★ ..... A defesa real
   │        └── L4-bis: as TRÊS exceções declaradas ao portão (§L4-bis)
   ├─ L5  rate limit / backoff / lockout / alerta
   ├─ L6  allowlist de chat_id + confirmação com nonce (canal de comando)
   ├─ L7  veto de elevação + sandbox do DSH
   └─ L8  kill switch, TTL, auditoria
```

### L0 — Cloudflare Access (autenticação na borda) — **só Modo B**

**O que é.** Políticas avaliadas na borda da Cloudflare **antes** de o tráfego tocar a sua
máquina. Deny-by-default: "All Access applications are deny by default". Ações possíveis:
Allow / Block / Bypass / Service Auth, avaliadas com Service Auth e Bypass primeiro,
depois Block/Allow de cima para baixo, primeira correspondência decide.
(<https://developers.cloudflare.com/cloudflare-one/policies/access/>)

**Método recomendado para uso pessoal: One-time PIN.** Não exige IdP nenhum: PIN enviado
por e-mail, expira em 10 minutos, e **só é enviado se o e-mail já casar com uma política**
— ou seja, um endereço fora da política não recebe nada e não tem oráculo.

**O que pega:** T1, T2 e a maior parte de T6 de fora — o varredor e quem tem só a URL
nunca chegam à sua máquina. É a camada com melhor relação custo/benefício, se você tiver
domínio.

**O que NÃO pega:**
- **Não existe no Modo A.** Access exige aplicação com `zone_id`/domínio na Cloudflare;
  quick tunnel não tem. Não há como colocar Access na frente de um quick tunnel.
- Não protege se alguém alcançar a origem por outro caminho (LAN, outro processo local).
- **Bypass desliga tudo e ainda por cima não gera log.** Nunca usar.
- Se a política estiver mal configurada, falha aberta silenciosamente. Por isso L4 **não
  pode ser removida** só porque há Access na frente. Misconfiguração de política é o modo
  de falha mais comum desta camada.

**Requisito de implementação (Modo B).** A origem **valida o JWT**. A Access injeta
`Cf-Access-Jwt-Assertion` (header) e `CF_Authorization` (cookie), assinados com par de
chaves da conta, com as chaves públicas em
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Validar `kid`, `iss`, `aud`,
`exp`. A doc recomenda validar **o header e não o cookie** ("the cookie is not guaranteed
to be passed"). Alternativa suportada: ativar "Protect with Access" no próprio túnel para
o `cloudflared` validar.

> **NÃO CONFIRMADO:** o limite de "50 usuários" do plano Zero Trust gratuito. Duas frentes
> de pesquisa independentes falharam em achar o número em página oficial atual; ele só
> aparece em terceiros e num PDF da Cloudflare de Q4/2022. O que **é** oficial:
> "The user will occupy and consume a single seat regardless of the number of applications
> accessed or login events"
> (<https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/>).
> Para um usuário, irrelevante — mas não escreva "50 grátis" na documentação.

**Alternativa documentada, se auth na borda for requisito e não houver domínio:** o ngrok
oferece OAuth (até 5 MAU) e Basic Auth via Traffic Policy no plano **gratuito**
(<https://ngrok.com/docs/guides/identity-aware-proxy/securing-with-oauth>). O quick tunnel
da Cloudflare não oferece equivalente. Isto entra no plano como opção documentada, não
como caminho default.

### L1 — `cloudflared`: o processo e a janela de exposição

**O que pega:** reduz a superfície e, principalmente, o **tempo**. Uma URL viva por 60
minutos é um alvo muito pior do que uma viva por 3 semanas.

Controles obrigatórios desta camada:

| Controle | Especificação | Verificação |
|---|---|---|
| Instalação verificada | apt de `pkg.cloudflare.com` (assinado por `cloudflare-main.gpg`) **ou** binário do GitHub com sha256 conferido contra as release notes | o próprio `cloudflared` **loga o seu checksum no arranque** (`Version 2026.7.3 (Checksum 9d71c...)`), e esse valor foi verificado idêntico ao `sha256sum` do arquivo e ao publicado no GitHub — dá auditoria sem re-hashear |
| Sem `--loglevel debug` | proibido por código, não por convenção | teste que falha se a flag aparecer no `argv` |
| Métricas em porta fixa | `--metrics 127.0.0.1:<porta>` **explícito** — o default no 2026.7.3 é `localhost:0` (porta aleatória) com fallback 20241–20245; a doc afirma a faixa, o binário afirma o aleatório. **Não confie no default.** | teste de integração lê a porta que passamos |
| Extração da URL | `GET /quicktunnel` no metrics server → `{"hostname":"xxx.trycloudflare.com"}` (sem esquema; prefixe `https://`). Scraping de `stderr` **nunca é fonte primária** — é o fallback obrigatório quando o endpoint não responde no timeout (a formulação anterior, "**nunca** scraping de log", contradizia o próprio parágrafo abaixo e foi corrigida) | ver `04-TESTES.md` |
| TTL obrigatório (Modo A) | `tunnel.ttlMinutes`, default **60 min**, teto **480 (8 h)**, `0`/ausente é config inválida no load; ao expirar, derruba o túnel, **invalida as sessões emitidas** e avisa no Telegram. **Dono: T3.1** (`03-ONDAS.md` §8); IDs `TUN-016…TUN-019`. Na revisão anterior este controle era exigido aqui e **não tinha nenhuma sub-tarefa nem nenhum ID de teste** | teste de tempo com relógio injetado (`test/support/clock.ts`) |
| Shutdown limpo | `SIGTERM` → grace (default 30s) → o processo sai; **a URL pública passa a devolver HTTP 530 imediatamente** e a porta de métricas recusa conexão. Medido. Não fica órfão na borda | teste de integração |
| Sem estado em disco (Modo A) | após execuções completas, `~/.cloudflared` **não é criado**. Medido | teste que verifica ausência |
| Token do túnel (Modo B) | `--token-file` e **nunca** `--token` em argv — argv vaza no `ps` para qualquer processo local | inspeção de `argv` no teste |

**O que NÃO pega:** o túnel não autentica nada. Ele é um cano. Quem chega no cano chega
no DSH.

**Sobre a extração da URL — detalhes que evitam bug de integração:**
a URL sai **100% em STDERR** (medido: stdout ficou com **0 bytes** em duas execuções).
Um script que capture só stdout **nunca** verá a URL. O tempo entre lançar e a URL ficar
disponível foi de **6–7 segundos** nas medições; use polling com timeout ≥30s. O
`--output json` **não ajuda**, porque a URL continua embutida numa caixa ASCII dentro do
campo `message`. Por isso o endpoint `/quicktunnel` é o caminho canônico — ele é
determinístico e não quebra com mudança de formato de log.
*(Todos estes pontos foram **verificados localmente** com `cloudflared 2026.7.3`; o
endpoint `/quicktunnel` **não está documentado** na página oficial de métricas, que só
menciona `/metrics`. Ou seja: é confiável mas não contratual — o plano precisa de fallback
por regex `https://[-a-z0-9]+\.trycloudflare\.com` sobre o stderr.)*

**Aviso operacional real, registrado durante a pesquisa e que vira teste:** ao testar,
a porta 3080 já estava ocupada pelo DSH do usuário; o origin de teste não conseguiu
bindar e o quick tunnel **expôs o Harness real, publicamente e sem autenticação, por ~40
segundos**. `--url http://localhost:3080` publica o que estiver ali, sem perguntar nada.

→ **Requisito derivado — probe fail-closed. Reescrito nesta revisão, porque a versão
anterior testava a superfície errada.** Dizer apenas "o túnel não sobe se `/` não devolver
401" **não cobre o modo de falha que este projeto já reproduziu em laboratório**: o modo de
falha real é **ordem de carregamento**, e `/` é servido pelo `registerFallback` do
`@deepseek-ai/dsh-host-frontend-static` — **outro pacote, outro momento de registro** — ao
passo que `/api` vem de outro. É perfeitamente possível, e é o caso mais provável, que o
fallback caia **depois** do `apply()` e o `/api` **antes**: o probe de `/` passa, o túnel
sobe, e `POST /api/commands/execute` fica público.

**O probe é de quatro superfícies, todas anônimas, todas contra `127.0.0.1:<porta>`, e
qualquer `200` aborta a subida:**

| # | Sonda | Esperado | Por que existe |
| - | ----- | -------- | -------------- |
| 1 | `GET /` (fallback da SPA) | 401 | cobre o `registerFallback` |
| 2 | `POST /api/<rpc inofensivo>` — corpo vazio, RPC de leitura | 401 | cobre o `register` de `/api`, que é a superfície da #853 e a que o probe antigo **não** cobria |
| 3 | `GET /` com `Upgrade: websocket` + `Connection: Upgrade` | socket destruído / 401 | cobre `registerUpgrade`, onde o plano admite não ter confirmado nem a existência do ponto de enganche (§12.7) |
| 4 | `GET /__guard/probe-canary-<aleatório>` — caminho **fora** de `guardedPrefixes` | 401 | prova que `alwaysGuarded` está ligado; se responder 404 sem passar pelo gate, a política default-allow ainda está valendo e o túnel **não pode** subir |

Qualquer sonda devolvendo `200` — ou a sonda 4 devolvendo 404 sem ter passado pelo gate —
significa **gate não armado**: o túnel não sobe, o estado vai para `FAILED` e a mensagem ao
dono diz **qual** sonda falhou. Isto é fail-closed e é critério de aceite (§10.2).
Dono da implementação: **T3.1** (`03-ONDAS.md` §8), com os IDs `TUN-020…TUN-023`.

### L2 — Bind em loopback — **INALTERADO**

`assertSecureBind()` (src/index.ts:1311) continua exatamente como está: wildcard
(`0.0.0.0`, `::`, `*`, vazio) faz `throw` no `apply()`, e host fora de `allowedHosts` faz
`throw`. O plano **não** adiciona nenhuma configuração que permita relaxar isso, nem em
modo túnel. Quem quiser alargar o bind está fora do caminho suportado.

Reforço vindo da pesquisa: o "0.0.0.0 Day" (Oligo, 2024) mostrou que sites públicos
alcançavam serviços em `0.0.0.0` no macOS/Linux driblando a Private Network Access do
Chromium, com exploração observada in the wild. Bind em `0.0.0.0` é risco **mesmo sem
túnel**.

**O que NÃO pega:** nada do que vem pelo túnel — que chega justamente por loopback.

### L2.5 — Validação do cabeçalho `Host` — camada NOVA (anti DNS rebinding)

**O que é.** O gate compara o cabeçalho `Host` da requisição — e do handshake de upgrade —
contra `exposure.allowedRequestHosts`. Default derivado em runtime: `127.0.0.1:<porta>`,
`localhost:<porta>` e, enquanto o túnel está `READY`, o hostname do túnel. `Host` ausente,
vazio, com porta divergente ou fora da lista → **403**, antes de qualquer verificação de
credencial (mesma razão de 403-antes-de-401: não dar oráculo e não convidar a repetir).

**Por que faltava.** O `README.md` deste repositório já registra que `allowedHosts` é a
allowlist do **endereço de bind**, e explicitamente **não** do cabeçalho `Host`. Ninguém
ocupava esse lugar. Sem esta camada, um site hostil aberto no browser do dono (T11) alcança,
por DNS rebinding, tudo que ficou fora de `guardedPrefixes` — **sem túnel nenhum**, com
origem `127.0.0.1` que `trustedRemotes` aprova.

**O que pega:** T11 inteiro, e o caso trivial de "o dono deixou uma aba maliciosa aberta".

**O que NÃO pega:** nada que já tenha credencial válida; nem um processo local (T8), que
manda o `Host` que quiser. É camada barata contra um vetor específico, não defesa geral.

### L3 — `trustedRemotes` — honestamente inerte, em todos os modos

Ver §0.2. Mudanças obrigatórias, todas de **verdade** e não de comportamento:

1. O log de arranque em modo túnel emite, em nível `warn`, uma linha explícita:
   `trustedRemotes está ATIVO mas INERTE: com o túnel, todo tráfego chega como 127.0.0.1.`
2. O comentário da função `isTrustedRemote()` ganha essa nota.
3. O README ganha a nota.
4. **Nenhuma** mensagem do bot ou da UI pode listar `trustedRemotes` como proteção contra
   acesso externo.

A semântica fail-closed (`[]` nega tudo, inclusive loopback) **fica**. Ela continua
correta — mas **não protege T9**, e a versão anterior deste documento errava ao dizer que
sim: quem protege T9 é o bind (L2), que impede o socket de abrir antes de qualquer código
do plugin rodar. Ver §0.2. Item 5 das mudanças obrigatórias: **nenhum documento pode
atribuir valor residual a `trustedRemotes`.**

### L4 — O portão de credencial ★ — a defesa real

Esta é a camada que decide se o projeto é seguro ou não. Ela já existe e funciona; o que
muda é a **força do segredo** e a **forma de entrega**.

**O que já existe e o plano PRESERVA integralmente:**

| Peça | Local | Por que fica |
|---|---|---|
| `verifyBasicAuth()` | src/index.ts:179 | compara **digests SHA-256 de tamanho fixo** com `timingSafeEqual`, não os tokens crus. Isso é obrigatório: `timingSafeEqual` **lança** se os buffers tiverem tamanhos diferentes, e o próprio comprimento vazaria (<https://nodejs.org/api/crypto.html>) |
| `createGuardedHandler()` | src/index.ts:1372 | guarda `registerFallback` (toda a Web UI) e as rotas com prefixo em `guardedPrefixes` |
| `createGuardedUpgradeHandler()` | src/index.ts:1491 | guarda o handshake de WebSocket **inteiro**, sem olhar prefixos — WebSockets não têm same-origin policy, não há preflight, não há CORS. É o controle que impede a família CWE-1385 (CVE-2023-26114, CVE-2025-52882) |
| 403 antes de 401 | `denyUntrustedOrigin()` (src/index.ts:1343) | 401 convida a repetir a credencial; repetir não ajuda quando o problema é a origem. Devolver 401 ali daria oráculo ao atacante |
| Fail-closed no `catch` do upgrade | src/index.ts:~1540 | erro na decisão **destrói o socket**, nunca aprova |
| `canonicalRequestPath()` / `isGuardedPath()` | src/index.ts:306/341 | normalização de path antes de decidir — sem isso, `/%61pi` fura o prefixo |
| `assertUsableCredential()` | src/index.ts:1154 | recusa credenciais degeneradas (`undefined:undefined`, `null`, vazio) |

**O que MUDA:**

| Mudança | De | Para | Motivo |
|---|---|---|---|
| Origem da credencial | `ADMIN_USER`/`ADMIN_PASS` humanos (`cordis.patch.yml:238`) | segredo gerado por CSPRNG, ≥128 bits (§4) | senha humana atrás de um túnel público é o cenário do §1.3 |
| Segunda prova aceita | só `Authorization: Basic` | `Basic` **ou** cookie de sessão `__Host-dsh_sid` | o Basic Auth nativo do navegador é péssimo no celular e não tem logout; e precisamos do link mágico (§5) |
| Ponto de decisão | `verifyBasicAuth` direto no handler | continua entrando pela mesma cascata `ctx.waterfall('http/auth-check', ...)` | a cascata já existe (src/index.ts:1417 e 1514) e é o ponto de extensão correto — **nenhum novo caminho de decisão é criado** |

> **Decisão de desenho registrada:** o cookie de sessão **não substitui** o Basic; ele
> entra como um segundo `ctx.on('http/auth-check', ...)` que resolve `true` antes de o
> `next()` cair no Basic. Isso mantém uma única fronteira de autorização e preserva a
> propriedade que o plugin já tem: quem quiser auditar "onde se decide se passa" lê **um**
> lugar.

**O que L4 pega:** T1, T2, T8-pela-porta, e T6 depois que a senha some do chat.

**O que L4 NÃO pega:**
- Não pega T3 (prompt injection): o atacante já está **dentro** da sessão autenticada.
- Não pega T5/T4 pelo canal do Telegram: aquele caminho não passa por HTTP.
- Não pega T7: a credencial trafega em texto claro pela borda da Cloudflare a cada
  requisição (esse é, aliás, um argumento concreto a favor do cookie de sessão sobre o
  Basic: reduz a *quantidade* de vezes que o segredo permanente atravessa o intermediário
  — o segredo permanente atravessa uma vez, no login; depois só o identificador de
  sessão, que é revogável).
- Não pega XSS na Web UI do DSH. Se houver XSS, cookie `HttpOnly` protege o cookie, mas o
  atacante já executa dentro da origem autenticada. **XSS derrota qualquer mitigação de
  CSRF e a maior parte das de sessão.**

**Sobre CSRF.** NIST SP 800-63B-4 §5.1.1 é normativo: "POST/PUT content SHALL contain a
session identifier that the RP SHALL verify to protect against cross-site request forgery"
(<https://pages.nist.gov/800-63-4/sp800-63b.html>). Ordem de preferência do OWASP:
proteção do framework > synchronizer token > signed double-submit (HMAC) > Fetch Metadata
(`Sec-Fetch-Site`). Double-submit ingênuo está **desaconselhado** (cookie injection via
subdomínio), e `SameSite` sozinho **não basta**.

Consequência de arquitetura que economiza trabalho: **autenticação por
`Authorization: Bearer`/`Basic` não é vulnerável a CSRF**, porque o navegador não envia
esse header automaticamente cross-site. Portanto:
- caminho Basic → sem trabalho de CSRF;
- caminho cookie → cookie de sessão com `HttpOnly`, `Path=/`, valor opaco de 128 bits
  CSPRNG (ASVS 7.2.3), **mais** verificação de `Sec-Fetch-Site` nas rotas mutantes de `/api`
  como camada barata, **mais** um synchronizer token nas rotas mutantes de `/__guard`
  (que **são** nossas). Dois atributos mudaram nesta revisão, e a razão está escrita:

  1. **`SameSite=Lax`, não `Strict`.** `Strict` **quebra o caso de uso central do produto**:
     o dono clica no link do túnel dentro do app do Telegram, o browser faz uma navegação
     top-level *cross-site*, e um cookie `Strict` **não é enviado** — o dono leva 401 mesmo
     com sessão viva e é empurrado de volta ao magic link ou ao Basic. NIST SP 800-63B-4
     §5.1.1 aceita `Lax` **ou** `Strict`; a diferença de proteção contra CSRF é coberta pelo
     synchronizer token nas rotas mutantes, que é o que a ordem de preferência do OWASP põe
     acima de `SameSite` de qualquer forma.
  2. **`__Host-` + `Secure` são condicionais ao esquema efetivo.** Sobre o túnel (sempre
     HTTPS) o cookie é `__Host-dsh_sid` com `Secure`. Sobre `http://127.0.0.1:3080` (o
     painel local, que é o caminho de recuperação de §11.2) o cookie cai para `dsh_sid`,
     `Path=/__guard`, `HttpOnly`, `SameSite=Lax`, **sem** `Secure` — porque
     **NÃO CONFIRMADO** que Safari aceite `Secure` em `http://localhost` (Chrome e Firefox
     aceitam; Safari historicamente não), e um cookie que o browser recusa em silêncio
     transforma o caminho de recuperação em beco sem saída. A decisão é por requisição, a
     partir do esquema **efetivo do socket**, e **nunca** a partir de `X-Forwarded-Proto`,
     que é forjável por qualquer processo local. Spike roteado a **T2.2**.

Atributos exigidos pelo NIST 63B-4 §5.1.1 e ASVS V7/V3: cookie `Secure`-only, `HttpOnly`,
prefixo `__Host-` com `Path=/`, `SameSite=Lax` ou `Strict`, valor **apenas string opaca**,
e sessão autenticada **SHALL NOT** cair para `http`. A sessão do **painel local** é a
exceção declarada acima e existe porque o painel local é o caminho de recuperação; ela
**não** é aceita em requisições cujo `Host` seja o hostname do túnel (L2.5 já separa os
dois), então uma sessão emitida no loopback não vale pela internet e vice-versa.

**Timeouts.** NIST AAL2: reautenticação global ≤ 24h, inatividade ≤ 1h. O plano adota
**inatividade 60 min, absoluto 8h**, e — importante — a sessão **morre junto com o túnel**:
derrubar o túnel invalida todas as sessões emitidas para ele. Isso torna o kill switch
(L8) um controle de verdade e não um teatro.

> **Dono e prova.** "A sessão morre junto com o túnel" era exigido aqui e em §10.3 e não
> tinha, na revisão anterior, **nenhuma sub-tarefa nem nenhum ID de teste** — `SESS-001…008`
> não cobriam. Passa a ter: implementação em **T3.3** (o gate chama
> `SessionStore.revokeAllTunnelSessions()` em toda transição `READY|STARTING|DEGRADED →
> STOPPING`, e em `DEGRADED` por queda do processo), integração em **T5.1**, e o ID de teste
> é **`SESS-009`**. Sessões emitidas no **loopback** sobrevivem — elas não dependem do túnel
> e são o caminho de recuperação.

### L4-bis — As três exceções declaradas ao portão

O portão tem exceções. Fingir que não tem seria o mesmo erro de `trustedRemotes`. Elas são
**três**, estão listadas na tabela canônica de rotas de `01-ARQUITETURA.md` §3(e), e cada
uma declara o controle que substitui a credencial:

| Rota | Por que precisa ser anônima | O que a protege no lugar |
| ---- | --------------------------- | ------------------------ |
| `POST /__guard/api/login` | é onde a credencial é apresentada | rate limit da L5, resposta genérica, custo constante |
| `GET/POST /__guard/magic` | é o que **emite** a sessão; exigir sessão seria circular | `mk` de 128 bits com TTL 120 s, uso único, **rate limit próprio**, contagem no teto de falhas, consumo só por gesto humano (§5.3) |
| `GET /__guard/secret` | exibe o segredo no primeiro boot | **token de uso único impresso no stdout do terminal**, TTL 10 min, uso único, e a rota deixa de existir depois do primeiro consumo (§4.4) |

**`/__guard/magic` é um bypass do L4 por construção**, e a versão anterior deste documento
nunca o declarava como tal: ele não aparecia na §3, não aparecia no §10.2/§10.3, não era
coberto pelo rate limit da §6 e não contava para o teto de 100. Agora conta, nas três.

### L5 — Rate limit, backoff, lockout e alerta

Cobre-se em detalhe na §6. Resumo do que a camada faz aqui: com credencial de 128 bits, o
brute force online é matematicamente irrelevante. O rate limit existe por **três** motivos
que não são adivinhação de senha: (a) impedir DoS de CPU; (b) gerar **sinal** — a primeira
tentativa falha é o evento mais valioso do sistema; (c) elevar custo para quem tenta
credenciais default e paths de CVE conhecidas.

**O que NÃO pega:** um atacante com a credencial correta passa na primeira tentativa e
nunca aciona o rate limit. L5 não detecta acesso legítimo-mas-não-autorizado. Para isso
existe o alerta de **sessão nova** (L8), que dispara mesmo em login bem-sucedido.

### L6 — Allowlist de `chat_id` + confirmação com nonce — o canal de comando

Detalhado na §7. É a camada que protege T4 e T5. Sem ela, **qualquer pessoa que ache
`t.me/seu_bot` executa `/desligar` ou, pior, `/ligar`**. Não é hardening; é
requisito de dia zero. A documentação oficial coloca a responsabilidade explicitamente no
backend:

> "Your backend should always verify that received commands are valid and that the user
> was authorized to use them regardless of scope."
> — <https://core.telegram.org/bots/features>

### L7 — Veto de elevação + sandbox do DSH

**Mantém-se sem alteração** o ouvinte `security/permission-elevate` (src/index.ts:1678) e
a `deniedPermissions`. O comentário existente já classifica isso corretamente como defesa
em profundidade e não como travão principal — essa classificação está certa e o plano
a reafirma.

**O que pega:** o padrão CVE-2025-53773 — o agente sendo convencido, por conteúdo lido,
a elevar a si mesmo. É barato e vale a pena.

**O que NÃO pega:** qualquer coisa que já esteja dentro do orçamento de permissão vigente.
E não pega #1769 (o `bwrap workspace-write` é escapável). Ver §2.3.

### L8 — Kill switch, TTL e auditoria

| Controle | Especificação |
|---|---|
| Kill switch | `/desligar` no bot e o botão no painel derrubam **a exposição**: o `cloudflared` morre e as sessões emitidas são invalidadas. **Não** derrubam o processo do DSH — isso está explicitamente adiado (`03-ONDAS.md` §19: o bot roda como filho do DSH; matar o pai mata o filho e não sobra ninguém para ouvir "religue"). `/emergencia` mata o **worker do bot**, o que é coisa diferente e está documentado como tal. A ordem "túnel primeiro" continua sendo a regra sempre que houver dois recursos a derrubar, porque derrubar a origem com o túnel vivo deixa uma URL pública apontando para uma porta que outra coisa pode ocupar |
| Ordem inversa no boot | subir servidor → **probe autenticado** → só então subir túnel |
| TTL | Modo A: default 60 min, teto 8h. Ao expirar: derruba túnel, invalida sessões, avisa no Telegram |
| Alerta de sessão nova | **toda** autenticação bem-sucedida de uma sessão nova gera mensagem no Telegram com horário e um identificador de agente (hash curto de User-Agent), com botão "não fui eu" que executa o kill switch imediatamente |
| Log de auditoria | append-only, fora do Telegram, fora do workspace, `0600`: `{ts, evento, resultado, ip_normalizado, sessao_id_hash}` — **nunca** credencial, **nunca** token, **nunca** URL do túnel completa |
| Relatório periódico | a cada 30 min de túnel aberto, o bot manda um lembrete com o tempo restante e um botão de encerrar. Combate T10 |

**O que NÃO pega:** tudo que já aconteceu antes do kill switch ser acionado. Exfiltração é
irreversível. O kill switch limita duração, não desfaz dano.

---

## 4. Geração, armazenamento, rotação e entrega da senha

### 4.1. Geração

| Decisão | Valor | Justificativa |
|---|---|---|
| Fonte | `crypto.randomBytes(32)` do Node | documentado como "Generates cryptographically strong pseudorandom data" (<https://nodejs.org/api/crypto.html>). **Proibido**: `Math.random()`, `Date.now()`, `crypto.randomUUID()` como fonte de entropia — ASVS 11.5.1 é explícito que "UUIDs do not respect this condition" |
| Tamanho | **256 bits** (32 bytes) | o alvo normativo é 128: ASVS 11.5.1 (L2) exige ≥128 bits para todo valor aleatório não-adivinhável, e ASVS 7.2.3 (L2) exige ≥128 bits para reference tokens de sessão. 256 é folga barata |
| Formato apresentado | **base32 sem padding**, RFC 4648 (alfabeto `A–Z2–7`) | 5 bits/char, sem `0/O`, sem `l/1`, sem `+/`, case-insensitive. É o formato que sobrevive a ser ditado no telefone, lido de um QR ou digitado em teclado de celular. 256 bits = 52 chars; 128 bits = 26 chars (<https://www.rfc-editor.org/rfc/rfc4648.html>) |
| Agrupamento visual | blocos de 4 separados por `-` na exibição, **ignorados na verificação** | reduz erro de digitação sem custo de entropia |
| Usuário do Basic | fixo `dsh`, não é segredo | o segredo inteiro está na senha; ter usuário variável só cria suporte |

**Por que não passphrase.** A lista longa da EFF tem 7776 palavras (verificado: 7776
linhas) = 12,925 bits/palavra; a EFF recomenda no mínimo 6 palavras (~77,5 bits). Para
chegar a 128 bits precisaria de **10 palavras**. Passphrase é ótima para memorização
humana e cara em bits. Este segredo vai para um gerenciador de senhas ou é consumido por
um link mágico — não é memorizado. Base32 vence.

Assinatura pretendida (ilustrativa, não é a implementação):

```ts
// src/secret.ts
export interface GeneratedSecret {
  /** 52 chars base32, agrupados em blocos de 4 para exibição. */
  readonly display: string
  /** SHA-256 do valor canônico (upper, sem separadores). Isto é o que persiste. */
  readonly digest: Buffer
}
export function generateAccessSecret(bytes?: number): GeneratedSecret
export function canonicalizeSecret(input: string): string  // upper + remove '-' e espaço
```

### 4.2. Armazenamento

**O segredo em claro nunca toca o disco.** O que persiste é `sha256(canonical)`.

```
$XDG_STATE_HOME/dsh-guarded-bot/state.json     (fallback: ~/.local/state/dsh-guarded-bot/)
  modo 0600, diretório 0700, FORA do workspace do agente
  { "version": 1,
    "secretDigest": "<hex 64>",
    "secretCreatedAt": "<iso8601>",
    "sessions": { "<sid_hash>": { "exp": ..., "createdAt": ..., "uaHash": "..." } } }
```

**Hash rápido ou Argon2id?** Decisão: **SHA-256 + `timingSafeEqual` sobre os digests**,
sem KDF lento. A justificativa é de engenharia, e vou ser explícito sobre o que ela **não**
é:

- O argumento válido: o segredo é gerado por CSPRNG com 256 bits. Ataque offline exige
  2^256 (ou 2^128 no piso normativo) — computacionalmente impossível. KDFs lentos existem
  para compensar a **baixa entropia de senha humana**, que aqui não existe. Além disso,
  Argon2id com os parâmetros do OWASP (19 MiB, t=2, p=1) por tentativa vira vetor de DoS
  de CPU/memória — o próprio OWASP alerta que work factor alto demais "could be used by an
  attacker to carry out a denial of service attack by exhausting the server's CPU".
- **O argumento que NÃO pode ser usado (refutado — ver §12.1):** que o ASVS 5.0 §6.5.2
  autorize isso. A citação literal existe ("A standard hash function can be used if the
  secret has 112 bits of entropy or more"), mas o escopo textual daquele requisito é
  **lookup secrets** — códigos de recuperação/backup de MFA — e não tokens em geral. A
  norma é **silente** sobre este caso. Escrever "o ASVS diz que basta SHA-256" seria
  citação errada.
- Ressalva que continua valendo: **ASVS 13.3.1 (L2)** exige solução de secrets management
  para chaves e seeds de backend. Nosso arquivo `0600` é o mínimo defensável para uma
  ferramenta local de um usuário; **não** é o que a norma pede para um serviço. Isto está
  declarado no risco residual (§11).

**Se algum dia o usuário puder escolher a própria senha** (o plano **desaconselha**, mas
prevê): aí Argon2id é obrigatório, com m=19456 KiB, t=2, p=1, salt ≥16 bytes — parâmetros
OWASP 2026. Node ≥ 24.7.0 tem `crypto.argon2()`/`argon2Sync()` **nativos** (o `engines`
deste pacote já exige `>=24`), então não entra dependência nova. Alternativas equivalentes
da tabela OWASP: m=47104/t=1/p=1, m=12288/t=3/p=1, m=9216/t=4/p=1, m=7168/t=5/p=1.

**Comparação em tempo constante — regras não negociáveis:**
1. Comparar **digests de 32 bytes**, nunca os segredos crus (`timingSafeEqual` lança com
   tamanhos diferentes, e o comprimento por si só vaza informação).
2. `crypto.timingSafeEqual` garante a comparação, **não** o código ao redor: a doc do Node
   é literal — "Use of `crypto.timingSafeEqual` does not guarantee that the surrounding
   code is timing-safe". Portanto o caminho de rejeição deve ter o **mesmo formato** de
   resposta e o mesmo custo aproximado, sem `return` antecipado que distinga "prefixo
   errado" de "senha errada" com folga mensurável.
3. Ataque de timing remoto é real: Crosby/Wallach (ACM TISSEC, 2009) mediram eventos com
   15–100 µs de precisão pela internet. CWE-208 cobre exatamente isso. ASVS 11.2.4 (L3)
   exige operações cripto em tempo constante sem short-circuit.

### 4.3. Rotação e expiração

| Evento | Ação |
|---|---|
| Primeiro boot sem `state.json` | gera segredo, exibe **uma vez** na saída do terminal local, persiste só o digest |
| `/rotacionar` no bot (com confirmação de 2 etapas) | gera novo segredo, invalida **todas** as sessões, e **não envia o segredo pelo Telegram** — envia um link mágico (§5.3) |
| Suspeita de comprometimento | mesma coisa, mais kill switch |
| Rotação periódica obrigatória | **não existe** |

Sobre a última linha: o NIST SP 800-63B rev.4 é explícito contra rotação por calendário —
"SHALL NOT require subscribers to change passwords periodically", forçando mudança apenas
quando há evidência de comprometimento
(<https://pages.nist.gov/800-63-4/sp800-63b.html>). Ele também proíbe regras de composição
("SHALL NOT impose other composition rules"), o que aqui é irrelevante porque o segredo é
gerado por máquina.

**Expiração do segredo:** não expira. **Expiração de sessão:** 60 min de inatividade / 8h
absoluto / morte imediata quando o túnel cai (§L4).

### 4.4. Entrega ao usuário — três caminhos, em ordem de preferência

> ### 🔴 Furo crítico corrigido nesta revisão: a página que entregava a senha pela internet
>
> A versão anterior oferecia, como caminho 2, a página
> `http://127.0.0.1:3080/__gate/secret`, *"acessível **só de loopback**, exibida uma vez"*.
> **Isso era um furo crítico, e a §0.2 deste mesmo arquivo já continha a prova, 700 linhas
> antes:** com o túnel de pé, *todo* tráfego chega como `127.0.0.1`. "Acessível só de
> loopback" significava, literalmente, **acessível pela URL pública**. Pior: essa página,
> por definição, não pode estar atrás do gate (seria preciso a senha para ver a senha),
> logo ficava fora de `guardedPrefixes` e o `register` interceptado a deixava passar
> intacta (`src/index.ts:1770` — *"o plugin é um portão, não um proxy universal"*).
>
> Cenário concreto que isso permitia: o dono roda o onboarding, abre o túnel, ainda não
> abriu a página. Um scanner com a URL faz `GET https://xxx.trycloudflare.com/__gate/secret`
> e recebe o segredo de 256 bits em claro. RCE com o UID do usuário, sem tocar na senha.
> E **sem** túnel o mesmo furo continuava explorável por DNS rebinding (T11, §L2.5).
>
> **A rota `/__gate/secret` está morta.** O que a substitui está na linha 2 da tabela
> abaixo, e a diferença é de natureza, não de grau: a prova deixa de ser "origem loopback"
> (inerte) e passa a ser **posse do terminal** (a raiz de confiança real deste sistema).

| # | Caminho | Quando | Propriedade |
|---|---|---|---|
| 1 | **Terminal local**, no primeiro boot, uma vez — em texto **e** como **QR code ASCII** na mesma tela | onboarding | o segredo nunca sai da máquina; o QR resolve o "digitar 52 caracteres no celular" sem canal intermediário |
| 2 | **Página local** `http://127.0.0.1:3080/__guard/secret?ott=<token>`, onde `<token>` é um **token de uso único de 128 bits impresso no stdout do terminal**, com TTL de 10 min; a rota **deixa de existir** após o primeiro consumo ou após o TTL | usuário já está no navegador da máquina e prefere copiar do que digitar | a prova é **posse do terminal**, não origem de socket. Um scanner com a URL pública recebe **404 idêntico** ao de rota inexistente, sem oráculo |
| 3 | **Link mágico de uso único** pelo Telegram (`/__guard/magic`) | usuário está fora, no celular — **que é o caso de uso central do produto** | o que trafega **não é** o segredo permanente; é um bearer de 128 bits, TTL 120s, consumido uma vez, por gesto humano explícito (§5.3) |

**Proibido:** enviar o segredo permanente pelo Telegram, por e-mail, ou colocá-lo em
qualquer mensagem. Não é uma recomendação; é um teste que falha o build (§10).

**Correção de default — o caminho 3 é o caminho do usuário-alvo, e estava desligado.**
A versão anterior deste plano apontava o magic link como o caminho para "usuário está fora,
no celular" — que é o produto inteiro — enquanto `03-ONDAS.md` §10 o colocava **atrás de
flag desligada por padrão**. No default, portanto, o único caminho para o celular era
digitar 52 caracteres base32 que apareceram **uma única vez** no stdout de um terminal. O
comportamento previsível do usuário real, nesse desenho, é **colar a senha no chat do
Telegram** — exatamente o que a §5 gasta 60 linhas provando ser inaceitável. Um plano que
encara a pergunta com rigor e depois não entrega um caminho utilizável que a torne
desnecessária **empurra o usuário para o que ele proíbe**.

> **Decisão:** `control.magicLink` é **`true` por padrão quando `exposure.mode: 'tunnel'`**.
> O trade-off continua escrito e continua sendo o mesmo: troca-se uma credencial de longa
> duração no histórico por uma de **TTL de 120 s e uso único**. Quem quiser desligar,
> desliga — e aí o caminho para o celular passa a ser o QR do caminho 1, lido antes de sair
> de casa. `03-ONDAS.md` §10 foi corrigido.

---

## 5. A pergunta incômoda: é seguro mandar a senha pelo Telegram?

**Resposta curta: não.** E a Telegram concorda por escrito.

### 5.1. Os cinco fatos, com fonte

1. **Chat com bot não é fim-a-fim.** A Telegram documenta duas camadas: "Server-client
   encryption is used in Cloud Chats (private and group chats), Secret Chats use an
   additional layer of client-client encryption"
   (<https://telegram.org/faq#q-so-how-do-you-encrypt-data>). Chat com bot é cloud chat.
2. **Secret Chat não existe para bots.** São específicos de dispositivo, fora da nuvem; o
   `Chat.type` da Bot API só admite `private`/`group`/`supergroup`/`channel`, e não há
   método nem tipo de secret chat na API. Logo **nenhuma** conversa com bot pode ser E2E.
3. **A Telegram armazena o histórico e roda análise automatizada sobre ele.** Política de
   Privacidade 3.3.1: "Armazenamos mensagens, fotos, vídeos e documentos de seus chats em
   nuvem em nossos servidores" (<https://telegram.org/privacy#3-3-1-chats-em-nuvem>). E
   §5.3: "Também podemos usar algoritmos automatizados para analisar mensagens de chats em
   nuvem para impedir spam e phishing".
4. **O FAQ oficial manda literalmente não fazer isso:** "any bot should be treated as a
   stranger — don't give them your passwords, Telegram codes or bank account numbers, even
   if they ask nicely" (<https://core.telegram.org/bots/faq>).
5. **O segredo passa a existir em N lugares fora do seu controle:** o histórico
   sincronizado em **todos** os dispositivos logados do dono (desktop, celular, web), os
   backups desses dispositivos, e — se você logar updates — o log do seu próprio servidor.
   Isto é exatamente T6.

### 5.2. E "eu apago depois"? Não é controle de segurança

| Mecanismo | Existe? | Limite |
|---|---|---|
| Autodestruição de mensagem | **Não, para bots.** É exclusiva de Secret Chats (Política 10.3), indisponível para bots | — |
| `setChatMessageAutoDeleteTime` | **Não existe.** Grep na doc inteira: `message_auto_delete_time` é **somente leitura** (aparece em `ChatFullInfo` e no service message `MessageAutoDeleteTimerChanged`). O bot **não consegue** ligar auto-delete | só o usuário, pela UI, e para o chat inteiro |
| `deleteMessage` | Sim | **só se a mensagem tiver menos de 48 horas**. Em chat privado o bot apaga as próprias e as recebidas (<https://core.telegram.org/bots/api#deletemessage>) |
| `deleteMessages` | Sim, 1–100 de uma vez; ids não encontrados são silenciosamente ignorados | mesma janela de 48h |
| `has_protected_content` | Sim | impede **encaminhar**, não impede ler nem tirar print |

E, mesmo dentro das 48h, apagar **não é remoção segura**: remove da timeline, não garante
purga imediata dos servidores; em supergrupos as mensagens apagadas ficam retidas 48h para
admin logs; e não desfaz uma notificação já entregue no lock screen, já espelhada num
smartwatch ou já lida.

> **Conclusão:** apagar depois é higiene cosmética. Usamos `deleteMessage` — mas como
> redução de rastro, não como mitigação, e o plano nunca conta com ele para justificar
> enviar algo sensível.

### 5.3. A mitigação prática: link mágico de uso único

O padrão correto, derivado dos fatos acima: **o segredo permanente fica no servidor; o
Telegram carrega apenas uma intenção e um bearer opaco, efêmero e de uso único.**

```
Dono no celular:  /acessar
                     │
Plugin (local):      ├─ verifica from.id ∈ ALLOWLIST  E  chat.id ∈ ALLOWLIST
                     ├─ verifica que o túnel está ATIVO (senão, oferece /ligar)
                     ├─ mk = randomBytes(16)           # 128 bits, base64url = 22 chars
                     ├─ guarda sha256(mk) em memória com { exp: now+120s, usado:false }
                     └─ envia: https://<host-do-tunel>/__guard/magic#<mk>
                                                                  ↑
                                        FRAGMENTO, não query string
Dono clica:          GET /__guard/magic  →  a página local lê location.hash e faz
                     POST /__guard/magic { mk }  →  servidor valida (timingSafeEqual sobre
                     digests), marca usado, emite cookie __Host-dsh_sid, redireciona para /
                     e dispara ALERTA de sessão nova no Telegram
Plugin:              apaga a mensagem do link (deleteMessage) — cosmético, não controle
```

**Propriedades que isso compra:**

| Propriedade | Como |
|---|---|
| O segredo permanente **nunca** entra no Telegram | só o `mk` efêmero entra |
| Vazamento tardio do histórico é **inútil** | `mk` expira em 120s e é consumido no primeiro uso |
| Uso indevido é **detectável** | o consumo do `mk` dispara alerta de sessão nova com botão "não fui eu" |
| O link **não aparece em log de servidor nem em Referer** | está no **fragmento** (`#`), que não é enviado ao servidor nem propagado em `Referer` |
| Uso duplo é **impossível** | marcado como usado na primeira troca; a segunda tentativa falha **e alerta** |
| TTL curto limita a janela de T6 | 120s |
| **Consumo automático por scanner não queima o `mk`** | o `GET` **não consome nada**: entrega uma página estática que lê `location.hash` e espera um **clique explícito** ("Entrar"). O `POST` que consome só nasce de gesto humano. Ver o quadro abaixo |
| **Está sob rate limit e conta para o teto de falhas** | igual a `/__guard/api/login`, com a mesma resposta genérica |

> ### Consumo automático: o modo de falha que a tabela anterior não considerava
>
> A tabela afirmava "uso duplo é **impossível**" e "vazamento tardio é **inútil**" sem
> considerar **quem consome o link sem ser gente**: o crawler de preview de link do próprio
> Telegram, antivírus e scanners de URL, e reescrita corporativa de links. Qualquer um
> deles que execute a página **queima o `mk`**: o dono não entra, e o alerta de "sessão
> nova" dispara **falso** — treinando o dono a ignorar exatamente o alerta que importa.
>
> **Três controles obrigatórios, os três novos:**
> 1. `GET /__guard/magic` é **inerte**: devolve HTML estático que não consome nada. O
>    consumo é um `POST` disparado por **clique explícito** do usuário. Um crawler que
>    renderize a página não queima o token.
> 2. A mensagem do Telegram é enviada com **`disable_web_page_preview: true`** (o plano
>    nunca mencionava isso), o que impede o próprio Telegram de buscar a URL.
> 3. Se o `mk` for consumido **sem** clique detectável (sem interação, User-Agent de
>    crawler conhecido), a sessão **não é emitida**, o `mk` **não é queimado**, e o evento
>    entra no audit log como `magic.crawler-suspect`.

**O que isto NÃO resolve, dito de frente:** se o atacante estiver **olhando o celular no
momento** em que o link chega (T6 com acesso concorrente), ele clica primeiro. TTL curto
não salva desse caso. A defesa que resta é o alerta de sessão nova, que chega **no mesmo
chat** — inútil se o atacante controla o chat. Contra T6 pleno, o único controle real é o
bloqueio de tela do celular, que está fora do nosso escopo. Está na §11.

**Requisito de implementação:** o `mk` mora **em memória do processo**, nunca no
`state.json`. Reiniciar o plugin invalida todos os links pendentes — comportamento
desejado.

---

## 6. Força bruta: rate limit, backoff, lockout e alerta

### 6.1. Números normativos e o que adotamos

| Fonte | Prescrição |
|---|---|
| NIST SP 800-63B-4 §3.2.2 | "the verifier SHALL limit consecutive failed authentication attempts using a specific authenticator on a single subscriber account to no more than **100**" — o texto explica que 100 balanceia chance de acerto contra necessidade de account recovery |
| NIST SP 800-63B-4 | sugere espera crescente após falha, "e.g. 30 seconds up to an hour", mais desafio de bot-detection |
| OWASP Authentication | lockout tem 3 parâmetros (threshold, observation window, duration); sugere backoff **exponencial** a partir de ~1s, dobrando; o contador deve estar associado à **conta**, não ao IP, para não ser burlado por rotação de IP |
| OWASP Blocking Brute Force | lockout puro "is insufficient for stopping brute-force attacks" e cria DoS trivial |
| fail2ban (defaults oficiais, `config/jail.conf`) | `maxretry = 5`, `findtime = 10m`, `bantime = 10m` (<https://github.com/fail2ban/fail2ban/blob/master/config/jail.conf>) |

**Tensão real que o plano precisa resolver:** com **um único usuário**, lockout de conta é
**auto-DoS total** — trava o dono para fora da própria máquina, sem caminho de recuperação
remota. E lockout por IP é fraco: 85% dos IPs atacantes aparecem em um único dia (§1.3).

**Política adotada:**

| Camada | Regra | Motivo |
|---|---|---|
| Backoff por IP normalizado | a partir da **5ª** falha em 10 min: 1s, 2s, 4s, 8s… teto 30s, com **full jitter** (`random(0, min(cap, base*2^n))`) | custo assimétrico, sem travar o dono |
| Ban temporário por IP | ≥15 falhas na janela → 60 min de recusa imediata para aquele IP | alinhado ao fail2ban, mais agressivo |
| Teto global | 100 falhas consecutivas na conta → **modo restrito**, não lockout | cumpre o SHALL do NIST sem brickar |
| **Modo restrito** (em vez de lockout) | o gate deixa de aceitar credencial **pelo túnel** e passa a aceitar **só de loopback**; o túnel é derrubado; o bot avisa | o dono recupera indo à máquina; ninguém fica de fora para sempre |
| Resposta a falha | **sempre** 401 genérico, corpo idêntico, sem distinguir "usuário inexistente" de "senha errada", sem revelar se houve ban | OWASP Authentication: mensagem genérica idêntica; e não dar oráculo |
| Custo constante | mesmo com IP banido, a resposta gasta o mesmo caminho de código | evita oráculo de timing sobre o próprio ban |

### 6.2. Alerta — o produto mais valioso desta camada

| Gatilho | Ação |
|---|---|
| **Primeira** falha de autenticação numa janela de 10 min | mensagem no Telegram: horário, IP normalizado, path, e botão **"derrubar túnel agora"** |
| Rajada (≥5 falhas) | segunda mensagem, com contagem, **com throttling** para não virar flood |
| Ban de IP acionado | mensagem |
| **Sessão nova bem-sucedida** | mensagem (§L8) — este é o alerta que pega o atacante que **tem** a senha |
| Modo restrito ativado | mensagem + o túnel já caiu |

**Rate limit do lado do Telegram** (para o alerta não se tornar o problema): 1 msg/s no
mesmo chat, ~30 msg/s em broadcast, com 429 + `parameters.retry_after` quando estoura
(<https://core.telegram.org/bots/faq>). Estratégia: coalescer alertas em janela de 30s e
tratar 429 esperando exatamente `retry_after` — **nunca** retry cego, que amplifica. A
biblioteca escolhida (grammY) tem plugin oficial de auto-retry que lê `retry_after`.

### 6.3. Onde o contador vive

Em memória do processo, com o `state.json` guardando apenas o **modo restrito** (que
precisa sobreviver a restart — senão reiniciar o DSH vira o bypass do controle). Contadores
de IP não persistem: reiniciar zera, e isso é aceitável porque o custo de reiniciar o DSH
não está ao alcance do atacante remoto.

### 6.4. Quem constrói cada peça desta camada

Esta subseção existe porque, na revisão anterior, **"modo restrito" aparecia seis vezes neste
documento e zero vezes em `03-ONDAS.md` e em `04-TESTES.md`** — e o alerta na primeira falha, o
botão "não fui eu" e o kill switch por mensagem estavam na mesma situação. Um controle sem dono
não é um controle.

| Peça | Dono (`03-ONDAS.md`) | Verificação (`04-TESTES.md`) |
|---|---|---|
| Backoff com full jitter e ban por identidade | **T2.3** (`src/ratelimit/policy.ts`, `tracker.ts`) | `RL-001…RL-012` |
| **Modo restrito**: ativa aos 100, persiste no `state.json`, derruba o túnel, aceita só loopback | **T2.3** decide e persiste (`src/ratelimit/restricted.ts`, via `StateStore` de **T2.5**); **T3.3** fia no gate e **T3.1/T5.1** executam a derrubada | `RL-008` reescrito: aos 100, `pgrep -f cloudflared` vazio, requisição pela URL pública falha, requisição de loopback com credencial correta passa, e **após restart o modo continua ativo** |
| Resposta **sempre 401 idêntico**, sem `429` e sem `Retry-After`, com custo constante | **T2.3** + **T3.3** | `RL-005`/`RL-011` reescritos: corpo e headers **byte a byte iguais** ao 401 de senha errada |
| Alerta na primeira falha da janela, com botão de kill switch | **T5.4** compõe, **T5.2** renderiza, **T5.1** executa o intent do botão | `TG-*` de alerta |
| Alerta em toda sessão nova, com botão "não fui eu" | **T5.4**, sobre o gancho congelado no COMMIT PREP 5 | `TG-*` de alerta |
| Relatório periódico de 30 min com tempo restante do TTL | **T5.4**, alimentado pelo timer de **T3.1** | `TG-*` de alerta |

**Nota de precisão que muda a implementação, e que veio de uma refutação adversarial:** o modo
restrito diz "aceita só de loopback", mas a §0.2 deste mesmo documento estabelece que, sob túnel,
**tráfego de túnel e tráfego de loopback são indistinguíveis**. A frase só tem conteúdo porque
**o túnel é derrubado junto** — é a derrubada que cria a distinção, não a checagem de origem.
Logo: (a) a implementação **não pode** depender de `isTrustedRemote` para separar os dois, e (b)
enquanto o modo restrito estiver ativo, **`/ligar` é recusado** — sem isso, o dono (ou o atacante
que já controla o chat) reabre a exposição no comando seguinte e o controle vira decorativo. Isso
é requisito de T5.1 e item de teste.

---

## 7. Allowlist de `chat_id`: o controle crítico do canal de comando

### 7.1. A regra, e o erro que quase todo mundo comete

A Bot API **não oferece nada pronto**. Sem allowlist, `t.me/seu_bot` é um endpoint público
de administração.

**Valide `from.id`, não (apenas) `chat.id`.** Motivos concretos:

1. `callback_query` chega com `callback_query.from`. Num grupo, **qualquer membro** pode
   apertar o botão de uma mensagem que o bot enviou. Se você validou só `chat.id`, está
   furado.
2. `message.from` é **opcional** (ausente em channel posts). Ausência = **negação**.
3. Portanto: valide nos **dois** eixos — `from.id ∈ ALLOWLIST` **E** `chat.id ∈ ALLOWLIST`.
4. **Nunca** por `username`: username é mutável e sequestrável. Só IDs numéricos.
5. `Chat.id` e `User.id` têm até **52 bits significativos** — use `number` (double do JS é
   seguro até 2^53) ou `bigint`. **Nunca** `int32`.
6. Default **deny**. Allowlist vazia = bot inerte que responde apenas
   "não configurado, rode o onboarding na máquina".

```ts
// pseudocódigo — o único lugar onde se decide autorização do canal
function isOwner(u: Update): boolean {
  const from = u.message?.from?.id ?? u.callback_query?.from?.id
  const chat = u.message?.chat?.id ?? u.callback_query?.message?.chat?.id
  if (from === undefined || chat === undefined) return false        // fail closed
  return ALLOW.has(from) && ALLOW.has(chat)
}
```

### 7.2. Como obter o `chat_id` com segurança no onboarding

O fluxo tem uma janela perigosa: entre "o bot existe" e "a allowlist está preenchida",
**qualquer pessoa que descubra o bot pode ser a primeira a mandar `/start` e virar o dono**.
O onboarding fecha essa janela assim:

| Passo | O quê | Controle |
|---|---|---|
| 1 | O usuário cria o bot no BotFather (`/newbot`) e cola o token **no terminal local**, nunca em chat | o token entra pela UI local (loopback) ou por `TELEGRAM_BOT_TOKEN` |
| 2 | O plugin valida o token com `getMe` — método oficial para isso (<https://core.telegram.org/bots/api#getme>) | falha ruidosa se inválido |
| 3 | O plugin gera um **código de pareamento** de 6 dígitos, exibido **só no terminal/UI local**, válido por 5 min | quem não tem acesso local não pareia |
| 4 | O plugin liga o polling com `drop_pending_updates: true` e `allowed_updates: ["message","callback_query"]` | descarta até 24h de updates represados; sem isso, comandos velhos executam em avalanche |
| 5 | O usuário manda `/parear 123456` no chat com o bot | o código prova posse do terminal |
| 6 | O plugin grava `from.id` **e** `chat.id` no `state.json` e **fecha o pareamento permanentemente** | segundo `/parear` é recusado; reabrir exige `--reset-pairing` na máquina |
| 7 | Qualquer update de outro `from.id` daí em diante: descartado silenciosamente, **contado**, e o dono é avisado uma vez por hora | não dá oráculo ao estranho |

**Por que código de pareamento e não "o primeiro que der `/start` vence":** o segundo é
uma corrida que o atacante pode ganhar, especialmente se o username do bot for previsível.
O código amarra a identidade do Telegram à **posse do terminal**, que é a raiz de confiança
real deste sistema.

**Alternativa oficial documentada, opcional:** `KeyboardButtonRequestUsers` produz o
service message `users_shared` (<https://core.telegram.org/bots/api#usersshared>). É o
mecanismo de UI oficial para o usuário informar IDs. Não substitui o código de pareamento;
pode complementar.

### 7.3. O que acontece de verdade se o token do bot vazar (T5)

Esta subseção existe porque a formulação intuitiva está **errada** e circulou neste
projeto. A formulação errada é: *"quem tem o token contorna completamente a allowlist,
porque age como o bot; logo vazamento de token = capacidade de acionar as ações
destrutivas"*. **Isso é falso como generalização** e a §12.2 traz o detalhe.

**A direção está invertida.** O token autentica chamadas **saindo** para a API do Telegram.
A ação destrutiva é disparada por um update **entrando**. No desenho deste plano
(**long polling**, decidido em `01-ARQUITETURA.md`), o bot **não tem endpoint HTTP**: não
existe para onde o portador do token possa fazer POST de um update forjado com
`from.id`/`chat.id` da allowlist. E a doc fecha o laço interno: "bots will not be able to
see messages from other bots regardless of mode"
(<https://core.telegram.org/bots/faq>) — o `sendMessage` do atacante não volta como update
para o nosso worker.

**O que o vazamento realmente dá** (grave, mas em outro eixo — confidencialidade e
disponibilidade, não execução local):

| Capacidade | Consequência |
|---|---|
| `getUpdates` | **rouba a fila**: updates confirmados somem do servidor, e o dono legítimo **nunca vê** aqueles comandos ("Only one consumer receives each update") |
| `setWebhook` | aponta para o servidor do atacante e exfiltra em tempo real tudo que chega ao bot |
| `sendMessage` | personifica o bot perante o dono |
| conflito de `getUpdates` | DoS: HTTP 409 `"Conflict: terminated by other getUpdates request"` derruba nosso polling |
| `logOut`/`close` | derruba o bot |

**O vetor real de execução, e é um só: deputado confuso.** Com o token, o atacante manda —
**como o bot** — uma mensagem com teclado inline cujo `callback_data` é um comando
destrutivo. Se **o dono clicar**, o `callback_query` chega com `from.id`/`chat.id`
legítimos e passa na allowlist. Isso exige ação do usuário legítimo; não é "contornar
completamente".

**Mitigação que fecha esse vetor (obrigatória):**

```
Toda ação destrutiva ou que AUMENTA exposição usa nonce emitido pelo servidor:

1. servidor gera nonce = randomBytes(8).toString('base64url')   # ~11 chars
2. guarda { nonce -> {acao, exp: now+60s, usado:false} }  EM MEMÓRIA
3. callback_data = `${acaoCurta}:${nonce}`                # ≤64 BYTES, limite duro da API
4. ao receber callback: valida from.id/chat.id, DEPOIS procura o nonce
   - nonce desconhecido  -> recusa + ALERTA "botão não emitido por mim" (isto É o detector de T5)
   - nonce expirado/usado -> recusa silenciosa
   - ok -> consome, executa, answerCallbackQuery
```

`callback_data` é **client-supplied** — um cliente modificado manda qualquer string. A
própria doc avisa que "the message originated the query can contain no callback buttons
with this data". Portanto `callback_data` **nunca** é prova de autorização. O nonce
server-side transforma um botão forjado num **alarme**, que é a melhor propriedade
possível aqui.

**Assimetria deliberada de confirmação** (fail-safe na direção certa):

| Ação | Confirmação |
|---|---|
| `/desligar`, derrubar túnel, `/emergencia` (**reduzem** exposição) | **sem** confirmação — em pânico, o botão tem que funcionar de primeira |
| `/ligar`, abrir túnel, `/acessar` (link mágico), `/rotacionar` (**aumentam** exposição) | 2 etapas com nonce de 60s |

**Higiene do token** (detalhe estrutural útil): o formato é `<bot_user_id>:<segredo>`, com
`user_id > 0` e `< 2^54`, total ≤80 chars, sem `/`, não começa com `0`. Ou seja **o token
vaza o ID numérico do bot** — não é opaco, e um regex de mascaramento
(`bot\d+:[\w-]+`) precisa existir no logger. Cuidado extra: o token vai na **URL** das
chamadas, então ele aparece em log de HTTP, proxy e APM. Rotação: `/token` no BotFather
revoga o antigo. Transferência de posse do bot é **permanente e irreversível** e dá acesso
às mensagens (<https://core.telegram.org/bots/features>).

### 7.4. Uma instância só

`getUpdates` e `setWebhook` são mutuamente exclusivos, e **duas instâncias fazendo polling
produzem 409** — o servidor mata o long-poll antigo e ainda faz throttle. Consequência de
arquitetura: **long polling não escala horizontalmente sem líder eleito**; duas réplicas =
flapping infinito. Para este produto (um dono, uma máquina) isso é uma feature: o plugin
deve **detectar** o 409 e reportá-lo como "há outro processo usando este bot", que é
exatamente o sinal de T5 ou de um segundo DSH esquecido rodando.

---

## 8. Higiene de segredos

### 8.1. Onde cada segredo vive

| Segredo | Onde vive | Modo | Nunca |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | `$XDG_STATE_HOME/dsh-guarded-bot/secrets.env` (ou variável de ambiente do processo do DSH) | `0600`, dir `0700` | git, argv, log, mensagem do bot, workspace |
| Segredo de acesso (senha) | **não existe em disco**; só `sha256` no `state.json` | `0600` | git, log, Telegram, argv |
| Sessões (`sid`) | `state.json` guarda apenas `sha256(sid)` | `0600` | log em claro |
| Nonces de confirmação e `mk` do link mágico | **memória do processo**, nunca em disco | — | qualquer persistência |
| Token do túnel (Modo B) | arquivo próprio, entregue por `--token-file` | `0600` | `--token` em argv (vaza no `ps`) |
| Credenciais do `cloudflared` (Modo B) | `~/.cloudflared/*.json`, `cert.pem` | como o `cloudflared` cria | git |
| URL do túnel ativa | `state.json` + mensagem no Telegram | — | log de auditoria em forma completa (só hash curto) |

**Modo A não cria estado:** após execuções completas de quick tunnel, `~/.cloudflared`
**não é criado** — verificado. Não há credencial persistente a proteger nesse modo.

### 8.2. Regras duras

1. **`.gitignore` ganha** `secrets.env`, `state.json`, `*.pem`, `*.tunnel.json`,
   `.cloudflared/`. O `.gitignore` atual já cobre `.env` e `.env.local` — insuficiente.
2. **`gitleaks` no pre-commit e no CI**, com regra custom para `bot\d+:[\w-]+` (token do
   Telegram) e para base32 de 52 chars. Falhar o job é o comportamento correto.
3. **Mascaramento no logger** é código, não convenção: um `redact()` aplicado no ponto de
   saída, cobrindo o padrão do token, `Authorization:`, `Cookie:` e o `mk` do link mágico.
   O plugin já tem `LOG_SCOPE` centralizado — o `redact` entra ali.
4. **Nunca logar `req.headers` inteiro.** Allowlist de headers logáveis
   (`method`, `path` canônico, `content-length`, `user-agent` **hasheado**).
5. **`assertUsableCredential()` fica** e ganha um caso novo: recusar segredo com menos de
   26 chars base32 (128 bits), porque agora existe geração automática e um segredo curto
   só chega ali por edição manual errada.
6. O `cordis.patch.yml` **não deve mais** derivar a credencial de `ADMIN_USER`/`ADMIN_PASS`
   via `!!js`. Isso muda para leitura do `state.json` gerenciado pelo plugin. O bloco `!!js`
   atual (linhas 238 e 419) é um lugar onde uma senha pode acabar num arquivo versionável.
7. **Permissões verificadas em runtime:** no boot, se `state.json` ou `secrets.env`
   estiverem com modo mais permissivo que `0600`, o plugin **recusa carregar** (mesma
   política "fail loud at load" que `assertSecureBind` já aplica).

### 8.3. O worker não recebe `process.env` inteiro — o controle já existe

`buildWorkerEnv()` (src/index.ts:621) já monta o ambiente do filho por **allowlist**
(`WORKER_ENV_ALLOWLIST` + prefixos `LC_*`) e injeta o token **por ambiente e nunca por
argv**, com a justificativa correta no comentário: "argv é legível por qualquer processo
local em `/proc/<pid>/cmdline`". Isto **fica**, e o plano estende:

| Mudança | O quê |
|---|---|
| **Dividir em dois perfis** | `buildWorkerEnv(source, {telegramToken})` para o worker do bot e `buildTunnelEnv(source, {tunnelToken?})` para o `cloudflared`. Hoje há um só, e o `cloudflared` **não pode** receber `TELEGRAM_BOT_TOKEN` |
| Princípio | cada filho recebe **exatamente** os segredos que precisa e nada além |
| Teste | um teste por perfil assertando que a variável do outro **não** está presente |

### 8.4. Nota sobre a API real do subprocesso (correção que afeta segurança)

A `spawn` real do serviço de subprocesso do DSH tem assinatura de **objeto único**:

```ts
abstract spawn(spec: SubprocessSpawnSpec): SubprocessHandle
// campos obrigatórios: argv: readonly string[], cwd: string,
//                      stdio: SubprocessStdio, graceMs: number
//                      signal?: AbortSignal
```

Isso é relevante para segurança por dois motivos: (a) `argv` sendo um array explícito
elimina a tentação de `shell: true` — **nenhum caminho deste plugin pode usar `shell`**,
porque interpolar hostname de túnel ou path de workspace num shell é injeção de comando;
(b) `graceMs` é obrigatório, o que força uma decisão explícita sobre a janela SIGTERM→
SIGKILL em vez de herdar um default. Ver §12.6 e `01-ARQUITETURA.md`.

O supervisor existente (`createWorkerSupervisor`, src/index.ts:705) usa `detached: true` +
`process.kill(-pid)`, que é a técnica correta em POSIX: o grupo de processos é resolvido
**pelo kernel no momento do sinal**, sem a corrida inerente à enumeração por snapshot que
`tree-kill` faz. Isto **fica**. Duas correções de precisão para os comentários:

- A afirmação "`child.kill()` **nunca** basta quando há shell" é forte demais: com
  `/bin/bash`, o shell faz `exec` do último comando e nem existe como processo
  intermediário; com `/bin/sh` (dash) ele fica e o neto sobrevive. A regra segura é
  **sempre `detached: true` + `kill(-pid)`**, que funciona nos dois casos. Ver §12.5.
- `process.kill(-child.pid)` só é seguro quando **nós** garantimos `detached: true`. Sem
  isso, o PID não é um PGID e o sinal pode acertar **outro grupo** por coincidência de
  número (reuso de PID). Nunca aplicar `kill(-pid)` a um filho que não foi spawnado com
  `detached`.

---

## 9. Modos de falha — todos DEVEM ser fail-safe

Regra geral: **na dúvida, feche.** Nenhum caminho de erro pode terminar em "deixa passar".

| Falha | Detecção | Comportamento exigido | Anti-padrão proibido |
|---|---|---|---|
| `cloudflared` morre sozinho | evento `'close'` do filho (**não** `'exit'` — ver abaixo) | marca túnel como caído, invalida sessões, avisa no Telegram, **não** reabre automaticamente sem confirmação do dono | reabrir túnel sozinho: recria exposição sem consentimento |
| `cloudflared` não sobe (binário ausente) | `'error'` com `ENOENT`, `child.pid === undefined`, `exitCode === -2` | erro claro com instrução de instalação; **não** faz retry | loop de retry: `ENOENT` é determinístico |
| URL não aparece em 30s | polling em `/quicktunnel` estoura o timeout | mata o `cloudflared`, reporta falha | assumir que subiu |
| Gate não está armado quando o túnel ia subir | **qualquer uma das quatro sondas** de §L1 falhou (não só a de `/`) | **túnel não sobe**, estado vai para `FAILED`, e a mensagem ao dono **nomeia a sonda** | subir e "ajustar depois"; ou testar só `/`, que não cobre `/api` nem o upgrade |
| Rede cai | polling do Telegram falha; túnel cai | worker faz backoff com **full jitter** (base 250ms, teto 30s); túnel fica caído até comando; o DSH local segue funcionando | hot-loop de reconexão |
| Token do bot revogado/inválido | `getMe` ou `getUpdates` devolve 401 | para o polling, log de erro, **mantém** o DSH e o gate funcionando; a UI local avisa | tentar para sempre |
| HTTP 409 no `getUpdates` | resposta da API | **alerta de segurança** ("outro processo usa este bot") + para o polling | ignorar e reiniciar em laço |
| TTL do túnel expira | timer | derruba túnel, invalida sessões, avisa | prorrogar sozinho |
| `state.json` corrompido | parse falha | recusa carregar (fail loud), instrui `--reset` explícito | recriar em silêncio: geraria segredo novo sem o dono saber |
| Permissão do arquivo de segredo frouxa | `statSync().mode` no boot | recusa carregar | corrigir em silêncio |
| Supervisor (DSH) morre com `SIGKILL` | — | os filhos sobrevivem: é irrecuperável em POSIX puro | fingir que `cleanup` resolve |
| Erro dentro do caminho de decisão de auth | `catch` | 401/socket destruído | `catch` que retorna `true` |

**Detalhe de implementação que é causa comum de travamento silencioso:** o **único evento
terminal universal** de um `ChildProcess` do Node é **`'close'`**. Num `ENOENT`, a
sequência medida é `error → close` e **`'exit'` NUNCA dispara**. Um supervisor que espera
por `'exit'` **trava para sempre** exatamente no modo de falha mais comum (binário
ausente / PATH errado). Toda lógica de supervisão neste plano pendura em `'close'`;
`'error'` só classifica a causa (<https://nodejs.org/api/child_process.html>).

Complemento: o `'spawn'` **não** é readiness — a doc avisa que ele dispara "regardless of
whether an error occurs within the spawned process", inclusive com `shell: true`.
Readiness do `cloudflared` = polling do endpoint de métricas com `AbortController`
abortado no `'close'` do filho.

**Órfãos.** Se o DSH cair de forma abrupta, o `cloudflared` pode sobreviver — e um túnel
órfão é uma URL pública viva sem gate por trás. O `cloudflared` sobe `detached: true`, que é
precisamente o que faz o órfão sobreviver, e o dead-man's switch por pipe herdado **não cobre** o
caso de a máquina reiniciar. Controles: (a) `--pidfile` e verificação no boot seguinte, matando o
órfão antes de subir; (b) `graceMs` explícito; (c) no boot, checar se o `state.json` registra
`tunnel: { pid, startedAt }` e, em caso positivo, **derrubar antes de qualquer outra coisa**.
**Dono: T3.1** (`src/tunnel/pidfile.ts`), com o `StateStore` de T2.5 e o teste de caos de T6.4 —
na revisão anterior este controle era exigido aqui, **testado** por T6.4 e por `E2E-012/013`, e
**não tinha nenhuma sub-tarefa que o construísse**: teste sem dono é teste que alguém apaga.
Note também que o que é persistido é `pid`/`startedAt`, **não a URL** — a URL do quick tunnel é
efêmera e muda a cada restart, e a formulação antiga ("túnel órfão registrado em `state.json`")
não dizia o que era registrado. Isto é critério de aceite (§10.2).

---

## 10. Checklist de aceite

O revisor de cada onda marca isto. Item não marcado = onda não aceita.

**Regra de honestidade deste checklist, e ela vale mais que qualquer item dele.** Um controle
descrito aqui e **não construído** é pior que um controle ausente: ele aparece no documento, o
revisor o lê, e ninguém verifica que não existe. Por isso, **todo item desta seção tem, na coluna
"dono", a sub-tarefa de `03-ONDAS.md` que o constrói e a família de casos de `04-TESTES.md` que o
verifica** — ou está explicitamente rebaixado a **risco residual aceito** na §11, com a razão
escrita. Não existe meio-termo, e não existe item sem uma das duas marcas.

Auditoria anterior deste conjunto encontrou **seis** controles declarados obrigatórios aqui e sem
nenhuma sub-tarefa que os construísse: TTL do túnel, pareamento por código, probe fail-closed,
modo restrito, pidfile de órfão e invalidação de sessão ao derrubar o túnel — três deles com teste
escrito em `04-TESTES.md` para código que ninguém ia escrever. Os seis passaram a ter dono
(T3.1, T4.1/T4.4, T3.1, T2.3/T3.3, T3.1, T3.1/T3.3). O que **não** conseguiu dono está na §11.

### 10.1. Invariantes preservadas do plugin atual

- [ ] `assertSecureBind()` inalterado; existe teste que falha se `0.0.0.0`, `::`, `*` ou host fora de `allowedHosts` **não** causar `throw` no `apply()`.
- [ ] Não existe nenhuma opção de configuração capaz de relaxar o bind, em nenhum modo.
- [ ] `createGuardedUpgradeHandler()` continua guardando o handshake de WebSocket **inteiro**, sem consultar `guardedPrefixes`.
- [ ] `verifyBasicAuth()` continua comparando **digests SHA-256 de 32 bytes** via `timingSafeEqual`, nunca os valores crus.
- [ ] 403 (origem) continua distinto de 401 (credencial), e 403 não emite `WWW-Authenticate`.
- [ ] `catch` no caminho de upgrade continua destruindo o socket (fail-closed).
- [ ] Ouvinte `security/permission-elevate` e `deniedPermissions` continuam ativos.
- [ ] `buildWorkerEnv()` continua sendo allowlist e o token continua entrando por ambiente, nunca por `argv`.
- [ ] Disposers continuam propagados; descarregar o plugin mata worker **e** túnel (LIFO).

### 10.2. Novos controles do túnel

| Controle | Dono (03) | Verificação (04) |
|---|---|---|
| Túnel **não sobe** se **qualquer uma das quatro sondas** de §L1 falhar; a mensagem ao dono **nomeia a sonda**. Não basta "o probe em `/` responde": `/` vem do `registerFallback` do frontend estático e `/api` vem de outro registro — provar `/` não prova `/api`, e foi exatamente essa diferença que expôs o DSH real por ~40 s na pesquisa | **T3.1** (`src/tunnel/probe.ts`) | `TUN-020…TUN-023`, uma por sonda |
| No boot, túnel órfão registrado no `state.json` é derrubado **antes** de qualquer outra inicialização | **T3.1** (`src/tunnel/pidfile.ts`) + **T2.5** (`StateStore`) | Onda 6, T6.4 |
| `--loglevel debug` do `cloudflared` é impossível de ativar; teste inspeciona `argv` | **T3.1** (`src/tunnel/args.ts`) | `TUN-*` de argv |
| `--metrics 127.0.0.1:<porta>` é explícito; nada depende do default | **T3.1** (`src/tunnel/args.ts`) | `TUN-*` de argv |
| URL extraída via `GET /quicktunnel`, com fallback por regex sobre **stderr**; teste cobre os dois | **T3.2** | `TUN-001…TUN-011` |
| **TTL obrigatório no Modo A**: default 60 min, teto 480 min, `0`/ausente/`>480` é config inválida **recusada no load**. Ao expirar: derruba o túnel, invalida sessões, avisa no Telegram | **T3.1** (`src/tunnel/ttl.ts`) | `TUN-016…TUN-019`, com relógio injetado |
| Derrubar o túnel invalida **todas** as sessões emitidas | **T3.1** + **T3.3** (fiação no gate) | `TUN-016…TUN-019` e `SESS-*` |
| L4 permanece obrigatória no Modo B; **não existe** flag "tenho Access, dispensa senha" | **T3.3** | Suíte de T6.3 |
| Nenhum `shell: true` em nenhum spawn; `argv` sempre array | **T1.1** / **T3.1** | Lint + `TUN-*` |
| Token do túnel (Modo B) por `--token-file`; teste falha se aparecer em `argv` | **T3.1** (`src/tunnel/args.ts`) | `TUN-014` |

#### Roadmap v0.2 — **fora do aceite da v0.1**

- **Validação do header `Cf-Access-Jwt-Assertion`** (`kid`, `iss`, `aud`, `exp`). O que **está** na
  v0.1 é o **transporte** named tunnel: `tunnel.mode: 'named'` com `tunnel.tokenFile` entregue por
  `--token-file`, sem onboarding automatizado — conta, domínio e política de Access o usuário
  configura fora do plugin. Adiar a validação do JWT **não enfraquece a linha de base**, e a razão
  é estrutural: **L4 continua obrigatório no Modo B**, então a borda é defesa em profundidade sobre
  uma credencial que já é exigida. Marcar isto como aceite da v0.1, como versões anteriores deste
  documento faziam, cobrava de `03-ONDAS.md` uma entrega que ele declarava adiada e que
  `07-COMUNIDADE.md` anunciava publicamente como futuro.

### 10.3. Credencial e sessão

- [ ] Segredo gerado por `crypto.randomBytes(32)`; teste falha se a fonte não for CSPRNG.
- [ ] Segredo exibido em base32 RFC 4648, sem padding; canonicalização ignora `-` e caixa.
- [ ] Disco guarda **apenas** `sha256`; teste grep no `state.json` procurando o segredo em claro.
- [ ] Cookie `__Host-dsh_sid`: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, valor opaco ≥128 bits.
- [ ] Sessão: inatividade 60 min, absoluto 8h, morte com o túnel.
- [ ] Rotação invalida todas as sessões.
- [ ] Não há rotação obrigatória por calendário (NIST 63B-4).
- [ ] Existe teste que garante que o segredo permanente **nunca** aparece num payload de `sendMessage`.

### 10.4. Força bruta e alerta

- [ ] Backoff exponencial com **full jitter** a partir da 5ª falha/IP/10 min, teto 30s.
- [ ] Ban de IP em ≥15 falhas por 60 min.
- [ ] 100 falhas consecutivas → **modo restrito** (só loopback + túnel derrubado), **não** lockout permanente.
- [ ] Modo restrito **persiste** entre reinícios.
- [ ] Resposta de falha genérica e idêntica; sem oráculo de existência ou de ban.
- [ ] Alerta na **primeira** falha da janela, com botão de kill switch. *(Dono: **T5.4** compõe e
      **T5.2** renderiza o botão; o botão executa o `ControlIntent` de **T5.1**.)*
- [ ] Alerta em **toda sessão nova bem-sucedida**, com botão "não fui eu". *(Dono: **T5.4**,
      consumindo o gancho congelado no COMMIT PREP 5 dentro de `src/http/gate.ts`. Note que a
      definição **não** pode depender de IP: se S2 disser que a borda não repassa IP confiável,
      "acesso não reconhecido por IP" é uma frase sem conteúdo — por isso o gatilho é **toda**
      sessão nova, não "a primeira de origem desconhecida".)*
- [ ] **Relatório periódico**: a cada 30 min de túnel aberto, o bot manda o tempo restante do TTL
      e um botão de encerrar. É o controle desenhado contra T10 (operador cansado). *(Dono:
      **T5.4**, alimentado pelo timer de `src/tunnel/ttl.ts` de T3.1.)*
- [ ] 429 do Telegram tratado esperando `retry_after`; nunca retry cego.

### 10.5. Telegram

- [ ] Allowlist valida `from.id` **E** `chat.id`; ausência de `from` = negação.
- [ ] IDs tratados como `number`/`bigint` de 64 bits; teste com id > 2^31.
- [ ] Allowlist só por ID numérico; nenhum caminho aceita `username`.
- [ ] Pareamento por código de 6 dígitos exibido **só localmente**, TTL 5 min, uso único, fechado
      permanentemente após sucesso; reabrir exige `--reset-pairing` **na máquina**. *(Dono:
      **T4.1** `src/telegram/pairing.ts` + **T4.4** `worker/auth/pairing.ts`. `/start` responde
      boas-vindas e **não pareia ninguém**.)*
- [ ] **Tentativas de `/parear` têm teto e descarte.** Seis dígitos são 10⁶ e as tentativas chegam
      por definição de um `from.id` **desconhecido** — a allowlist não pode filtrá-las. Sem
      contagem por chat e teto, força bruta dentro dos 5 min de TTL é viável. *(Dono: **T4.4**.)*
- [ ] Polling com `drop_pending_updates: true` e `allowed_updates: ["message","callback_query"]` no boot.
- [ ] `callback_data` ≤ **64 bytes** e composto por `acao:nonce`.
- [ ] Nonce server-side em memória, TTL 60s, uso único; nonce desconhecido gera **alerta**.
- [ ] Ações que reduzem exposição **não** exigem confirmação; as que aumentam, exigem.
- [ ] `answerCallbackQuery` chamado **sempre**, inclusive em recusa.
- [ ] HTTP 409 tratado como sinal de segurança, com alerta.
- [ ] Nenhuma mensagem do bot contém segredo permanente, token ou URL de túnel com credencial embutida.

### 10.6. Segredos e arquivos

- [ ] `state.json` e `secrets.env` em `0600`, diretório `0700`, **fora do workspace**.
- [ ] Boot recusa carregar se as permissões estiverem frouxas.
- [ ] `.gitignore` cobre `secrets.env`, `state.json`, `*.pem`, `*.tunnel.json`, `.cloudflared/`.
- [ ] `gitleaks` no CI, com regra para `bot\d+:[\w-]+`.
- [ ] `redact()` no logger, coberto por teste com token real-formato.
- [ ] `buildWorkerEnv` e `buildTunnelEnv` separados; teste cruzado provando que cada um **não** vaza o segredo do outro.
- [ ] `cordis.patch.yml` não deriva mais credencial de `ADMIN_USER`/`ADMIN_PASS` via `!!js`.

### 10.7. Documentação honesta (sim, isto é critério de aceite)

- [ ] O README diz que `trustedRemotes` fica **inerte** sob túnel, e o log de arranque avisa.
- [ ] O onboarding diz que o túnel **fura o firewall** do usuário.
- [ ] O onboarding apresenta T7 (Cloudflare vê o texto claro) **antes** do primeiro túnel, com alternativas (VPN/SSH).
- [ ] O onboarding diz que a URL do túnel **não é segredo**.
- [ ] O onboarding avisa sobre a reputação de malware do domínio `trycloudflare.com` em redes gerenciadas.
- [ ] A documentação **não** afirma que o sandbox do DSH é fronteira de segurança.
- [ ] A documentação **não** repete nenhuma das afirmações refutadas na §12.

---

## 11. Risco residual — o que continua perigoso

Nada disto é resolvido pelo plano. É o preço de fazer o que o usuário pediu.

1. **Prompt injection continua sem defesa confiável.** Taxa de sucesso >85% contra defesas
   estado-da-arte; a maioria das defesas avaliadas fica <50% de mitigação. O agente lê
   conteúdo hostil como parte do trabalho normal. O veto de elevação e a confirmação humana
   reduzem o dano; não fecham a porta.
2. **Quem tem a senha tem shell.** Não há segundo fator no Modo A. Se o segredo vazar do
   gerenciador de senhas do usuário, acabou. No Modo B, o Access com One-time PIN é o
   segundo fator — e é por isso que ele é o modo recomendado.
3. **A Cloudflare vê tudo em claro (T7).** Sem mitigação técnica. Decisão de confiança.
4. **T6 com acesso concorrente ao celular derrota o link mágico.** TTL curto não protege
   contra quem está olhando a tela naquele instante.
5. **O sandbox do DSH é escapável (#1769) e falha em silêncio (#3144).** Não conte com ele.
6. **`state.json` em `0600` não é secrets management.** ASVS 13.3.1 pede key vault; nós
   entregamos permissão de arquivo. Qualquer processo com o mesmo UID lê tudo (T8) — e
   "qualquer processo com o mesmo UID" inclui a próxima dependência npm comprometida.
7. **`SIGKILL` no processo do DSH deixa o `cloudflared` órfão** até o próximo boot. A
   janela é real, mesmo com pidfile.
8. **O ecossistema DSH inteiro está em `0.0.1-rc`/`0.1.0-rc`**, com o README oficial
   avisando "developer preview, expect breaking changes". Uma atualização pode mudar o nome
   do serviço interceptado e **desarmar o gate em silêncio**. Mitigação parcial: pinar
   versões exatas **e** ter um teste de fumaça que prove que uma requisição anônima recebe
   401 — se o intercept parar de funcionar, esse teste é o que avisa.
9. **`ctx.intercept` só envolve registros feitos DEPOIS do `apply()`** (nota já presente em
   src/index.ts:1610). Se a ordem de carga mudar, rotas podem escapar do gate. O teste de
   fumaça da linha anterior é a única rede de proteção contra isso.
10. **Não há revisão de segurança independente deste plugin.** Um bug de lógica no gate —
    um `canonicalRequestPath` que normaliza diferente do roteador do DSH, por exemplo —
    vale mais para um atacante do que todas as camadas acima somadas.
11. **Modo A não tem SLA** e o hostname muda a cada restart, o que empurra o usuário a
    manter o túnel aberto por mais tempo do que precisa — exatamente T10. Mitigado, não
    eliminado, pelo TTL obrigatório e pelo relatório de 30 min.
12. **O agente pode abrir o próprio túnel, e nada neste plano impede, detecta ou audita isso.**
    A §2.4 diz "o agente não abre túnel, não emite link de acesso, não rotaciona senha". Isso é
    **política, não controle**: o agente tem shell com o UID do dono. Um prompt injection
    bem-sucedido — que a própria §2.4 trata como certeza operacional, não como risco — pode rodar
    `cloudflared tunnel --url http://127.0.0.1:3080` num **segundo** processo, que o
    `TunnelSupervisor` não spawnou, que não está no `state.json`, que não tem TTL e que não aparece
    na máquina de estados. O dono manda `/desligar`, o bot responde "túnel fechado", o relatório de
    30 min confirma — e a máquina continua exposta pelo túnel do atacante. O mesmo vale para
    exfiltração por saída (`curl` de `~/.ssh/id_ed25519`, `.env`, `~/.config/gh/hosts.yml`): o
    `buildWorkerEnv`/`buildTunnelEnv` protege **subprocessos do plugin**, não o agente.
    **Consequência que precisa estar escrita:** todos os controles temporais deste documento —
    TTL, kill switch, relatório de 30 min, invalidação de sessão — vigiam **apenas o túnel do
    plugin**. O modelo aqui é `internet → gate → agente`; a direção `agente → saída → atacante`
    **não é modelada**, e é justamente a que a §2.4 identifica como a mais provável.
    **Aceito como risco residual, não mitigado.** Fechá-lo exigiria egress filtering ou namespace
    de rede — componente de maior privilégio que o próprio plugin, com modelo de segurança
    próprio, e portanto onda própria. O que a documentação **deve** dizer ao usuário: se o agente
    for comprometido, `pgrep -f cloudflared` mostrando **mais de um** processo é o sinal, e nenhum
    controle deste plano roda esse comando fora do teardown de teste.
13. **A validação do `Cf-Access-Jwt-Assertion` fica para a v0.2** (§10.2, Roadmap). No Modo B, até
    lá, a borda é confiada sem verificação criptográfica da asserção. **Aceito** porque L4 continua
    obrigatório: a borda nunca é a única barreira, e o dano de uma política de Access mal
    configurada é limitado pela senha do plugin.

**A recomendação honesta, que a documentação deve repetir:** se o repositório contém
segredos de produção ou código sob NDA, **não use o túnel**. Use Tailscale/WireGuard ou
`ssh -L`. Eles não têm T7, não colocam URL pública em feed nenhum, e o custo de configurar
é uma tarde.

---

## 12. Errata: afirmações refutadas que NÃO podem ser usadas

Cada item abaixo circulou neste projeto, soa plausível e **foi refutado por verificação**.
Reintroduzi-las em código, comentário, README ou em qualquer arquivo do plano é motivo de
rejeição em revisão.

### 12.1. "O ASVS 5.0 §6.5.2 autoriza SHA-256 em vez de Argon2 para tokens de 128 bits"

A **citação** é literal e correta ("A standard hash function can be used if the secret has
112 bits of entropy or more", ASVS 5.0.0, `0x15-V6-Authentication.md`, L2). A **inferência**
é falsa: o requisito vive em "V6.5 General Multi-factor authentication requirements" e seu
escopo textual são **lookup secrets** (códigos de recuperação de MFA, espelhando NIST
63B §5.1.2.2), não tokens de API ou de sessão. Nada no ASVS 5.0 estende esse limiar a
tokens em geral — 11.4.2 fala de *passwords*, 7.2.3 fala de entropia de geração e não de
armazenamento. A norma é **silente**. Nossa decisão de usar SHA-256 (§4.2) é um argumento
de engenharia, e está escrita como tal.

### 12.2. "Quem tem o token do bot contorna completamente a allowlist"

Refutado como generalização — ver §7.3. A direção está invertida (o token autentica saída;
a ação vem de update entrando) e, sob long polling, não há endpoint para POST de update
forjado. O que existe é o vetor de **deputado confuso**, que exige clique do dono e é
fechado pelo nonce server-side. Escreva "o vazamento do token compromete confidencialidade
e disponibilidade do canal, e permite deputado confuso" — nunca "contorna a allowlist".

### 12.3. "Quick tunnels não suportam SSE, logo o streaming do LLM quebra"

A frase **está** na doc oficial da Cloudflare. A conclusão é falsa e foi testada ao vivo:
com um quick tunnel real e origem servindo `text/event-stream`, um **POST** com
`Accept: text/event-stream` chegou em streaming real (eventos a 0,47s / 0,97s / 1,47s…,
espaçamento idêntico ao da origem, `content-type: text/event-stream`, HTTP/2 200,
reproduzido 2×). O caso quebrado é **GET**, que bufferiza até o servidor fechar — o que
casa com `cloudflared` issue #1449. Streaming de token de LLM é **POST**
(`/v1/chat/completions` com `stream:true`). E, neste harness, a premissa é duplamente
falsa: o DSH **já migrou** o downlink de telemetria de SSE para um **WebSocket dedicado**
(documentado em src/index.ts:935), e WebSockets passam normalmente pelo quick tunnel.

Os argumentos **legítimos** contra o Modo A são outros e estão na §0.5: teto de 200
requisições em voo (429), sem SLA, hostname aleatório a cada restart, e ausência de
qualquer autenticação no nível do túnel.

### 12.4. "URLs de quick tunnel são indexadas por motores de busca"

**Não reproduzível.** A busca `site:trycloudflare.com` retornou apenas páginas da própria
Cloudflare, zero subdomínios aleatórios; a URL usada como prova não aparece no urlscan nem
no Wayback. Além disso, o `robots.txt` daquele host foi mal transcrito na alegação original
(ele contém `Allow: /auth/` e `Allow: /api/docs/`, ou seja libera caminhos de propósito),
o que destrói o "gotcha" que a alegação construía. O risco de descoberta é real, mas pela
via de **feeds e scanners** (§2.2), não pela via de busca. Classifique esta linha como
**baixa confiança / não reproduzível** em qualquer arquivo que a cite.

### 12.5. "`child.kill()` nunca basta quando há shell intermediário"

A citação da doc do Node é literal e atual. A conclusão "nunca" é falsa: com `/bin/bash`,
o shell faz `exec` do último comando e não sobra processo intermediário — `child.kill()`
mata o processo real. Com `/bin/sh` (dash), o shell permanece e o neto sobrevive. Também
não é "on Linux": é comportamento POSIX. A regra segura, que o plugin já aplica, é
**sempre `detached: true` + `process.kill(-pid)`**.

Correlato refutado: "sem `detached` o filho herda o PGID do pai e `kill(-child.pid)` dá
ESRCH" vale **apenas no instante do fork**. Um filho que chame `setsid()`/`setpgid()`
(`setsid`, `sudo`, `ssh`, `tmux`, shell com job control) quebra a premissa — e aí
`kill(-child.pid)` pode acertar **outro grupo**. Igualmente falso em geral:
"`process.kill(-process.pid)` mataria o próprio supervisor" — só se o supervisor for líder
de grupo, o que medido **não** era o caso.

### 12.6. Nomes de API errados que circulam nos 4 markdowns de referência

Os markdowns em `/home/ondokai/Documents/deepseek-harness` acertam a **arquitetura** e
erram a **API**. O `src/index.ts` atual herdou os erros e, com eles, **não compila** — o
que significa que hoje **o gate não existe em runtime**. Isto é um achado de segurança, não
de tipagem: um plugin que não carrega não protege nada.

| Usado hoje (errado) | Real |
|---|---|
| `import ... from '@deepseek-ai/dsh-host-subprocess'` | pacote **não existe** (404 no npm). Real: `@deepseek-ai/dsh-subprocess` (definição) e `@deepseek-ai/dsh-subprocess-local` (implementação) |
| `inject = ['webServer', ...]`, `ctx.webServer`, tipo `WebServer` | serviço real é **`ctx.httpServer`**, classe **`HttpServerService`**. Não existe símbolo `WebServer` no pacote |
| `ctx.intercept('webServer', ...)` | `ctx.intercept('httpServer', ...)` |
| `ctx.subprocess.spawn(cmd, args, opts)` | `spawn({ argv, cwd, stdio, graceMs, signal? })` — objeto único, 4 campos obrigatórios |
| `dsh-host-frontend` | `@deepseek-ai/dsh-host-frontend-static` |

`WebRoute` **existe** e está correto. As APIs do Cordis usadas (`ctx.intercept`,
`ctx.waterfall`, `ctx.effect`, `ctx.parallel`, `inject`, `Service`, Fibers, disposers)
foram **todas confirmadas** nos `.d.ts` reais de `@deepseek-ai/cordis@4.0.1`.

**Ação obrigatória antes de qualquer onda de implementação:** validar cada símbolo contra
os `lib/types/*.d.ts` reais (baixados do npm ou de `git clone` do repositório), e **parar
de usar os markdowns como fonte de API**. Eles seguem válidos no nível conceitual.

---

## 13. Fontes, com grau de confiança

| Fonte | Usada para | Confiança |
|---|---|---|
| <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/> | quick tunnel é para teste/dev, sem SLA, 200 req em voo | **Alta** — doc oficial, citação literal |
| <https://developers.cloudflare.com/cloudflare-one/policies/access/> | ações de política, deny-by-default, Service Auth | **Alta** — doc oficial |
| <https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/> | consumo de seat por usuário | **Alta** — doc oficial |
| Limite de "50 usuários" do Zero Trust free | — | **NÃO CONFIRMADO** — só em terceiros e num PDF de 2022 |
| `cloudflared 2026.7.3` executado localmente | `/quicktunnel`, URL só em stderr, 6–7s até subir, SIGTERM→530, sem `~/.cloudflared`, checksum no log | **Alta (medido)** — mas `/quicktunnel` **não é documentado** oficialmente |
| <https://core.telegram.org/bots/features> | token = senha; `/setprivacy`; transferência irreversível; backend valida autorização | **Alta** — doc oficial, citação literal |
| <https://telegram.org/faq#q-so-how-do-you-encrypt-data> | cloud chat não é E2E | **Alta** — doc oficial |
| <https://telegram.org/privacy#3-3-1-chats-em-nuvem> | armazenamento no servidor; análise automatizada | **Alta** — doc oficial |
| <https://core.telegram.org/bots/faq> | "treat any bot as a stranger"; rate limits; bots não veem bots | **Alta** — doc oficial |
| <https://core.telegram.org/bots/api#deletemessage> / `#getme` / `#usersshared` / `#setwebhook` | janela de 48h; validação de token; `users_shared`; `secret_token` | **Alta** — doc oficial |
| `tdlib/telegram-bot-api` (`Client.cpp`, `Client.h`) | strings de 409; `LONG_POLL_MAX_TIMEOUT = 50`; formato do token | **Alta** — código-fonte oficial |
| <https://pages.nist.gov/800-63-4/sp800-63b.html> | ≤100 tentativas; backoff crescente; sem rotação periódica; timeouts AAL2; CSRF em POST/PUT; atributos de cookie | **Alta** — norma, citação literal |
| ASVS 5.0 `0x20-V11-Cryptography.md` (11.5.1, 11.2.4) | ≥128 bits de CSPRNG; UUID não serve; tempo constante | **Alta** — repositório oficial |
| ASVS 5.0 `0x16-V7-Session-Management.md` (7.2.3) | ≥128 bits em reference token | **Alta** |
| ASVS 5.0 `0x22-V13-Configuration.md` (13.3.1, 13.4.x) | secrets management; sem debug/listing/versão exposta | **Alta** |
| ASVS 5.0 §6.5.2 | — | **REFUTADO como base para tokens** — ver §12.1 |
| OWASP Password Storage / Authentication / CSRF / Blocking Brute Force (cheatsheetseries) | parâmetros Argon2id/scrypt; erro genérico; ordem de defesas CSRF; lockout insuficiente | **Alta** |
| <https://www.rfc-editor.org/rfc/rfc4648.html> | base32 = 5 bits/char | **Alta** |
| RFC 7617 | Basic exige TLS; não é seguro isolado | **Alta** |
| <https://nodejs.org/api/crypto.html> | `randomBytes` CSPRNG; `timingSafeEqual` e seus limites; `argon2` nativo desde v24.7.0 | **Alta** — doc oficial |
| <https://nodejs.org/api/child_process.html> | `'close'` como único terminal; `'spawn'` não é readiness; `detached` cria grupo/sessão | **Alta** — doc oficial + medido no Node v24.15.0 |
| <https://github.com/fail2ban/fail2ban/blob/master/config/jail.conf> | `maxretry=5`, `findtime=10m`, `bantime=10m` | **Alta** |
| `https://urlscan.io/api/v1/search/?q=page.domain%3Atrycloudflare.com&size=100` | 73 hostnames distintos, 13 vivos em DNS | **Alta (medido)** — com as ressalvas da §2.2 |
| Discussões oficiais do DSH #853, #1769, #3144, #441 | RCE não autenticado; escape do sandbox; negações invisíveis; escrita não atômica do `cordis.yml` | **Alta** — HTTP 200 com títulos coerentes |
| <https://www.proofpoint.com/us/blog/threat-insight/threat-actor-abuses-cloudflare-tunnels-deliver-rats> | abuso de TryCloudflare para RATs | **Alta** |
| <https://arcticwolf.com/resources/blog/smash-and-grab-aggressive-akira-campaign-targets-sonicwall-vpns/> | Akira usa `cloudflared` como persistência | **Alta** |
| <https://www.aquasec.com/blog/panamorfi-a-new-discord-ddos-campaign/> | Jupyter exposto → DDoS com C2 no Discord | **Alta** |
| <https://ngrok.com/docs/guides/identity-aware-proxy/securing-with-oauth> | OAuth/Basic no free do ngrok | **Alta** |
| Unit 42 (honeypots), Censys (ComfyUI, tempo de detecção), Cisco (Ollama), Wiz (DeepSeek ClickHouse), Nx "s1ngularity", Oligo "0.0.0.0 Day", arXiv 2601.17548 | §1.1, §1.2, §1.3, §2.4 | **Média** — citados no dossiê **sem URL primária verificada**; ordens de grandeza, não medições nossas |
| CVE-2023-26114, CVE-2025-52882, CVE-2025-53773, CVE-2024-37032, CVE-2025-54135, CVE-2025-49150, CVE-2025-53097 | precedentes de WebSocket sem `Origin` e de auto-elevação | **Média** — IDs verificáveis no NVD; detalhes vindos do dossiê |
| Crosby/Wallach, ACM TISSEC 2009; CWE-208 | viabilidade de timing remoto | **Média** — citado no dossiê |
| Marc Brooker / AWS Architecture Blog | full jitter | **Média** — citado no dossiê |
| npm: `@deepseek-ai/dsh-subprocess`, `-local`, `dsh-host-webserver`, `cordis@4.0.1`, `dsh-host-frontend-static` | correção dos nomes de API (§12.6) | **Alta** — tarballs e `.d.ts` inspecionados |
