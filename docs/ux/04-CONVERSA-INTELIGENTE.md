# 04 — CONVERSA INTELIGENTE: SKILLS PEDEM VALORES

> **O problema (pedido do dono da máquina).** Do que adianta um comando com
> argumento — hoje só `/parear <código>` — se clicar na skill no menu (que manda
> `/parear` **sem** valor) cai num beco sem saída? Este contrato define o **modo
> híbrido**: um comando que exige valor funciona TAMBÉM clicando no menu — o bot
> faz a **PERGUNTA** na conversa e usa a **PRÓXIMA mensagem de texto** como
> resposta. O mecanismo é **genérico no núcleo neutro** (provider-agnóstico) e a
> validar pelo **mesmo receptor de pareamento** (zero duplicação de segurança).

> **Implementação de referência (Onda: skills pedem valores):**
> `worker/surface/core.ts` (o estado "aguardando valor" e a orquestração da
> conversa), `worker/surface/auth.ts` (o `verificarCandidato` reutilizável e os
> textos EXATOS), `worker/surface/contract.ts` (rasto), `worker/providers/telegram/
> parse.ts` (limitação DM-only), `client/index.ts` (instrução do Passo 2),
> `docs/ONBOARDING-TELEGRAM.md`, `docs/PANEL-TELEGRAM.md`.

---

## 1. Modo HÍBRIDO (decisão D1)

- `/parear <6-dígitos>` **inline continua 100% funcional**: valida pelo receptor
  de pareamento com os MESMOS tetos (`tentativasPorChat` 5 / `tentativasGlobal`
  20), o MESMO `atrasoPara` (backoff 250 ms → 4 s) e a MESMA resposta uniforme
  `RESPOSTA_PAREAMENTO_RECUSADO` para errado / inexistente / expirado.
- `/parear` **sem valor** — o clique no menu — dispara o fluxo **"pedir valor"**:
  o bot PERGUNTA o código na conversa e usa a PRÓXIMA mensagem de TEXTO PURO do
  mesmo chat+user como resposta. **NUNCA mais o beco sem saída.**
- **Outros comandos sem argumento continuam como estão.** Nenhum outro hoje exige
  valor (`/status`, `/menu`, `/ajuda`, `/emergencia`, `/ligar`/`/desligar`/`/acessar`
  `/rotacionar` confirmam por botão, não por texto). O mecanismo é GENÉRICO: basta
  um comando passar a exigir valor para ele colher a próxima mensagem.
- **[limitante documentado]** O contrato neutro `SurfaceIdentity` tem só
  `userKey`/`chatKey` — **não** carrega o `chat.type` do provedor. Por isso o
  fluxo "pedir valor" **não distingue chat privado de grupo** na fronteira neutra.
  A recusa `conversa-nao-privada` vive no **lado host** (`src/telegram/pairing.ts`),
  fora do átomo neutro; documenta-se a limitação e mantém-se o comportamento atual
  do receptor (sem porta DM-only no núcleo). A pergunta é inócua/uniforme, logo não
  cria oráculo num grupo.

---

## 2. O mecanismo "aguardando valor" (no CORE NEUTRO — decisão D2)

Um `Map<chatKey, { userKey, expiresAtMs }>` vive no **core** (`criarNucleo`).
Sem session da libraria, sem sessão externa — só um mapa em memória:

| Propriedade | Valor | Notas |
|---|---|---|
| Chave | `chatKey` (onde) | um fluxo por conversa |
| Valor | `{ userKey, expiresAtMs }` | `userKey` = quem pediu (para revalidar o dono da resposta) |
| TTL | `ESPERA_TTL_MS = 5 min` (`5 * 60 * 1000`) | `≤ TTL do código` (o desafio também tem 5 min); medido no relógio injetado `time.now()` |
| Expiração | **lazy**: no PRÓXIMO evento, por `time.now() >= expiresAtMs` | **NUNCA `setTimeout`** |
| Criação | **no MESMO tick** da pergunta (set síncrono antes do primeiro `await` do envio) | |
| Consumo | delete ao consumir / cancelar / expirar / comando-novo | |
| Teto do mapa | `MAX_AGUARDANDO = 64` (estilo `MAX_TOKENS_DESLIGAR`) | evita crescimento sem limite; mais antigo sai (FIFO) |
| "Texto puro" | comando cujo **texto não começa com `/`** (e, se o evento carregasse `entities`, exigiria **ausência de `bot_command`**) | o contrato neutro não carrega `entities`; a fronteira por omissão é o `/` inicial — ver §4 |

