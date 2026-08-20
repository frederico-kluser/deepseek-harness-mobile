# Spike T0.2 — `cloudflared` quick tunnel medido em campo

Medido em 2026-08-20 com `cloudflared version 2026.7.3 (built 2026-07-23-09:58 UTC)` em
`/home/ondokai/.local/bin/cloudflared`, Node `v24.15.0`, Linux x86-64. Scripts em
`scripts/spike/cloudflared/**` (Node puro, ESM, zero dependência nova). Run canônico: `node
scripts/spike/cloudflared/spike.mjs --warmup-ms 90000`. A saída abaixo é colada crua do
terminal, com **duas** transformações declaradas e nenhuma outra; onde um fato não foi
medido, está marcado com **NÃO MEDIDO** e o motivo (`05-QUALIDADE-CODIGO.md` §7.4).

1. **O IPv6 público do dono está mascarado como `2804:1b3:…:2df0` em todas as
   ocorrências, de propósito.** O endereço completo, com identificador de interface
   e data, aponta para a linha residencial do usuário — é o dado mais identificável
   que este spike tocou, e um relatório sobre não vazar não pode ser o vazamento. A
   evidência precisa mostrar a **posição** do valor no header, não o valor. As URLs
   `*.trycloudflare.com`, ao contrário, são de túneis já derrubados e **não são
   credenciais** (A-11) — ficam íntegras.
2. **As tabelas de warmup da janela DNS** saem de
   `scripts/spike/cloudflared/summarize-warmup.mjs` sobre logs do `spike.mjs`, porque
   85 tentativas em JSON indentado não cabem aqui. O script está versionado.

## VEREDITOS

```
VEREDITO S2: CONFIRMADO — a borda entrega `CF-Connecting-IP` à origem com o IP real do cliente, e RECUSA na própria borda (HTTP 403, `error code: 1000`) qualquer requisição em que o cliente envie esse header, de modo que o valor que chega à origem nunca é escolhido pelo cliente; `X-Forwarded-For`, ao contrário, é ACRESCENTADO ao valor enviado pelo cliente (valor forjado primeiro, IP real por último) e portanto é forjável.
  evidência: log cru da origem, run canônico, casos R1/R2/R3 — seção (c) abaixo.
    R1 (sem forja)  -> 200 — "Cf-Connecting-Ip","2804:1b3:…:2df0","X-Forwarded-For","2804:1b3:…:2df0"
    R2 (X-Forwarded-For: 1.2.3.4) -> 200 — "X-Forwarded-For","1.2.3.4,2804:1b3:…:2df0"
    R3 (CF-Connecting-IP: 1.2.3.4) -> 403 na borda; NENHUM evento chegou à origem

VEREDITO S3: CONFIRMADO — o WebSocket atravessou o quick tunnel e transportou payload de aplicação nos DOIS sentidos, não apenas o handshake 101.
  evidência: o cliente recebeu um frame que o servidor emitiu sem ninguém pedir (`SRV-PUSH:c90681796b75`) e o eco do frame que enviou (`SRV-ECHO:CLI-SEND:333e3d410eb0a7e3`); a origem registrou `ws-server-received` com 25 bytes. Nenhum lado inventa o nonce do outro, o que exclui eco local. Log completo na seção (d).
```

## Guarda de exposição — nenhum túnel apontou para a porta 3080

`cloudflared --url http://localhost:3080` publicaria o DeepSeek Harness real na internet,
sem confirmação. **O que a guarda garante, literalmente:** o alvo de um túnel não pode ser
nomeado por número — `spawnQuickTunnel` recebe o `net.Server`, não a porta, e
`targetPortOfOwnServer` deriva a porta de `server.address()` depois de exigir um
`net.Server` **deste processo e em escuta**. É allowlist por construção: `listen()` numa
porta que outro processo já serve falha com `EADDRINUSE` antes de existir servidor. A
blocklist da 3080 fica como defesa em profundidade, para o caso de o próprio spike abrir um
servidor ali por acidente. Auto-teste no início de cada run, com quatro tentativas de
burlar:
```
porta 3080 (DSH real) ocupada neste instante? false
guarda OK — recusou numero de porta cru (3080)
  motivo: RECUSADO: o alvo de um tunel precisa ser um net.Server deste processo, nao number. Nao existe caminho que aceite um numero de porta: e isso que impede apontar o tunel para um servico que este processo nao abriu.
guarda OK — recusou numero de porta cru (qualquer)   [mesma mensagem]
guarda OK — recusou objeto que finge ser servidor    [mesma mensagem, "nao um objeto qualquer"]
guarda OK — recusou servidor real ainda sem listen()
  motivo: RECUSADO: o servidor alvo nao esta em escuta; sem listen() bem-sucedido nao ha prova de posse da porta.
targetPortOfOwnServer(origin.server) = 44647 — a porta sai do servidor, nao de um argumento
```
Um servidor já fechado também é recusado (`listening === false`), então a posse é verificada
no instante do uso, não uma vez no arranque.

