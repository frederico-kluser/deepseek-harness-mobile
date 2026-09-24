/**
 * =============================================================================
 * O UNICO writer do `state.json` em todo o repositorio.
 * =============================================================================
 *
 * DONO: T2.5. Implementa `StateStore` de `src/contracts/state.ts` (CONGELADO no
 * COMMIT PREP 2). A invariante congelada com o contrato: T2.1 (`secretDigest`),
 * T2.3 (modo restrito), T3.1 (`tunnel.pid` para a varredura de orfao) e T5.1
 * (`desiredState`) passam TODAS por aqui. Verificavel por comando:
 * `grep -rn 'state.json' src worker bin` so pode mostrar `src/state/**`.
 *
 * -----------------------------------------------------------------------------
 * AS TRES GARANTIAS, e porque cada uma e escrita assim e nao de outra forma
 * -----------------------------------------------------------------------------
 *
 * 1. ESCRITA ATOMICA DE VERDADE.
 *    O temporario nasce em `paths.dir` — o MESMO diretorio do destino. Nao e
 *    detalhe: `rename(2)` so e atomico DENTRO do mesmo sistema de ficheiros, e
 *    um temporario em `os.tmpdir()` esta, na maquina tipica, noutro
 *    (`/tmp` em tmpfs, `$HOME` no disco). Ali, `rename` falha com `EXDEV` ou o
 *    runtime degrada para copiar-e-apagar, que e precisamente a escrita
 *    NAO-atomica que isto existe para evitar.
 *    A ordem e: escrever tudo -> `fchmod` 0600 -> `fsync` -> `close` ->
 *    `rename` -> `fsync` do DIRETORIO. O `fsync` ANTES do `rename` e o que faz
 *    com que a entrada nova nunca aponte para bytes que ainda estao em cache; o
 *    `fsync` do diretorio e o que torna o proprio `rename` duravel. Um leitor
 *    concorrente ve sempre o ficheiro velho INTEIRO ou o novo INTEIRO.
 *
 * 2. RECUSA CARREGAR COM MODO FROUXO (`02-SEGURANCA.md` 8.2 item 7).
 *    O modo e lido por `fstat` sobre o MESMO descritor de onde se le o conteudo
 *    — nao por um `stat` do caminho antes de abrir. Assim nao ha janela entre
 *    verificar e usar: o que foi verificado e o que foi lido. E abre-se com
 *    `O_NOFOLLOW`, para que um `state.json` substituido por um link simbolico
 *    de e para outro sitio de com `ELOOP` em vez de ser seguido em silencio.
 *    Recusa-se em vez de "corrigir com `chmod`": um ficheiro que esteve legivel
 *    por outros e um segredo que PODE ja ter sido lido, e apagar o vestigio com
 *    um chmod nosso tiraria ao dono a unica pista de que tem de rodar o segredo.
 *
 * 3. CORROMPIDO PARA, NUNCA "COMECA DO ZERO".
 *    A distincao e entre AUSENCIA e CORRUPCAO, e so ela: `ENOENT` (ficheiro
 *    nao existe) e primeiro arranque legitimo e devolve `emptyState()`; um
 *    ficheiro que EXISTE e nao le como estado valido — inclusive vazio — lanca
 *    `STATE_CORRUPT` com a mensagem acionavel de `schema.ts`. Recomecar do zero
 *    apagaria `secretDigest` e `pairing`: trocaria a senha e o dono do bot sem
 *    que ninguem tivesse pedido.
 *
 * -----------------------------------------------------------------------------
 * LIMITE CONHECIDO, escrito de proposito: um so PROCESSO.
 * -----------------------------------------------------------------------------
 * `update()` e read-modify-write. E atomico face a LEITORES (nunca ha ficheiro
 * meio escrito) e serializado dentro deste processo (o `update` reentrante
 * lanca). NAO ha lock entre processos: dois processos a chamar `update()` em
 * simultaneo podem perder a escrita do primeiro. A arquitetura nao tem esse
 * caso — o worker do Telegram fala com o plugin por IPC (`src/ipc/channel.ts`)
 * e nao toca no disco — e um lockfile traria caducidade de lock obsoleto, que
 * e um modo de falha novo por um problema que nao existe. Se algum dia existir,
 * o sitio e aqui, e este paragrafo e o aviso.
 */
