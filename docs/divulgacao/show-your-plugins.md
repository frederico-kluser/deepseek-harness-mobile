# Rascunho — GitHub Discussions "Show Your Plugins!"

> **Estado:** RASCUNHO. Canal de maior sinal: público 100% usuário de DSH
> (07-COMUNIDADE §7.2). Guidelines fixadas (#2004): título
> "DSH | Project Name | One-line description", exige GIF/vídeo **e** explicação da
> integração, um projeto por thread, proibida promoção não relacionada e post duplicado
> (para updates, editar a thread, nunca repostar).
>
> **Sem rede real em teste / sem frase de vendas:** texto factual, admite o risco no
> primeiro parágrafo, cita o concorrente por nome, declara autoria (07 §8.1).

---

## Título (obrigatório: DSH | Nome | one-line)

DSH | dsh-guarded-bot-orchestrator | Use a Web UI do DSH pelo celular sem alargar o bind
de loopback

---

## Demo

![Demo — fluxo completo: ligar, autenticar, desligar](../assets/demo.gif)

> GIF de ~20 segundos (critério de 07 §4.1: 4 cenas, first-frame 401, segredo mascarado,
> auditoria frame a frame por segredo). Artefato produzido por T7.3; referência de caminho
> estável: docs/assets/demo.gif.

---

## Corpo (post)

Rodo o DeepSeek Harness na workstation de casa. Toda vez que eu saía, o agente continuava
rodando e eu não tinha como acompanhar nem redirecionar. As opções eram alargar o bind
para 0.0.0.0 — que é o caminho do RCE não autenticado da discussão #853 do upstream — ou
não usar.

Este plugin faz o caminho do meio. O bind continua em 127.0.0.1; o plugin falha no load,
ruidosamente, se você tentar alargar. O que muda é que um cloudflared roda como processo
filho supervisionado na mesma máquina e leva o tráfego da borda da Cloudflare até o
loopback. A senha é gerada por CSPRNG (≥128 bits) e não trafega pelo Telegram — chat de
bot não é E2E, então o bot só carrega o comando e um token de confirmação opaco. Você liga
e desliga o túnel pelo bot, do celular.

### Como a integração funciona (obrigatório pelas guidelines #2004)

- O gate HTTP é montado com a API do Cordis: ctx.intercept + filters
  (register/registerFallback/registerUpgrade), com a ordem deliberada de camadas
  (origem → Host → credencial → navegador):
  - **L2** trustedRemotes → 403 para quem está do outro lado do socket
    (src/http/gate.ts);
  - **L3** autenticação → 401;
  - handshake de **WebSocket** interceptado no upgrade — captura do listener
    `upgrade` em src/http/intercept.ts e `Origin` fora da allowlist no upgrade → 403
    (src/http/session-auth.ts);
- A **allowlist do bind** (allowedHosts em src/config/bind.ts) é distinta de
  trustedRemotes: é a interface onde o servidor escuta; um bind fora dela falha no
  load.
- O processo do bot (longa duração, consome input da internet) vive **dentro de um
  ctx.effect()** (src/index.ts), com ambiente construído por **allowlist**
  (WORKER_ENV_ALLOWLIST em src/proc/env.ts); o token do bot entra por env, sempre,
  nunca por argv (legível em /proc/<pid>/cmdline).
- O túnel é uma operação de primeira classe: o supervisor (src/tunnel/supervisor.ts)
  faz tree-kill real do grupo de processos (src/proc/tree-kill.ts —
  process.kill(-pid, sig) / taskkill /T /F; SIGTERM ao grupo → janela de graça → SIGKILL
  em src/tunnel/pidfile.ts), e o "desligar" fecha o túnel deixando zero órfão.

### Limites (honestidade primeiro)

O que eu NÃO estou dizendo: isto não é seguro por padrão só porque tem senha. Você está
expondo um agente com shell. A URL do túnel não deve ser tratada como credencial — ela
vira pública assim que qualquer scanner ou feed a vê. O TLS termina na Cloudflare. Prompt
injection continua sendo risco aceito, não resolvido. O modelo de ameaça está no README,
antes da lista de features, de propósito.

Se você aceita instalar um cliente no celular, Tailscale tem um modelo de segurança
melhor que este. Se você só quer autenticação no DSH e nada mais, existe o
dsh-webui-auth, que faz essa parte. Este plugin é para quem quer o fluxo montado e o
botão de desligar no bolso.

MIT. Sou o autor. Feedback de segurança é o que eu mais quero.

---

## Verificação (rastreamento número → código)

| Número/afirmação | Fonte (08 = 08-PESQUISA-E-FONTES.md) | Confiança |
| --- | --- | --- |
| Senha ≥128 bits CSPRNG | 08 §8:22 (ASVS 7.2.3); src/secret/generate.ts | Alta |
| RCE discutido na #853 | 08 §6.1 (discussion #853, reportada em 0.1.0-rc.6) | Alta |
| Quick tunnel "no SLA / testing only" | 08 §8:7 (doc Cloudflare) | Alta |
| dsh-webui-auth cobre four-layer auth | 08 §6.1 (plugins.json) | Alta |
| Tree-kill por grupo: POSIX kill(-pid) / Windows taskkill | 08 §8:33, §8:38; src/proc/tree-kill.ts | Alta |
| Token por env, nunca por argv | src/proc/env.ts | Alta |
