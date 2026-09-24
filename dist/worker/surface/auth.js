/**
 * AUTORIZACAO NEUTRA DA SUPERFICIE — allowlist de dois eixos, receptor de
 * pareamento e guard, TUDO sobre `SurfaceIdentity{userKey,chatKey}` (STRINGS,
 * D4) e `SurfaceEvent`, em vez da forma crua do update do Telegram.
 *
 * DONO: onda 2 "desacoplar o bot de mensageria para arquitetura de provedores".
 * PORTE FIEL de `worker/auth/{allowlist,guard,pairing}.ts` ($BASE) sobre o
 * CONTRATO em `./contract.ts`. NADA antigo e tocado: estas funcoes sao novas e
 * coexistam com o funil Telegram ate a Onda 4 (rewire) as cortar.
 *
 * ===========================================================================
 * O QUE MUDOU vs. o funil Telegram, E O QUE NAO PODE MUDAR
 * ===========================================================================
 * - **A identidade chega JA normalizada.** O `worker/auth/allowlist.ts`
 *   desembrulhava o JSON cru do Telegram (`from.id`, `chat.id`) e validava
 *   52 bits. Aqui a fronteira (D4) ja entregou uma {@link SurfaceIdentity} com
 *   `userKey`/`chatKey` como STRINGS (o adaptador de provedor resolveu-as, Onda
 *   3). Por isso nao ha `detectSurface`, `extractIdentity` nem `isTelegramId`
 *   neste ficheiro — funcionariam sobre a forma errada (um JSON por provedor).
 * - **As regras de SEGURANCA portam-se INTEGRAS** (TG-0xx, PAIR-0xx): os DOIS
 *   eixos sempre (TG-001..006/008), default DENY inclusive o dono (TG-007),
 *   ausencia de eixo = NEGACAO (TG-004), revalidacao de identidade em TODO
 *   evento de acao (TG-024), descarte silencioso CONTADO (TG-089) com
 *   `answerTarget` obrigatorio (TG-027), nenhum nonce validado localmente (S5),
 *   sequidor de pareamento = segunda porta ao estranho (PAIR-001..010).
 * - **A auditoria vira eventos neutros em PT-BR.** `telegram.update.admitido`
 *   e o marcador do canal antigo; aqui o equivalente e
 *   `surface.evento.admitido` (e o descartado `/surface.evento.descartado`, o
 *   pareamento `/surface.pareamento.*`). A Onda 4 reescreve o prefixo do antigo
 *   para bater com estes.
 *
 * ===========================================================================
 * S5 — NENHUM NONCE AQUI DENTRO
 * ===========================================================================
 * {@link SurfaceActionEvent} ja chega com `action` e `token` extraidos PELO
 * ADAPTADOR. Este modulo NAO deserializa `callback_data` nenhum (isso e do
 * provedor, Onda 3) e NAO valida o valor do token: transporta-o OPACO ate ao
 * contexto do comando / host (S5 de `src/contracts/ipc.ts`). Um token validado
 * no processo que fala com a internet nao e um controlo, e uma variavel.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
export class SurfaceAuthError extends Error {
    name = 'SurfaceAuthError';
    code;
    constructor(code, detail) {
        super(`[worker/surface/auth] ${code}: ${detail}`);
        this.code = code;
    }
}
/**
 * Constroi a allowlist de dois eixos a partir de STRINGS, e copia-as.
 *
 * FALHA ALTO em chave vazia ou so espaco (`ALLOWLIST_INVALID_KEY`): uma chave
 * que "nunca casa" seria uma allowlist silenciosamente mais estreita — o modo
 * de falha indistinguivel de um bug. Copia para `Set` proprio: mutar a origem
 * depois nao alarga a allowlist.
 */
export function criarAllowlistSurface(input) {
    const users = new Set();
    const chats = new Set();
    function acumula(alvo, chaves) {
        for (const chave of chaves) {
            const limpa = chave.trim();
            if (limpa.length === 0) {
                throw new SurfaceAuthError('ALLOWLIST_INVALID_KEY', `chave de allowlist vazia ou so espaco em ${alvo === users ? 'users' : 'chats'}; deixar entrar uma chave morta e enganar o operador`);
            }
            alvo.add(limpa);
        }
    }
    acumula(users, input.users);
    acumula(chats, input.chats);
    return {
        size: users.size + chats.size,
        hasUser: (key) => users.has(key),
        hasChat: (key) => chats.has(key),
    };
}
/** A allowlist do arranque: VAZIA, e portanto inerte (TG-007). */
export const ALLOWLIST_VAZIA = criarAllowlistSurface({ users: [], chats: [] });
/**
 * A UNICA funcao de decisao de autorizacao da superficie neutra.
 *
 * PORQUE UMA FUNCAO E NAO UM METODO DA ALLOWLIST: a decisao fica pura e pode
 * ser injetada. Default DENY (TG-007): lista vazia nega ATE O DONO. E
 * `&&`, nunca `||` (TG-003): os DOIS eixos tem de estar em lista.
 */
