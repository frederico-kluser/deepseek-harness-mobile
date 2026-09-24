/**
 * =============================================================================
 * O codigo de pareamento: 6 digitos, TTL 5 min, uso unico, so no terminal.
 * =============================================================================
 *
 * DONO: T4.1. Este ficheiro GERA e VALIDA o codigo no HOST. A recepcao do
 * `/parear <codigo>` dentro do worker de long polling e de T4.4
 * (`worker/auth/pairing.ts`) e NAO esta aqui.
 *
 * -----------------------------------------------------------------------------
 * PORQUE UM CODIGO, E NAO "o primeiro `/start` vence"
 * -----------------------------------------------------------------------------
 * Ha uma janela entre "o bot existe" e "a allowlist esta preenchida". Nessa
 * janela, QUALQUER pessoa que descubra o bot pode ser a primeira a mandar
 * `/start` e virar o dono. Isso e uma CORRIDA, e e uma corrida que o atacante
 * ganha: nomes de bot sao adivinhaveis (`bots/features` exige o sufixo `bot`, o
 * que reduz o espaco de nomes), o dono esta a ler um tutorial, e o atacante tem
 * um script. E ganha-la nao e um incomodo — e `shell`: com o dono pareado, o
 * `/acessar` (`01-ARQUITETURA.md` 9.5) EMITE SESSAO sem que ninguem digite a
 * senha permanente. Ou seja, ganhar a corrida do pareamento EQUIVALE a ter a
 * senha, sem nunca a ter visto.
 *
 * O codigo fecha a janela porque amarra a identidade do Telegram a POSSE DO
 * TERMINAL, que e a raiz de confianca real deste sistema: quem tem o terminal
 * ja tem a maquina, e quem tem a maquina ja tinha tudo. O codigo nao acrescenta
 * um segredo novo ao modelo — ele TRANSPORTA um privilegio que ja existia.
 * (`02-SEGURANCA.md` 7.2, passos 3 a 6; `09-DECISOES-CANONICAS.md` D8.)
 *
 * -----------------------------------------------------------------------------
 * PAIR-010 — O CODIGO EXISTE NO STDOUT DO TERMINAL E EM MAIS LADO NENHUM
 * -----------------------------------------------------------------------------
 * Nunca em log, nunca em resposta HTTP, nunca em payload do Telegram. Aqui isso
 * nao e so uma promessa em comentario, e uma propriedade da ESTRUTURA:
 *
 *   1. o codigo vive numa VARIAVEL DE FECHO, nao numa propriedade do objeto —
 *      logo `console.log(sessao)` e `util.inspect(sessao)` nao o alcancam;
 *   2. `toJSON()` esta definido e devolve {@link ResumoDePareamento} — logo
 *      `JSON.stringify(sessao)`, que e como um valor acaba num corpo HTTP ou
 *      num `sendMessage`, tambem nao o alcanca;
 *   3. a UNICA porta e {@link SessaoDePareamento.revelarCodigo}, cujo nome
 *      existe para aparecer no `grep` de quem revê o codigo.
 *
 * -----------------------------------------------------------------------------
 * TETO DE TENTATIVAS (`02-SEGURANCA.md` 8.3; RL-018 / PAIR-007)
 * -----------------------------------------------------------------------------
 * Seis digitos sao 10^6, e as tentativas chegam pelo Telegram — de graca, sem
 * limite nosso e sem CAPTCHA. Um codigo de 6 digitos com TTL de 5 min e SEM
 * teto de tentativas e forca bruta viavel dentro do proprio TTL. Por isso a
 * sessao esgota-se ao fim de {@link TENTATIVAS_MAXIMAS} codigos errados e passa
 * a `esgotado` — o que NAO tranca nada de forma permanente: o operador gera
 * outro codigo no terminal, que e precisamente a prova de posse que se quer.
 */
/** Seis digitos: o que uma pessoa copia do terminal para o telemovel sem errar. */
export declare const DIGITOS_DO_CODIGO = 6;
/** TTL de 5 minutos (`02-SEGURANCA.md` 7.2, passo 3). */
export declare const TTL_DO_CODIGO_MS: number;
/**
 * Codigos ERRADOS tolerados antes de a sessao se esgotar.
 *
 * Cinco, e nao "sem limite": ver o cabecalho. E nao 1, porque a pessoa digita
 * no telemovel e um digito trocado nao pode custar-lhe recomecar o onboarding.
 */
export declare const TENTATIVAS_MAXIMAS = 5;
/** A forma que o dono digita no chat. O nome do comando e canonico (D5). */
export declare const COMANDO_DE_PAREAMENTO = "/parear";
/** Codigos estaveis: a mensagem e para a pessoa, o codigo e para o programa. */
export type PairingErrorCode = 
/** O codigo fornecido a {@link criarSessaoDePareamento} nao tem a forma exigida. */
'PAIRING_CODE_MALFORMED'
/** Pediu-se o codigo a uma sessao que ja nao o pode dar (consumida/esgotada). */
 | 'PAIRING_SESSION_CLOSED';
