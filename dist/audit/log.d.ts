/**
 * Log de auditoria append-only, 0600, FORA do workspace e FORA do Telegram.
 * DONO: T2.4. Implementa `AuditSink` (`../contracts/auth.ts`, congelado).
 *
 * NAO NO TELEGRAM: o bot e canal de NOTIFICACAO -- mensagens apagaveis pelo dono,
 * ordenadas pelo servidor de outra pessoa, e o Telegram e das coisas que este
 * plugin audita quando falha. Um registo que vive dentro do sistema que audita
 * nao e um registo; `./notify.ts` (T5.4) notifica sempre DEPOIS do log. NAO NO
 * WORKSPACE: ele e servido pela Web UI e commitado, e um ficheiro com as
 * tentativas de autenticacao e os IPs la dentro e uma fuga a espera de suceder.
 *
 * APPEND-ONLY A SERIO: `O_WRONLY | O_CREAT | O_APPEND`. Com `O_APPEND` o nucleo
 * posiciona a escrita no FIM DENTRO da propria `write(2)` -- sem "procurar o fim,
 * depois escrever", logo sem janela para outro processo se meter. Ao contrario
 * de um `writeFile`, que abre com `O_TRUNC` e apaga a prova em silencio.
 *
 * DISCO CHEIO: FECHA (fail-closed). Justificacao em {@link AuditWriteError}.
 *
 * SEM ROTACAO, com um numero atras: quem alimenta este ficheiro e o caminho de
 * autenticacao, atras do limitador de T2.3 -- 100 falhas consecutivas ativam o
 * modo restrito e derrubam a exposicao, ~18 KB antes de a torneira fechar. Ter
 * rotacao seria dar a este ficheiro a unica primitiva que ele existe para nao
 * ter: uma que apaga bytes ja escritos. */
import type { AuditEvent, AuditSink } from '../contracts/auth.ts';
/** Subdiretorio deste plugin sob a raiz do host. O MESMO que guarda o estado. */
export declare const AUDIT_DIR_NAME = "guarded-bot";
/** Nome do ficheiro. Estavel: ha operadores a apontar `tail -F` para ele. */
export declare const AUDIT_FILE_NAME = "audit.log";
/** Modos: nem grupo nem outros, nem sequer leitura. */
export declare const AUDIT_FILE_MODE = 384;
export declare const AUDIT_DIR_MODE = 448;
/**
 * Nome do evento sintetico que marca uma LACUNA no registo.
 *
 * >>> PARA T5.4: tem de entrar no vocabulario fechado de `./events.ts`, escrito
 * >>> com sufixo `:<n>` (registos perdidos) -- reconhecido por PREFIXO.
 *
 * Sem ele, disco cheio deixa um salto de tempo e mais nada, e quem ler nao
 * distingue "ninguem tentou" de "nao deu para registar". */
export declare const EVENTO_LACUNA = "auditoria_lacuna";
/**
 * Move o ficheiro para outro volume. PORQUE E UM BOTAO: com fail-closed, encher
 * o volume onde vive o log fecha o gate -- e uma decisao dura sem mitigacao
 * operacional e so uma decisao dura. */
export declare const AUDIT_PATH_ENV = "DSH_GUARD_AUDIT_LOG";
/**
 * Falha ao ABRIR o log. Q-3 deste repositorio: *fail loud at load*.
 *
 * Um plugin de seguranca que arranca sem conseguir registar arranca cego. As
 * condicoes -- caminho relativo, dentro do workspace, modo mais frouxo que 0600,
 * symlink, alvo nao regular, diretorio frouxo -- sao de CONFIGURACAO e resolvem-se
 * antes do primeiro pedido: falhar alto custa uma mensagem no arranque, falhar
 * baixo custa descobrir seis meses depois que o log era 0644. A mensagem CONTEM
 * caminhos de proposito -- stderr do operador, nunca um corpo HTTP. */