export function autorizar(identity, allowlist) {
    return allowlist.hasUser(identity.userKey) && allowlist.hasChat(identity.chatKey);
}
/**
 * A decisao de autorizacao com o motivo certo para o audit. A ORDEM importa:
 * allowlist vazia (nunca parou) -> eixos fora da lista (estranho).
 */
export function decidirAutorizacao(identity, allowlist) {
    if (identity === undefined) {
        return { ok: false, reason: 'deny:incomplete-identity' };
    }
    if (allowlist.size === 0) {
        return { ok: false, reason: 'deny:not-configured' };
    }
    if (!autorizar(identity, allowlist)) {
        return { ok: false, reason: 'deny:not-allowlisted' };
    }
    return { ok: true };
}
/* ========================================================================== */
/* 3. O DESAFIO DE PAREAMENTO (PAIR-010: o codigo entra e NAO sai)            */
/* ========================================================================== */
/** Quantos digitos o codigo que o HOST gera tem. */
const PAIRING_CODE_DIGITS = 6;
/**
 * Forma do codigo — por varrimento de `charCodeAt`, NUNCA por `RegExp`.
 *
 * `RegExp.prototype.test` e `String.prototype.search` publicam o sujeito nas
 * estaticas GLOBAIS `RegExp.input`/`RegExp.lastMatch`, que sobrevivem ao
 * retorno e ficam legiveis ao processo inteiro (PAIR-010, ACHADO 7).
 */
function eSeisDigitos(value) {
    if (value.length !== PAIRING_CODE_DIGITS)
        return false;
    for (let i = 0; i < PAIRING_CODE_DIGITS; i += 1) {
        const digito = value.charCodeAt(i);
        // 0x30..0x39 = '0'..'9'. Sem parseInt/Number.isNaN: aceitam lixo ('1e5').
        if (digito < 0x30 || digito > 0x39)
            return false;
    }
    return true;
}
/**
 * Constroi o desafio a partir do codigo em claro e descarta o claro.
 *
 * PORQUE COMPARAR DIGESTS NAO STRINGS: `timingSafeEqual` lanca `RangeError`
 * com buffers de comprimentos diferentes; reduzir os dois lados a `sha256` da
 * sempre 32 bytes e torna a comparacao total. FALHA ALTO se o codigo nao for 6
 * digitos, sem o citar na mensagem (PAIR-010 vale ate no erro).
 */
export function criarDesafioDePareamento(code, expiresAt) {
    if (!eSeisDigitos(code)) {
        throw new SurfaceAuthError('PAIRING_CHALLENGE_INVALID', `codigo de pareamento tem de ser 6 digitos decimais (recebido: ${code.length} caracteres)`);
    }
    if (!Number.isFinite(expiresAt)) {
        throw new SurfaceAuthError('PAIRING_CHALLENGE_INVALID', 'expiresAt tem de ser um epoch em ms finito');
    }
    // O UNICO ponto onde o claro existe. Depois so o digest vive na closure.
    const digest = sha256(code);
    return {
        expiresAt,
        verify: (candidate) => timingSafeEqual(sha256(candidate), digest),
    };
}
function sha256(value) {
    return createHash('sha256').update(value, 'utf8').digest();
}
/** Os numeros e a conta que os justifica (idêntico a $BASE). */
export const LIMITES_PAREAMENTO_PADRAO = Object.freeze({
    maxAttemptsPerChat: 5,
    maxAttemptsGlobal: 20,
    maxProbeChatsTracked: 64,
    baseDelayMs: 250,
    maxDelayMs: 4_000,
});
function validarLimites(limits) {
    const ok = limits.maxAttemptsPerChat > 0 &&
        limits.maxAttemptsGlobal > 0 &&
        limits.maxProbeChatsTracked > 0 &&
        limits.baseDelayMs >= 0 &&
        limits.maxDelayMs >= limits.baseDelayMs;
    if (!ok) {
        throw new SurfaceAuthError('PAIRING_LIMITS_INVALID', 'tetos tem de ser positivos e maxDelayMs >= baseDelayMs; um teto <= 0 seria limite decorativo');
    }
}
// -- Os textos. Constantes de modulo: e assim que PAIR-003 e PAIR-010 valem. --
/** A resposta UNICA a qualquer tentativa falhada durante a janela aberta. */
export const RESPOSTA_PAREAMENTO_RECUSADO = 'Código errado ou expirado. Confere no painel e tenta de novo.';
/** A resposta ao DONO que manda `/parear` outra vez (so o dono a ve). */
export const RESPOSTA_JA_PAREADO = 'Este bate-papo já é o dono deste bot. Para trocar o dono, reset na máquina.';
/**
 * A resposta ao DONO-JA-PAREADO quando envia `/parear` SEM codigo: nao usa
 * codigos porque este chat ja e o dono. So o dono a ve (o estranho e silencio).
 */