**Regras da conversa (enquanto há "aguardando"):**
1. A captura é **só da PRÓXIMA mensagem de TEXTO PURO** do **mesmo `chatKey` +
   `userKey`** que pediu. Texto de OUTRO user no mesmo chat **não** é capturado
   (é ignorado em silêncio, o fluxo continua).
2. **UM comando novo durante a espera CANCELA** o aguardando e **roda normal**
   (o texto de comando **NUNCA** é capturado como valor). Ex.: `/status` durante a
   espera cancela e abre o `/status`.
3. **`/parear <valor>` durante a espera** cancela a espera e valida inline
   (equivalente a re-digitar; mesmo receptor/budget).
4. **`/cancelar` (comando ou texto puro `cancelar` / `não`)** cancela com
   `Ok, cancelado.` e remove o estado.
5. **`/parear` vazio durante a espera** → **no-op** (fica a esperar). Anti-bomba:
   `N` cliques em `/parear` no menu produzem **UMA** pergunta (a primeira), não `N`.

---

## 3. Captura e validação: o mesmo receptor (decisão D3 / checklist)

O valor capturado NÃO corre num caminho paralelo de segurança: é validado pela
**mesma função** `verificarCandidato(identity, candidato)` que o receptor de
pareamento expõe, e que o fluxo inline também usa (zero duplicação de
verificação de desafio/digest, de tetos e de backoff).

```
verificarCandidato(identity, candidato):
  1. malformado (≠6 dígitos / não-numérico) → refuse:malformed
       · NÃO debita tentativa (palpite), NÃO conta sonda nova
       · reply = RESPOSTA_PEDIR_VALOR_MALFORMADO (re-pede), delay 0, orcamento 'nenhum'
  2. já-pareado (estado fechado) → refuse:already-paired
       · dono → RESPOSTA_JA_PAREADO; estranho → silêncio
  3. TETO (PAIR-007): tentativasPorChat ≥ 5 ou tentativasGlobal ≥ 20 → refuse:rate-limited (silêncio, delay 4 s)
  4. debts: attempts+1, tentativasGlobal+1, tentativasPorChat+1
  5. TTL do desafio → refuse:expired (RESPOSTA_PAREAMENTO_RECUSADO, backoff)
  6. verify(candidato) → refuse:wrong-code (RESPOSTA_PAREAMENTO_RECUSADO, backoff)
  7. verify ok → { kind:'paired', owner } (reply do ± pareado; audit sem código)
```

> **Teto de re-pedidos MALFORMADOS (correção adversarial pós-revisão):** o
> retorno de `refuse:malformed` num valor capturado fica **limitado por chat**
> com `MAX_MALFORMADO_POR_ESPERA = 5` re-asks por fluxo, com o **backoff do
> receptor** (`atrasoPara`, 250 ms → 4 s) aplicado ANTES de cada re-ask e **sem
> renovar o TTL da espera** (a janela total continua a expirar — o lazy-expire
> `time.now() >= expiresAtMs` no próximo evento remove a espera). Ao estourar o
> teto, a espera é **removida** e o bot fica em **SILÊNCIO** (default-deny,
> TG-089 contado, sem resposta) até um novo `/parear`. O contador zera ao armar
> a espera e ao consumir com sucesso. Sem isto, um atacante poderia armar a
> espera com `/parear` vazio (sonda) e fazer N respostas "Não entendi o código…"
> — farm de reflexão fraco mas real.

Sem `await` entre **ler estado → verificar cota → comparar → marcar consumido**
(PAIR-009): `verificarCandidato` é síncrono, e no core a criação/consumo do
"aguardando" também é síncrona antes de qualquer `await` de envio — a atomicidade
do pareamento fica preservada na comparação de um valor capturado.

## 4. "Texto puro" na fronteira (decisão D4)

O `SurfaceCommandEvent` carrega `text` CRU e **não** carrega `entities`. O sketch
de deteção no átomo neutro é portanto:
- texto que **não começa com `/`** após `trim()` → candidato a "texto puro" de
  valor (desde que haja "aguardando" e o `userKey` bata);
- o comando é reconhecido por `extrairNomeDeComando` (já existente) quando o texto
  começa com `/` → num "aguardando", um comando **cancela** (regra §2.2).

> **Nota `entities`:** se no futuro o contrato vier a carregar `entities` (o
> Telegram marca `bot_command` mesmo sem o `/` graficamente nalgumas superfícies),
> exigir a **ausência de `bot_command`** para tratar o texto como valor. Hoje o
> contrato não as carrega; documenta-se o rasto sem código.

---

## 5. Textos EXATOS (PT-BR) — novos (auth.ts)

