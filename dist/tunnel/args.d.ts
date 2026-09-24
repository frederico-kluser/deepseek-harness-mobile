/**
 * =============================================================================
 * `argv` do `cloudflared`. Array SEMPRE, `shell` NUNCA.
 * =============================================================================
 *
 * Tres controlos de seguranca vivem neste ficheiro, e nenhum deles e convencao:
 *
 * 1. `--metrics 127.0.0.1:PORT` EXPLICITO E FIXO — E NAO SE AFIRMA AQUI QUAL E O
 *    DEFAULT. As fontes congeladas deste repositorio contradizem-se sobre isso:
 *    `src/contracts/tunnel.ts` e `04-TESTES.md` TUN-011 dizem "porta aleatoria,
 *    com fallback 20241-20245"; o cabecalho de `test/bin/fake-cloudflared.mjs`
 *    diz, com enfase, o oposto. Resolver a contradicao exigiria medir o binario
 *    REAL, e este plano proibe faze-lo aqui (D10). Escrever uma das versoes seria
 *    afirmar o que nao se sabe.
 *
 *    A CONCLUSAO OPERACIONAL NAO DEPENDE DE QUAL DELAS ESTA CERTA, e e por isso
 *    que o controlo existe na mesma: nos dois mundos a porta default e
 *    DISPUTADA. Dois `cloudflared` na mesma maquina, ou qualquer processo sentado
 *    na porta que o binario escolher, deslocam-na em silencio — e a descoberta de
 *    URL passaria a ler o servidor de metricas DE OUTRO TUNEL. Nao se confia no
 *    default, nao se adivinha a faixa: passa-se a porta, sempre.
 *
 * 2. `--token-file`, NUNCA `--token`. `argv` e legivel por qualquer processo do
 *    mesmo utilizador em `/proc/<pid>/cmdline` e no `ps`. Um token de named
 *    tunnel em `argv` e uma credencial publicada para a maquina inteira. Q-4:
 *    "segredo nunca em argv".
 *
 * 3. `--loglevel debug` PROIBIDO POR CODIGO. O modo debug do `cloudflared` regista
 *    URLs, metodos e TODOS os cabecalhos das requisicoes que atravessam o tunel
 *    — ou seja, o `Authorization` e o `Cookie` de sessao dos pedidos autenticados
 *    do dono. Nao basta "nao escrever a flag": o nivel tambem entra por ambiente
 *    (`TUNNEL_LOGLEVEL`), e por isso o nivel e escrito EXPLICITAMENTE no `argv` e
 *    a variavel de ambiente e apagada com uma lapide.
 *
 * NAO MEDIDO, e declarado como tal (`05-QUALIDADE-CODIGO.md` 7.4): a precedencia
 * "flag de linha de comando ganha da variavel de ambiente" e o comportamento
 * normal do `urfave/cli`, que o `cloudflared` usa, mas NAO foi medido por esta
 * sub-tarefa. Por isso os dois controlos existem em vez de um: a flag explicita E
 * a lapide no ambiente. Se a precedencia fosse ao contrario, a lapide sozinha
 * ainda fecharia o caso.
 */
import type { Server } from 'node:http';
import type { TunnelConfig, TunnelFailure, TunnelMode } from '../contracts/tunnel.ts';
import type { SubprocessSpawnSpec } from '../dsh/adapter.ts';
import { type ProcessFailure } from '../proc/failure.ts';
/** Interface de escuta do servidor de metricas. Loopback, e so loopback. */
export declare const METRICS_HOST = "127.0.0.1";
/**
 * Nivel de log escrito explicitamente no `argv`.
 *
 * `'info'` e o nivel em que o banner da URL sai em `stderr` — que e o caminho de
 * fallback da descoberta (T3.2). Baixar para `warn` calaria esse banner e
 * deixaria a descoberta so com o caminho primario.
 */
export declare const CLOUDFLARED_LOGLEVEL = "info";
/**
 * Janela de graca por omissao (`SubprocessSpawnSpec.graceMs`), alinhada com
 * `worker.graceMs`. O `--grace-period` do proprio `cloudflared` tem default 30 s;
 * o nosso e passado EXPLICITAMENTE porque o assento nao aplica defaults nenhuns
 * ("this seam applies no defaults") e um `graceMs` em falta seria um erro de spec.
 */
export declare const DEFAULT_GRACE_MS = 3000;
/**
 * Orcamento de reinicio por omissao. Os numeros sao os MESMOS do supervisor do
 * worker, e isso e deliberado: T3.1 generaliza o supervisor em vez de o duplicar,
 * e dois orcamentos diferentes para o mesmo mecanismo seriam a primeira fenda por
 * onde a generalizacao deixaria de ser real.
 */
