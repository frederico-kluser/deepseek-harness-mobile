# TUNNEL.md — quick vs named, TTL, o que a Cloudflare vê

Este documento descreve o túnel Cloudflare que expõe o DSH ao telemóvel: como o plugin
o sobe, os dois modos (`quick` e `named`), o TTL que limita a janela de exposição e o
modelo de ameaça específico do transporte. Para o atacante em geral, ver
`docs/THREAT-MODEL.md`; para o comportamento ao subir, `docs/EXPOSURE.md`.

## 1. Como o túnel sobe

Quando sai o comando para ligar (`/ligar` no bot, botão do painel ou superfície de
UI), o plugin:

1. corre o **probe fail-closed de 4 sondas** contra a instância em loopback e só avança
   se as quatro devolverem `401` (`src/tunnel/probe.ts`);
2. arranca o `cloudflared` com argumentos auditados: `--metrics` obrigatório,
   `--no-autoupdate`, e o `loglevel debug` **proibido por código** — e o token,
   no modo *named*, só por ficheiro (nunca por `argv`) (`src/tunnel/args.ts`);
3. descobre a URL por polling de `GET <metrics>/quicktunnel` **e** por regex do
   stderr (a URL sai 100% em stderr; o stdout fica com 0 bytes) (`src/tunnel/discover.ts`);
4. confirma **readiness** contra a URL pública, atravessando a borda da Cloudflare
   (`src/tunnel/readiness.ts`);
5. só em `READY` publica a URL nas superfícies (`src/tunnel/supervisor.ts`).

A URL demora tipicamente **6–7 s** a chegar; o piso de espera é de 30 s (se passar de 30 s
é falha). Factos em `docs/plano/08-PESQUISA-E-FONTES.md §8` (itens 3–4).

## 2. Quick tunnel (`trycloudflare.com`)

- **É o modo default e o único com onboarding automatizado.**
- **Não tem SLA** e é *"intended for testing and development only"*
  ([doc oficial](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)).
- **Hostname novo a cada reinício**; sem domínio próprio; sem cache nem controlo de borda.
- **Limite de requisições em voo**: o quick tunnel sustenta ~200 requisições in-flight;
  acima disso devolve `429` (limite do produto, não defeito do plugin).
- **A URL é pública e não é segredo.**
- **O TLS termina na borda da Cloudflare.** O texto claro passa por um terceiro
  (é o que permite WAF/Access/cache). Não é ponta-a-ponta.
- **Cloudflare Access NÃO pode ficar na frente de um quick tunnel** (exige domínio/
  `zone_id`). Sobre `*.trycloudflare.com` toda a autenticação tem de estar
  dentro da aplicação — o portão deste plugin. Fato de confiança **Alta**
  (`docs/plano/08-PESQUISA-E-FONTES.md §§1.3 e 7.4`).

## 3. TTL — a janela de exposição

O túnel tem um `ttlMinutes` configurável (default `60` minutos, valor entregue no
manifesto de Bundle — não há default silencioso no código). Ao expirar:

1. o túnel cai (a URL passa a `530`);
2. **todas as sessões emitidas são invalidadas**;
3. o facto é auditado;
4. só depois o dono é avisado no Telegram — nesta ordem, porque o aviso é o passo que
   pode falhar por rede (`src/tunnel/ttl.ts`).

Não existe `renew`: para voltar a expor, liga de novo — sobe com URL nova.

> **Quando é que as sessões são revogadas no servidor?** A revogação de TODAS as
> sessões ocorre quando o túnel cai por **expiração do TTL**, quando a **varredura de
> órfão** no arranque encontra um túnel que sobreviveu, ou no **`/emergencia`**.
> Um `stop` manual (`/desligar` no bot, botão do painel) **derruba o `cloudflared` e
> fecha a exposição**, mas não revoga ele mesmo as sessões já emitidas. O efeito
> prático é seguro: com o túnel em baixo, a URL pública não se alcança; se ligares de
> novo, a URL muda de hostname e o cookie `__Host-dsh_sid` da sessão antiga não
> autentica no hostname novo. (Só o TTL, a varredura e a emergência invalidam
> explicitamente as sessões — `src/tunnel/ttl.ts`, `src/tunnel/pidfile.ts`,
> `src/control/controller.ts`.)

## 4. O que a Cloudflare vê

O texto em claro dos pedidos e respostas que passam pelo túnel é visível para a borda da
Cloudflare (TLS termina lá). Para um túnel `quick` não há configuração de borda
adicional (WAF/Access não se aplicam por falta de domínio). Se isso é inaceitável para o
teu caso, o caminho é o *named tunnel* + Cloudflare Access (abaixo), que põem
autenticação **antes** de a requisição chegar à tua máquina — mas continuam a ver o
texto em claro na borda; a diferença é a porta que se fecha antes.

## 5. Named tunnel + Cloudflare Access (o caminho superior, quando tens domínio)

Se tens um **domínio com DNS na Cloudflare**, o modo superior de segurança é:

1. um *named tunnel* (não *quick*) com token por ficheiro (`--token-file`, nunca
   `--token` — `src/tunnel/args.ts:206`);
2. uma política de **Cloudflare Access** à frente (One-time PIN por e-mail, deny-by-default).

Aí a autenticação acontece **antes** de chegar à tua máquina, e o plugin continua a ser a
segunda camada (L4 in-app). Confiança da Cloudflare sobre a limitação do quick tunnel:
`docs/plano/08-PESQUISA-E-FONTES.md §8` itens 8–9.

## 6. Falhas e recuperação

- Se o `cloudflared` morrer (`kill -9`), o estado vai a `DEGRADED` e o plugin
  reinicia com recuo exponencial; esgotado o orçamento, vai a `FAILED` e não
  re-tenta (não-retryable: `ENOENT`/config inválida nunca fazem *crash-loop*).
- O `cloudflared` **exposto por si só** já criou, num caso real, ~40 s de
  exposição à internet sem portão ("janela de pré-ready") — o probe fail-closed existe
  para não repetir isso (ver nota em `src/tunnel/args.ts:118-123`).
- Ao reiniciar o DSH, uma varredura de órfão derruba qualquer `cloudflared` que
  tenha sobrevivido (uma URL pública sem portão por trás) e revoga as sessões
  (`src/tunnel/pidfile.ts`).

## 7. O que NÃO é mitigado pelo túnel

- O túnel **fura a firewall** de saída (é o objetivo).
- A URL pública é alcançável por quem a souber/deduzir. O que fecha é a credencial.
- Sob o túnel, toda a conexão chega do `cloudflared` em loopback; a identidade do
  rate limit colapsa para um caso global (`trustEdgeHeaders: false` por omissão).
