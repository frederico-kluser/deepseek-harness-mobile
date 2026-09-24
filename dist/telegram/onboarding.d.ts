/**
 * =============================================================================
 * Onboarding do Telegram: DETECTOR de estado + o texto que a pessoa le.
 * =============================================================================
 *
 * DONO: T4.1. Duas entregas num ficheiro, e elas nao se separam:
 *
 *   1. um DETECTOR PURO — recebe um retrato do ambiente e devolve o proximo
 *      passo. Zero I/O na funcao de decisao;
 *   2. o TEXTO — `TG-070` diz, com todas as letras, que o que a pessoa ve em
 *      cada um dos quatro estados e artefacto revisavel, nao improviso de quem
 *      implementa. Por isso ele vive aqui, em constantes, e nao espalhado por
 *      `console.log` dentro do CLI, onde ninguem o reve e qualquer refactor o
 *      troca por uma mensagem tecnica sem que nenhum teste caia.
 *
 * -----------------------------------------------------------------------------
 * E UMA SUB-MAQUINA DE ESTADOS, NAO UM README (`01-ARQUITETURA.md` 9.5)
 * -----------------------------------------------------------------------------
 *     SEM_TOKEN -> TOKEN_INVALIDO -> TOKEN_OK_SEM_DONO -> PRONTO
 *
 * A propriedade que interessa e "guiar SO O PASSO EM FALTA": correr a
 * ferramenta com o token ja configurado tem de SALTAR o passo do BotFather.
 * Um tutorial linear que reimprime tudo a cada execucao nao e onboarding, e um
 * ficheiro de texto com um `cat` a frente. A prova disso e testavel e esta
 * testada: o texto de `TOKEN_OK_SEM_DONO` e o de `PRONTO` nao contem `/newbot`.
 *
 * -----------------------------------------------------------------------------
 * REGRAS DO TEXTO, e cada uma tem uma razao operacional
 * -----------------------------------------------------------------------------
 *   - PORTUGUES, sem jargao. O publico e quem acabou de instalar o harness.
 *   - SEM STACK TRACE e SEM NOME DE SIMBOLO INTERNO. Um `TypeError: Cannot read
 *     properties of undefined` no ecra nao diz a ninguem o que fazer a seguir.
 *   - SEM CAMINHO ABSOLUTO QUE IDENTIFIQUE O UTILIZADOR. Este texto e copiado
 *     para issues e colado em chats; `/home/<nome>/...` leva o nome da conta
 *     junto. Ver {@link caminhoApresentavel}: o `~` ja e a forma anonima do
 *     mesmo caminho e continua a dizer QUAL o ficheiro.
 *   - SEM SEGREDO. O token nunca aparece no texto — nem truncado. O codigo de
 *     pareamento aparece EXATAMENTE num sitio (o texto de `TOKEN_OK_SEM_DONO`,
 *     que so o terminal imprime), e a funcao que o compoe exige-o como
 *     parametro explicito, para que nenhum outro chamador o obtenha por acaso.
 */
import { type StatePaths } from '../state/paths.ts';
import type { DonoPareado } from './pairing.ts';
import type { ProviderId } from '../proc/env.ts';
import type { RespostaGetMe } from '../onboarding/sonda.ts';
import { type OpcoesDePasso } from './texts.ts';
export { AVISOS_ANTES_DO_TUNEL, COMANDO_CLI, textoSemDono, textoSemToken, textoPronto, textoTokenInvalido, tituloSemToken, tituloTokenInvalido, TITULO_PRONTO, TITULO_SEM_DONO, TITULO_SEM_TOKEN, TITULO_TOKEN_INVALIDO, type OpcoesDePasso, } from './texts.ts';
export type OnboardingErrorCode = 
/** O token veio na linha de comando. Recusado: `argv` e publico (TG-069). */
'SETUP_TOKEN_IN_ARGV'
/** Argumento que a ferramenta nao conhece. */
 | 'SETUP_UNKNOWN_ARGUMENT'
/** O `secrets.env` esta legivel por outras contas desta maquina. */
 | 'SECRETS_MODE_TOO_OPEN'
/** Nao foi possivel ler o `secrets.env` que existe. */
 | 'SECRETS_READ_FAILED'
/** Nao foi possivel gravar o `secrets.env`. O ficheiro antigo ficou intacto. */
 | 'SECRETS_WRITE_FAILED'
/** Nome de variavel invalido para um ficheiro de ambiente. */
 | 'SECRETS_KEY_INVALID';