export declare class AuditOpenError extends Error {
    readonly name = "AuditOpenError";
}
/**
 * Falha ao ESCREVER no log. E a resposta a pergunta do disco cheio.
 *
 * ============================ FAIL-CLOSED ============================
 * `append()` LANCA. Nao engole nem "regista em memoria e continua": quem chama e
 * o caminho de autenticacao, e a excecao e o sinal de que a decisao que ele
 * acabou de tomar NAO ficou registada -- para um gate isso tem de significar
 * negar. `03-ONDAS.md:1632` exige-o literalmente. PORQUE NAO fail-open:
 *
 *   1. ASSIMETRIA. Explorar o fail-closed exige encher o disco da maquina, e
 *      quem escreve no disco ja executa codigo la dentro -- ponto em que este
 *      plugin ja nao e a defesa relevante. O fail-open so exige ESPERAR que o
 *      disco encha e atacar remotamente, sem deixar uma linha: e uma janela de
 *      forca bruta INVISIVEL nascida de uma falha de recurso.
 *   2. E LITERALMENTE A ENTREGA. "Registra TODA tentativa de auth"; um sink que
 *      serve pedidos que nao consegue registar nao esta degradado -- esta a
 *      mentir sobre a sua unica funcao.
 *   3. O CUSTO E RECUPERAVEL, o do fail-open nao. Disco cheio arranja-se na
 *      maquina e o dono TEM a maquina; uma janela de forca bruta sem registo
 *      nao se arranja, porque os bytes nunca existiram.
 *
 * NAO E o lockout permanente que T2.3 rejeita: aquele e disparado por um
 * ATACANTE (auto-DoS remoto), este pelo ESTADO DO HOST, que nenhum pedido remoto
 * controla, e desaparece assim que houver espaco -- {@link AuditLog.append}
 * volta a tentar em cada chamada, sem latch.
 * =====================================================================
 *
 * >>> COSTURA PARA O PREP DA ONDA 3: a `message` e generica e o caminho vive em
 * >>> {@link AuditWriteError.path}, NAO APRESENTAVEL. D9 exige `401` de corpo
 * >>> identico em toda falha de autenticacao; propagar isto em cru daria um
 * >>> `500` com texto proprio -- oraculo, e com topologia de disco dentro.
 */
export declare class AuditWriteError extends Error {
    readonly name = "AuditWriteError";
    /** Registos que ja se perderam nesta janela de falha. */
    readonly perdidos: number;
    /** NAO APRESENTAVEL: topologia de disco. Para o log do operador, nunca HTTP. */
    readonly path: string;
    constructor(message: string, perdidos: number, path: string, options?: {
        cause?: unknown;
    });
}
/** Assinatura da escrita, para o teste simular `ENOSPC` sem encher o disco. */
export type WriteSyscall = (fd: number, data: Uint8Array) => number;
export interface AuditLogOptions {
    /** Caminho absoluto do ficheiro. Omitido: {@link resolveAuditLogPath}. */
    readonly path?: string;
    /** Relogio injetavel (`04-TESTES.md` 8.1). Omitido: `Date.now`. */
    readonly now?: () => number;
    /**
     * FORNECEDOR de literais a mascarar, avaliado a cada escrita: o segredo roda e
     * o URL do tunel muda a cada arranque, logo uma lista capturada na abertura
     * fica obsoleta no instante em que passa a importar. */
    readonly secrets?: () => readonly string[];
    /** Raiz proibida. Omitido: `process.cwd()`. Ver o cabecalho do modulo. */
    readonly workspaceRoot?: string;
    /**
     * `fsync` a cada linha. DESLIGADO por omissao: e uma ida ao disco no caminho de
     * autenticacao, e T2.3 exige tempo de resposta INDISTINGUIVEL entre sucesso e
     * falha -- latencia de I/O variavel ali e um oraculo. O que se perde sem ele e
     * a janela do page cache num corte de energia. */
    readonly fsyncEachWrite?: boolean;
    /** Costura de teste. Ver {@link WriteSyscall}. */
    readonly write?: WriteSyscall;
}
export interface AuditLog extends AuditSink {
    /** Caminho efetivo, ja resolvido. */
    readonly path: string;
    /** Escreve UMA linha. LANCA {@link AuditWriteError} se nao conseguir. */
    append(event: AuditEvent): void;
    /** Registos perdidos desde a ultima escrita bem sucedida. `0` = log intacto. */
    perdidos(): number;
    /**
     * Disposer SINCRONO (Q-2), e pode se-lo sem perder nada: `writeSync` e uma
     * chamada ao sistema direta, sem buffer em espaco de utilizador. Idempotente:
     * o segundo `dispose` nao fecha um descritor que ja e de outra pessoa. */
    dispose(): void;
}
/**
 * `$DSH_GUARD_AUDIT_LOG`, senao `<raiz do host>/guarded-bot/audit.log`, com a
 * raiz na precedencia do host: configurada > `$DSH_HOME` > `~/.dsh`.
 *
 * NOTA DE FRONTEIRA: e DELIBERADAMENTE a mesma raiz e o mesmo subdiretorio que
 * T2.5 usa para o `state.json`, e nao por simetria -- fazer backup da raiz do
 * host, ou move-la para um disco cifrado, tem de levar o log que regista todas
 * as tentativas de autenticacao do dono; noutra arvore ele fica para tras,
 * invisivel, na operacao em que o dono julga levar tudo. Se a raiz mudar, muda
 * nos DOIS ficheiros -- {@link HOST_HOME_DIR_NAME} diz porque nao se importa. */
export declare function resolveAuditLogPath(env?: Readonly<Record<string, string | undefined>>, home?: string, configuredHome?: string): string;
/** Abre (ou cria) o log. LANCA {@link AuditOpenError} -- *fail loud at load*. */
export declare function openAuditLog(options?: AuditLogOptions): AuditLog;
//# sourceMappingURL=log.d.ts.map