export const RESPOSTA_PAREAR_VAZIO_JA_PAREADO = 'Ainda não usas códigos — este chat já está pareado.';
/** Boas-vindas de `/start`, INOCUA e IGUAL para toda a gente (PAIR-006). */
export const RESPOSTA_BOAS_VINDAS = '👋 Olá. Este bot controla o acesso ao teu Harness pelo Telegram.\n\n' +
    'Antes de mais nada, pareie-o: gere um código no painel e envie:\n' +
    '   /parear 123456\n\n' +
    'Depois, abra o menu para ligar e desligar o túnel.';
/* ========================================================================== */
/* CONVERSA INTELIGENTE (docs/ux/04-CONVERSA-INTELIGENTE.md) — textos EXATOS  */
/* ========================================================================== */
/**
 * A PERGUNTA quando `/parear` vazio (o clique no menu) arma a espera de valor:
 * o bot usa a PROXIMA mensagem de texto do mesmo chat+user como resposta.
 * INOCUA e IGUAL para toda a gente (mesmo espirito de PAIR-006) — nunca
 * revela estado nem ecoa o codigo.
 */
export const RESPOSTA_PEDIR_VALOR = 'Envia-me o código de 6 dígitos que aparece no painel.';
/**
 * Re-pede quando o valor capturado Nao tem a forma de 6 digitos. NUNCA ecoa o
 * texto digitado (so a forma fixa). NAO debita tentativa nem conta sonda.
 */
export const RESPOSTA_PEDIR_VALOR_MALFORMADO = 'Não entendi o código — 6 dígitos, ex.: `123456`.';
/** Timeout da espera de valor: o codigo (TTL 5 min) expirou. Estado removido. */
export const RESPOSTA_AGUARDANDO_EXPIROU = 'O código expirou. Use /parear de novo.';
/** Cancela a espera de valor (`/cancelar` ou texto puro `cancelar`/`não`). */
export const RESPOSTA_AGUARDANDO_CANCELADO = 'Ok, cancelado.';
/**
 * Constroi o receptor.
 *
 * PAIR-009 — A CORRIDA: dois `/parear` com o codigo certo no MESMO tick dao UM
 * dono porque {@link SurfacePairingReceiver.receive} **nao tem um unico
 * `await`**: entre ler o estado e gravar o dono nao ha ponto de suspensao,
 * logo o event loop nao intercala a segunda chamada.
 */
