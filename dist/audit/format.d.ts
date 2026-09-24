/**
 * Serializacao de `{ts, evento, resultado, ip_normalizado, sessao_id_hash}`.
 *
 * DONO: T2.4. Par de `./log.ts`: aqui decide-se O QUE fica escrito, la decide-se
 * COMO e ONDE fica escrito. A separacao existe porque as duas metades falham por
 * razoes diferentes -- esta falha por vazar um segredo, aquela por perder uma
 * linha -- e misturar as duas num ficheiro so faria com que nenhuma delas fosse
 * testavel isoladamente.
 *
 * TRES INVARIANTES, e todas sao testadas:
 *
 *   1. LISTA BRANCA DE CHAVES, NAO LISTA NEGRA. O registo escrito tem exatamente
 *      as cinco chaves acima, sempre, pela mesma ordem. Um `AuditEvent` que traga
 *      campos a mais (de codigo futuro, ou de um `JSON.parse`) perde-os -- e essa
 *      e a resposta a "o log grava o segredo tentado?": nao ha caminho por onde
 *      um campo nao previsto chegue ao ficheiro, mesmo que alguem o acrescente.
 *
 *      ATE ONDE VAI, e nao mais: a lista branca cobre as CHAVES, nao o CONTEUDO
 *      de `evento`, que e uma string livre e vai para o ficheiro. Do conteudo
 *      cuidam as mascaras -- e mascara e heuristica: apanha as formas fixadas
 *      (token de bot, `mk`, URL do tunel `quick`, segredo em base32 MAIUSCULO),
 *      nao apanha o que nao tem forma (um segredo re-codificado, um token curto
 *      sem prefixo `bot`, a mesma base32 em minusculas). Isso e defesa em
 *      PROFUNDIDADE, nao fronteira: o `evento` e escrito pelo plugin a partir do
 *      vocabulario fechado de T5.4, nunca por quem ataca. Quem la puser um
 *      segredo em claro poe-no no ficheiro, e nenhuma regex o salva -- a camada
 *      fiavel para isso e {@link maskAuditText} com o literal em `knownSecrets`.
 *
 *   2. UMA LINHA E UMA LINHA. O corpo e JSON, e `JSON.stringify` escapa `\n`
 *      para `\\n`. Um `evento` que contenha uma quebra de linha e um registo
 *      forjado -- injecao de log -- nao consegue portanto produzir uma segunda
 *      linha. E por isso que o formato e JSON e nao um `printf` com separadores.
 *
 *   3. MASCARAMENTO ANTES DE SERIALIZAR, nunca depois. Depois seria mascarar
 *      texto ja escapado, onde `\n` e `\\n` e um segredo partido ao meio por um
 *      escape deixaria de casar com a sua forma.
 *
 * PORQUE `redact()` E CHAMADO E NAO COPIADO (`../logging/redact.ts`, T1.1): uma
 * primitiva de mascaramento duplicada e uma primitiva que diverge -- a copia
 * ganha um padrao que o original nao tem, e o autor do original corrige um bug
 * que a copia continua a ter.
 *
 * O QUE MUDOU NA COSTURA DA ONDA 3, e porque este paragrafo encolheu. Duas das
 * formas que viviam aqui -- o URL do quick tunnel e o `mk` do link magico --
 * eram, por escrito, o que `redact.ts` declarava em falta no proprio cabecalho
 * "ate os donos as fixarem". Foram fixadas, e SUBIRAM para `SECRET_SHAPES`.
 * Enquanto estiveram so aqui, quem chamava `redact()` diretamente (todo o
 * encaminhamento de stdout/stderr de subprocesso) nao tinha nenhuma das duas --
 * a duplicacao nao era redundancia, era um buraco com aparencia de cinto.
 *
 * O QUE FICOU, E PORQUE `maskAuditText` NAO E `redact` COM OUTRO NOME: as tres
 * formas de {@link AUDIT_SHAPES} sao especificas de um log de AUDITORIA, onde um
 * falso positivo custa uma linha ilegivel e um falso negativo custa o bot ou a
 * credencial permanente do dono. Num log de OPERADOR o calculo inverte-se, e por
 * isso elas nao subiram: o token de bot CURTO (a forma de `redact.ts` exige >= 20
 * caracteres depois dos dois pontos, de proposito), a cauda de um segredo
 * engolido pela camada 1, e o segredo do plugin em base32 -- que e a unica que
 * nem sequer pode depender do literal, porque T2.1 o descarta da memoria.
 */
import type { AuditEvent } from '../contracts/auth.ts';
/**
 * O registo tal como fica no ficheiro. Forma FIXA: as cinco chaves existem
 * sempre, e a ausencia e `null` explicito.
 *
 * PORQUE `null` E NAO A CHAVE AUSENTE: "nao havia IP de cliente fiavel" e um
 * FACTO -- e, depois do spike S2, o facto normal, porque sob `cloudflared` a
 * origem e sempre `127.0.0.1` e `X-Forwarded-For` e forjavel. Omitir a chave
 * tornaria esse facto indistinguivel de "o programador esqueceu-se do campo",
 * que e precisamente a duvida que ninguem consegue resolver seis meses depois a
 * ler um log.
 */