export declare const DEFAULT_TUNNEL_BACKOFF: {
    readonly initialDelayMs: 500;
    readonly maxDelayMs: 10000;
    readonly maxAttempts: 10;
    readonly resetAfterMs: 60000;
};
/** Comando efetivo do `cloudflared`. Ausente = resolvido pelo `PATH` do assento. */
export declare function resolveCloudflaredCommand(binaryPath: string | undefined): string;
/**
 * Porta da ORIGEM, derivada de um `net.Server` DESTE processo e EM ESCUTA.
 *
 * PORQUE NAO ACEITA UM NUMERO, e este e o controlo mais importante do ficheiro:
 * `cloudflared --url http://localhost:3080` publica na Internet o que estiver
 * naquela porta, sem perguntar nada a ninguem. Durante a pesquisa que originou
 * este plano a porta 3080 ja estava ocupada pelo DSH do utilizador, o origin de
 * teste nao conseguiu bindar, e o quick tunnel expos o Harness real, publicamente
 * e sem autenticacao, durante ~40 segundos.
 *
 * Um numero de porta e uma AFIRMACAO sobre o mundo ("ali esta o meu servidor"). Um
 * `Server` com `listening === true` e uma PROVA: `listen()` numa porta que outro
 * processo ja serve falha com `EADDRINUSE` antes de existir servidor. A posse e
 * verificada no INSTANTE DO USO — o `buildSpec` do supervisor chama isto a cada
 * tentativa — e nao uma vez no arranque, porque um servidor fechado entretanto
 * deixa de ser prova.
 */
export declare function originPortOfOwnServer(server: Server | undefined | null): number;
/** Tudo o que decide a linha de comando de uma tentativa de tunel. */
export interface CloudflaredArgvInput {
    readonly binaryPath: string | undefined;
    readonly mode: TunnelMode;
    /** Porta da origem, ja PROVADA por {@link originPortOfOwnServer}. */
    readonly originPort: number;
    /** Porta do servidor de metricas, escolhida por nos e sempre explicita. */
    readonly metricsPort: number;
    /** Caminho do ficheiro `0600` com o token. Obrigatorio sse `mode === 'named'`. */
    readonly tokenFile?: string | undefined;
}
/**
 * Monta o `argv` do `cloudflared`.
 *
 * O `argv` e TOTALMENTE determinado por esta funcao: nao ha campo de "argumentos
 * extra" na configuracao, e essa ausencia e a decisao. Um canal por onde o
 * utilizador injeta flags e um canal por onde `--loglevel debug` volta.
 */
export declare function buildCloudflaredArgv(input: CloudflaredArgvInput): readonly string[];
/**
 * O SPEC COMPLETO de uma tentativa de spawn do `cloudflared`.
 *
 * Vive aqui, e nao no supervisor, porque tudo o que ele decide e "como se lanca
 * este binario": o `argv`, o ambiente, o `cwd` e a janela de graca. O supervisor
 * decide QUANDO lancar; este ficheiro decide COM O QUE.
 */
export declare function buildCloudflaredSpec(input: {
    readonly config: TunnelConfig;
    readonly metricsPort: number;
    readonly origin: Server;
    readonly signal: AbortSignal;
}): SubprocessSpawnSpec;
/**
 * Ambiente EXPLICITO do `cloudflared`.
 *
 * `undefined` e uma LAPIDE no contrato do assento ("a tombstone that removes an
 * ordinary ambient entry from the child"), e e isso que se usa aqui: o nivel de
 * log e o token nao podem entrar por ambiente herdado. Sem as lapides, um
 * `TUNNEL_TOKEN` exportado no shell do utilizador passaria a ser a credencial
 * efetiva do tunel sem que nada na configuracao o dissesse, e um
 * `TUNNEL_LOGLEVEL=debug` reactivaria o registo de cabecalhos que o controlo 3
 * existe para impedir.
 */
export declare function buildCloudflaredEnv(): NodeJS.ProcessEnv;
/**
 * Recusa um `argv` proibido.
 *
 * PORQUE EXISTE, se o `argv` e todo montado acima: e o guardiao da proxima
 * edicao. Alguem que acrescente uma flag "so para depurar" tropeca aqui, e o
 * teste TUN-013 falha antes de o commit sair da maquina. Um controlo que so
 * existe no cuidado de quem escreve nao e um controlo — e um controlo que so
 * reconhece UMA das duas grafias da mesma flag tambem nao.
 */
export declare function assertNoForbiddenArgv(argv: readonly string[]): void;
/**
 * Projecta a falha GENERICA do supervisor de processos na falha do TUNEL.
 *
 * VIVE NESTE FICHEIRO porque a unica coisa que ela acrescenta e CONHECIMENTO
 * SOBRE O BINARIO — onde se instala, o que significa nao o poder executar — e e
 * este o ficheiro que sabe o que e o executavel do `cloudflared`. Nao pode viver
 * em `src/proc/**`: o supervisor generico nao sabe (nem deve saber) que existe um
 * repositorio da Cloudflare em `pkg.cloudflare.com`.
 */
export declare function toTunnelFailure(processFailure: ProcessFailure): TunnelFailure;
//# sourceMappingURL=args.d.ts.map