export function criarReceptorDePareamento(deps) {
    const limits = deps.limits ?? LIMITES_PAREAMENTO_PADRAO;
    validarLimites(limits);
    let challenge = deps.challenge;
    let state = deps.owner === undefined ? { status: 'aberto' } : { status: 'fechado', owner: deps.owner };
    /** Orcamento de PALPITES: por chat e global. E o que a forca bruta gasta. */
    const tentativasPorChat = new Map();
    let tentativasGlobal = 0;
    let attempts = 0;
    /** Contador de SONDAS, separado do de palpites (LIMITES_PAREAMENTO_PADRAO). */
    const sondasPorChat = new Map();
    let probes = 0;
    let refused = 0;
    const byReason = new Map();
    function recusar(reason, reply, delayMs, identity, orcamento) {
        refused += 1;
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        return {
            kind: 'refused',
            reason,
            reply,
            delayMs,
            // O `chatKey` para o chamador responder (o core usa-o em `recusado.chat`).
            ...(identity === undefined ? {} : { chat: identity.chatKey }),
            audit: {
                evento: 'surface.pareamento.recusado',
                resultado: 'negado',
                motivo: reason,
                orcamento,
                ...(identity === undefined ? {} : { userKey: identity.userKey, chatKey: identity.chatKey }),
            },
        };
    }
    /** Atraso exponencial nas falhas ANTERIORES do chat. Expoente cortado p/ anti-Infinity. */
    function atrasoPara(falhasAnteriores) {
        const bruto = limits.baseDelayMs * 2 ** Math.min(falhasAnteriores, 32);
        return Math.min(limits.maxDelayMs, bruto);
    }
    /**
     * O caminho REUTILIZAVEL de comparacao de um CANDIDATO (o codigo) — a UNICA
     * porta de verificacao de um valor (docs/ux/04-CONVERSA-INTELIGENTE.md §3).
     *
     * CORRIDO pela conversa "pedir valor" (o core, na proxima mensagem de texto
     * puro do mesmo chat+user) E pelo fluxo inline (`/parear <codigo>`). Mesmo
     * orcamento, mesmos tetos, mesmo backoff, mesma resposta uniforme. **SINCRONO**
     * (PAIR-009): nao ha `await` entre ler estado -> verificar cota -> comparar ->
     * marcar consumido.
     *
     * Presupostos do chamador:
     *   - `identity` NAO e `undefined` (o receptor trata `missing-identity` antes);
     *   - para o FLUXO CONVERSACIONAL o estado `fechado` e tratado aqui
     *     (`refuse:already-paired`); para o INLINE o `receive` ja o tratou, entao
     *     este check nunca dispara em duplicado.
     *
     * VALOR MALFORMADO (≠6 digitos / nao-numerico): NAO debita tentativa nem conta
     * sonda, e re-pede com `RESPOSTA_PEDIR_VALOR_MALFORMADO` SEM ecoar o candidato.
     */
    function verificarCandidatoInterno(identity, candidato) {
        // MALFORMADO — antes de qualquer teto/debita. Re-pede, nunca debita, nunca
        // ecoa. So a comparacao de um valor bem-formado debita (recomendacao 3.b).
        if (!eSeisDigitos(candidato)) {
            return recusar('refuse:malformed', RESPOSTA_PEDIR_VALOR_MALFORMADO, 0, identity, 'nenhum');
        }
        // JA-PAREADO — defesa defensiva p/ o caminho conversacional (o inline ja o
        // tratou no `receive`; aqui garantir o mesmo para o valor capturado).
        if (state.status === 'fechado') {
            const eDono = identity.userKey === state.owner.userKey && identity.chatKey === state.owner.chatKey;
            return recusar('refuse:already-paired', eDono ? RESPOSTA_JA_PAREADO : undefined, 0, identity, 'nenhum');
        }
        // TETO ANTES DA VERIFICACAO (PAIR-007): um chat esgotado nao chega a TESTAR.
        const falhasDoChat = tentativasPorChat.get(identity.chatKey) ?? 0;
        if (falhasDoChat >= limits.maxAttemptsPerChat || tentativasGlobal >= limits.maxAttemptsGlobal) {
            return recusar('refuse:rate-limited', undefined, limits.maxDelayMs, identity, 'palpite');
        }
        attempts += 1;
        tentativasGlobal += 1;
        tentativasPorChat.set(identity.chatKey, falhasDoChat + 1);
        // TTL — PAIR-004. Relogio injetado.
        if (deps.clock.now() >= challenge.expiresAt) {
            return recusar('refuse:expired', RESPOSTA_PAREAMENTO_RECUSADO, atrasoPara(falhasDoChat), identity, 'palpite');
        }
        if (!challenge.verify(candidato)) {
            // >>> UNICO RAMO QUE DEVOLVE SINAL A QUEM NAO E DONO. Responde porque
            // PAIR-003 exige resposta generica — e POR RESPONDER debita palpite.
            return recusar('refuse:wrong-code', RESPOSTA_PAREAMENTO_RECUSADO, atrasoPara(falhasDoChat), identity, 'palpite');
        }
        // ---- PAREADO. Os dois eixos vem DESTE evento (o que carrega o codigo certo).
        const owner = {
            userKey: identity.userKey,
            chatKey: identity.chatKey,
            pairedAt: deps.clock.now(),
        };
        state = { status: 'fechado', owner };
        byReason.set('ok', (byReason.get('ok') ?? 0) + 1);
        return {
            kind: 'paired',
            owner,
            // Nao ecoa o codigo.
            reply: '✓ Pareado com sucesso! Agora:\n' +
                '  • /menu — painel de controlo\n' +
                '  • /status — estado do túnel\n\n' +
                'Segurança: só este chat pode comandar o bot.',
            audit: {
                evento: 'surface.pareamento.concluido',
                resultado: 'permitido',
                motivo: 'ok',
                orcamento: 'palpite',
                userKey: identity.userKey,
                chatKey: identity.chatKey,
            },
        };
    }
    return {
        receive(evento) {
            const command = parseComando(evento);
            if (command === undefined)
                return { kind: 'ignored' };
            const identity = command.identity;
            // /start — boas-vindas, e NADA MAIS (D8, PAIR-006). O argumento e
            // ignorado de proposito: o payload de /start viaja numa URL partilhavel.
            if (command.nome === 'start') {
                return {
                    kind: 'welcome',
                    reply: RESPOSTA_BOAS_VINDAS,
                    ...(identity === undefined ? {} : { chat: identity.chatKey }),
                    audit: {
                        evento: 'surface.pareamento.boas-vindas',
                        resultado: 'negado',
                        motivo: 'ok',
                        orcamento: 'nenhum',
                        ...(identity === undefined ? {} : { userKey: identity.userKey, chatKey: identity.chatKey }),
                    },
                };
            }
            if (command.nome !== 'parear')
                return { kind: 'ignored' };
            // PAIR-005/009 — o SEGUNDO pareamento e recusado, antes de tudo.
            if (state.status === 'fechado') {
                const eDono = identity !== undefined &&
                    identity.userKey === state.owner.userKey &&
                    identity.chatKey === state.owner.chatKey;
                // CONTRATO §7: ao dono ja pareado, `/parear` SEM codigo nao tenta
                // parear — avisa que este chat ja e o dono. A um estranho, SILENCIO.
                if (eDono && command.arg.length === 0) {
                    return recusar('refuse:already-paired', RESPOSTA_PAREAR_VAZIO_JA_PAREADO, 0, identity, 'nenhum');
                }
                // Ao dono, explicacao; a qualquer outro identidade, SILENCIO.
                return recusar('refuse:already-paired', eDono ? RESPOSTA_JA_PAREADO : undefined, 0, identity, 'nenhum');
            }
            // SINTAXE: exige um elemento completo para continuar.
            if (identity === undefined) {
                // Sem os dois eixos nao ha para onde responder. Recusa silenciosa.
                return recusar('refuse:missing-identity', undefined, limits.maxDelayMs, undefined, 'nenhum');
            }
            // ---- SONDA SEM PALPITE — `/parear` seco. SILENCIO SEMPRE, orcamento proprio.
            if (command.arg.length === 0) {
                probes += 1;
                const visto = sondasPorChat.get(identity.chatKey);
                let sondasAnteriores;
                if (visto !== undefined) {
                    sondasAnteriores = visto;
                    sondasPorChat.set(identity.chatKey, visto + 1);
                }
                else if (sondasPorChat.size < limits.maxProbeChatsTracked) {
                    sondasAnteriores = 0;
                    sondasPorChat.set(identity.chatKey, 1);
                }
                else {
                    // Mapa cheio: nao se registam chats novos; o escalar continua a subir.
                    sondasAnteriores = Number.MAX_SAFE_INTEGER;
                }
                return recusar('refuse:malformed', undefined, atrasoPara(sondasAnteriores), identity, 'sonda');
            }
            // ---- A PARTIR DAQUI TODA A TENTATIVA CARREGA UM PALPITE.
            // O fluxo inline delega no caminho REUTILIZAVEL `verificarCandidato` (o
            // MESMO que o core usa na conversa "pedir valor"): teto -> debitar ->
            // TTL -> verificar -> parear. Zero duplicacao de logica de seguranca
            // (docs/ux/04-CONVERSA-INTELIGENTE.md §3).
            return verificarCandidatoInterno(identity, command.arg);
        },
        verificarCandidato(identity, candidato) {
            return verificarCandidatoInterno(identity, candidato);
        },
        state() {
            return state;
        },
        stats() {
            return { attempts, probes, refused, byReason: Object.fromEntries(byReason) };
        },
        rotateChallenge(next) {
            challenge = next;
        },
        semearDono(dono) {
            // `fechado` e terminal neste modulo: uma vez com dono, `/parear` e
            // recusado (PAIR-005). O orcamento de palpites NAO e zerado, e o desafio
            // corrente nao e tocado (o host continua a rota-lo por `rotateChallenge`).
            state = { status: 'fechado', owner: dono };
        },
    };
}
/** Limite da forma do texto de que este modulo trata. Nao processamos alem. */
const MAX_TEXT_CHARS = 4_096;
function parseComando(evento) {
    const texto = evento.text;
    if (texto.length === 0 || texto.length > MAX_TEXT_CHARS)
        return undefined;
    const aparado = texto.trim();
    if (!aparado.startsWith('/'))
        return undefined;
    const espaco = indiceDeEspacoAscii(aparado);
    const cabeca = espaco === -1 ? aparado : aparado.slice(0, espaco);
    const arg = espaco === -1 ? '' : aparado.slice(espaco + 1).trim();
    // `/parear@nome_bot 123456` — o cliente de grupo acrescenta o `@bot`.
    const arroba = cabeca.indexOf('@');
    const nome = (arroba === -1 ? cabeca.slice(1) : cabeca.slice(1, arroba)).toLowerCase();
    if (nome.length === 0)
        return undefined;
    return { nome, arg, identity: evento.identity };
}
/** Indice do primeiro espaco em branco ASCII, ou `-1`. Cobra ` `, `\t`..`\r`. */
function indiceDeEspacoAscii(value) {
    for (let i = 0; i < value.length; i += 1) {
        const c = value.charCodeAt(i);
        if (c === 0x20 || (c >= 0x09 && c <= 0x0d))
            return i;
    }
    return -1;
}
/* ========================================================================== */
/* 5. A TABELA DE EXPOSICAO (o espelho neutro de `INCREASES_EXPOSURE`)         */
/* ========================================================================== */
/**
 * Acao -> exige confirmacao de 2 etapas?
 *
 * `Record<SurfaceAction, boolean>` (SurfaceAction = IpcIntentName) e o ponto
 * todo: se `IpcIntentName` ganhar um membro novo, este objecto deixa de
 * compilar e alguem e OBRIGADO a decidir, aqui, se ele aumenta ou reduz
 * exposicao. A assimetria e fail-safe na direccao certa (`02-SEGURANCA.md` 7.3):
 * o que AUMENTA confirma; o que REDUZ executa a primeira.
 */
