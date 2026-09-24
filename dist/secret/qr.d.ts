/**
 * Codificador de QR code -- funcao pura `string -> matriz de bits`, SEM
 * DEPENDENCIA NOVA. Quem o desenha em texto e `generate.ts`.
 *
 * PORQUE CODIFICADOR PROPRIO, e nao um pacote: a Onda 2 declara `package.json`
 * como singleton de NINGUEM (`03-ONDAS.md` 4.1) e o custo de supply chain de um
 * pacote de QR numa camada de autenticacao nao se paga. Este ficheiro nao toca
 * em rede, disco, processo nem no segredo persistido.
 *
 * PORQUE UM QR DE TODO (`03-ONDAS.md` 7, T2.1): com `control.magicLink`
 * desligado, a alternativa e o dono copiar 52 caracteres a mao para o telemovel.
 *
 * O QUE ESTA IMPLEMENTADO, e o que nao esta:
 *   - Nivel de correccao M (~15%), versoes 1 a 6 (21x21 a 41x41).
 *   - Modo ALFANUMERICO (11 bits por 2 caracteres) quando toda a entrada cabe no
 *     alfabeto do ISO/IEC 18004 tabela 5; senao, modo BYTE. O segredo e base32
 *     maiusculo, logo cai sempre no alfanumerico: 52 caracteres dao versao 3
 *     (29x29, 37 colunas com moldura) em vez da versao 4 do modo byte (33x33,
 *     41 colunas) -- quanto menor o simbolo, menos exigente e a leitura por
 *     camara a partir de um terminal.
 *   - NAO ha segmentacao mista nem versao >= 7 (que exigiria o bloco de
 *     informacao de versao). Entrada mista vai inteira em modo byte: correcta e
 *     legivel, apenas nao a menor possivel.
 *
 * VERIFICACAO: `test/unit/secret/qr.test.ts` compara a matriz produzida aqui,
 * bit a bit, com a da `libqrencode` 4.1.1 -- a implementacao de referencia em C
 * do utilitario `qrencode` -- em 23 vectores que cobrem as fronteiras de
 * capacidade de todas as versoes suportadas, nos dois modos.
 */
/** Matriz de modulos. `dark[y * size + x] === 1` e um modulo escuro. */
export interface QrMatrix {
    readonly size: number;
    readonly version: number;
    readonly dark: Uint8Array;
}
/** Falha de codificacao. Fail loud: nada de QR truncado, que nao le. */
export declare class QrEncodeError extends Error {
    readonly name = "QrEncodeError";
}
/** Codifica `text` num QR de nivel M. Lanca se nao couber na versao 6. */
export declare function encodeQr(text: string): QrMatrix;
//# sourceMappingURL=qr.d.ts.map