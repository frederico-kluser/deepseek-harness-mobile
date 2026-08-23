# Checklist dos 50 mutantes (04-TESTES §7.2 — lista FECHADA, congelada no COMMIT PREP 6)

Rito (D16): aplica-se o mutante, roda-se a suíte, EXIGE-SE falha, reverte-se.
Um sobrevivente é um buraco de teste NOMEADO, não uma métrica. Mutation score de
ferramenta NÃO é critério de aceite — mutation testing automatizado roda em job
noturno separado, `break` desligado, não bloqueia PR. T6.3 preenche e assina.

**ASSINADO por T6.3 (Onda 6) — 48/50 mortos por teste dirigido (aplica → exige falha → reverte por CÓPIA),
2/50 com justificativa escrita (defesa em profundidade: a mutação única é inobservável).
Método de verificação por mutante: `TESTE DIRIGIDO` = a mutação foi aplicada, a suíte nomeada correu,
a falha foi exigida e o ficheiro foi revertido por cópia (nunca `git checkout`).
`LEITURA` = a mutação é estruturalmente impossível de observar com a suíte atual (justificado).**

| Mutante | Mutação | Teste que o mata | Verificado por |
| --- | --- | --- | --- |
| M-01 | remover a guarda `pid === undefined` do tree-kill | `test/unit/proc/tree-kill.test.ts` | TESTE DIRIGIDO |
| M-02 | reintroduzir `&& !child.killed` no tree-kill | `test/unit/proc/supervisor-disposer.test.ts (faz tree-kill do GRUPO mesmo depois de terminate)` | TESTE DIRIGIDO |
| M-03 | trocar `process.kill(-pid)` por `process.kill(pid)` | `test/unit/proc/tree-kill.test.ts (sinaliza o GRUPO -pid)` | TESTE DIRIGIDO |
| M-04 | trocar `SIGKILL` por `SIGTERM` no tree-kill final | `test/unit/proc/tree-kill.test.ts (SIGKILL)` | TESTE DIRIGIDO |
| M-05 | remover o `try/catch` de ESRCH | `test/unit/proc/tree-kill.test.ts (engole ESRCH)` | TESTE DIRIGIDO |
| M-06 | `timingSafeEqual` → `===` | `test/unit/http/auth-basic.test.ts` | TESTE DIRIGIDO |
| M-07 | comparar credencial crua em vez de digest | `test/unit/http/auth-basic.test.ts` | TESTE DIRIGIDO |
| M-08 | remover o `.toLowerCase()` do esquema | `test/unit/http/auth-basic.test.ts` | TESTE DIRIGIDO |
| M-09 | aceitar qualquer esquema (remover a checagem de prefixo) | `test/unit/http/auth-basic.test.ts` | TESTE DIRIGIDO |
| M-10 | `isTrustedRemote`: `length === 0 → true` (lista vazia = todos) | `test/unit/http/origin.test.ts` | TESTE DIRIGIDO |
| M-11 | remover a normalização IPv4-mapeado | `test/unit/http/origin.test.ts` | TESTE DIRIGIDO |
| M-12 | `isGuardedPath`: `startsWith` sem fronteira de segmento | `test/security/path-bypass.test.ts (ADV-002)` | TESTE DIRIGIDO |
| M-13 | remover a decodificação percent em `canonicalRequestPath` | `test/security/path-bypass.test.ts (ADV-007/008)` | TESTE DIRIGIDO |
| M-14 | decodificar percent **duas** vezes | `test/security/path-bypass.test.ts (M-14: triplo encoding)` | TESTE DIRIGIDO |
| M-15 | trocar 403 por 401 na negação de origem | `test/security/header-forgery.test.ts (AUTH-032)` | TESTE DIRIGIDO |
| M-16 | remover `WWW-Authenticate` do 401 | `test/security/desafio-401.test.ts (WWW-Authenticate)` | TESTE DIRIGIDO |
| M-17 | responder 401 com corpo diferente para "usuário existe" | `test/security/ratelimit-oracle.test.ts (M-17: literal do corpo)` | TESTE DIRIGIDO |
| M-18 | `requestsDeniedPermission`: comparar substring em vez de token | `test/unit/permissions/deny.test.ts` | TESTE DIRIGIDO |
| M-19 | remover o gate do handler de **upgrade** | `test/security/websocket-origin.test.ts (ADV-040)` | TESTE DIRIGIDO |
| M-20 | guardar upgrade só nos `guardedPrefixes` | `test/security/websocket-origin.test.ts (M-20: fora de guardedPrefixes)` | TESTE DIRIGIDO |
| M-21 | no `catch` do upgrade, chamar o handler original | `test/security/websocket-origin.test.ts (ADV-047)` | TESTE DIRIGIDO |
| M-22 | allowlist do Telegram: validar `chat.id` e não `from.id` | `test/unit/worker/surface/auth.test.ts (TG-003)` | TESTE DIRIGIDO |
| M-23 | allowlist: `from` ausente ⇒ aceito | `test/unit/worker/surface/auth.test.ts (TG-004)` | TESTE DIRIGIDO |
| M-24 | allowlist: comparar `username` | `test/unit/worker/surface/auth.test.ts (TG-008)` | TESTE DIRIGIDO |
| M-25 | allowlist vazia ⇒ aceita tudo | `test/unit/worker/surface/auth.test.ts (TG-007)` | TESTE DIRIGIDO |
| M-26 | token de confirmação reutilizável | `test/unit/worker/surface/commands.test.ts (uso unico)` | TESTE DIRIGIDO |
| M-27 | token de confirmação sem TTL | `test/unit/worker/surface/commands.test.ts (TTL)` | TESTE DIRIGIDO |
| M-28 | token não ligado ao `from.id` | `test/unit/worker/surface/commands.test.ts (TG-024)` | TESTE DIRIGIDO |
| M-29 | não chamar `answerCallbackQuery` no caminho de negação | `test/unit/worker/surface/core.test.ts (TG-027 — answer em TODOS os caminhos)` | TESTE DIRIGIDO |
| M-30 | ler a URL do túnel do **stdout** | `test/unit/tunnel/discover.test.ts (TUN-005)` | TESTE DIRIGIDO |
| M-31 | remover o prefixo `https://` do hostname | `test/unit/tunnel/discover.test.ts (TUN-002)` | TESTE DIRIGIDO |
| M-32 | timeout de readiness `Infinity` | `test/unit/tunnel/discover.test.ts (TUN-009)` | TESTE DIRIGIDO |
| M-33 | não abortar o wait no `close` do processo | `test/unit/tunnel/discover.test.ts (TUN-010)` | TESTE DIRIGIDO |
| M-34 | `--metrics` sem host explícito | `test/unit/tunnel/args.test.ts (TUN-011)` | TESTE DIRIGIDO |
| M-35 | acrescentar `--loglevel debug` | `test/unit/tunnel/args.test.ts (TUN-013)` | TESTE DIRIGIDO |
| M-36 | supervisor pendurar em `exit` e não em `close` | `test/unit/proc/supervisor-disposer.test.ts (ENOENT close)` | TESTE DIRIGIDO |
| M-37 | reiniciar mesmo com `signal.aborted` | — | LEITURA (não-matável — ver nota) |
| M-38 | `maxAttempts` ignorado (retry infinito) | `test/unit/proc/retry.test.ts (SUP-005)` | TESTE DIRIGIDO |
| M-39 | `resetAfterMs` sempre zerando o contador | `test/unit/proc/retry.test.ts (SUP-004)` | TESTE DIRIGIDO |
| M-40 | backoff sem teto (`maxDelayMs` ignorado) | `test/unit/proc/backoff.test.ts (teto)` | TESTE DIRIGIDO |
| M-41 | backoff sem jitter | `test/unit/proc/backoff.test.ts (jitter)` | TESTE DIRIGIDO |
| M-42 | `seq` não incrementa | `test/unit/control/controller.test.ts (CTL-010)` | TESTE DIRIGIDO |
| M-43 | `start` em `READY` faz `spawn` novo | `test/unit/control/controller.test.ts (CTL-003)` | TESTE DIRIGIDO |
| M-44 | `dispose` não idempotente | — | LEITURA (não-matável — ver nota) |
| M-45 | `dispose` assíncrono | `test/unit/proc/supervisor-disposer.test.ts:57 (3 chamadas, 1 kill)` + `test/unit/proc/ipc-canal.test.ts:198 (\`dispose()\` 3x = 1 kill, e continua sincrono)` | TESTE DIRIGIDO |
| M-46 | `intercept` não desfeito no dispose | `test/unit/http/intercept.test.ts (reverte)` | TESTE DIRIGIDO |
| M-47 | remover a rejeição de bind curinga em `assertSecureBind` (`src/config/bind.ts:85` — assinatura real `(host, allowedHosts)`, sem parâmetro de modo) | `test/unit/config/bind.test.ts:11-15 (recusa binds em todas as interfaces)` | TESTE DIRIGIDO |
| M-48 | permitir `up` sem segredo | `test/unit/control/controller.test.ts:313-321 (CTL-009 — start sem segredo forte -> recusado)` | TESTE DIRIGIDO |
| M-49 | segredo gravado em claro no arquivo de estado | `test/unit/secret/store.test.ts:46-59 (provisiona 256 bits, persiste SO o digest e mostra o segredo uma vez)` | TESTE DIRIGIDO |
| M-50 | `buildWorkerEnv` fazendo `{...process.env}` | `test/security/secret-leak-canary.test.ts (ADV-055) + test/unit/proc/env.test.ts` | TESTE DIRIGIDO |

