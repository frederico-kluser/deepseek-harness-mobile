/**
 * =============================================================================
 * TTL do tunel — o controlo que limita a JANELA DE EXPOSICAO.
 * =============================================================================
 *
 * A ameaca concreta (T10 de `02-SEGURANCA.md`): abre-se o tunel numa terca a
 * noite, fecha-se o portatil, e descobre-se no domingo que ele nunca fechou. Num
 * quick tunnel — URL publica, descoberta em massa, sem Access a frente — o tempo
 * que a URL fica viva e a variavel que mais importa.
 *
 * -----------------------------------------------------------------------------
 * SEM DEFAULT NO CODIGO, E SEM CLAMP
 * -----------------------------------------------------------------------------
 * O default `60` vive no `cordis.patch.yml`, que o utilizador VE e pode editar.
 * O codigo nao tem fallback nenhum: ausente e tao invalido quanto `0`. E NUNCA
 * ha clamp — um `ttlMinutes: 10080` reduzido em silencio a 480 diz ao utilizador
 * que ele pediu uma semana e recebeu uma semana. Fail LOUD.
 *
 * A validacao e chamada por `assertValidConfig` (T3.3); a REGRA vive aqui, junto
 * do resto do TTL, para que exista uma so definicao do que e um TTL valido.
 *
 * -----------------------------------------------------------------------------
 * SOBREVIVE A MAIS DO QUE UM `setTimeout`
 * -----------------------------------------------------------------------------
 * Um `setTimeout` morre com o event loop: `SIGKILL` no DSH, reinicio da maquina,
 * queda de energia — e o temporizador desaparece enquanto o `cloudflared`
 * `detached` continua vivo. Por isso a base do TTL e o `startedAt` PERSISTIDO
 * (`src/contracts/state.ts`, `tunnel: { pid, startedAt, mode }`): o boot seguinte
 * compara-o com o relogio e conclui que o prazo ja passou, sem depender de
 * temporizador nenhum. {@link decideOnResume} e essa conclusao.
 *
 * -----------------------------------------------------------------------------
 * NAO EXISTE `renew()`, E A AUSENCIA E O CONTROLO (TUN-026)
 * -----------------------------------------------------------------------------
 * Um `/status` ou um acesso NAO estendem o TTL. So um `start` explicito abre
 * janela nova, e um `start` explicito chama {@link TunnelTtl.arm}. Nao ha metodo
 * de renovacao nesta superficie: um TTL que se estende com o uso e um TTL que
 * nunca expira para quem esta a usar — que e exatamente quem tem o tunel aberto.
 *
 * -----------------------------------------------------------------------------
 * A ORDEM DOS EFEITOS AO EXPIRAR NAO E ARBITRARIA
 * -----------------------------------------------------------------------------
 *   1. derruba o tunel        — fecha a exposicao;
 *   2. invalida TODAS as sessoes — sem isto, o cookie emitido pelo tunel velho
 *      continua valido e autentica no tunel seguinte;
 *   3. regista em auditoria   — a prova de que o controlo agiu;
 *   4. avisa no Telegram      — POR ULTIMO, porque e o passo que pode falhar
 *      (rede, bot bloqueado, token expirado) e a auditoria nao pode depender dele.
 */
/** Tecto duro, em minutos. `> 480` e recusado, nunca reduzido. */
export const TTL_MAX_MINUTES = 480;
/**
 * Erro de configuracao do TTL.
 *
 * Campo declarado e atribuido a mao, e nao "parameter property": `node --test`
 * corre os `.ts` em STRIP-ONLY MODE, que recusa essa sintaxe porque ela EMITE
 * codigo em vez de so apagar tipos.
 */
export class TunnelTtlError extends Error {
    name = 'TunnelTtlError';
    code;
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.code = code;
    }
}
/**
 * Valida `tunnel.ttlMinutes` e devolve-o. Ausente, `0`, negativo, nao inteiro ou
 * `> 480` LANCA (TUN-019). Nao ha caminho que devolva um valor que nao tenha sido
 * escrito pelo utilizador.
 */
export function assertValidTtlMinutes(value, field = 'tunnel.ttlMinutes') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new TunnelTtlError('TTL_INVALID', `${field} tem de ser um inteiro de minutos entre 1 e ${String(TTL_MAX_MINUTES)}. ` +
            'Nao ha default no codigo: o valor vem do manifesto, onde e visivel e editavel.');
    }
    if (value <= 0) {
        throw new TunnelTtlError('TTL_INVALID', `${field} tem de ser pelo menos 1 minuto (recebido ${String(value)}). ` +
            'Um TTL de zero desligaria o unico limite da janela de exposicao.');
    }
    if (value > TTL_MAX_MINUTES) {
        throw new TunnelTtlError('TTL_INVALID', `${field} nao pode passar de ${String(TTL_MAX_MINUTES)} minutos (recebido ${String(value)}). ` +
            'O valor NAO e reduzido em silencio: reduzi-lo diria que recebeu o que pediu.');
    }
    return value;
}
/** Instante em que o prazo termina. Epoch ms. */
export function ttlDeadline(startedAt, ttlMinutes) {
    return startedAt + ttlMinutes * 60_000;
}
/** Milissegundos que faltam. Nunca negativo — `0` significa "ja passou". */
export function ttlRemainingMs(startedAt, ttlMinutes, now) {
    return Math.max(0, ttlDeadline(startedAt, ttlMinutes) - now);
}
export function isTtlExpired(startedAt, ttlMinutes, now) {
    return ttlRemainingMs(startedAt, ttlMinutes, now) === 0;
}
export function decideOnResume(startedAt, ttlMinutes, now) {
    const remainingMs = ttlRemainingMs(startedAt, ttlMinutes, now);
    if (remainingMs > 0)
        return { expired: false, remainingMs };
    return { expired: true, overdueMs: now - ttlDeadline(startedAt, ttlMinutes) };
}
/**
 * Texto do aviso ao dono.
 *
 * SEM A URL DO TUNEL, e isso e deliberado: a URL de um quick tunnel e efemera,
 * a mensagem viaja pela infraestrutura de um terceiro, e repetir uma URL que ja
 * nao existe so serve para alguem tentar abri-la.
 */