Todo túnel deste spike apontou para uma origem HTTP+WebSocket criada pelo próprio script,
numa porta alta atribuída pelo SO (`36627`, `44647`, `43203`, `35049`, `41589`, entre
outras). **Achado colateral:** durante toda a medição a porta 3080 estava **livre** — `curl`
devolveu `Failed to connect to 127.0.0.1 port 3080` e `ss -ltnp` não listou ninguém nela. O
DSH real não estava no ar nesta janela.

## (a) `GET /quicktunnel` no metrics server com `--metrics` fixado

```
argv: ["/home/ondokai/.local/bin/cloudflared","tunnel","--no-autoupdate","--metrics","127.0.0.1:37373","--url","http://127.0.0.1:36627"]
polling: { "ok": true, "elapsedMs": 8031, "status": 200, "tentativas": 33,
  "primeiras3": [{"atMs":5,"cause":"ECONNREFUSED"},{"atMs":257,"cause":"ECONNREFUSED"},{"atMs":508,"cause":"ECONNREFUSED"}],
  "ultima": {"atMs":8031,"ok":true,"status":200,"cause":null} }
corpo CRU de GET http://127.0.0.1:37373/quicktunnel:
{"hostname":"marks-organization-moved-coupons.trycloudflare.com"}
chaves do JSON: ["hostname"]
tem esquema (://)? false
URL publica apos prefixar https://: https://marks-organization-moved-coupons.trycloudflare.com
```
**Confirmado:** o endpoint existe, responde `200`, e o corpo é exatamente `{"hostname":"…"}`
— chave única, **sem esquema**; prefixar `https://` é obrigatório e nenhum scraping de log
entra no caminho primário (A-10). `--metrics 127.0.0.1:PORT` fixa a porta: em cinco runs o
endpoint respondeu na porta que passamos (`35667`, `43137`, `42567`, `37373`, `43427`).
Tempo até responder, por run: **6024, 6281, 8031 ms** — o timeout de produção de ≥30 s
continua adequado, com polling de 250 ms.

Endpoints auxiliares do mesmo metrics server. `/ready` devolve `503` enquanto
`readyConnections` é `0` e passa a `200` quando a conexão registra — as duas últimas linhas
vêm de uma observação separada de 2 minutos:
```
GET /ready       -> status=503 body="{\"status\":503,\"readyConnections\":0,\"connectorId\":\"a35aa973-…\"}"
GET /healthcheck -> status=200 body="OK"
GET /            -> status=404 body="404 page not found"
GET /metrics     -> status=200 body="15818 bytes"
t=42s ready="{\"status\":200,\"readyConnections\":1,\"connectorId\":\"e592fc72-…\"}"
2026-08-20T02:58:06Z INF Registered tunnel connection connIndex=0 connection=baff781c-… event=0 ip=2606:4700:a0::4 location=gru14 protocol=quic
```

### Correção ao plano: a porta **default** de métricas não é aleatória por si só

