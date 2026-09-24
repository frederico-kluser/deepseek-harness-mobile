/**
 * INTROSPECCAO DE PROCESSOS: quem e o programa por tras de um pid, e desde quando.
 *
 * PORQUE VIVE EM `src/proc/**` E NAO JUNTO DE QUEM O USA: nada aqui sabe o que e
 * um tunel. Sao leituras de `/proc` que respondem a duas perguntas genericas —
 * "que programa e este pid?" e "desde quando existe?" — e a POLITICA de o que
 * fazer com a resposta e de quem chama (`src/tunnel/pidfile.ts`). Separar as duas
 * coisas e o que permite testar a leitura contra o sistema operativo real e a
 * decisao contra valores escolhidos a mao.
 *
 * TUDO AQUI DEVOLVE `null` EM VEZ DE LANCAR. Ausencia de `/proc` (macOS), pid que
 * ja saiu, ficheiro de outro utilizador: sao todos "nao da para saber", que e uma
 * resposta legitima e diferente de um erro. Quem chama decide o que fazer com a
 * ignorancia — e em `pidfile.ts` essa decisao esta escrita em voz alta.
 */
/**
 * Le a linha de comando de um pid. `null` quando nao ha como saber.
 *
 * `/proc/<pid>/cmdline` traz o `argv` separado por bytes `NUL`. Ele NAO existe em
 * macOS, e ai a funcao devolve `null` de proposito em vez de inventar uma
 * alternativa que exigiria lancar um `ps` — spawnar um processo dentro da
 * varredura que corre "antes de qualquer outra inicializacao" trocaria um
 * controlo simples por uma dependencia de arranque.
 */
export declare function readProcessCmdline(pid: number): string | null;
/**
 * O PROGRAMA de uma linha de comando: `argv[0]`, e nada mais.
 *
 * `/proc/<pid>/cmdline` traz o `argv` inteiro. O primeiro elemento e o programa;
 * todos os outros sao dados que ele recebeu, e um NOME QUE APARECE NUM ARGUMENTO
 * NAO E O PROGRAMA. Confundir os dois e a diferenca entre matar o tunel e matar
 * o editor que tem o ficheiro de configuracao aberto.
 */
export declare function programOf(cmdline: string): string;
/**
 * Instante em que um pid arrancou, em epoch ms. `null` quando nao ha como saber.
 *
 * PORQUE ISTO EXISTE (e o `cmdline` sozinho nao chega): a identificacao por linha
 * de comando responde "e outro PROGRAMA?". NAO responde "e outra INSTANCIA do
 * mesmo programa?", que e o caso classico de reciclagem de pid — e o mais caro,
 * porque a vitima e um `cloudflared` legitimo do utilizador, com o tunel de
 * producao dele por tras. Medido antes desta correccao: registo `pid: 424242,
 * startedAt: 1000` mais um `/usr/bin/cloudflared tunnel run o-tunel-do-utilizador`
 * a ocupar esse pid davam `outcome: 'killed'`.
 *
 * O campo 22 de `/proc/<pid>/stat` (`starttime`) e o instante do arranque em
 * TICKS desde o boot. Duas dificuldades, e as duas tem resposta sem dependencia
 * nenhuma:
 *
 *   - o `comm` (campo 2) pode conter espacos e parenteses, o que estraga um
 *     `split` ingenuo. Le-se a partir do ULTIMO `)`, que e como o proprio kernel
 *     documenta que se faz;
 *   - o Node nao expoe `CLK_TCK`. Em vez de assumir 100 (o valor quase universal,
 *     mas ainda assim uma suposicao), CALIBRA-SE com o proprio processo: sabemos
 *     ha quantos segundos ele arrancou (`os.uptime() - process.uptime()`) e
 *     sabemos quantos ticks isso deu. Se a calibracao nao for fiavel (processo
 *     acabado de arrancar), devolve-se `null` em vez de um numero inventado.
 */
export declare function readProcessStartMs(pid: number): number | null;
/**
 * Folga entre "o processo arrancou" e "o dono do registo o gravou".
 *
 * O registo e escrito no gancho `onSpawned`, milissegundos DEPOIS de o processo
 * existir, portanto o arranque real e sempre ANTERIOR ao valor gravado. A folga
 * cobre a resolucao de segundos do `os.uptime()` e um relogio que ande um pouco;
 * um pid reciclado costuma se-lo minutos ou horas depois, muito alem disto.
 */
export declare const START_TIME_TOLERANCE_MS = 60000;
/**
 * `true` enquanto o pid existir. Usa `kill(pid, 0)`, que NAO entrega sinal nenhum
 * — so pergunta ao nucleo se ha alguem ali.
 *
 * `EPERM` conta como VIVO: significa que o processo existe e pertence a outra
 * conta. Tratar isso como "nao existe" faria a varredura de orfao concluir que
 * nao ha nada a derrubar precisamente quando ha.
 */
export declare function isProcessAlive(pid: number): boolean;
//# sourceMappingURL=introspect.d.ts.map