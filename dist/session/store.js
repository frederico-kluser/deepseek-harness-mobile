/**
 * `SessionStore`: emissao, lookup, expiracao (inatividade 60 min, absoluto 8 h)
 * e disposer sincrono. PURO -- nenhuma rota HTTP vive aqui (03-ONDAS.md 7).
 *
 * DONO: T2.2.
 *
 * ------------------------------------------------------------------------
 * O QUE ESTE MODULO E, E O QUE NAO E
 * ------------------------------------------------------------------------
 * E o dono do CICLO DE VIDA da sessao: quem a emite, quem a valida, quando ela
 * morre. Nao sabe o que e um pedido HTTP, nao le cabecalhos e nao decide
 * resposta -- isso e do portao (T3.3) e das rotas (T3.4). A Onda 2 e
 * "primitivas sem fiacao" por construcao: construir o modulo e ligar o modulo
 * sao etapas separadas, e misturar as duas colapsa o paralelismo da onda.
 *
 * ------------------------------------------------------------------------
 * INVARIANTE: SO EXISTE SESSAO AUTENTICADA
 * ------------------------------------------------------------------------
 * Este store NUNCA emite sessao anonima. Um id so nasce DEPOIS de a credencial
 * ter sido verificada (segredo, Basic ou `mk` do link magico). Isso e metade da
 * defesa contra SESSION FIXATION; a outra metade e `regenerate()`, que destroi
 * o id que o cliente APRESENTOU antes de emitir o novo. Um atacante que planta
 * um cookie de sessao no navegador da vitima (via subdominio, via XSS noutra
 * aplicacao, via link) nao ganha nada: no instante em que a vitima autentica,
 * o id plantado deixa de existir do lado do servidor.
 *
 * >>> T3.4: chame SEMPRE `regenerate(idApresentado)` no caminho de login.
 * >>> `create()` existe porque o contrato congelado o exige e e apenas o alias
 * >>> de `regenerate(undefined)` -- usa-lo quando o cliente APRESENTOU um id e
 * >>> deixar a fixacao viva.
 *
 * ------------------------------------------------------------------------
 * O ID NAO E GUARDADO EM CLARO
 * ------------------------------------------------------------------------
 * O mapa e indexado por `sha256(id)` em hex; o id em claro existe uma unica vez
 * -- no instante da emissao -- e a partir dai so o cliente o tem. Tres
 * consequencias, todas deliberadas:
 *   1. um despejo de memoria do processo nao entrega sessoes vivas;
 *   2. `validate()` devolve como `id` a PROPRIA string apresentada pelo
 *      chamador, ja com marca -- nao ha copia do lado do servidor para vazar;
 *   3. o `idHash` que vai para o log de auditoria (`AuditEvent.sessao_id_hash`)
 *      nasce aqui, e nao no modulo de audit, para que nenhum outro ficheiro
 *      precise de tocar no id em claro para o poder correlacionar.
 *
 * Q-4 (segredo nunca em argv/log/mensagem/disco em claro) vale para o id de
 * sessao: ele E uma credencial portadora. Nenhuma mensagem de erro deste
 * ficheiro inclui o valor apresentado.
 */