export function ownerExpiryMessage(ttlMinutes) {
    return (`O tunel expirou apos ${String(ttlMinutes)} minutos e foi encerrado, como estava combinado. ` +
        'Todas as sessoes abertas deixaram de valer. Para abrir uma janela nova, ligue o tunel outra vez.');
}
/**
 * Nome do evento de auditoria da expiracao. O vocabulario fechado e de T5.4
 * (`src/audit/events.ts`); ate la o nome canonico vive aqui, junto de quem o emite.
 */
export const EVENTO_TTL_EXPIRADO = 'tunel_ttl_expirado';
/**
 * Monta os quatro efeitos a partir das costuras.
 *
 * Vive AQUI, e nao no supervisor, porque a ORDEM e a forma do registo fazem parte
 * do controlo do TTL — nao da composicao de quem o usa.
 */
export function createTtlEffects(wiring) {
    return {
        stopTunnel: (facts) => {
            wiring.stopTunnel(facts);
        },
        revokeAllSessions: () => {
            // Sem isto, o cookie emitido pelo tunel velho continua valido e autentica no
            // tunel seguinte: o prazo teria fechado a porta e deixado a chave na fechadura.
            wiring.sessions.revokeAll();
        },
        audit: (facts) => {
            wiring.audit.append({
                evento: `${EVENTO_TTL_EXPIRADO}:${String(facts.ttlMinutes)}min:${facts.detectedBy}`,
                resultado: 'permitido',
            });
        },
        notifyOwner: (message) => {
            wiring.notifyOwner(message);
        },
    };
}
/**
 * Executa a expiracao NA ORDEM. Exportada porque o boot tambem a usa: um tunel
 * que expirou enquanto a maquina estava desligada tem de percorrer exatamente os
 * mesmos quatro passos que um que expirou com o plugin vivo.
 */
export function applyTtlExpiry(effects, log, facts) {
    log.info(`TTL de ${String(facts.ttlMinutes)} min cumprido (deteccao: ${facts.detectedBy}); ` +
        'a derrubar o tunel e a invalidar as sessoes.');
    // 1 e 2 sao os passos de SEGURANCA e correm primeiro. Se algum deles lancar, a
    // excepcao sobe: uma falha a fechar exposicao NAO pode ser mitigada em silencio.
    effects.stopTunnel(facts);
    effects.revokeAllSessions();
    // 3 — a auditoria nao pode depender do aviso, por isso vem antes dele. Se o
    // sink recusar (disco cheio, fail-closed), a exposicao JA esta fechada: o
    // registo em falta e um problema de observabilidade, nao de seguranca, e
    // deixar de avisar o dono por causa dele seria trocar um mal por outro pior.
    try {
        effects.audit(facts);
    }
    catch (error) {
        log.error(`TTL cumprido, tunel derrubado e sessoes invalidadas, mas o registo de auditoria FALHOU: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 4 — o passo que pode falhar por rede. A excepcao e registada, nunca engolida,
    // e nunca desfaz os tres passos anteriores.
    try {
        effects.notifyOwner(ownerExpiryMessage(facts.ttlMinutes), facts);
    }
    catch (error) {
        log.error(`TTL cumprido e tunel derrubado, mas o aviso ao dono FALHOU: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function createTunnelTtl(deps) {
    const ttlMinutes = assertValidTtlMinutes(deps.ttlMinutes);
    let timer;
    let deadline;
    let disposed = false;
    const clear = () => {
        if (timer === undefined)
            return;
        deps.scheduler.clearTimeout(timer);
        timer = undefined;
    };
    return {
        arm(startedAt) {
            if (disposed)
                return;
            clear();
            deadline = ttlDeadline(startedAt, ttlMinutes);
            const facts = { startedAt, expiresAt: deadline, ttlMinutes, detectedBy: 'timer' };
            const remainingMs = ttlRemainingMs(startedAt, ttlMinutes, deps.now());
            if (remainingMs === 0) {
                // `startedAt` vindo do disco ja passou do prazo: expira JA, sem agendar
                // nada. Um `setTimeout(0)` daria o mesmo resultado um tick depois — e
                // esse tick e uma janela em que o tunel esta vivo e ninguem sabe.
                applyTtlExpiry(deps.effects, deps.log, { ...facts, detectedBy: 'boot' });
                deadline = undefined;
                return;
            }
            timer = deps.scheduler.setTimeout(() => {
                timer = undefined;
                deadline = undefined;
                applyTtlExpiry(deps.effects, deps.log, facts);
            }, remainingMs);
        },
        get expiresAt() {
            return deadline;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            // O disposer CANCELA o prazo, nao o cumpre: descarregar o plugin ja derruba
            // o tunel pelo disposer do supervisor (LIFO), e disparar a expiracao aqui
            // notificaria o dono de um vencimento que nao aconteceu.
            clear();
            deadline = undefined;
        },
    };
}
//# sourceMappingURL=ttl.js.map