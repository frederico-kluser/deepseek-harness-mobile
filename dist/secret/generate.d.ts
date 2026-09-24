/**
 * Geracao e APRESENTACAO do segredo do dono.
 *
 * ENTROPIA (`03-ONDAS.md` 7, T2.1): 32 bytes de `crypto.randomBytes`, ou seja
 * 256 bits de CSPRNG. A ASVS 5.0 11.5.1 exige, literalmente, que "all random
 * numbers and strings which are intended to be non-guessable must be generated
 * using a cryptographically secure pseudo-random number generator (CSPRNG) and
 * have at least 128 bits of entropy". 256 bits e o dobro do piso -- a folga nao
 * custa nada aqui (sao 20 caracteres a mais de base32) e e o que sustenta a
 * decisao de NAO usar um KDF caro, argumentada em `verify.ts`.
 *
 * APRESENTACAO em base32 do RFC 4648 (5 bits por caractere). O alfabeto e
 * `A-Z` + `2-7`: nao contem `0`, `1`, `8` nem `9`, precisamente porque `0`/`O`
 * e `1`/`l`/`I` sao os pares que se confundem a ler e a ditar (RFC 4648 3.4).
 * Nao ha padding: 256 bits dao 52 caracteres exatos de 5 bits com 4 bits de
 * sobra no ultimo, e os bits de enchimento sao zero, como o RFC 3.5 exige da
 * codificacao canonica -- por isso o ultimo caractere e sempre de indice par.
 *
 * O SEGREDO EM CLARO NAO VIVE AQUI. `generateSecret()` devolve-o e nao guarda
 * copia: nao ha variavel de modulo, cache nem log neste ficheiro. O buffer de
 * bytes crus e zerado antes do retorno; a string em si nao se pode apagar
 * (strings sao imutaveis em JS e a sua vida acaba no colector de lixo) -- por
 * isso o unico contrato honesto e "o chamador nao a guarda", que e o que
 * `store.ts` faz: hasheia, persiste o digest e deixa a string sair de ambito.
 */
/** 256 bits (ASVS 5.0 11.5.1 pede >= 128). */
export declare const SECRET_BYTES = 32;
/** 52 caracteres de 5 bits: `Math.ceil(256 / 5)`. */
export declare const SECRET_LENGTH = 52;
/** Alfabeto base32 do RFC 4648 seccao 6. Sem `0`, `1`, `8` e `9`. */
export declare const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/**
 * Codifica bytes em base32 RFC 4648 SEM padding.
 *
 * Acumulador de bits em vez de tabela de blocos de 5 bytes: o unico chamador
 * tem 32 bytes (que nao e multiplo de 5) e um resto tratado a parte seria um
 * ramo a mais para o mesmo resultado.
 */
export declare function encodeBase32(bytes: Uint8Array): string;
/**
 * Gera um segredo novo. O valor devolvido e a UNICA copia em claro que existe.
 */
export declare function generateSecret(): string;
/** `MJDN-2GVY-...`: grupos de 4 separados por `-`, para ditar sem perder o sitio. */
export declare function groupSecret(canonical: string): string;
/**
 * Desenha um QR em texto, dois modulos por linha (meio bloco).
 *
 * FUNDO ESCURO POR OMISSAO: num terminal de fundo escuro o glifo desenhado e
 * CLARO, logo o modulo ESCURO do QR e a AUSENCIA de glifo. Com `invert` a
 * convencao troca, para terminal ou pagina de fundo claro -- um leitor de QR
 * espera contraste na polaridade certa e um codigo invertido nao le em muitos
 * telemoveis. Um modulo ocupa uma celula de largura e meia de altura, que e o
 * que o torna quadrado no ecra (a celula de texto e cerca de duas vezes mais
 * alta que larga).
 */
export declare function renderQrAscii(text: string, options?: {
    readonly invert?: boolean;
}): string;
/**
 * O painel de apresentacao: o texto agrupado e o QR na MESMA tela.
 *
 * PORQUE OS DOIS JUNTOS (`03-ONDAS.md` 7, T2.1): com `control.magicLink`
 * desligado nao ha link para tocar, e o telemovel e onde o dono vai usar isto.
 * O QR e o caminho curto para quem tem a camara a mao; o texto agrupado e o
 * caminho de quem esta ao telefone com outra pessoa, ou cujo leitor de QR nao
 * enxerga o terminal. Devolver so um deles obrigaria o chamador a escolher por
 * nos, e havia dois chamadores (o CLI de T4.1 e a rota de T3.4).
 *
 * Sem prosa aqui: a moldura de texto ("guarde isto", "mostrado uma unica vez")
 * pertence a superficie que apresenta, nao a esta camada.
 */
export declare function renderSecretPanel(canonical: string, options?: {
    readonly invert?: boolean;
}): string;
//# sourceMappingURL=generate.d.ts.map