export const AUMENTA_EXPOSICAO = Object.freeze({
    'tunnel.up': true,
    'tunnel.down': false,
    'tunnel.status': false,
    'session.issue': true,
    'secret.rotate': true,
    emergency: false,
    // EMENDA ONDA-4-AGENTS-HOST: o dispatch EXECUTA CODIGO no host (aumenta
    // exposicao -> exige nonce, como tunnel.up); status e cancel reduzem/leem.
    'agent.dispatch': true,
    'agent.status': false,
    'agent.cancel': false,
    // EMENDA ONDA-2-CONTRATO-CAPACIDADES: `chat.new` (sessao que CORRE um chat) e
    // `worktree.create` (worktree em disco) criam e expõem recursos novos no host
    // -> AUMENTAM exposicao -> exigem nonce 'reset' (o precedente de
    // agent.dispatch). Par obrigatorio de `INCREASES_EXPOSURE`
    // (`worker/providers/telegram/parse.ts`).
    'chat.new': true,
    'worktree.create': true,
    // NAVEGACAO LOCAL (Onda 3/5): nunca aumenta exposicao; o nucleo resolve em local.
    menu: false,
    ajuda: false,
    inicio: false,
    cancel: false,
});
/**
 * Constroi o funil neutro.
 *
 * O UNICO estado sao CONTADORES. Nenhum nonce, nenhum token consumido, nenhuma
 * sessao. A identidade e REVALIDADA em TODO evento de `acao` (TG-024) e em todo
 * evento de `comando` — e por isso que um clique de um membro estranho num
 * grupo autorizado nunca chega ao host.
 *
 * O evento nao pode carregar um token verificavel por nos: {@link SurfaceActionEvent}
 * ja vem COM o token extraido pelo adaptador. O guard nao valida o VALOR (S5),
 * apenas transporta.
 */
