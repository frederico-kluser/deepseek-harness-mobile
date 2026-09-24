/**
 * Relogio e espera INJETADOS. Nenhum modulo deste worker chama `Date.now()` ou
 * `setTimeout` diretamente.
 *
 * PORQUE (`04-TESTES.md` 8.1, e os casos TG-043 e TG-049 em concreto): o
 * espacamento de 1 mensagem/segundo por chat e a espera de `retry_after` do 429
 * sao, os dois, "o programa dorme N milissegundos". Um teste que esperasse esse
 * tempo real seria lento e instavel; um que mockasse `setTimeout` globalmente
 * contaminaria a suite inteira. A dependencia entra pela porta da frente.
 *
 * NAO se reutiliza `test/support/clock.ts`: aquele e apoio de TESTE (e so tem
 * `now()`), e codigo de producao nao importa de `test/`.
 */
/**
 * Implementacao real.
 *
 * O timer e SEMPRE limpo e o ouvinte SEMPRE removido — nos dois caminhos. Um
 * `setTimeout` esquecido segura o event loop e adia a saida do processo; um
 * ouvinte de `abort` esquecido e uma fuga por cada espera que ocorre, e este
 * worker espera uma vez por mensagem.
 *
 * Abortar RESOLVE em vez de rejeitar. Rejeitar obrigaria cada chamador a apanhar
 * uma excecao que nao descreve erro nenhum — o processo esta a fechar, e isso
 * nao e uma falha. Quem precisa de saber consulta `signal.aborted` a seguir, que
 * e o que o transformer de `./auto-retry.ts` faz.
 *
 * `ms <= 0` resolve JA, sem agendar nada.
 */
export const systemTime = {
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise((resolve) => {
        if (!(ms > 0) || signal?.aborted === true) {
            resolve();
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve();
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort);
    }),
};
//# sourceMappingURL=clock.js.map