`01-ARQUITETURA.md` §7.1 afirma que o default no 2026.7.3 é porta aleatória. Medido com
`default-metrics-port.mjs` **sem** `--metrics`, e depois com as cinco portas da faixa
ocupadas por servidores do próprio script (`--occupy`):
```
run 1: linha bruta = "2026-08-20T03:13:12Z INF Starting metrics server on 127.0.0.1:20241/metrics"
run 2: linha bruta = "2026-08-20T03:13:19Z INF Starting metrics server on 127.0.0.1:20241/metrics"
--- com --occupy: portas ocupadas por este processo: [20241,20242,20243,20244,20245]
run 1: endereco de metricas escolhido = 127.0.0.1:36035
run 2: endereco de metricas escolhido = 127.0.0.1:43641
```
O default tenta `20241…20245` **em ordem** e só cai numa porta efêmera se todas estiverem
ocupadas; o `--help` (`default: "localhost:0"`) descreve o fallback, não o caminho comum.
**A conclusão do plano vale e a razão muda:** fixar `--metrics` é obrigatório não porque o
default seja aleatório, mas porque ele é **disputado** — dois `cloudflared` na mesma
máquina, ou qualquer processo sentado na 20241, deslocam a porta em silêncio e a descoberta
lê o metrics server errado.

## (b) A URL sai em `stderr`; `stdout` fica com 0 bytes

```
bytes em stdout: 0
bytes em stderr: 5460
stdout capturado (cru, entre marcadores):
<<<STDOUT
STDOUT>>>
URL achada por regex em stderr: "https://marks-organization-moved-coupons.trycloudflare.com"
tempo ate a URL aparecer em stderr: 7826 ms
```
**Confirmado em sete execuções independentes** (cinco do `spike.mjs`, duas do
`default-metrics-port.mjs`): `stdout` teve **0 bytes** em todas, e a regex
`https://[-a-z0-9]+\.trycloudflare\.com` casou em `stderr` todas as vezes. Bloco cru onde a
URL aparece:
```
2026-08-20T03:10:34Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-08-20T03:10:34Z INF |  https://marks-organization-moved-coupons.trycloudflare.com                |
```
O fallback por `stderr` (7826 ms) chegou **antes** do `/quicktunnel` responder (8031 ms)
neste run — os dois caminhos são complementares, não redundantes.

## (c) S2 — que identidade de cliente chega à origem

Método: a origem loga `req.rawHeaders` cru (ordem e duplicatas preservadas) e cada caso
força **um** header por vez a partir da URL pública, de fora — testar vários de uma vez só
diria "algo foi recusado", sem dizer qual. IP público desta máquina no teste, por
`https://cloudflare.com/cdn-cgi/trace`: `2804:1b3:…:2df0`.

| caso | header forjado | status | o que chegou à origem |
| --- | --- | --- | --- |
| R1 | (nenhum) | 200 | `Cf-Connecting-Ip: 2804:1b3:…:2df0` · `X-Forwarded-For: 2804:1b3:…:2df0` |
| R2 | `X-Forwarded-For: 1.2.3.4` | 200 | `X-Forwarded-For: 1.2.3.4,2804:1b3:…:2df0` — **valor forjado preservado, IP real acrescentado no fim** |
| R3 | `CF-Connecting-IP: 1.2.3.4` | **403** | **nada** — a borda barrou antes da origem |
| R4 | `True-Client-IP: 1.2.3.4` | 200 | `True-Client-Ip: 1.2.3.4` — **repassado intacto** |
| R5 | `X-Real-IP: 1.2.3.4` | 200 | **removido** — não chegou à origem |
| R6 | `X-Forwarded-For: 203.0.113.9, 198.51.100.7` | 200 | `X-Forwarded-For: 203.0.113.9, 198.51.100.7,2804:1b3:…:2df0` |
| R7 | `CF-IPCountry: XX` | 200 | `Cf-Ipcountry: BR` — **sobrescrito** |
| R8 | `CDN-Loop: forjado; loops=99` | 200 | `Cdn-Loop: forjado; loops=99, cloudflare; loops=1; subreqs=1` — acrescentado |
| R9 | `CF-Ray: 0000000000000000-XXX` | 200 | `Cf-Ray: a2de353ffb73f1c1-GRU` — **sobrescrito** |
| R10 | `X-Forwarded-Proto: http` | 200 | `X-Forwarded-Proto: https` — **sobrescrito** |
| R11 | os quatro de identidade juntos | **403** | **nada** |