export function criarGuardDeIdentidade(deps) {
    let admitido = 0;
    let descartado = 0;
    const byReason = new Map();
    function contar(motivo, permitido) {
        if (permitido)
            admitido += 1;
        else
            descartado += 1;
        byReason.set(motivo, (byReason.get(motivo) ?? 0) + 1);
    }
    return {
        admit(evento) {
            // -------------------------------------------------------------------
            // ACAO MALFORMADA/DESCARTAVEL — o adaptador nao conseguiu ler um payload
            // valido. NUNCA inventa `action`/`token`: responde ao clique (TG-027) e
            // conta. `answerTarget` e obrigatorio neste evento.
            // -------------------------------------------------------------------
            if (evento.kind === 'acao-invalida') {
                const motivo = evento.reason ?? 'deny:callback-data-invalido';
                contar(motivo, false);
                return {
                    kind: 'rejeitado',
                    reason: motivo,
                    answerTarget: evento.answerTarget,
                    identity: evento.identity,
                    audit: {
                        evento: 'surface.evento.descartado',
                        resultado: 'negado',
                        motivo,
                        ...(evento.identity === undefined
                            ? {}
                            : { userKey: evento.identity.userKey, chatKey: evento.identity.chatKey }),
                    },
                };
            }
            // -------------------------------------------------------------------
            // COMANDO — um update de TEXTO normalizado. Revalida os dois eixos.
            // -------------------------------------------------------------------
            if (evento.kind === 'comando') {
                const decisao = decidirAutorizacao(evento.identity, deps.allowlist);
                if (!decisao.ok) {
                    contar(decisao.reason, false);
                    return {
                        kind: 'rejeitado',
                        reason: decisao.reason,
                        identity: evento.identity,
                        audit: {
                            evento: 'surface.evento.descartado',
                            resultado: 'negado',
                            motivo: decisao.reason,
                            ...(evento.identity === undefined
                                ? {}
                                : { userKey: evento.identity.userKey, chatKey: evento.identity.chatKey }),
                        },
                    };
                }
                const identity = evento.identity;
                contar('ok', true);
                return {
                    kind: 'comando',
                    identity,
                    audit: {
                        evento: 'surface.evento.admitido',
                        resultado: 'permitido',
                        motivo: 'ok',
                        userKey: identity.userKey,
                        chatKey: identity.chatKey,
                    },
                };
            }
            // -------------------------------------------------------------------
            // ACAO — um clique. A PARTIR DAQUI A IDENTIDADE JA FOI REVALIDADA
            // (TG-024): `decidirAutorizacao` acabou de comparar `userKey` (quem
            // carregou) E `chatKey` (onde estava a mensagem) contra a allowlist.
            // -------------------------------------------------------------------
            const decisao = decidirAutorizacao(evento.identity, deps.allowlist);
            if (!decisao.ok) {
                contar(decisao.reason, false);
                return {
                    kind: 'rejeitado',
                    reason: decisao.reason,
                    // TG-027: responder NA negacao tambem. O `answerTarget` do evento.
                    answerTarget: evento.answerTarget,
                    identity: evento.identity,
                    audit: {
                        evento: 'surface.evento.descartado',
                        resultado: 'negado',
                        motivo: decisao.reason,
                        ...(evento.identity === undefined
                            ? {}
                            : { userKey: evento.identity.userKey, chatKey: evento.identity.chatKey }),
                    },
                };
            }
            const identity = evento.identity;
            // Falta de `answerTarget` = impossivel cumprir TG-027; fail-closed.
            if (evento.answerTarget.length === 0) {
                contar('deny:sem-alvo-de-resposta', false);
                return {
                    kind: 'rejeitado',
                    reason: 'deny:sem-alvo-de-resposta',
                    identity,
                    audit: {
                        evento: 'surface.evento.descartado',
                        resultado: 'negado',
                        motivo: 'deny:sem-alvo-de-resposta',
                        userKey: identity.userKey,
                        chatKey: identity.chatKey,
                    },
                };
            }
            contar('ok', true);
            return {
                kind: 'acao',
                identity,
                action: evento.action,
                token: evento.token,
                increasesExposure: AUMENTA_EXPOSICAO[evento.action],
                answerTarget: evento.answerTarget,
                audit: {
                    evento: 'surface.evento.admitido',
                    resultado: 'permitido',
                    motivo: 'ok',
                    userKey: identity.userKey,
                    chatKey: identity.chatKey,
                },
            };
        },
        stats() {
            return { admitido, descartado, byReason: Object.fromEntries(byReason) };
        },
    };
}
export function criarAllowlistIncremental(users, chats) {
    const setUsers = new Set(users);
    const setChats = new Set(chats);
    return {
        // `size` e DERIVADO (getter): `adicionar*` muta o conjunto e o default-deny
        // passa a ver o novo dono semeado (sem isso, `size===0` negaria tudo).
        get size() {
            return setUsers.size + setChats.size;
        },
        hasUser: (key) => setUsers.has(key),
        hasChat: (key) => setChats.has(key),
        adicionarUser(chave) {
            const limpa = chave.trim();
            if (limpa.length > 0)
                setUsers.add(limpa);
        },
        adicionarChat(chave) {
            const limpa = chave.trim();
            if (limpa.length > 0)
                setChats.add(limpa);
        },
    };
}
/** Traduz `decidirAutorizacao` para a `SurfaceAdmissaoSuperficie` (motivo sem prefixo). */
function admissaoPara(identidade, allowlist) {
    const decisao = decidirAutorizacao(identidade, allowlist);
    if (decisao.ok)
        return { admitido: true };
    return { admitido: false, motivo: decisao.reason.slice('deny:'.length) };
}
/**
 * Composicao que o CORE consome como `SurfaceAuth`. Ordem do funil (PAIR-006/007):
 * pareamento PRIMEIRO (via `receber`), allowlist DEPOIS (via `admitirComando`/
 * `admitirAcao`). `semearDono` fecha o receptor E da ao dono os dois eixos.
 */