export declare class OnboardingError extends Error {
    readonly name = "OnboardingError";
    readonly code: OnboardingErrorCode;
    constructor(code: OnboardingErrorCode, detail: string);
}
/** Nome da variavel, no `secrets.env` e no ambiente (`02-SEGURANCA.md` 8.1). */
export declare const CHAVE_DO_TOKEN = "TELEGRAM_BOT_TOKEN";
/**
 * Teto de comprimento do token.
 *
 * Um token real tem ~46 caracteres (`<id de 8 a 10 digitos>:<35 caracteres>`).
 * 80 e folga generosa; acima disso o que se colou nao foi um token — foi uma
 * linha inteira, um URL, ou dois tokens colados. Recusar por comprimento ANTES
 * da rede evita mandar para o Telegram o que quer que a pessoa tenha colado.
 */
export declare const COMPRIMENTO_MAXIMO_DO_TOKEN = 80;
export type MotivoDeFormato = 'vazio' | 'sem-dois-pontos' | 'id-comeca-por-zero' | 'id-nao-numerico' | 'segredo-curto' | 'caracteres-invalidos' | 'comprimento-excessivo';
/**
 * A forma de um token VALIDO, por provedor.
 *
 * `botId` e OPCIONAL de proposito: e o `bot_user_id` do TELEGRAM (a parte
 * antes dos dois pontos do token), e nenhum consumidor do retrato usa o
 * `botId` (os textos so leem `valido`/`motivo`).
 */
export type FormatoDoToken = {
    readonly valido: true;
    readonly botId?: number | undefined;
} | {
    readonly valido: false;
    readonly motivo: MotivoDeFormato;
};
/**
 * TG-061 — ERRO DE FORMATO ANTES DE QUALQUER CHAMADA DE REDE.
 *
 * Nao e so economia de latencia. Um token malformado enviado a API do Telegram
 * cai FORA da rota (`/bot<lixo>/getMe`) e devolve `404 Not Found` sem
 * `description` util — medido em `docs/spikes/telegram.md` 2.1. Ou seja: a rede
 * responde PIOR do que nos. E o que a pessoa colou (que pode ser qualquer coisa
 * que estivesse na area de transferencia) viaja para um terceiro sem precisar.
 */
export declare function validarFormatoDoToken(bruto: string): FormatoDoToken;
export type EstadoOnboarding = 'SEM_TOKEN' | 'TOKEN_INVALIDO' | 'TOKEN_OK_SEM_DONO' | 'PRONTO';
/** De onde veio o token — muda a instrucao de como o corrigir. */
export type OrigemDoToken = 'secrets.env' | 'ambiente';
export interface TokenConfigurado {
    readonly origem: OrigemDoToken;
    readonly formato: FormatoDoToken;
}
/**
 * O RETRATO DO AMBIENTE: tudo o que o detector precisa de saber, ja recolhido.
 *
 * Este e o ponto em que o I/O acaba. Quem recolhe (o CLI, ou o painel de T5.3)
 * faz as chamadas; quem decide nao faz nenhuma. E por isso que os quatro
 * estados sao testaveis sem rede, sem disco e sem relogio real.
 */
export interface RetratoDoAmbiente {
    /** `undefined` = nao ha token nenhum configurado. */
    readonly token: TokenConfigurado | undefined;
    /** `undefined` = ninguem chamou `getMe` nesta execucao. */
    readonly getMe: RespostaGetMe | undefined;
    /** `pairing` do `state.json`. `undefined` = pareamento por fazer. */
    readonly dono: DonoPareado | undefined;
}
/**
 * A funcao de decisao. PURA: nao le disco, nao fala com a rede, nao ve relogio.
 *
 * A ordem das guardas e a maquina de estados de `01-ARQUITETURA.md` 9.5, e
 * duas delas merecem justificacao:
 *
 *   - FORMATO ANTES DE `getMe`: um token malformado nunca chega a ser enviado
 *     (TG-061), logo `getMe` vem `undefined` e nao ha ambiguidade.
 *   - `getMe` POR CONFIRMAR CONTA COMO NAO CONFIRMADO. Um token que ninguem
 *     validou nao e um token bom; supo-lo bom levaria a ferramenta a pedir o
 *     codigo de pareamento e a ficar a espera de um `/parear` que nunca chega,
 *     porque o bot nem sequer existe. Falha-se para o lado que diz a verdade.
 */
export declare function detectarEstado(retrato: RetratoDoAmbiente): EstadoOnboarding;
/**
 * O passo que a pessoa ve. `titulo` e uma linha; `texto` e o corpo.
 *
 * `estado` sai junto porque o painel (T5.3) precisa de o REPRESENTAR (icone,
 * cor), nao de o mostrar: o nome do estado e simbolo interno e nao entra no
 * texto — TG-070 assere-o.
 */