import type { PersistedState, StateStore } from '../contracts/state.ts';
import { type ResolveStatePathsOptions, type StatePaths } from './paths.ts';
/**
 * NOTA sobre o temporario que SOBRA depois de um crash.
 *
 * Se o processo morrer entre o `fsync` e o `rename` (e `test/unit/state/
 * crash.test.ts` mata-o exatamente ali), o temporario fica no disco. Isso e
 * deliberado e nao se varre no arranque: o ficheiro e o VESTIGIO de que houve
 * uma escrita interrompida, traz o pid de quem a comecou, nunca colide com
 * outro nome, e a leitura so alguma vez abre `state.json`. Apaga-lo no boot
 * seguinte destruiria a unica pista, para poupar bytes que ninguem conta.
 */
export interface StateStoreOptions extends ResolveStatePathsOptions {
    /**
     * Caminhos ja resolvidos. E por aqui que o teste injeta `makeTempStateDir()`
     * (`test/support/state-dir.ts`) sem mexer no ambiente do processo.
     */
    readonly paths?: StatePaths | undefined;
    /**
     * PONTO DE INJECAO EXCLUSIVO DO TESTE DE CRASH, e nao um `hook` generico.
     *
     * Corre entre o `fsync` e o `rename`. A pergunta falsificavel 1 de
     * `03-ONDAS.md` 7 exige matar o processo NO MEIO da escrita e ler o ficheiro
     * depois — e "no meio" nao e observavel de fora sem um instante nomeado.
     * Em producao ninguem passa isto e a propriedade custa uma chamada opcional.
     */
    readonly beforeRename?: (() => void) | undefined;
}
/** Q-2: tudo o que aloca recurso devolve disposer SINCRONO. */
export interface StateStoreHandle {
    readonly store: StateStore;
    readonly paths: StatePaths;
    /** Fecha o store: temporarios pendentes sao apagados e o uso seguinte lanca. */
    dispose(): void;
}
/**
 * O item 7 de `02-SEGURANCA.md` 8.2, em codigo.
 *
 * A mensagem diz o que fazer E o que a permissao frouxa significa: o `chmod`
 * fecha a porta a partir de agora, nao desfaz uma leitura que ja tenha
 * acontecido. Por isso instrui tambem a rotacao — que e a unica coisa que
 * invalida um segredo possivelmente ja visto.
 */
export declare function assertNotExposed(mode: number, file: string): void;
/**
 * Le, verifica e valida — nesta ordem, sobre um so descritor.
 *
 * `ENOENT` e `ENOTDIR` (o diretorio ainda nao existe) sao a AUSENCIA legitima:
 * primeiro arranque. Tudo o resto e uma falha que tem de ser vista.
 */
export declare function readStateFrom(paths: StatePaths): PersistedState;
/**
 * Torna o proprio `rename` duravel.
 *
 * Sem isto, os bytes do ficheiro estao no disco (garantido pelo `fsync` do
 * ficheiro) mas a ENTRADA DE DIRETORIO que lhes da o nome pode nao estar. Nem
 * todos os sistemas de ficheiros e plataformas suportam `fsync` num descritor
 * de diretorio; onde nao suportam, a falha e informativa e nao muda o
 * resultado ja escrito — por isso e engolida DE PROPOSITO, e so aqui.
 *
 * Exportada para que os dois caminhos engolidos sejam EXERCIDOS por teste: uma
 * excepcao que ninguem consegue provocar num teste e uma excepcao que ninguem
 * sabe se esta escrita ao contrario.
 */
export declare function syncDirectory(dir: string): void;
export declare function createStateStore(options?: StateStoreOptions): StateStoreHandle;
//# sourceMappingURL=store.d.ts.map