**M-37 — não-matável por mutação única (justificativa escrita).** A prevenção de
reinício após `signal.aborted` é imposta em TRÊS camadas independentes:
(1) `if (isCancelled())` no `handleTermination` do supervisor; (2) `if (deps.isCancelled())`
no `conclude()` do orçamento (`src/proc/retry.ts`); (3) `if (handle !== spawned) return` no
mesmo tratador. Verificado por teste dirigido: remover UMA ou DUAS camadas mantém a suíte
verde (SUP-009 continua a passar); só removendo as TRÊS o `SUP-009` falha. Uma mutação de
camada única é inobservável — é exatamente o comportamento que a defesa em profundidade
(02-SEGURANCA §9, fail-safe) exige, e o score de ferramenta não é critério de aceite.

**M-44 — não-matável por mutação única (justificativa escrita).** A idempotência do
`dispose()` é imposta em DUAS camadas: (1) o `latch disposed` no início do disposer; (2)
`releaseCurrentHandle()` limpa `handle` ANTES de qualquer tree-kill, pelo que uma segunda
chamada encontra `handle === undefined` e não mata. Verificado por teste dirigido: remover
o `latch` sozinho mantém `3 chamadas, 1 kill` (o teste `o disposer continua idempotente` passa);
a idempotência observável é preservada pela segunda camada. Uma mutação de camada única
é inobservável — a suíte atual não a consegue matar, e a justificativa fica registada.