export interface PassoDeOnboarding {
    readonly estado: EstadoOnboarding;
    readonly titulo: string;
    readonly texto: string;
}
/**
 * A FUNCAO DE DECISAO COMPLETA: retrato -> proximo passo, com o texto.
 *
 * Repare no que ela NAO faz: nao imprime, nao le, nao espera. Devolve uma
 * string. E por isso que o CLI e o painel podem ser duas superficies do MESMO
 * motor — uma implementacao, duas superficies (`03-ONDAS.md`, aceite de T4.1).
 */
export declare function proximoPasso(retrato: RetratoDoAmbiente, opcoes: OpcoesDePasso): PassoDeOnboarding;
export type ComandoDoCli = 'guiar' | 'pedir-token' | 'parear' | 'reset-pairing' | 'ajuda';
export interface ArgumentosDoCli {
    readonly comando: ComandoDoCli;
    /** `--sim`: confirmacao ja dada, para uso nao interativo deliberado. */
    readonly confirmado: boolean;
}
/**
 * TG-069 — TOKEN NO `argv` E RECUSADO, COM EXPLICACAO.
 *
 * PORQUE E RECUSA E NAO AVISO: em Linux, `/proc/<pid>/cmdline` e legivel por
 * qualquer processo da maquina, e um `ps aux` de outra conta mostra a linha de
 * comando inteira. O token e a senha de controlo total do bot
 * (`bots/features#botfather`: *"it can be used by anyone to control your bot"*).
 * Aceitar "so desta vez" seria publicar a senha e depois pedir desculpa: no
 * instante em que o processo arranca, o valor ja esta a vista, e nenhum
 * tratamento posterior o desfaz. A linha de comando fica ainda no historico da
 * shell, que e um ficheiro em disco que ninguem se lembra de limpar.
 *
 * A recusa apanha as tres formas: a bandeira `--token`, a bandeira com valor
 * colado (`--token=...`), e um valor SOLTO com forma de token — porque a
 * tentativa mais provavel e `dsh-guard-setup 123456789:AA...`, sem bandeira
 * nenhuma.
 */
export declare function analisarArgumentos(argv: readonly string[]): ArgumentosDoCli;
/** Vive ao lado do `state.json`, no diretorio de estado 0700 e FORA do git. */
export declare const NOME_DO_SECRETS_ENV = "secrets.env";
/** Modo do ficheiro. O MESMO do `state.json`: so o dono le e escreve. */
export declare const MODO_DO_SECRETS_ENV = 384;
/**
 * Le um `secrets.env` em memoria. Formato deliberadamente MINIMO.
 *
 * Nao ha expansao de variavel, nao ha continuacao de linha, nao ha
 * interpolacao: este ficheiro guarda segredos, e cada regra de expansao e uma
 * forma nova de o conteudo de uma linha influenciar outra. Aspas simples ou
 * duplas EM VOLTA do valor inteiro sao retiradas, porque e o que toda a gente
 * escreve; o resto e literal.
 */
export declare function analisarSecretsEnv(texto: string): Map<string, string>;
/**
 * TG-068 — funde uma chave PRESERVANDO todas as outras linhas.
 *
 * "Preserva as outras linhas" e literal: comentarios, linhas em branco, ordem,
 * espacamento e chaves de outros componentes ficam byte a byte como estavam. A
 * alternativa obvia — ler para um mapa e reescrever o ficheiro a partir do mapa
 * — perderia os comentarios e reordenaria tudo, e o `secrets.env` e partilhado:
 * apagar a linha de outra pessoa e apagar o segredo de outra pessoa.
 *
 * A chave existente e substituida NO LUGAR (nao no fim), para que o ficheiro
 * nao ganhe uma linha a cada execucao e para que o comentario que explica
 * aquela linha continue por cima dela.
 */
export declare function fundirSecretsEnv(existente: string, chave: string, valor: string): string;
/** Onde vive o `secrets.env`: ao lado do `state.json`, no mesmo diretorio 0700. */
export declare function caminhoDoSecretsEnv(paths: StatePaths): string;
/**
 * Le o `secrets.env`, RECUSANDO um ficheiro exposto a outras contas.
 *
 * A verificacao e a mesma de `src/state/store.ts` e pela mesma razao: o modo e
 * lido por `fstat` SOBRE O DESCRITOR de onde se le o conteudo, nunca por um
 * `stat` do caminho antes de abrir — assim nao ha janela entre verificar e
 * usar. `O_NOFOLLOW` faz um `secrets.env` trocado por link simbolico dar
 * `ELOOP` em vez de ser seguido em silencio para o alvo que outra pessoa
 * escolheu.
 *
 * Recusa-se em vez de "corrigir com chmod": um ficheiro com o token que esteve
 * legivel por outras contas e um token que PODE ja ter sido lido, e um chmod
 * nosso apagaria a unica pista de que ele tem de ser rodado no BotFather.
 */
