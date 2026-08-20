# Checklist dos 50 mutantes (04-TESTES §7.2 — lista FECHADA, congelada no COMMIT PREP 6)

Rito (D16): aplica-se o mutante, roda-se a suíte, EXIGE-SE falha, reverte-se.
Um sobrevivente é um buraco de teste NOMEADO, não uma métrica. Mutation score de
ferramenta NÃO é critério de aceite — mutation testing automatizado roda em job
noturno separado, `break` desligado, não bloqueia PR. T6.3 preenche e assina.

| Mutante | Mutação | Teste que o mata | Verificado por |
| --- | --- | --- | --- |
| M-01 | remover a guarda `pid === undefined` do tree-kill |  |  |
| M-02 | reintroduzir `&& !child.killed` no tree-kill |  |  |
| M-03 | trocar `process.kill(-pid)` por `process.kill(pid)` |  |  |
| M-04 | trocar `SIGKILL` por `SIGTERM` no tree-kill final |  |  |
| M-05 | remover o `try/catch` de ESRCH |  |  |
| M-06 | `timingSafeEqual` → `===` |  |  |
| M-07 | comparar credencial crua em vez de digest |  |  |
| M-08 | remover o `.toLowerCase()` do esquema |  |  |
| M-09 | aceitar qualquer esquema (remover a checagem de prefixo) |  |  |
| M-10 | `isTrustedRemote`: `length === 0 → true` (lista vazia = todos) |  |  |
| M-11 | remover a normalização IPv4-mapeado |  |  |
| M-12 | `isGuardedPath`: `startsWith` sem fronteira de segmento |  |  |
| M-13 | remover a decodificação percent em `canonicalRequestPath` |  |  |
| M-14 | decodificar percent **duas** vezes |  |  |
| M-15 | trocar 403 por 401 na negação de origem |  |  |
| M-16 | remover `WWW-Authenticate` do 401 |  |  |
| M-17 | responder 401 com corpo diferente para "usuário existe" |  |  |
| M-18 | `requestsDeniedPermission`: comparar substring em vez de token |  |  |
| M-19 | remover o gate do handler de **upgrade** |  |  |
| M-20 | guardar upgrade só nos `guardedPrefixes` |  |  |
| M-21 | no `catch` do upgrade, chamar o handler original |  |  |
| M-22 | allowlist do Telegram: validar `chat.id` e não `from.id` |  |  |
| M-23 | allowlist: `from` ausente ⇒ aceito |  |  |
| M-24 | allowlist: comparar `username` |  |  |
| M-25 | allowlist vazia ⇒ aceita tudo |  |  |
| M-26 | token de confirmação reutilizável |  |  |
| M-27 | token de confirmação sem TTL |  |  |
| M-28 | token não ligado ao `from.id` |  |  |
| M-29 | não chamar `answerCallbackQuery` no caminho de negação |  |  |
| M-30 | ler a URL do túnel do **stdout** |  |  |
| M-31 | remover o prefixo `https://` do hostname |  |  |
| M-32 | timeout de readiness `Infinity` |  |  |
| M-33 | não abortar o wait no `close` do processo |  |  |
| M-34 | `--metrics` sem host explícito |  |  |
| M-35 | acrescentar `--loglevel debug` |  |  |
| M-36 | supervisor pendurar em `exit` e não em `close` |  |  |
| M-37 | reiniciar mesmo com `signal.aborted` |  |  |
| M-38 | `maxAttempts` ignorado (retry infinito) |  |  |
| M-39 | `resetAfterMs` sempre zerando o contador |  |  |
| M-40 | backoff sem teto (`maxDelayMs` ignorado) |  |  |
| M-41 | backoff sem jitter |  |  |
| M-42 | `seq` não incrementa |  |  |
| M-43 | `start` em `READY` faz `spawn` novo |  |  |
| M-44 | `dispose` não idempotente |  |  |
| M-45 | `dispose` assíncrono |  |  |
| M-46 | `intercept` não desfeito no dispose |  |  |
| M-47 | `assertSecureBind` aceita `0.0.0.0` quando `exposure.mode='tunnel'` |  |  |
| M-48 | permitir `up` sem segredo |  |  |
| M-49 | segredo gravado em claro no arquivo de estado |  |  |
| M-50 | `buildWorkerEnv` fazendo `{...process.env}` |  |  |

# Política de mutation testing (congelada no COMMIT PREP 6)

- Mutation testing automatizado roda em **job noturno separado**, com `break`
  desligado, e **não bloqueia PR**.
- O runner do projeto continua sendo `node:test`. **Não** se introduz Vitest —
  trocar o runner do projeto inteiro por causa de uma ferramenta de qualidade
  secundária é custo desproporcional (decisão de 03-ONDAS §11).
- T6.3 abre com um spike de 1 h: se o Stryker não suportar `node:test` na versão
  da matriz, o item sai do aceite e vira nota em `docs/TESTING.md`.
- O critério de aceite é ESTE checklist preenchido (cada mutante com o teste
  nomeado que o mata, ou a justificativa escrita de por que não é matável) —
  nunca o score da ferramenta.

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