export function criarAuthDeSuperficie(deps) {
    const allowlist = criarAllowlistIncremental(deps.users ?? [], deps.chats ?? []);
    const receiver = criarReceptorDePareamento({
        challenge: deps.challenge,
        clock: deps.clock,
        ...(deps.limits === undefined ? {} : { limits: deps.limits }),
        ...(deps.owner === undefined ? {} : { owner: deps.owner }),
    });
    // Se o facade nasce com dono, a allowlist ja o aceita nos dois eixos.
    if (deps.owner !== undefined) {
        allowlist.adicionarUser(deps.owner.userKey);
        allowlist.adicionarChat(deps.owner.chatKey);
    }
    return {
        receber(evento) {
            const resultado = receiver.receive(evento);
            switch (resultado.kind) {
                case 'paired':
                    return { kind: 'pareado', dono: resultado.owner, reply: resultado.reply };
                case 'welcome':
                    return { kind: 'boas-vindas', reply: resultado.reply, chat: resultado.chat };
                case 'refused':
                    return {
                        kind: 'recusado',
                        reason: resultado.reason,
                        reply: resultado.reply,
                        delayMs: resultado.delayMs,
                        chat: resultado.chat,
                    };
                case 'ignored':
                    return { kind: 'ignorado' };
            }
        },
        verificarCandidato(identidade, candidato) {
            const resultado = receiver.verificarCandidato(identidade, candidato);
            switch (resultado.kind) {
                case 'paired':
                    return { kind: 'pareado', dono: resultado.owner, reply: resultado.reply };
                case 'refused':
                    return {
                        kind: 'recusado',
                        reason: resultado.reason,
                        reply: resultado.reply,
                        delayMs: resultado.delayMs,
                        chat: resultado.chat,
                    };
                case 'welcome':
                case 'ignored':
                    // `verificarCandidato` nunca produz boas-vindas nem ignorado; cobre o
                    // tipo por exaustao (a traducao nao pode inventar um kind).
                    return { kind: 'ignorado' };
            }
        },
        admitirComando(identidade) {
            return admissaoPara(identidade, allowlist);
        },
        admitirAcao(identidade, _action) {
            // A REVALIDACAO de identidade (S6) nao depende da acao: qualquer membro
            // estranho de um grupo autorizado e barrado em TG-024, qualquer que seja
            // o botao. O `_action` existe na assinatura que o core espera.
            return admissaoPara(identidade, allowlist);
        },
        estado() {
            const estado = receiver.state();
            if (estado.status === 'fechado')
                return { status: 'fechado', dono: estado.owner };
            return { status: 'aberto' };
        },
        rotacionarDesafio(desafio) {
            receiver.rotateChallenge(desafio);
        },
        semearDono(dono) {
            receiver.semearDono(dono);
            // O dono persistido passa a ser aceite nos DOIS eixos (8c).
            allowlist.adicionarUser(dono.userKey);
            allowlist.adicionarChat(dono.chatKey);
        },
    };
}
//# sourceMappingURL=auth.js.map