export declare function lerSecretsEnv(caminho: string): string | undefined;
/** O MINIMO que a escrita do `secrets.env` precisa de saber (o HOST + o CLI). */
export interface EscritaDeSegredos {
    readonly paths: StatePaths;
    readonly caminhoSecrets: string;
}
/**
 * Grava a chave preservando o resto do ficheiro, com modo 0600 (TG-068).
 *
 * A escrita e ATOMICA e pela mesma razao que a do `state.json`: o temporario
 * nasce no MESMO diretorio (`rename(2)` so e atomico dentro do mesmo sistema de
 * ficheiros), leva `fchmod` explicito (o `mode` do `open` passa pelo `umask` do
 * host, que so RETIRA bits) e um `fsync` antes do `rename`, para que a entrada
 * nova nunca aponte para bytes que ainda estao em cache. Um leitor concorrente
 * ve o ficheiro velho inteiro ou o novo inteiro — nunca meio `secrets.env`, que
 * seria um token truncado a arrancar o harness.
 *
 * `O_EXCL | O_NOFOLLOW` no temporario: nome novo a cada escrita, e nenhum link
 * simbolico e seguido.
 *
 * E o DESTINO UNICO da escrita do token em runtime: o CLI (`bin/dsh-guard-setup`)
 * e a rota POST /__guard-ui/api/token chamam EXATAMENTE esta funcao — nao ha
 * um segundo writer do `secrets.env` para a mesma chave.
 *
 * LANCAMENTO de `OnboardingError` quando a gravacao falha; o ficheiro antigo
 * fica intacto (o `rename` so acontece depois de o novo estar completo).
 */
export declare function gravarSecretsEnv(ctx: EscritaDeSegredos, chave: string, valor: string): void;
/**
 * De onde sai o token, e por que ordem.
 *
 * `secrets.env` PRIMEIRO, ambiente a seguir: o ficheiro e a decisao deliberada
 * de quem correu o onboarding nesta maquina; a variavel de ambiente e o
 * fallback documentado (`02-SEGURANCA.md` 8.1) e pode vir herdada de um shell
 * qualquer sem ninguem reparar. NUNCA o `.env` do projeto: ele esta DENTRO do
 * workspace que o agente le, e injecao de prompt e premissa operacional deste
 * plano, nao risco residual (`01-ARQUITETURA.md` 9.5).
 *
 * A `chave` e o NOME da variavel a ler nas DUAS fontes — a CHAVE do provedor
 * ativo (`PROVIDER_ENV[provider].tokenVar`): `TELEGRAM_BOT_TOKEN` por omissao.
 * O default e o telegram para que quem chama sem provedor continue a correr
 * exatamente como antes (D1).
 */
export declare function resolverToken(caminho: string, ambiente?: Readonly<Record<string, string | undefined>>, chave?: string): {
    readonly token: string;
    readonly origem: OrigemDoToken;
} | undefined;
/**
 * Torna um caminho mostravel sem publicar o nome da conta.
 *
 * `/home/ana/.dsh/guarded-bot/secrets.env` -> `~/.dsh/guarded-bot/secrets.env`.
 * Continua a dizer QUAL o ficheiro, deixa de dizer DE QUEM — e este texto e
 * copiado para issues e colado em conversas. O `~` e a forma anonima do mesmo
 * caminho, e e por isso que `src/logging/redact.ts` nao lhe toca.
 *
 * Fora da casa do utilizador, `redact()` decide: ele mascara `$HOME` e deixa
 * `/opt`, `/etc` e afins em paz, porque essa estrutura e igual em todas as
 * maquinas e e ela que diz onde procurar.
 */
export declare function caminhoApresentavel(caminho: string, casa?: string): string;
export { API_ROOT_PADRAO, classificarFalha, criarSondaHttp, lerIdentidade, LIMITE_DE_UPDATES, TIMEOUT_DA_SONDA_MS, type CausaDeFalha, type FalhaDoGetMe, type IdentidadeDoBot, type OpcoesDaSonda, type RespostaGetMe, type ResultadoDeUpdates, type SondaTelegram, } from '../onboarding/sonda.ts';
/**
 * A checagem de formato do PROVEDOR ATIVO (a porta usada pelo painel).
 *
 * Telegram: a forma estrita `\d{5,12}:[A-Za-z0-9_-]{20,}` (TG-061). Um
 * provedor novo acrescenta o ramo aqui, nao nos chamadores.
 */
export declare function validarFormatoDe(_provedor: ProviderId, bruto: string): boolean;
//# sourceMappingURL=onboarding.d.ts.map