import { createHash, randomBytes as csprngBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { toSessionId } from "../brand.js";
import { PLUGIN_NAME } from "../errors.js";
/**
 * 32 bytes = 256 bits de CSPRNG.
 *
 * O piso normativo e 128: ASVS 5.0 **7.2.3** -- *"Verify that if reference
 * tokens are used to represent user sessions, they are unique and generated
 * using a cryptographically secure pseudo-random number generator (CSPRNG) and
 * possess at least 128 bits of entropy"*. 256 bits e folga barata (43 octetos
 * em base64url) e alinha com o tamanho do segredo de T2.1.
 */
export const SESSION_ID_BYTES = 32;
/** Inatividade: 60 min sem uso e a sessao morre (02-SEGURANCA.md 10.3). */
export const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
/** Teto absoluto: 8 h desde a emissao, com ou sem atividade. */
export const SESSION_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
/**
 * Teto de sessoes vivas.
 *
 * DEFESA EM PROFUNDIDADE, NAO O CONTROLO PRIMARIO: so um login BEM-SUCEDIDO
 * cria sessao, e o caminho de login e limitado por T2.3. O teto existe para o
 * caso em que o dono (ou um script dele) autentica em ciclo e deixa sessoes
 * vivas a acumular durante 8 h. Ao encher, morre a sessao com o uso mais
 * antigo -- a que estava mais perto de expirar por inatividade de qualquer
 * forma.
 */
export const SESSION_MAX_LIVE = 64;
/** Fronteira do que se aceita sequer olhar como id apresentado. */
const PRESENTED_ID = /^[A-Za-z0-9_-]{22,256}$/u;
/** Relogio de producao. */
export const systemClock = { now: () => Date.now() };
function digestOf(id) {
    return createHash('sha256').update(id, 'utf8').digest('hex');
}
/**
 * Constroi o store.
 *
 * @param deps relogio obrigatorio; fonte de bytes so em teste.
 */
export function createSessionStore(deps) {
    const clock = deps.clock;
    const randomBytes = deps.randomBytes ?? csprngBytes;
    const vivas = new Map();
    let disposto = false;
    function guardaDisposto() {
        if (disposto) {
            throw new Error(`[${PLUGIN_NAME}] SessionStore ja foi disposto: emitir sessao agora produzia uma credencial que nunca validaria`);
        }
    }
    /**
     * Expirada? A resposta e a MESMA para inatividade e para o teto absoluto:
     * quem consome nao precisa de distinguir, e distinguir seria um oraculo de
     * "esta sessao existiu" para quem adivinhasse um id.
     *
     * LIMITE CONHECIDO: o relogio injetado e de PAREDE (`Date.now()`), nao e
     * monotonico. Um recuo grande -- acerto de NTP, mudanca de fuso, suspensao da
     * maquina -- torna estas duas diferencas negativas e ADIA os dois prazos.
     * O clamp de `Math.max` em `validate()` cobre outra coisa, e so essa: impede
     * que uma renovacao ESTIQUE a janela de inatividade para tras. Nao existe
     * relogio monotonico com origem estavel entre reinicios em Node, e amarrar a
     * expiracao a `performance.now()` trocava este modo de falha por um pior (o
     * prazo deixava de sobreviver a um reinicio do processo).
     */
    function expirada(rec, agora) {
        return (agora - rec.ultimoUsoEm >= SESSION_IDLE_TIMEOUT_MS ||
            agora - rec.criadaEm >= SESSION_ABSOLUTE_TIMEOUT_MS);
    }
    function varrer(agora) {
        for (const [chave, rec] of vivas) {
            if (expirada(rec, agora))
                vivas.delete(chave);
        }
    }
    /** Ao encher, sai a de uso mais antigo. Ver `SESSION_MAX_LIVE`. */
    function abrirEspaco() {
        while (vivas.size >= SESSION_MAX_LIVE) {
            let maisAntiga;
            let instante = Number.POSITIVE_INFINITY;
            for (const [chave, rec] of vivas) {
                if (rec.ultimoUsoEm < instante) {
                    instante = rec.ultimoUsoEm;
                    maisAntiga = chave;
                }
            }
            if (maisAntiga === undefined)
                return;
            vivas.delete(maisAntiga);
        }
    }
    function novoId() {
        const bytes = randomBytes(SESSION_ID_BYTES);
        // base64url: alfabeto `A-Za-z0-9-_`, todo ele *cookie-octet* valido, logo
        // o valor nunca precisa de escape nem de percent-encoding no cabecalho.
        return Buffer.from(bytes).toString('base64url');
    }
    /**
     * REVOGA EXATAMENTE UMA: a que foi apresentada. Nao e um `revokeAll()`
     * disfarcado -- o dono pode ter sessao viva no telemovel e autenticar no
     * portatil sem perder a primeira.
     *
     * Um `previousId` que nem sequer TEM a forma de um id nao revoga nada e nao
     * lanca: entrada de cliente nao derruba o servidor. Isso nao abre fixation,
     * porque todo id vivo e base64url de 43 octetos e casa sempre com
     * `PRESENTED_ID` -- o que nao casa nunca esteve no mapa. O efeito medido e
     * so este: chamar com lixo emite uma sessao a mais sem apagar nenhuma, logo
     * "fica exatamente uma viva" e verdade para UMA sessao apresentada, nao uma
     * invariante do store.
     */
    function regenerate(previousId, metadados) {
        guardaDisposto();
        if (typeof previousId === 'string' && PRESENTED_ID.test(previousId)) {
            vivas.delete(digestOf(previousId));
        }
        const agora = clock.now();
        varrer(agora);
        abrirEspaco();
        const id = novoId();
        vivas.set(digestOf(id), {
            criadaEm: agora,
            ultimoUsoEm: agora,
            // Aditivo: so entram quando o nascimento os entregou, e apenas os
            // campos presentes — um `undefined` nao cria um campo `ip: undefined`
            // que o JSON do painel depois serializaria como `null`.
            ...(metadados?.userAgent === undefined ? {} : { userAgent: metadados.userAgent }),
            ...(metadados?.ip === undefined ? {} : { ip: metadados.ip }),
        });
        return toSessionId(id);
    }
    function validate(id) {
        // Depois de `dispose()` a leitura e FECHADA e silenciosa: um pedido em voo
        // durante a desmontagem tem de levar 401, nao derrubar o hospedeiro. A
        // assimetria com `regenerate()` -- que LANCA -- e deliberada: ler tarde e
        // uma corrida normal; emitir tarde e um defeito de programa.
        if (disposto)
            return null;
        if (typeof id !== 'string' || !PRESENTED_ID.test(id))
            return null;
        const chave = digestOf(id);
        const rec = vivas.get(chave);
        if (rec === undefined)
            return null;
        const agora = clock.now();
        if (expirada(rec, agora)) {
            vivas.delete(chave);
            return null;
        }
        // `Math.max` e o que impede um relogio que ande PARA TRAS de ESTICAR a
        // janela de inatividade: o ultimo uso nunca recua.
        rec.ultimoUsoEm = Math.max(rec.ultimoUsoEm, agora);
        const idHash = chave.slice(0, 16);
        const criadaEm = rec.criadaEm;
        const ultimoUsoEm = rec.ultimoUsoEm;
        const redigida = () => ({
            id: '[REDACTED]',
            criadaEm,
            ultimoUsoEm,
            idHash,
        });
        return {
            id: toSessionId(id),
            criadaEm,
            ultimoUsoEm,
            idHash,
            toJSON: redigida,
            [inspect.custom]: redigida,
        };
    }
    return {
        create: () => regenerate(undefined),
        regenerate,
        validate,
        revoke(id) {
            if (typeof id !== 'string' || !PRESENTED_ID.test(id))
                return false;
            return vivas.delete(digestOf(id));
        },
        revokeAll() {
            vivas.clear();
        },
        dispose() {
            // SINCRONO e sem `await` (Q-2): o `ctx.on('dispose')` do cordis nao
            // espera por Promise, e uma limpeza assincrona aqui deixaria sessoes
            // vivas depois de o plugin ser dado por desmontado.
            disposto = true;
            vivas.clear();
        },
        get live() {
            return vivas.size;
        },
        listar() {
            const agora = clock.now();
            const registos = [];
            for (const [chave, rec] of vivas) {
                // A mesma redacao de `validate`: o `idHash` e o prefixo de 16 hex do
                // digest, nunca o portador. A sessao EXPIRADA nao entra na projecao —
                // seria uma sessao que o `validate` ja devolveria `null`.
                if (expirada(rec, agora))
                    continue;
                registos.push({
                    idHash: chave.slice(0, 16),
                    criadaEm: rec.criadaEm,
                    ultimoUsoEm: rec.ultimoUsoEm,
                    ...(rec.userAgent === undefined ? {} : { userAgent: rec.userAgent }),
                    ...(rec.ip === undefined ? {} : { ip: rec.ip }),
                });
            }
            return registos;
        },
    };
}
//# sourceMappingURL=store.js.map