export declare class PairingError extends Error {
    readonly name = "PairingError";
    readonly code: PairingErrorCode;
    constructor(code: PairingErrorCode, detail: string);
}
/** Fonte de aleatoriedade injetavel. `randomInt` do `node:crypto` satisfaz-la. */
export type FonteDeInteiros = (min: number, max: number) => number;
/**
 * Gera um codigo de 6 digitos por CSPRNG (PAIR-001).
 *
 * `crypto.randomInt` e a escolha e nao `Math.random()` (que nao e CSPRNG) nem
 * `randomBytes(4) % 1e6` (que tem VIES DE MODULO: 2^32 nao e multiplo de 10^6,
 * e os primeiros 967 296 valores sairiam mais vezes que os restantes). O
 * `randomInt` do Node faz amostragem por rejeicao e devolve uniforme em
 * `[min, max)`.
 *
 * O `padStart` e o que torna `000123` um codigo legitimo: sem ele o espaco
 * encolhia de 10^6 para 900 000 e os codigos "curtos" nunca sairiam.
 */
export declare function gerarCodigoDePareamento(fonte?: FonteDeInteiros): string;
export declare function codigoTemFormaValida(candidato: string): boolean;
/**
 * Compara dois codigos em tempo constante.
 *
 * Nao e teatro por serem so 6 digitos: as tentativas chegam pela rede e a
 * comparacao curta-circuito de `===` vaza o prefixo acertado. Custa uma
 * chamada; a alternativa e um oraculo que reduz 10^6 a 60 tentativas.
 * `timingSafeEqual` EXIGE comprimentos iguais (lanca `RangeError` se diferirem),
 * por isso o comprimento e verificado antes — e o comprimento nao e segredo.
 */
export declare function codigosSaoIguais(a: string, b: string): boolean;
/**
 * O DONO, tal como o contrato o guarda (`src/contracts/state.ts`) — os DOIS
 * EIXOS em STRING (EMENDA ONDA-1-IPC-ENVELOPE-STRING, V2).
 *
 * DOIS ids, e nao um: `from.id` e quem FALA, `chat.id` e ONDE. Em conversa
 * privada eles coincidem por construcao, que e exatamente a armadilha que faz
 * alguem validar so um (A-12 de `05-QUALIDADE-CODIGO.md`). Guardam-se os dois
 * porque e com os dois que a decisao do dono se fecha.
 */
export interface DonoPareado {
    readonly ownerUserId: string;
    readonly ownerChatId: string;
    readonly pairedAt: number;
}
/**
 * O que um `/parear <codigo>` traz, depois de lido de um update cru.
 *
 * `userId`/`chatId` ja nascem STRING aqui: o update cru carrega numeros, mas a
 * FRONTEIRA deste parser converte para string UMA vez (V2) — o mesmo principio
 * do `parse.ts` do adaptador. Todo o resto do pipeline e string.
 */
export interface ComandoDePareamento {
    readonly userId: string;
    readonly chatId: string;
    readonly codigo: string;
}
/** Porque um update NAO virou pareamento. Cada motivo e contado. */
export type MotivoDeDescarte = 
/** Nao e `/parear <6 digitos>` — inclui `/start`, que NAO pareia ninguem (D8). */
'nao-e-comando-de-pareamento'
/** `message.from` ausente: channel post. A doc marca o campo `Optional`. */
 | 'sem-remetente'
/** `message.chat.id` ausente ou nao numerico. */
 | 'sem-conversa'
/**
 * A conversa NAO e privada (grupo, supergrupo ou canal).
 *
 * PORQUE E RECUSA E NAO DETALHE: `ownerChatId` e PARA ONDE O BOT RESPONDE.
 * Amarrado a um grupo, tudo o que o bot enviar ao dono chega a todos os
 * membros — e o que ele envia inclui o que o `/acessar` emite, que e o LINK
 * MAGICO DE USO UNICO que estabelece sessao (`01-ARQUITETURA.md` 9.5). Um
 * pareamento acidental num grupo converte o canal de entrega de credencial
 * num canal publico. E nao e hipotetico: o sufixo `@nome_do_bot` que este
 * ficheiro aceita de proposito e precisamente a forma que o cliente do
 * Telegram usa EM GRUPOS, logo este caminho e alcancavel a partir de um.
 *
 * POLITICA DO PROVEDOR TELEGRAM: a sessao de pareamento e provider-agnostica
 * nos tipos (os dois eixos do dono sao STRING desde o V2); e o PARSER deste
 * ficheiro que conhece a gramatica do canal — um adaptador de outro canal
 * leria os seus proprios updates e aplicaria a sua propria politica de "onde
 * o pareamento pode acontecer", sem herdar `chat.type === 'private'`.
 */
 | 'conversa-nao-privada'
/** Chegou um codigo, e nao era este. */
 | 'codigo-errado'
/** O TTL ja tinha passado quando o update chegou. */
 | 'codigo-expirado'
/** Ja ha dono: a sessao foi consumida. Segundo `/parear` e recusado. */
 | 'ja-pareado'
