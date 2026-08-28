# 03 — MICROCOPY (guia de estilo consolidado)

> **Objetivo:** as Ondas 3 (bot) e 4 (painel) não criarem texto inconsistente.
> Este guia vale para **qualquer nova string** — se uma frase nova não passar
> nas regras abaixo, reescreve-a antes de entregar.
>
> Consolida as 5 pesquisas (bot UX, teclados/menu, pareamento, painel, microcopy
> PT-BR) num único padrão vocálico: **tom "você", imperativo com verbo, frases
> curtas, 1 ideia/frase, hierarquia título → contexto → ação.**

---

## A. As 13 regras

1. **Uma ideia por frase.** Se a frase tem dois verbos de ação, divide.
2. **Imperativo com verbo** (nunca só "OK"). `Gerar código`, `Salvar bot`,
   `Copiar`, `Trocar`. Não `[OK]`.
3. **Frases curtas.** Microcopy ≤ ~10 palavras; mensagem de bot ≤ 1-3 linhas;
   painel escaneável com cabeçalhos.
4. **Hierarquia título → contexto → ação.** Primeiro o título (o que é), depois
   o contexto (porquê/estado), depois o CTA (o que faz).
5. **1 CTA primário por estado** no bot e no painel; os restantes secundários
   ou text-links.
6. **Botão = verbo do resultado.** `✅ Sim, desligar`, `Abrir menu`, `Copiar` —
   o rótulo diz o que acontece ao clicar, não apenas "confirmar".
7. **Confirmação destrutiva específica.** Frase diz **o que vai acontecer** e
   **que não tem volta**: `Desligar o túnel derruba o acesso remoto. Não dá
   para desfazer?` → o texto exato do bot é `🔴 Desligar o túnel derruba o
   acesso remoto. Continuar?`.
8. **Permissão/confirmação com porquê + timing + reversão** quando applicável:
   *porquê* (o túnel desliga), *timing* (agora), *reversão* (para reabrir, use
   Ligar).
9. **Erro guia à correção sem culpa.** Nunca "você errou"; diga o que fazer:
   `Formato errado. O token vem assim: 123456:aaaa…`.
10. **Tom "você", informalidade calibrada.** PT-BR coloquial mas claro; sem
    gíria excessiva; sem exclamativos em excesso.
11. **Bot ≤ 2 linhas por parágrafo + emoji leve.** Um emoji por ideia, não um
    por palavra.
12. **Nunca jargão no texto do usuário.** Túnel→"acesso remoto", chave→"link de
    acesso", parear (mantido, é o verbo do produto e o glossário explicita).
13. **Vazio ensina o próximo passo.** Nem vazios "sem dados" nem "nenhum
    comando": diga o que falta e o que virá a seguir.

---

## B. Banco de frases por situação

| Situação | Frase recomendada |
|---|---|
| Sucesso de ligar | `Túnel ligado. Link enviado aqui.` / no-op `Túnel já estava ligado.` |
| Sucesso de desligar | `Túnel desligado. Nada ficou exposto.` / no-op `Túnel já estava desligado.` |
| Chave nova | `Chave nova gerada. O link antigo deixou de funcionar.` |
| Falha de rede | `Sem ligação. Verifica a rede e tenta de novo.` |
| Falha interna | `Algo falhou do meu lado. Tenta de novo.` |
| Erro de token | `Formato errado. O token vem assim: 123456:aaaa…` |
| Não entendeu (dono) | `Não entendi. Queres fazer o quê?` + botões |
| Parear certo | `✓ Pareado com sucesso! Agora: /menu e /status.` |
| Parear errado/expirado | `Código errado ou expirado. Confere no painel e tenta de novo.` |
| Parear sem código (dono pendente) | `Envia /parear seguido do código de 6 dígitos, assim: /parear 123456` |
| Confirmação destrutiva | `🔴 Desligar o túnel derruba o acesso remoto. Continuar?` |
| Cancelar confirmação | `OK` (answer) + volta à anterior |
| Enquanto processa | `Ligando…`, `Desligando…`, `Gerando chave nova…`, `A conectar ao Telegram…`, `A consultar…` (botão `🤖 Agentes`) |
| `/agente` sem skill | `Uso: /agente <skill> <o que o agente deve fazer>` |
| `/agente` skill fora de kebab-case | `Skill inválida (kebab-case). Uso: /agente <skill> <o que o agente deve fazer>` |
| `/agente` sem prompt | `Falta o prompt. Uso: /agente <skill> <o que o agente deve fazer>` |
| Confirmação de dispatch (a mais sensível — executa código) | `🤖 Disparar o agente "<skill>?"` + `Ele executa código na tua máquina com este prompt:` + `"<prompt>"` — botões `✅ Sim, disparar` e `✕ Não` |
| Sem nonce do host (fail-closed) | `Não foi possível obter a confirmação do host. Tente de novo em alguns segundos.` |
| Dispatch aceite | `Agente disparado. O resultado chega aqui quando terminar.` |
| Skill fora da allowlist | `A skill "<skill>" nao esta autorizada neste plugin (config agents.skills).` |
| Teto de runs atingido | `Ja ha agentes a correr ate o limite (config agents.maxRuns). Espera um terminar ou cancela um.` |
| Confirmação expirada (clique tardio) | `Confirmação expirada ou inválida. Mande /agente de novo.` |
| `/agentes` com runs | `🤖 Agentes:` + `• <id> — <skill> — <estado> <há quanto>` (+ `   💬 <summary>`) |
| `/agentes` sem runs (vazio ensina) | `Nenhum agente rodando.` |
| Difusão proativa de fim de runs | `🤖 Atualização de agentes:` + linhas |
| `/parar-agente` cancelado | `Agente <id> cancelado.` |
| `/parar-agente` não encontrado (noop) | `Agente <id> não encontrado.` |
| `/parar-agente` id inválido | `Id inválido. Uso: /parar-agente <id> — os ids aparecem em /agentes.` |

