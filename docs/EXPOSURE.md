# EXPOSURE.md — o que muda quando o túnel sobe

Este documento descreve os **modos de exposição** do DSH guardado por este plugin e o que
muda, de forma verificável, quando se expõe o servidor à internet. É a versão "para o
usuário" do modelo de ameaça — leia `THREAT-MODEL.md` para o atacante e as mitigações em detalhe.

## 1. O princípio: o bind nunca é alargado

O socket local do DSH **continua em loopback** (`127.0.0.1`). Expor faz-se **sempre** por
um processo à frente (`cloudflared`) que leva tráfego da borda até esse loopback. Isto
**não é** o mesmo que `dsh web --host 0.0.0.0`: o socket nunca sai de loopback, a
exposição é *opt-in*, efémera e revogável, e a barreira de autenticação continua no mesmo
lugar — a proteger `/api`, o fallback da SPA e o handshake de WebSocket.

No carregamento, o plugin recusa arrancar se o endereço de bind for o universal (`0.0.0.0`/
`::`) ou não constar da allowlist `allowedHosts` (fail loud at load, `src/config/bind.ts`).

## 2. Os modos

O eixo `exposure.mode` tem dois valores (`src/contracts/tunnel.ts:194`, resolvido em `src/config/schema.ts`):

| Modo | Significado | Túnel |
| --- | --- | --- |
| `loopback` | Só `127.0.0.1`. Nada sai da máquina. | nunca (sem borda) |
| `tunnel` | O `cloudflared` pode subir e levar tráfego até o loopback. | opt-in + TTL |

Ausência do eixo `exposure` equivale a nível seguro `loopback` (`LOOPBACK_ONLY_EXPOSURE`).
Ausência de configuração de túnel com `mode: tunnel` é erro de arranque: pedir
exposição sem declarar o túnel é configuração que só se revelaria errada no instante do uso.

## 3. O que muda ao subir o túnel

1. **A superfície fica alcançável** pela URL pública do `trycloudflare.com`.
2. **A URL é pública e não é segredo.** Hostnames efémeros de túnel são descobríveis por
   amostragem pública. Quem protege é a credencial, não a obscuridade do endereço.
3. **O TLS termina na borda da Cloudflare.** Arquitetonicamente o texto claro passa por
   lá (o que permite WAF, Access e cache). Não é ponta-a-ponta.
4. **`trustedRemotes` fica inerte como controlo de rede.** Sob o túnel, todo o tráfego
   chega do `cloudflared` em loopback, e a identidade usada pelo rate limit colapsa
   num caso global (`trustEdgeHeaders: false` por omissão). O teto de falhas NIST
   (100) passa a ser o controlo principal.
5. **O TTL limita a janela.** Quando o TTL expira (default 60 min), o túnel cai sozinho,
   todas as sessões emitidas são invalidadas, o facto é auditado e só depois o dono é
   avisado no Telegram (nesta ordem, porque o aviso é o passo que pode falhar por rede).
6. **Existe um botão de desligar** (kill switch) nas duas superfícies: pelo bot
   (`/desligar`) e pelo painel. O túnel também se derruba em modo restrito depois de
   100 falhas acumuladas. O `stop` manual fecha a exposição (mata o `cloudflared`);
   a revogação explícita de todas as sessões acontece na expiração do TTL, na varredura
   de órfão do arranque e no `/emergencia` (detalhe em `docs/TUNNEL.md` §3).

## 4. O probe fail-closed (o que impede um túnel "nu")

Antes de publicar qualquer URL, o plugin corre um **probe de 4 sondas** contra a própria
instância em loopback e só avança se **as quatro** devolverem `401` (sem credencial):

1. `GET /` — o fallback da SPA tem de estar guardado;
2. `POST /api/state` — a sub-estação RPC tem de estar guardada;
3. handshake de WebSocket — tem de ser recusado/cortado sem credencial;
4. canário `GET /__guard/probe-canary-<token>` — sonda dedicada.

Qualquer sonda que não devolva o esperado **aborta** a subida (`src/tunnel/probe.ts`).
Isto é o que impede o cenário que já expôs o DSH real: um túnel a abrir sem a barreira por trás.

## 5. Auto-arranque e intenção persistida

O túnel **não** abre sozinho por omissão (`autoStart: false`). Se liga o túnel e o
DSH reinicia, a intenção persistida (`desiredState`) é honrada no boot: se estava
`READY` e o modo é `tunnel`, volta a subir com uma URL nova; senão, fica em
`STOPPED` com o motivo. Um túnel que abre sozinho a cada boot é um túnel que fica
aberto sem ninguém saber — por isso o default é não abrir.

## 6. Como verificar, tu mesmo

O critério de aceite é o mesmo do `examples/minimal` (ver pasta) e resume a
propriedade central:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/api/commands/execute
401
```

Sob o túnel, o mesmo pedido pela URL pública também tem de dar `401` sem credencial — é
o que o probe fail-closed garante antes de a URL ser publicada.

## 7. Quando NÃO subir o túnel

- Se não precisas de acesso remoto, não exponhas nada (loopback puro).
- Se queres rede privada real / identidade por dispositivo, usa Tailscale.
- Se tens um domínio na Cloudflare, usa *named tunnel* + Access (auth antes de chegar à
  tua máquina) — ver `docs/TUNNEL.md`.
- Máquina corporativa: `trycloudflare.com` tem reputação de malware documentada em
  alguns filtros; muitas redes/EDRs bloqueiam ou sinalizam `cloudflared`.