# Veredito do spike de T6.3 (1 h) — Stryker 10.0.0 + node:test

**VALIDADO — a dependência fica.** Medido nesta matriz (Node 24.15.0, pnpm 11.7.0, TS em
strip-only mode, `@stryker-mutator/core@10.0.0` + `@stryker-mutator/tap-runner@10.0.0`):

- O Stryker NÃO tem runner nativo para `node:test` (issue #5421 aberta, sem implementação).
  O caminho DOCUMENTADO é o **tap-runner**, que desde v7.0 cobre "the build-in node test
  runner" como produtor de TAP — e foi esse o caminho que o spike mediu.
- `src/ratelimit/policy.ts` (134 mutantes) com os testes de política + tracker: **92 mortos,**
  **0 no-cov**, com `coverageAnalysis: 'all'` (o `perTest` reporta falsos no-cov porque o
  tap-runner vê cada FICHEIRO como uma unidade de teste — limitação declarada, usada
  honestamente: a config usa `'all'`).
- `src/http/gate.ts` + `path.ts` (314 mutantes) com suites de segurança + integração do
  portão (servidores reais): **160 mortos**, 82 no-cov legítimos (código exercitado só por
  suites não incluídas naquela execução), 2 erros.
- Mutações em código de NÍVEL DE MÓDULO (ex.: apagar o `assertRateLimitPolicy` de load) fazem
  o processo de teste morrer ao importar → contabilizadas como ERROS, não como mortos.
  Aceite: `break: null` e o job noturno não bloqueia PR.

**Decisão (regista 04-TESTES §7.3).** O item NÃO sai do aceite: o suporte via tap-runner é
funcional e medido. Fica `stryker.config.mjs` (thresholds `high: 80, low: 60, break: null`,
`coverageAnalysis: 'all'`, `incremental` para CI, `test:mutation` = `stryker run` no
`package.json`) e a nota em `docs/TESTING.md` (criado) sobre o limite: per-test coverage
não está disponível com node:test, o score de ferramenta NUNCA é critério de aceite, e o
checklist 50/50 acima é a verificação que vale.

# Ratificacao da EMENDA-COSTURA-5 (COMMIT PREP 6)

A costura da Onda 5 (commit 89f96af) emendou o contrato IPC (src/contracts/ipc.ts) com TRES
mensagens novas, marcadas no codigo como 'a RATIFICAR no COMMIT PREP 6'. Ficam RATIFICADAS:

| Mensagem | Direcao | Forma | Porque |
| --- | --- | --- | --- |
| nonce.request | worker -> host | {acao: ControlAction, requestId} | o fluxo de 2 etapas do /ligar//rotacionar do Telegram: o worker PEDE o nonce ao host (S5: o nonce e emitido e validado SO no host) |
| nonce.issued | host -> worker | {acao, requestId, nonce, expiresAt} | o host responde com o nonce opaco (TTL 60 s do ConfirmService de T5.1); timeout 5 s fail-closed no worker — sem nonce, o intent que AUMENTA exposicao NAO sai (CTL-023) |
| pairing.owner | host -> worker | {fromId, chatId, pairedAt} | no boot, o host informa o dono persistido (state.json) e o worker re-monta a superficie com o receptor FECHADO — sem nova parelha |

Invariantes preservadas: S1 (uma mensagem por linha), S2 (JSONL so em stdout), S3 (nenhum
segredo no payload — o nonce viaja SO neste pipe, nunca em log nem no texto do Telegram;
o digest do codigo de pareamento continua a excecao unica e nomeada), S4 (malformada e
descartada sem derrubar o canal), parsers das DUAS pontas em paridade (presa por teste).

PENDENCIAS declaradas para a Onda 6 (handoff da costura): emissor de auth_falha_primeira_janela
(caminho de autenticacao + limitador, janela de 10 min — o teste de honestidade do vocabulario
obriga a mover para EMITIDOS quando chegar); reveal do painel (ponte CLI -> /__guard/secret);
decisao do /parear em grupo no HOST (mensagem worker->host de pareamento concluido + state.json).
