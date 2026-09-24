/**
 * Contrato do CONTROLADOR UNICO — COMMIT PREP 5. CONGELADO.
 *
 * LEITURA LIVRE, ESCRITA PROIBIDA na Onda 5 (03-ONDAS.md 16: protocolo de
 * violacao — uma sub-tarefa que precise alterar isto PARA e reporta).
 *
 * O que este ficheiro congela:
 *
 *   1. As TRANSICOES LEGAIS da maquina de estados, na forma de uma TABELA
 *      (fonte normativa: 01-ARQUITETURA 6 — ver a nota de discrepancia de
 *      diagrama mais abaixo). O VOCABULARIO dos estados vive em
 *      `src/contracts/tunnel.ts` (PREP 3) e NAO e duplicado aqui — duas
 *      fontes da verdade divergiriam na primeira correcao.
 *
 *   2. `ControlIntent` e o resultado do despacho, com a TRANSCRICAO de D29
 *      (09-DECISOES-CANONICAS.md D29): `start` recebido em `STOPPING` e
 *      REJEITADO com `SHUTDOWN_IN_PROGRESS`, sem fila e sem reconciliacao
 *      posterior. O PREP 5 nao decide nada: transcreve.
 *
 *   3. O contrato do NONCE DE CONFIRMACAO (`src/control/confirm.ts`, T5.1):
 *      server-side no HOST, TTL 60 s, uso unico. O worker so transporta o
 *      valor opaco (S5/S6 de src/contracts/ipc.ts).
 *
 * A implementacao (serializacao de intents em fila de um, idempotencia por
 * `requestId`, reconciliacao com o processo real, broadcast com `seq`
 * monotonico) e de T5.1 (`src/control/controller.ts`), que tambem e dona da
 * fiacao em `src/index.ts`.
 */
/**
 * Fonte normativa: 01-ARQUITETURA 6 ("Transicoes, gatilhos e efeitos").
 *
 * DISCREPANCIA DE DIAGRAMA, RESOLVIDA AQUI. O diagrama de 03-ONDAS 10 desenha
 * `STOPPING --falha--> FAILED`; a tabela de 01-ARQUITETURA 6 NAO o lista.
 * Vale a tabela: `STOPPING` so sai para `STOPPED`. Se a morte do processo
 * falhar, o supervisor (T3.1) tem SIGTERM -> janela de graca -> SIGKILL e o
 * estado PERMANECE `STOPPING` ate o processo morrer — fail-closed: nunca se
 * declara STOPPED um tunel que pode estar vivo. O diagrama tambem desenha
 * `DEGRADED --backoff esgotou sem sucesso--> STOPPED`; a tabela nao o lista e
 * tampouco vale — a saida do DEGRADED e FAILED (terminal) ou STARTING
 * (re-tentativa). Se a implementacao medir que uma borda ausente acontece na
 * pratica, reporta (03 13.2) e o PREP 6 corrige.
 */
export const TRANSICOES_LEGAIS = [
    { de: 'STOPPED', para: 'STARTING', gatilho: 'start() por bot|UI. Pre: exposure.mode tunnel, segredo forte valido, probe L1 fail-closed passou' },
    { de: 'STARTING', para: 'READY', gatilho: 'URL obtida em /quicktunnel E probe local responde' },
    { de: 'STARTING', para: 'DEGRADED', gatilho: 'falha: timeout de readiness (>=30 s) ou close do processo' },
    { de: 'READY', para: 'DEGRADED', gatilho: 'close/error do cloudflared' },
    { de: 'DEGRADED', para: 'STARTING', gatilho: 're-tentativa automatica com backoff (orcamento nao esgotado)' },
    { de: 'DEGRADED', para: 'FAILED', gatilho: 'orcamento esgotado' },
    { de: 'STOPPED', para: 'FAILED', gatilho: 'erro nao-retryable (ENOENT, EACCES, config invalida) — CTL-013: sem passar por STARTING' },
    { de: 'STARTING', para: 'FAILED', gatilho: 'erro nao-retryable (ENOENT, EACCES, config invalida)' },
    { de: 'DEGRADED', para: 'FAILED', gatilho: 'erro nao-retryable (ENOENT, EACCES, config invalida)' },
    { de: 'READY', para: 'STOPPING', gatilho: 'stop() por bot|UI|disposer OU TTL expirado' },
    { de: 'STARTING', para: 'STOPPING', gatilho: 'stop() por bot|UI|disposer' },
    { de: 'DEGRADED', para: 'STOPPING', gatilho: 'stop() por bot|UI|disposer' },
    { de: 'STOPPING', para: 'STOPPED', gatilho: 'processo confirmado morto' },
    { de: 'FAILED', para: 'STOPPED', gatilho: 'reset() explicito do dono — UNICO caminho de saida' },
];
// ---------------------------------------------------------------------------
// 3. O CONTRATO DO NONCE DE CONFIRMACAO (T5.1 implementa em src/control/confirm.ts)
// ---------------------------------------------------------------------------
export const NONCE_TTL_MS = 60_000;
//# sourceMappingURL=control.js.map