> **A tabela completa com o porquê de cada frase está no §10 de
> [`01-CONTRATO-BOT.md`](01-CONTRATO-BOT.md)** — os textos acima são os EXATOS
> do código (`worker/surface/commands.ts`, `worker/surface/text.ts` e
> `src/control/surface-ipc.ts`), congelados aqui como banco de referência.

---

## C. Diferenças BOT × PAINEL

| Eixo | Bot (Telegram) | Painel (aba "Remote Access") |
|---|---|---|
| Comprimento | ≤ 5 linhas/mensagem; ≤ 2 linhas/parágrafo; emoji leve | Escaneável por cabeçalhos; frases podem ser levemente maiores |
| Língua | Imperativo direto + 1 ação | Hierarquia título→contexto→ação; rótulos de CTA verb-first |
| Botões | Teclado inline 3-4/linha, destruído ao concluir | ≤1 CTA primário; text-links nos `<details>` |
| Estado | Cartão edit-in-place + toasts | Trilha de checkpoints (só o atual aberto) |
| Microcopy | Botão muda o estado (navegação) | Botão leva ao conteúdo (descoberta) |

**Regra de voz unificada:** os DOIS falam com o usuário em **"você"** (não "tu")
— ex. `entregou`, `envias`, `abre` — sem nunca usar "OK" como rótulo de ação.

---

## D. Glossário de termos (definição humana, 1 linha)

| Termo | Definição humana |
|---|---|
| **Túnel (de acesso)** | Uma porta segura da internet para a tua máquina; quando está ligado, o teu Harness responde a links na web. "Ligar o túnel" = abrir esse acesso; "desligar" = fechá-lo. |
| **Token (do bot)** | A "chave" secreta que liga o teu bot do Telegram à tua máquina. Parece `123456:aaaa...` e vem do @BotFather. Só tu a deves ter. |
| **Bot (do Telegram)** | O assistente/contato no Telegram com quem mandas os comandos (ex. `/menu`, `/status`) — na prática, é o "porta-voz" do teu Harness na conversa. |
| **Parear** | Ligar o teu bot a um dono de verdade: tu geres um código só teu no painel, envias `/parear <código>` no bot, e a partir daí só esse chat comanda o bot. Sem parear, ninguém (nem tu) usa o bot. |
| **Link de acesso / chave de acesso** | O endereço que o túnel gera para a tua máquina aparecer na internet; quem tem o link entra "direto". "Nova chave" revoga a anterior e emite outra. |
| **Agente (do harness)** | Um assistente de IA que o teu Harness dispara para executar uma tarefa na tua máquina — com o que a skill mandar e o prompt que escreveres. Disparar um agente **executa código na tua máquina** (por isso pede confirmação). |
| **Skill** | Um "kit de instruções" instalado no Harness que diz ao agente como fazer uma tarefa (ex.: revisar código). O nome é curto, em kebab-case — só as skills da allowlist podem ser disparadas. |
| **Run (de agente)** | Um agente que está a correr (ou correu). Cada run tem um **id curto** (8 caracteres) que aparece no `/agentes` e serve para o `/parar-agente`. |

> **Regra:** estes termos, quando aparecerem no texto do usuário, usam sempre a
> definição acima. Nunca "exposure.mode", "callback_data", "nonce", "allowlist",
> "seq" (jargão interno) no texto que o usuário vê. Nos textos de agentes, o
> jargão de config (`agents.skills`, `agents.maxRuns`) só aparece nas **recusas
> do host** — de propósito: é o texto que guia o DONO à correção (regra 9), e o
> dono é quem edita o `cordis.patch.yml`.

---

## E. Anti-padrões proibidos

- `OK` como rótulo de botão (ex.: `[OK]` a servir de confirmação).
- `Invalid command`, `Erro 422`, `Não conheço este comando.` (sem saída).
- Dois CTAs primários competindo no mesmo estado.
- Mensagens > 5 linhas; parágrafos > 2 linhas no bot.
- Botão com rótulo que não descreve o resultado (ex.: `Continuar` sozinho).
- Falar de "exposure.mode", "token fingerprinted", "allowlist" para o usuário.

---

## F. Checklist antes de entregar uma string nova

1. Passa nas 13 regras? (1 ideia, imperativo, curta, título→contexto→ação, 1 CTA)
2. Tem emoji leve (≤1/ideia), tom "você", sem jargão?
3. É destrutiva? → inclui o que acontece e a impossibilidade de desfazer.
4. É erro? → guia à correção sem culpa.
5. Bot fora do canal do dono (estranho) → é **silêncio** ou **genérico**, nunca
   revela estado do túnel.
6. Bate com o glossário (§D)?