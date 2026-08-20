/**
 * Branded IDs (SessionId, Nonce, SecretDigest) e construtores validadores.
 *
 * VAZIO DE PROPOSITO NESTA ONDA. O layout canonico (03-ONDAS.md 4.2) atribui
 * este ficheiro a T1.1, mas a Onda 1 e um refactor de FIDELIDADE: dissolve o
 * que existe, nao inventa o que ainda nao existe. Nenhum dos identificadores
 * acima tem produtor ou consumidor antes da Onda 2 (`src/secret/**`,
 * `src/session/**`), e escrever construtores validadores agora seria adivinhar
 * a forma que T2.1/T2.2 vao fixar -- codigo sem teste e sem chamador.
 *
 * DONO: T1.1 (esta onda deixa-o vazio, deliberadamente); preenchido na Onda 2.
 */
export {}