export interface AuditRecord {
    readonly ts: string;
    readonly evento: string;
    readonly resultado: 'permitido' | 'negado';
    readonly ip_normalizado: string | null;
    readonly sessao_id_hash: string | null;
}
/** Falha de formatacao: o registo NAO pode ser escrito como esta. */
export declare class AuditFormatError extends Error {
    readonly name = "AuditFormatError";
}
/**
 * Teto do campo `evento`.
 *
 * NAO e cosmetica: uma linha curta cabe num unico `write(2)`, e e a atomicidade
 * desse `write` unico que impede duas linhas de dois processos de se
 * intercalarem (ver `./log.ts`). Um `evento` sem teto poria essa garantia nas
 * maos de quem chama.
 */
export declare const MAX_EVENTO_LENGTH = 200;
/** Marcador acrescentado ao `evento` que foi cortado por {@link MAX_EVENTO_LENGTH}. */
export declare const TRUNCATED_MARK = "[TRUNCADO]";
/** Valor gravado quando `evento` chega vazio. Registar o facto, nao rebentar. */
export declare const EVENTO_SEM_NOME = "evento_sem_nome";
/** Valor gravado em `ip_normalizado` quando o que chegou nao e um endereco. */
export declare const IP_INVALIDO = "nao-ip";
/**
 * Mascara `text` com as duas camadas: `redact()` primeiro, {@link AUDIT_SHAPES}
 * depois.
 *
 * @param text texto a escrever num campo do registo.
 * @param knownSecrets literais que o chamador SABE serem segredos (URL do tunel
 *   `named`, token do bot vindo da configuracao). Camada 1: exata, nao depende
 *   de o segredo ter o formato esperado.
 */
export declare function maskAuditText(text: string, knownSecrets?: readonly string[]): string;
/**
 * Normaliza o IP de origem para uma forma unica e comparavel.
 *
 * PORQUE NORMALIZAR: `::ffff:127.0.0.1` e `127.0.0.1` sao o mesmo host e
 * aparecem os dois, consoante o socket seja v6 com mapeamento v4 ou v4 puro. Um
 * log com as duas formas nao se consegue agregar, e um limitador que contasse
 * por esta string contaria o mesmo atacante duas vezes.
 *
 * PORQUE O LIXO NAO E REGISTADO EM CLARO: depois do spike S2 sabemos que
 * `X-Forwarded-For` e ACRESCENTADO ao valor do cliente, logo o conteudo deste
 * campo pode ser texto arbitrario escolhido por quem ataca. Escrever esse texto
 * no ficheiro nao vaza segredo nenhum (o JSON escapa tudo), mas suja um campo
 * que os leitores tratam como endereco. Fica {@link IP_INVALIDO}, que e um facto
 * verdadeiro; o valor cru pertence a um evento proprio do vocabulario de T5.4.
 */
export declare function normalizeIp(raw: string | undefined): string | null;
/**
 * `sha256` hexadecimal de um id de sessao, para o campo `sessao_id_hash`.
 *
 * PORQUE ISTO EXISTE AQUI e nao em cada chamador: correlacionar duas linhas do
 * log exige que a mesma sessao de sempre o mesmo valor. Dois chamadores com dois
 * hashes diferentes (um com `sha256`, outro com os primeiros 8 caracteres do id)
 * produzem um log que parece correlacionavel e nao e.
 *
 * PORQUE HASHEAR A SESSAO E LEGITIMO, e hashear o SEGREDO nao (a pergunta 4
 * desta sub-tarefa): um id de sessao e 128 bits de CSPRNG com validade de horas
 * -- o digest nao e adivinhavel e o preimage nao vale nada depois de expirar. O
 * segredo do plugin e a credencial permanente do dono: gravar `sha256(tentativa)`
 * daria a quem lesse o ficheiro um oraculo OFFLINE para testar palpites sem
 * tocar no gate, sem passar pelo limitador e sem deixar rasto. Por isso nao ha,
 * em lado nenhum deste modulo, uma funcao que aceite um segredo.
 */
export declare function hashSessionId(sessionId: string): string;
/** Aplica a lista branca e o mascaramento. Nao serializa. */
export declare function toAuditRecord(event: AuditEvent, tsMs: number, knownSecrets?: readonly string[]): AuditRecord;
/** Serializa um evento numa linha pronta a escrever, com o `\n` final incluido. */
export declare function formatAuditLine(event: AuditEvent, tsMs: number, knownSecrets?: readonly string[]): string;
//# sourceMappingURL=format.d.ts.map