/** Teto de tentativas atingido: os excedentes nem sao comparados. */
 | 'tentativas-esgotadas';
/**
 * Le `/parear <codigo>` de um update cru, sem confiar em nada.
 *
 * O parametro e `unknown` DE PROPOSITO: o valor vem de um `JSON.parse` de
 * resposta de rede. Um tipo declarado aqui seria uma promessa do compilador
 * sobre bytes que o compilador nunca viu.
 *
 * O que se aceita: `message.text` que comece por `/parear`, opcionalmente com o
 * sufixo `@nome_do_bot` (o cliente Telegram acrescenta-o em grupos), seguido do
 * codigo. O que NAO se aceita, e cada um por uma razao:
 *   - `message.from` ausente -> `sem-remetente`. `#message` marca `from` como
 *     *"Optional. Sender of the message; may be empty for messages sent to
 *     channels."*, logo a ausencia tem de ser NEGACAO e nao "assume-se o chat".
 *   - `message.chat.type` diferente de `'private'` -> `conversa-nao-privada`.
 *     Ver o motivo em {@link MotivoDeDescarte}: o `chat.id` de um grupo e um
 *     endereco publico, e e para ele que o bot passaria a mandar credenciais.
 *     `#chat` fixa os quatro valores possiveis: `private`, `group`,
 *     `supergroup`, `channel`. Lista BRANCA: um tipo novo na Bot API entra
 *     como recusa, nao como aceitacao silenciosa.
 *   - `edited_message`, `channel_post`, `callback_query` -> nao sao lidos aqui.
 *     Parear por mensagem EDITADA deixaria o dono trocar o texto de uma
 *     mensagem antiga, ja entregue, para reabrir a corrida.
 */
export declare function lerComandoDePareamento(update: unknown): ComandoDePareamento | {
    readonly descarte: MotivoDeDescarte;
};
/** Estado observavel da sessao. Nenhum deles contem o codigo. */
export type EstadoDaSessao = 'aberto' | 'expirado' | 'consumido' | 'esgotado';
/** O que se pode dizer da sessao em voz alta — log, painel, auditoria. */
export interface ResumoDePareamento {
    readonly estado: EstadoDaSessao;
    readonly criadoEm: number;
    readonly expiraEm: number;
    /** Updates que foram oferecidos e nao parearam. */
    readonly descartados: number;
    /** Codigos ERRADOS recebidos. Subconjunto de `descartados`. */
    readonly tentativas: number;
    /** Quantas tentativas erradas ainda cabem antes de esgotar. */
    readonly tentativasRestantes: number;
}
export type ResultadoDeOferta = {
    readonly tipo: 'pareado';
    readonly dono: DonoPareado;
} | {
    readonly tipo: 'descartado';
    readonly motivo: MotivoDeDescarte;
};
export interface SessaoDePareamento {
    /**
     * A UNICA porta para o codigo (PAIR-010). O nome e longo de proposito: ele
     * existe para saltar a vista de quem faz `grep revelarCodigo` na revisao, e
     * o resultado dele so pode ir para o stdout do terminal ou para o painel
     * local ja autenticado — nunca para log, HTTP ou Telegram.
     */
    revelarCodigo(): string;
    estado(): EstadoDaSessao;
    /** Milissegundos que faltam para expirar. `0` quando ja expirou. */
    restanteMs(): number;
    /** Oferece UM update. Sincrono e determinista: nao ha corrida (PAIR-009). */
    oferecer(update: unknown): ResultadoDeOferta;
    resumo(): ResumoDePareamento;
    /** Serializacao segura: sem codigo. Ver PAIR-010 no cabecalho. */
    toJSON(): ResumoDePareamento;
}
/** Relogio injetado (`04-TESTES.md` 8.1): nenhum teste espera 5 minutos reais. */
export interface RelogioDePareamento {
    now(): number;
}
export interface OpcoesDeSessao {
    readonly clock: RelogioDePareamento;
    /** Codigo ja gerado. Omitido: gera-se um por CSPRNG. */
    readonly codigo?: string | undefined;
    /** Omitido: {@link TTL_DO_CODIGO_MS}. */
    readonly ttlMs?: number | undefined;
    /** Omitido: {@link TENTATIVAS_MAXIMAS}. */
    readonly tentativasMaximas?: number | undefined;
    /** Fonte de aleatoriedade, quando o codigo nao vem pronto. */
    readonly fonte?: FonteDeInteiros | undefined;
}
/**
 * Abre uma janela de pareamento.
 *
 * A janela e SEMPRE limitada em duas dimensoes — tempo e tentativas — e fecha-se
 * de forma DEFINITIVA no primeiro sucesso. "Fecha-se" aqui e so o fim desta
 * sessao em memoria; o fecho PERMANENTE e o `pairing` gravado no `state.json`
 * pelo chamador, e reabri-lo exige `--reset-pairing` na maquina (PAIR-005/008).
 */
export declare function criarSessaoDePareamento(opcoes: OpcoesDeSessao): SessaoDePareamento;
//# sourceMappingURL=pairing.d.ts.map