| Constante | Texto EXATO | Onde |
|---|---|---|
| `RESPOSTA_PEDIR_VALOR` (pergunta) | `Envia-me o código de 6 dígitos que aparece no painel.` | quando `/parear` vazio arma a espera |
| `RESPOSTA_PEDIR_VALOR_MALFORMADO` (re-pedir malformado) | ``Não entendi o código — 6 dígitos, ex.: `123456`.`` | quando o valor não é 6 dígitos **sem ecoar** o que o user digitou |
| `RESPOSTA_AGUARDANDO_EXPIROU` (timeout) | `O código expirou. Use /parear de novo.` | valor tardio após o TTL da espera; estado removido, valor NÃO validado |
| `RESPOSTA_AGUARDANDO_CANCELADO` (cancelar) | `Ok, cancelado.` | `/cancelar` ou texto puro `cancelar`/`não` |

> Regras microcopy ($03): imperativo curto, 1 ideia, sem ecoar o que o user
> digitou, nenhuma destas strings carrega o código do user.

---

## 6. Checklist de segurança (cada item é asserção de teste)

- [x] (a) **Mesmo receptor**: o valor capturado valida por `verificarCandidato`
  — mesmo desafio/digest, mesmos tetos `tentativasPorChat`/`tentativasGlobal`,
  mesmo `atrasoPara`, mesmo `RESPOSTA_PAREAMENTO_RECUSADO` p/ errado/inexistente/
  expirado. O fluxo inline `/parear <código>` E o conversacional usam a MESMA
  função — zero duplicação.
- [x] (b) **Malformado** (≠6 dígitos / não-numérico): NÃO debita tentativa, NÃO
  conta sonda nova, re-pede com `RESPOSTA_PEDIR_VALOR_MALFORMADO` SEM ecoar o
  texto digitado. (Decisão: o `/parear` vazio continua a contar como sonda no
  receptor — a semântica atual —; a comparação de um valor bem-formado é o único
  ramo que debita palpite. Recomendação da pesquisa C respeitada.)
- [x] (c) **DM-only**: a fronteira neutra não expõe `chat.type` → limitação
  documentada (§1); comportamento atual do receptor mantido. Nada de oráculo.
- [x] (d) **Nunca logado/ecoado**: o valor (e o código) nunca vão a log,
  auditoria, `sender.send` nem resposta. Só booleans/contadores. A
  `SurfacePairingAuditIntent` já não tem campo de código e **não** ganha nada.
- [x] (e) **Atomicidade PAIR-009**: leitura de estado → verificar cota →
  comparar → marcar consumido, tudo sem `await` (§3).
- [x] (f) **Estrangeiro**: a PERGUNTA é uniforme para todos (inócuo como `/start`,
  PAIR-006); um estranho que envie valor bem-formado recebe a resposta uniforme +
  debita + backoff — idêntico ao fluxo digitado do presente. Botões/media de
  estranho descartados em silêncio (TG-089/027); sem oráculo de existência.
- [x] (g) **Disponível SEM desafio**: a pergunta mantém-se uniforme mesmo sem
  desafio armado (resposta uniforme ao validar). Não revela estado; "gera código
  no painel" não se distingue.

---

## 7. Painel (client/index.ts — Passo 2) e docs

- **Painel** (§ `guard-code-line`): instrução híbrida única, ex.:
  `No Telegram, envia: /parear 123456 no @handle — ou envia /parear e o bot pede o código.`
  (ajuste fino conforme o layout; mantém as classes `guard-*` / `--dsw`).
- **`docs/ONBOARDING-TELEGRAM.md` §Passo 2** e **`docs/PANEL-TELEGRAM.md`
  §Passo 2** ganham o fluxo "pedir valor" (o clique no menu `/parear` também
  funciona).

---

## 8. Testes (onde foram colocadas as asserções)

- `test/unit/worker/surface/auth.test.ts` — direto no `verificarCandidato`:
  par para 6 dígitos certo; errado → resposta uniforme + debita; malformado →
  sem debitar/sem sonda + re-ask; tetos/backoff; expirado; audit nunca tem o
  valor; já-pareado (dono/estranho).
- `test/unit/worker/surface/core.test.ts` — orquestração da conversa no núcleo:
  `/parear` vazio → pergunta + "aguardando" (mesmo tick); valor certo → pareia;
  valor tardio após TTL → `O código expirou. Use /parear de novo.` e NÃO valida;
  malformado → re-pede sem ecoar; `/cancelar` / texto `cancelar`/`não` cancela;
  outro comando durante a espera cancela e roda normal; valor de outro user/chat
  não é capturado; estranho → pergunta uniforme + resposta uniforme/budget/backoff;
  sender nunca ecoa o valor; `/parear <código>` inline continua igual.
- `test/unit/client/index.test.ts` — o bundle contém a instrução nova (ASCII-safe).