Log cru do caso R1, como a origem o registrou, e a segunda testemunha em `curl` para o caso
`CF-Connecting-IP` (`fetch` do Node e `curl` concordam, logo o 403 é da borda e não do
cliente):
```
["Host","marks-organization-moved-coupons.trycloudflare.com","User-Agent","node","Accept","*/*","Accept-Encoding","gzip",
 "Accept-Language","*","Cdn-Loop","cloudflare; loops=1; subreqs=1","Cf-Connecting-Ip","2804:1b3:…:2df0",
 "Cf-Ew-Via","15","Cf-Ipcountry","BR","Cf-Ray","a2de353cfe56f1c1-GRU","Cf-Visitor","{\"scheme\":\"https\"}",
 "Cf-Warp-Tag-Id","a35aa973-0cd2-4899-aeac-1a618056b9c8","Cf-Worker","trycloudflare.com","Connection","keep-alive",
 "Sec-Fetch-Mode","cors","X-Forwarded-For","2804:1b3:…:2df0","X-Forwarded-Proto","https"]
--- e o caso CF-Connecting-IP, por curl ---
comando: curl -sS -i -m 20 -H "X-Forwarded-For: 1.2.3.4" -H "CF-Connecting-IP: 1.2.3.4" https://…/s2-curl
HTTP/2 403
server: cloudflare
cf-ray: a2de331c7c864931-GRU
error code: 1000
```
**Fonte primária que corrobora o 403.** `Error 1000: DNS points to prohibited IP`
(<https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1000/>)
lista textualmente entre as causas: *"The request includes a `CF-Connecting-IP` header."*,
*"The request `X-Forwarded-For` header is longer than 100 characters."* e *"The request
includes two `X-Forwarded-For` headers."* — as duas últimas **NÃO MEDIDAS** aqui, ficam como
fato documentado. E `True-Client-IP` passa intacto porque a doc de headers
(<https://developers.cloudflare.com/fundamentals/reference/http-headers/>) o declara
*Enterprise plan only*: numa conta sem esse plano — o caso de um quick tunnel sem conta — a
borda não o gera nem o limpa. **É lixo como identidade neste cenário.**

### Consequências que o código precisa respeitar

1. **`X-Forwarded-For` não identifica ninguém.** O atacante escolhe o primeiro
   elemento da cadeia a cada requisição; um limitador que leia o primeiro — o padrão
   em quase toda biblioteca — nunca acumula backoff e é envenenável contra o IP do
   dono. Ler o **último** devolveria o IP real aqui, mas depende de a borda ser
   sempre o último hop: frágil demais para basear controle.
2. **`CF-Connecting-IP` vindo da borda é imune à forja remota** — o cliente não
   consegue nem entregar a requisição: a borda devolve 403 antes da origem.
3. **A ressalva que impede tratar isso como fronteira:** a origem é
   `127.0.0.1:<porta>` e o `cloudflared` é só mais um cliente local. Qualquer
   processo local conecta direto e envia um `CF-Connecting-IP` arbitrário, e o
   socket é `127.0.0.1` nos dois casos — a origem **não distingue** pelo endereço
   quem veio do túnel. Confiar no header exige provar antes a proveniência, o que
   este spike não resolve.
4. **`exposure.trustEdgeHeaders` permanece `false` no modo quick** — `01-ARQUITETURA.md`
   já exige *named tunnel* + JWT, e nada aqui altera isso. A medição entrega a T2.3 a
   base factual para escolher entre limite por IP (`CF-Connecting-IP`, com a ressalva
   3 declarada no código e no README) e por sessão/global; a decisão é de T2.3.

## (d) S3 — WebSocket através do túnel, com payload nos dois sentidos

A origem faz o handshake RFC 6455 à mão (`lib/ws-frame.mjs`, sem dependência) e, assim que
responde `101`, **empurra um frame sem ninguém pedir** — é o que distingue "o 101 aconteceu"
de "o túnel é bidirecional". Depois ecoa o que o cliente mandar. O cliente é o `WebSocket`
global do Node 24.
```
conectando em wss://marks-organization-moved-coupons.trycloudflare.com/ws
resultado S3 (lado cliente): {
  "clientPayload": "CLI-SEND:333e3d410eb0a7e3",
  "received": ["SRV-PUSH:c90681796b75", "SRV-ECHO:CLI-SEND:333e3d410eb0a7e3"],
  "log": [ {"atMs":271,"event":"open (handshake 101 aceito pelo cliente)"},
           {"atMs":271,"event":"client->server enviado: CLI-SEND:333e3d410eb0a7e3"},
           {"atMs":271,"event":"server->client recebido: SRV-PUSH:c90681796b75"},
           {"atMs":282,"event":"server->client recebido: SRV-ECHO:CLI-SEND:333e3d410eb0a7e3"} ],
  "serverToClient": "SRV-PUSH:c90681796b75", "clientToServerEchoed": "SRV-ECHO:CLI-SEND:333e3d410eb0a7e3",
  "bidirectional": true, "elapsedMs": 282, "outcome": "bidirecional-confirmado" }
--- os mesmos eventos do lado da ORIGEM, com o upgrade vindo da borda ---
{"kind":"upgrade","url":"/ws","remoteAddress":"127.0.0.1","rawHeaders":[…,"Connection","Upgrade","Sec-Websocket-Key","3mla/QWKBye3oZzSybwApg==","Sec-Websocket-Version","13","Upgrade","websocket","X-Forwarded-For","2804:1b3:…:2df0",…]}
{"kind":"ws-server-sent","payload":"SRV-PUSH:c90681796b75"}
{"kind":"ws-server-received","payload":"CLI-SEND:333e3d410eb0a7e3","bytes":25}
{"kind":"ws-server-sent","payload":"SRV-ECHO:CLI-SEND:333e3d410eb0a7e3"}
```
Confirmado em **três** runs independentes (`bidirectional: true` nos três), com 246 ms, 282
ms e 271 ms entre abrir e completar a troca. A revisão adversarial reproduziu com um cliente
RFC 6455 independente do meu, validando `Sec-WebSocket-Accept` e masking: o cliente recebeu
o nonce gerado **no servidor** e o servidor registrou o nonce **do cliente**, o que exclui
eco local — nenhum lado inventa o nonce do outro. **O quick tunnel continua viável como modo
padrão**; S3 não bloqueia o COMMIT PREP 3. **Ressalva documentada, não medida:** a doc
oficial diz *"Quick Tunnels do not support Server-Sent Events (SSE)"* — WebSocket passa, SSE
não; se alguma superfície do DSH usar SSE, ela não funciona por quick tunnel.

## (e) SIGTERM, encerramento e ausência de resíduo

`process.kill(-pid, 'SIGTERM')` no **grupo** (o `spawn` usou `detached: true`, conforme
A-1), escutando `'error'` e `'close'`, nunca só `'exit'` (A-7).
```
process.kill(-pid, SIGTERM): {"signal":"SIGTERM","sentAtMs":31813,"killError":null,"sent":"group"}
evento 'close' do filho: {"code":0,"signal":null,"atMs":31826}
evento 'exit'  do filho: {"code":0,"signal":null,"atMs":31825.42}
evento 'error' do filho: null
bytes em stdout no total: 0
```
Encerramento em **13 ms** após o sinal, código de saída `0`, **sem `ESRCH`** — o `killError`
veio `null`, o grupo existia. O `--grace-period` default de 30 s não atrasou nada porque não
havia requisição em voo. Resíduo, verificado e não inferido:
```
GET /quicktunnel DEPOIS do SIGTERM: {"ok":false,"cause":"ECONNREFUSED"}
tentativa 1 na URL publica apos SIGTERM: {"ok":true,"status":530,"cfRay":"a2de35559840f1df-GRU"}
tentativa 2 na URL publica apos SIGTERM: {"ok":true,"status":530,"cfRay":"a2de3563bd8af1df-GRU"}
tentativa 3 na URL publica apos SIGTERM: {"ok":true,"status":530,"cfRay":"a2de35705cbbf1df-GRU"}
pgrep -af cloudflared:
~/.cloudflared existe? false
```
A porta de métricas recusa conexão, a URL pública devolve `530` (com o `cf-ray` mudando a
cada tentativa, logo a resposta é da borda e não de cache), nenhum processo `cloudflared`
sobrou e `~/.cloudflared` **não foi criado** em momento nenhum — nem depois de sete
execuções completas. **A URL pública não some: ela passa a devolver 530.** O DNS continua
publicado com TTL 300 s; quem tiver o hostname continua batendo na borda e recebe erro de
origem, não `NXDOMAIN`.

## (f) Checksum do binário

Três fontes independentes, todas iguais — o hash local, o corpo das release notes da tag
`2026.7.3` (API pública
`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.7.3`) e o startup do
próprio binário em `stderr`:
```
$ sha256sum /home/ondokai/.local/bin/cloudflared
9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17
cloudflared-linux-amd64: 9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17
2026-08-20T03:10:34Z INF Version 2026.7.3 (Checksum 9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17)
2026-08-20T03:10:34Z INF GOOS: linux, GOVersion: go1.26.4, GoArch: amd64
```
Tamanho do asset na release: `39278667` bytes. Tamanho local: `39278667` bytes.

**Bônus confirmado:** o `cloudflared` loga o próprio checksum no startup, o que permite
auditar o binário **em execução** sem re-hashear o arquivo: T5.4 pode casar a linha `Version
… (Checksum …)` de `stderr` contra a release.

**A fonte que T5.4 deve consumir é campo estruturado, não texto livre.** A API do GitHub
expõe o checksum por asset em `assets[].digest` — fazer parse do `body` é desnecessário e
frágil. O que não existe é um `.sha256` ao lado de cada asset:
```
{ "name": "cloudflared-linux-amd64", "size": 39278667,
  "digest": "sha256:9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17" }
```
O binário desta máquina **não** veio do repositório apt (`dpkg -S` não o reconhece; está em
`~/.local/bin`). O repositório assinado da Cloudflare continua o caminho preferível de
instalação, e este relatório não muda isso.

## Achado que muda o desenho da descoberta de URL: a janela DNS

Custou três runs falhados até ser isolado. **O `/quicktunnel` devolve o hostname ANTES de o
registro DNS existir.** Os blocos tabulares saem de `node
scripts/spike/cloudflared/summarize-warmup.mjs <log>` sobre logs do `spike.mjs` (script
versionado; os logs não, porque a fronteira desta sub-tarefa é `docs/` e
`scripts/spike/cloudflared/**`). Run canônico, resolvendo por DNS-over-HTTPS no resolvedor
público da Cloudflare (`https://cloudflare-dns.com/dns-query`, `accept:
application/dns-json`), que não passa pelo cache local:
```
== FASE 1 — publicacao do registo DNS (so DoH; o resolvedor do SO nao foi consultado)
   publicado=true atMs=22150 ttl=300 ips=["104.16.231.132","104.16.230.132"]
        31 ms  doh_rcode=3  answer=null    <- /quicktunnel ja devolvera o hostname
      2069 ms … 20131 ms  doh_rcode=3      (dez consultas, todas NXDOMAIN)
     22150 ms  doh_rcode=0  answer=2
== FASE 2 — warmup HTTP     pronto=true atMs=697 tentativas=1
       697 ms  lookup=OK  resolve4=OK  doh_rcode=0  http_status=200  erro=null
```
O registro apareceu **22 s depois** de o hostname ser conhecido — 10 s noutro run, e a
revisão adversarial mediu **24 s** num terceiro. Com a ordem corrigida, a primeira consulta
ao SO resolveu logo e o HTTP devolveu 200 em 697 ms.

> **Esta banda NÃO é um limite, e T3.2 não pode codificá-la.** Somando os ~6–8 s
> até o `/quicktunnel`, os meus runs deram de 16 s a 30 s até a URL ficar
> resolvível — mas o run da revisão adversarial deu **~30,6 s**, já fora do
> intervalo, com n=1. São três amostras de uma distribuição sem contrato publicado:
> o readiness precisa de polling com timeout generoso, nunca de espera fixa
> calibrada nestes números.

**A armadilha:** consultar o DNS cedo demais faz o resolvedor local cachear o `NXDOMAIN`
pelo TTL negativo da zona, e `trycloudflare.com` publica **1800 s** — verificado por duas
vias (`host -t soa` e DoH):
```
trycloudflare.com has SOA record kevin.ns.cloudflare.com. dns.cloudflare.com. 2412682339 10000 2400 604800 1800
{"name":"trycloudflare.com","type":6,"TTL":1800,"data":"… 604800 1800"}
```
O cache negativo pode segurar **30 minutos**. Observei **7 minutos contínuos** — que são um
**piso, não um teto**: o run parou por orçamento, não por expiração.
```
== warmup
   pronto=false atMs=n/a tentativas=85
        46 ms  lookup=ENOTFOUND  resolve4=ENOTFOUND  doh_rcode=3  http_status=null  erro=ENOTFOUND
     10104 ms  lookup=ENOTFOUND  resolve4=ENOTFOUND  doh_rcode=0  http_status=null  erro=ENOTFOUND
    423712 ms  lookup=ENOTFOUND  resolve4=ENOTFOUND  doh_rcode=0  http_status=null  erro=ENOTFOUND
```
A linha dos 10104 ms é o ponto exato em que o registro **já existe** no autoritativo e o
resolvedor local continua devolvendo `ENOTFOUND`.

**O envenenamento é da cadeia local, não universal.** A revisão adversarial separou os dois
braços na mesma máquina: UDP direto a `1.1.1.1` resolveu **aos 18 s**, enquanto
`systemd-resolved` (`127.0.0.53`) e o roteador da LAN ficaram `ENOTFOUND` por mais de 9
minutos; o braço de controle — só consultar o SO depois de o DoH confirmar — resolveu **à
primeira, em 711 ms**. Mesma máquina, mesma rede, minutos de intervalo, resultado oposto
conforme a ordem, o que exclui "a rede estava má" e "o túnel não estava pronto". O mecanismo
fica refinado sem mexer na conclusão: quem envenena é o **cache recursivo da cadeia local**,
e é por isso que sondar por DoH antes da publicação é a mitigação certa.

Forçar a rota com `curl --resolve` para um IP da borda **antes** da publicação também não
ajuda: a borda devolve `HTTP/2 530` com `<title>Origin DNS error | …` — não é o resolvedor
local, é a borda ainda sem o mapeamento.

**Consequência para T3.2 (readiness):** o critério de `STARTING → READY` não pode ser "o
`/quicktunnel` respondeu". Entre o hostname existir e a URL ser usável há dezenas de
segundos, e uma tentativa dentro dessa janela envenena o resolvedor de quem tentou por até
30 minutos. Entregar a URL ao dono antes disso produz um link que falha no celular por um
motivo que não aparece em log nenhum do plugin.

## Limites do quick tunnel — o que a doc oficial declara

De
<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/>:
*"Quick Tunnels are intended for testing and development only."* · *"Quick Tunnels are
subject to a hard limit on the number of concurrent requests that can be proxied at any
point in time. Currently, this limit is 200 in-flight requests. If a Quick Tunnel hits this
limit, the HTTP response will return a `429` status code."* · *"Quick Tunnels do not support
Server-Sent Events (SSE)."* · *"We don't guarantee any SLA or uptime of TryCloudflare."*

**NÃO MEDIDO:** o teto de 200 requisições em voo e o `429` — provocá-lo exigiria gerar carga
contra a infraestrutura pública da Cloudflare, fora do escopo de um spike de reconhecimento.
Fica como fato documentado. Esse `429` encosta na regra de `02-SEGURANCA.md` §6.1 de nunca
devolver `429` do gate: ele vem da **borda**, não do gate, e o gate não tem como suprimi-lo.
T2.3 e T5.4 precisam saber que um `429` observado pelo cliente não implica que o gate emitiu
um oráculo.

## O que este spike NÃO mediu

- Teto de 200 requisições em voo e o `429` (acima).
- `X-Forwarded-For` com mais de 100 caracteres, e duas ocorrências do header —
  documentados como causa de `error 1000`, não reproduzidos aqui.
- *Named tunnel* (`tunnel.mode: 'named'`); reconexão da borda após queda de rede e o
  orçamento de reinício de T3.1 — o spike só cobre quick tunnel em regime estável.
- `--loglevel debug`, deliberadamente: `01-ARQUITETURA.md` proíbe, porque a URL e os
  headers vazam para o log.

## Reprodução

```
node scripts/spike/cloudflared/spike.mjs [--bin PATH] [--origin-port N] [--warmup-ms N]
node scripts/spike/cloudflared/default-metrics-port.mjs [--occupy]
node scripts/spike/cloudflared/origin.mjs --port N     # só a origem, para inspeção manual
```
O alvo de um túnel só pode ser nomeado entregando um `net.Server` em escuta deste processo
(`targetPortOfOwnServer`); não há caminho que aceite número de porta, e a 3080 continua em
blocklist como defesa em profundidade. Node 24 e nada mais.
