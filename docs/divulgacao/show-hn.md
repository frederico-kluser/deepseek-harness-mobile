# Rascunho — Show HN

> **Estado:** RASCUNHO. Regras oficiais (news.ycombinator.com/newsguidelines.html; 08 §6.3):
> - não solicitar upvotes/comentários/submissões ("Don't solicit upvotes, comments, or
>   submissions" — é detectado e penaliza a conta);
> - título: usar o original, sem editorialização, sem linkbait; "don't editorialize";
> - Show HN **rejeita** blog posts e sign-up pages: tem que ser algo que a pessoa possa
>   rodar;
> - post que não pegou → second-chance pool via hn@ycombinator.com, nunca deletar-e-repostar.
>
> **Título sem superlativo, sem nome de site, factual.** Janela: segunda 00:00 UTC é a
> melhor medida, mas tratada como estimativa, nunca meta (08 §6.1; L10 — fonte não
> reacessível).

---

## Título proposto

Show HN: Acesse seu agente de código DSH pelo celular sem alargar o bind de loopback

> Fatos verificáveis: "Acesse pelo celular", "sem alargar o bind de loopback". Sem
> superlativo, sem "AI-powered", sem nome de site no título. O acrónimo DSH refere-se
> ao produto (DeepSeek Harness), não ao nome completo do projeto; o nome completo aparece
> no repositório, no corpo.

## Link

https://github.com/frederico-kluser/deepseek-harness-mobile

---

## Corpo (proposto — sem pedir voto; admite o risco no 1º parágrafo)

Rodo o DeepSeek Harness na workstation de casa. Toda vez que eu saía, o agente continuava
rodando e eu não tinha como acompanhar nem redirecionar. As opções eram alargar o bind
para 0.0.0.0 — que é o caminho do RCE não autenticado da discussão #853 do upstream — ou
não usar.

Este plugin faz o caminho do meio. O bind continua em 127.0.0.1 e o acesso local abre
direto, sem login; um cloudflared roda como processo filho supervisionado na mesma máquina
e leva o tráfego da borda da Cloudflare até o loopback. O túnel só entra por **sessão** ou
pela **chave no link** `?key=` que o bot envia no `/ligar` — sem pedir senha a ninguém (o
401 é sem popup, sem formulário). A chave é reutilizável e **revogável** por `/rotacionar`.
O bot só carrega o comando e um token de confirmação opaco. Você liga e desliga o túnel
pelo bot, do celular.

O que eu NÃO estou dizendo: isto não é seguro por padrão só porque é por chave. Você está
expondo um agente com shell; **quem tiver o link acede até você rotacionar**, e a `?key=`
viaja em query (visível a intermediários) — trade assumido do modelo expose-port. A URL do
túnel não deve ser tratada como credencial — ela vira pública assim que qualquer scanner ou
feed a vê. O TLS termina na Cloudflare. Prompt injection continua sendo risco aceito, não
resolvido. O modelo de ameaça está no README, antes da lista de features, de propósito.

Se você aceita instalar um cliente no celular, Tailscale tem um modelo de segurança
melhor que este. Se você só quer autenticação no DSH, existe o dsh-webui-auth, que faz
essa parte. Este plugin é para quem quer o fluxo montado e o botão de desligar no bolso.

MIT. Sou o autor. Feedback de segurança é o que eu mais quero.

---

## Checklist pós-post (para o humano — 07 §7.3)

- [ ] Título factual, sem superlativo, sem nome de site, sem editorialização
- [ ] Não pedir upvote em lugar nenhum (nem no corpo, nem em comentário)
- [ ] Não postar link pedindo voto em grupo
- [ ] Estar disponível nas primeiras 3–4 horas para responder a segurança (§9)
- [ ] Se não pegar: não deletar-e-repostar; usar hn@ycombinator.com (second chance)

## Verificação (número → fonte)

| Número/afirmação | Fonte (08 = 08-PESQUISA-E-FONTES.md) | Confiança |
| --- | --- | --- |
| Chave no link: CSPRNG 256 bits, guardada só como digest | src/session/link-token.ts | Alta |
| RCE não autenticado discutido na #853 | 08 §6.1 (discussion #853) | Alta |
| URL pública assim que um scanner a vê | 08 §7.4 (feeds públicos listam *.trycloudflare.com sem auth) | Alta |
| Tailscale modelo estritamente superior | 07-COMUNIDADE §2 (quadro honesto) | Alta |
| Janela segunda 00:00 UTC (10,8% chance de 50+) | 08 §6.1 + L10 (estimativa; fonte não reacessível) | Estimativa |
