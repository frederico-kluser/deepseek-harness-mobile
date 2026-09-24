/**
 * A SUPERFICIE Telegram do controlador: mapeia `IpcIntentMessage` (o canal
 * host <-> worker de T4.3, `src/ipc/channel.ts`) para `ControlIntent` e
 * devolve a resposta `IpcMessageToWorker` que o canal exige.
 *
 * DONO: T5.1 (a fiacao do canal IPC do host e desta sub-tarefa).
 *
 * ---------------------------------------------------------------------------
 * POR QUE ESTA CAMADA EXISTE — S6, D29 E O "ACK SEMPRE"
 * ---------------------------------------------------------------------------
 * - S6 (`src/contracts/ipc.ts`): a allowlist de identidade vive no worker; o
 *   host VOLTA a verificar contra o pareamento persistido, porque uma
 *   verificacao no processo que fala com a internet e a primeira a cair se
 *   esse processo for comprometido. A recusa e `NOT_PAIRED` e e CONTADA no
 *   audit (CTL-029).
 * - `EXPOSURE_DISABLED`: com `exposure.mode !== 'tunnel'` nao ha controlador
 *   (a fiacao so o cria com config de tunel) e a superficie recusa o pedido
 *   com o codigo cujo texto diz qual chave mudar.
 * - D29: `tunnel.up` em `STOPPING` e respondido `rejected` com
 *   `SHUTDOWN_IN_PROGRESS` — decidido de forma SINCRONA, nunca enfileirado.
 * - O `ack` e SEMPRE emitido: trabalho lento (`start` a partir de `STOPPED`,
 *   onde o probe corre) responde `accepted` JA e o resultado vem pelas
 *   difusoes de estado — o padrao do contrato IPC ("trabalho lento responde
 *   accepted ja e difunde o resto depois por send").
 * - `/emergencia` REDUZ exposicao e NAO exige nonce (CTL-024). Ele derruba o
 *   tunel PRIMEIRO (despacho `stop`) e so depois invalida as sessoes
 *   (`aposEmergencia`): "ordem tunel primeiro, sempre" (02-SEGURANCA L8).
 *
 * A COSTURA (item 5) fia `session.issue` e `secret.rotate`: o /acessar (e o
 * auto-link do /ligar) emite a CHAVE NO LINK (`LinkTokenSurface.emitir`) e
 * notifica o dono com `https://<url>?key=<token>` por `notify` (TG-085) — quem
 * abre entra DIRETO, sem senha (modelo expose-port da Onda 1); o /rotacionar
 * consome o nonce no HOST, regenera o segredo (SECRET-008: sessoes invalidadas)
 * e revoga a chave no link, notificando SEM enviar a senha pelo chat. Sem a
 * chave/rotacao fiadas, os dois respondem `INTERNAL` — fail-closed.
 *
 * EMENDA ONDA-3-HOST-TAREFAS: `chat.new`/`worktree.create` deixaram de ser STUB
 * e passam a DISPATCH REAL — idempotencia por `requestId`, nonce `'reset'`
 * consumido no host, revalidacao S6 da forma, efeitos no registry
 * (`src/agents/registry.ts` — criar chat/worktree) e difusao `agent.report`
 * apos o efeito. Sem `tarefas`/`confirm` fiados, as duas respondem `INTERNAL`
 * (fail-closed — o mesmo padrao de `agent.dispatch`).
 */
import { comporTextoLinkMagico } from "../audit/notify.js";
import { promptDeChatValido } from "../agents/chats.js";
import { baseDeWorktreeValida, nomeDeWorktreeValido } from "../agents/worktrees.js";
import { IPC_PROTOCOL_VERSION } from "../contracts/ipc.js";
/** Vocabulario de auditoria desta superficie. O fechado e de T5.4. */
export const EVENTO_NAO_PAREADO = 'tunel_intent_nao_pareado';
/**
 * Mapeia uma recusa do controlador para o vocabulario FECHADO do IPC.
 *
 * Uma entrada do vocabulario nao tem correspondente (`SEM_SEGREDO_FORTE`):
 * nao ha codigo IPC para "segredo nao provisionado". Responde-se `INTERNAL`
 * — o codigo catch-all cuja mensagem "nao denuncia topologia" — e o motivo
 * fica no audit, que e a fonte da verdade.
 */
export function codigoIpcDe(recusa) {
    switch (recusa) {
        case 'SHUTDOWN_IN_PROGRESS':
            return 'SHUTDOWN_IN_PROGRESS';
        case 'MODO_RESTRITO':
            return 'RESTRICTED_MODE';
        case 'SEM_SEGREDO_FORTE':
            return 'INTERNAL';
        case 'TERMINAL_SEM_RESET':
            return 'TUNNEL_FAILED';
        case 'NONCE_AUSENTE':
        case 'NONCE_INVALIDO':
        case 'NONCE_EXPIRADO':
            return 'NONCE_INVALID';
    }
}
/**
 * Deriva o `result` do ack a partir do resultado do despacho.
 *
 * `ControlResultado` nao carrega "accepted vs noop" — so o estado apos o
 * despacho e a recusa. A derivacao e a tabela de 01-ARQUITETURA 9.2:
 *
 *   - `start` -> `STARTING`/`DEGRADED`: accepted (a subida esta em curso);
 *     `READY`: noop (ja estava online; a URL vigente vem na difusao);
 *     `FAILED` sem recusa: rejected `PROBE_FAILED` (CTL-013);
 *   - `stop` -> `STOPPING`: accepted; `STOPPED`/`FAILED`: noop;
 *   - `reset` -> `STOPPED`: accepted; resto: noop.
 */
export function resultadoDoAck(action, resultado) {
    if (resultado.recusa !== undefined)
        return { result: 'rejected', code: codigoIpcDe(resultado.recusa) };
    switch (action) {
        case 'start':
            if (resultado.estado === 'STARTING' || resultado.estado === 'DEGRADED')
                return { result: 'accepted' };
            if (resultado.estado === 'READY')
                return { result: 'noop' };
            return { result: 'rejected', code: 'PROBE_FAILED' };
        case 'stop':
            if (resultado.estado === 'STOPPING')
                return { result: 'accepted' };
            return { result: 'noop' };
        case 'reset':
            if (resultado.estado === 'STOPPED')
                return { result: 'accepted' };
            return { result: 'noop' };
    }
}
/** Resposta de erro a uma intent (o `ack` e sempre emitido; o erro, nos caminhos de falha). */
function erro(intent, code, message) {
    return { v: IPC_PROTOCOL_VERSION, type: 'error', requestId: intent.requestId, code, message };
}
/** Resposta de ack a uma intent. */
function ack(intent, result, state) {
    return { v: IPC_PROTOCOL_VERSION, type: 'ack', requestId: intent.requestId, result, state };
}
export function criarRespondedorIpc(deps) {
    const { log } = deps;
    /**
     * EMENDA ONDA-3-HOST-TAREFAS: a IDEMPOTENCIA por `requestId` das DUAS
     * tarefas novas (o contrato: "E A CHAVE DE IDEMPOTENCIA: repetido devolve o
     * resultado da primeira execucao"; o `ack` documenta o caso como `noop`).
     * Um replay de uma intent JA DESPACHADA nunca cria um segundo chat/worktree
     * nem consome um segundo nonce. A entrada marca-se quando a intent passou o
     * nonce (houve efeito ou decisao final); uma recusa de NONCE NAO marca — um
     * clique tardio (nonce expirado) tem de poder voltar a tentar com um nonce
     * novo, e nada corre nesse caminho. Teto modesto + evicao FIFO: uma tabela
     * de replay nao pode crescer sem fim.
     */
    const MAX_INTENTS_PROCESSADAS = 1024;
    const processadas = new Set();
    const marcarProcessada = (requestId) => {
        processadas.add(requestId);
        while (processadas.size > MAX_INTENTS_PROCESSADAS) {
            const maisAntiga = processadas.keys().next().value;
            if (maisAntiga === undefined)
                break;
            processadas.delete(maisAntiga);
        }
    };
    const estadoAtual = () => deps.controller?.snapshot().state ?? 'STOPPED';
    const controlIntentDe = (intent, action, nonce) => ({
        action,
        requestedBy: `telegram:${intent.from}`,
        requestId: intent.requestId,
        ...(nonce === undefined ? {} : { nonce }),
        at: deps.agora(),
    });
    /**
     * `tunnel.up`/`tunnel.down`: decide de forma SINCRONA quando possivel; o
     * `start` a partir de `STOPPED` responde `accepted` ja e corre na fila.
     */
    const despacharControle = (intent, action, nonce) => {
        if (!deps.modoTunel || deps.controller === undefined) {
            return erro(intent, 'EXPOSURE_DISABLED', 'A exposicao esta desativada nesta instalacao. Defina exposure.mode como tunnel para ligar o tunel.');
        }
        const controlIntent = controlIntentDe(intent, action, nonce);
        const decidido = deps.controller.decidirSincrono(controlIntent);
        if (decidido === null) {
            // Trabalho lento: aceita ja, difunde o resto depois (o padrao do IPC). O
            // despacho "nunca rejeita" por contrato, mas um defeito nao pode virar
            // unhandled rejection — o ack JA saiu (linha acima), o erro e logado e
            // segue (Frente 4, Onda 6).
            void deps.controller.despachar(controlIntent).catch((error) => {
                log.error(`falha no despacho pos-ack de ${action}: ${error instanceof Error ? error.message : String(error)}`);
            });
            return ack(intent, 'accepted', estadoAtual());
        }
        const veredito = resultadoDoAck(action, decidido);
        return veredito.code === undefined
            ? ack(intent, veredito.result, decidido.estado)
            : { ...ack(intent, veredito.result, decidido.estado), code: veredito.code };
    };
    return (intent) => {
        // 1. IDENTIDADE (S6): o host re-verifica contra o pareamento persistido,
        //    ANTES de tocar na maquina de estado (CTL-029), e conta no audit.
        if (!deps.pareado(intent.from, intent.chat)) {
            try {
                deps.audit.append({
                    evento: `${EVENTO_NAO_PAREADO}:telegram:${intent.from}`,
                    resultado: 'negado',
                });
            }
            catch (error) {
                log.error(`falha ao registar a recusa de identidade no audit: ${error instanceof Error ? error.message : String(error)}`);
            }
            log.warn(`intencao '${intent.intent}' de identidade nao pareada (from ${intent.from}); recusada.`);
            return erro(intent, 'NOT_PAIRED', 'Este chat nao esta pareado com o dono do tunel.');
        }
        switch (intent.intent) {
            case 'tunnel.up':
                return despacharControle(intent, 'start', intent.nonce);
            case 'tunnel.down':
                return despacharControle(intent, 'stop', undefined);
            case 'emergency': {
                // Kill switch: sem nonce (CTL-024). Tunel primeiro, sessoes depois.
                if (deps.controller !== undefined) {
                    // (b) O despacho pode LANCAR DE FORMA SINCRONA (controlador avariado:
                    // persistirIntencao/supervisor a rebentar). O throw vira ack de erro,
                    // nunca escapa — o "ack sempre emitido" e o contrato do canal (Q-5).
                    try {
                        // (a) A promise DERIVADA (despachar + aposEmergencia) tem catch: se
                        // o aposEmergencia (ou o despacho) rejeitar DEPOIS do ack, o erro e
                        // logado e segue — um kill switch falho nunca derruba o processo
                        // por uma promise sem catch (Frente 4, Onda 6).
                        void deps.controller
                            .despachar(controlIntentDe(intent, 'stop'))
                            .then(() => deps.aposEmergencia(intent))
                            .catch((error) => {
                            log.error(`falha no /emergencia apos o ack: ${error instanceof Error ? error.message : String(error)}`);
                        });
                    }
                    catch (error) {
                        log.error(`falha ao despachar o /emergencia: ${error instanceof Error ? error.message : String(error)}`);
                        return erro(intent, 'INTERNAL', 'Nao foi possivel processar o pedido. Tente novamente.');
                    }
                }
                else {
                    // Sem tunel nao ha o que derrubar; a invalidacao continua a valer.
                    // Best-effort tambem aqui: um aposEmergencia avariado nao pode
                    // impedir o ack ("ack sempre emitido").
                    try {
                        deps.aposEmergencia(intent);
                    }
                    catch (error) {
                        log.error(`falha no /emergencia (sem tunel): ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                return ack(intent, 'accepted', estadoAtual());
            }
            case 'tunnel.status': {
                // Leitura pura; NAO estende o TTL (TUN-026). Reenvia o estado
                // completo — e assim que um worker (re)conectado se sincroniza.
                deps.reemitirEstado();
                return ack(intent, 'noop', estadoAtual());
            }
            case 'session.issue': {
                // Item 5 (costura) + ONDA 2 (expose-port): /acessar e o auto-link
                // pedem o acesso por LINK COM A CHAVE EMBUTIDA. O host compoe
                // `${url}?key=${token}` a partir do `LinkTokenSurface.emitir()` e
                // notifica o dono — quem abre entra DIRETO, sem senha e sem prompt.
                // O token e reutilizavel ate `revogar()` (rotacao do segredo) e sai
                // UMA vez do `emitir()`; NUNCA e logado (a URL com a chave nunca vai
                // ao log). A resposta `accepted` e INVISIVEL no worker de proposito —
                // o link chega por notify (A2/TG-085).
                if (deps.linkToken === undefined || deps.notificarDono === undefined) {
                    log.warn(`intencao 'session.issue' sem chave-fiada; respondida INTERNAL (fail-closed).`);
                    return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.');
                }
                const snap = deps.controller?.snapshot();
                const url = snap?.state === 'READY' ? snap.info?.url : undefined;
                if (url === undefined) {
                    // Sem tunel online nao ha painel para onde apontar o link.
                    return erro(intent, 'INTERNAL', 'O tunel nao esta online; ligue-o antes de pedir o acesso.');
                }
                const emitido = deps.linkToken.emitir();
                // A URL COMPOSTA pelo host, nunca por um log: o token sai 1x aqui,
                // direto para o notify — o log so ve que a chave foi emitida, nunca o
                // valor nem a URL com `?key=`.
                deps.notificarDono(comporTextoLinkMagico(deps.agora(), url, emitido.token, emitido.expiraEm));
                return ack(intent, 'accepted', estadoAtual());
            }
            case 'agent.dispatch': {
                // EMENDA ONDA-4-AGENTS-HOST: /agente. AUMENTA exposicao (execucao de
                // codigo no host) -> EXIGE nonce, consumido AQUI no host (S5) — o
                // worker pede-o por `nonce.request` com a acao 'reset' (a MESMA ponte
                // do /rotacionar: o vocabulario de `ControlAction` e fechado no PREP 5
                // e nao se toca). Sem agentes fiado, fail-closed INTERNAL.
                if (deps.agentes === undefined || deps.confirm === undefined) {
                    log.warn(`intencao 'agent.dispatch' sem registry/confirm fiados; respondida INTERNAL (fail-closed).`);
                    return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.');
                }
                const veredito = deps.confirm.consumirComVeredito(intent.nonce ?? '', 'reset');
                if (veredito !== 'ok') {
                    // CTL-021/022: nonce desconhecido/consumido ou expirado. A SKILL nao
                    // chega a ser consultada — sem confirmacao nao ha dispatch (o nonce
                    // autoriza; a allowlist defende).
                    return { ...ack(intent, 'rejected', estadoAtual()), code: 'NONCE_INVALID' };
                }
                const skill = intent.params?.skill;
                const prompt = intent.params?.prompt;
                if (skill === undefined || prompt === undefined) {
                    // Defesa em profundidade: o codec ja recusou esta forma (a intent
                    // sem params nao passa do canal); se chegou aqui, e defeito nosso.
                    return erro(intent, 'INTERNAL', 'Nao foi possivel processar o pedido. Tente novamente.');
                }
                const decidido = deps.agentes.despachar({
                    skill,
                    prompt,
                    origem: `telegram:${intent.from}`,
                });
                if (!decidido.ok) {
                    // RECUSA DE POLITICA (allowlist/teto/harness) — um `error` com a
                    // mensagem accionavel, que o worker mostra ao dono (o vocabulario de
                    // codigos e fechado e nenhum codigo diz "skill nao autorizada").
                    const mensagem = decidido.motivo === 'skill-nao-permitida'
                        ? `A skill "${skill}" nao esta autorizada neste plugin (config agents.skills).`
                        : decidido.motivo === 'teto-atingido'
                            ? 'Ja ha agentes a correr ate o limite (config agents.maxRuns). Espera um terminar ou cancela um.'
                            : 'O harness nao esta disponivel para disparar agentes.';
                    return erro(intent, 'INTERNAL', mensagem);
                }
                return ack(intent, 'accepted', estadoAtual());
            }
            case 'agent.status': {
                // EMENDA ONDA-4-AGENTS-HOST: /agentes. Leitura pura, sem nonce. A
                // RESPOSTA e a difusao `agent.report` (a lista) + o ack — o mesmo
                // padrao do `tunnel.status` (o estado completo vem pela difusao).
                if (deps.agentes === undefined || deps.relatorioDeAgentes === undefined) {
                    log.warn(`intencao 'agent.status' sem registry fiado; respondida INTERNAL (fail-closed).`);
                    return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.');
                }
                try {
                    deps.relatorioDeAgentes();
                }
                catch (error) {
                    log.error(`falha ao difundir o relatorio de agentes: ${error instanceof Error ? error.message : String(error)}`);
                }
                return ack(intent, 'noop', estadoAtual());
            }
            case 'agent.cancel': {
                // EMENDA ONDA-4-AGENTS-HOST: /parar-agente. REDUZ (cancela execucao)
                // -> dispensa nonce (CTL-024: em panico, o botao funciona de primeira).
                // Id desconhecido = noop idempotente (o run ja nao existe ou ja
                // terminou — nao ha o que cancelar).
                if (deps.agentes === undefined) {
                    log.warn(`intencao 'agent.cancel' sem registry fiado; respondida INTERNAL (fail-closed).`);
                    return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.');
                }
                const agentId = intent.params?.agentId;
                if (agentId === undefined) {
                    return erro(intent, 'INTERNAL', 'Nao foi possivel processar o pedido. Tente novamente.');
                }
                const cancelado = deps.agentes.cancelar(agentId, `telegram:${intent.from}`);
                return ack(intent, cancelado ? 'accepted' : 'noop', estadoAtual());
            }
            /* --- EMENDA ONDA-3-HOST-TAREFAS: as DUAS capacidades novas ----------
             * `chat.new` (/novo-chat, /novo-chat-wt) e `worktree.create` (/worktree).
             * AMBAS AUMENTAM exposicao (criar sessoes e correr prompts, criar
             * worktrees com um `git` no host) -> EXIGEM nonce de 2 etapas, consumido
             * AQUI no host (S5) com a acao de controlo `'reset'` — o MESMO precedente
             * de `agent.dispatch`/`secret.rotate` e a MESMA ponte do worker
             * (`ACAO_PARA_NONCE`). O universo de nonce continua UNICO: `ControlAction`
             * nao cresceu e o `ConfirmService` ja e generico por acao.
             *
             * SEQUENCIA (a mesma disciplina de `agent.dispatch`): identidade S6 ja
             * verificada acima (dois eixos `from`/`chat` + pareamento persistido) ->
             * idempotencia por `requestId` -> nonce -> revalidacao S6 da FORMA no
             * host (defesa em profundidade: o worker e o codec ja recusaram) ->
             * veredito sincrono do registry -> ack coerente. ORDEM REAL DO EFEITO
             * (emenda de honestidade apos revisao): o efeito COMECA no prefixo
             * sincrono do veredito — a criacao da sessao e o spawn do `git` correm
             * ANTES de o ack sair — e continua depois dele; o desfecho (fim do turno
             * / exit do git) chega pela difusao `agent.report` que o registry dispara
             * na transicao terminal.
             */
            case 'chat.new':
            case 'worktree.create': {
                const tarefa = intent.intent;
                if (deps.tarefas === undefined || deps.confirm === undefined) {
                    log.warn(`intencao '${tarefa}' sem tarefas/confirm fiados; respondida INTERNAL (fail-closed).`);
                    return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.');
                }
                if (processadas.has(intent.requestId)) {
                    // Replay de uma intent ja decidida: "nao um segundo chat/worktree" —
                    // o mesmo espirito do `noop` do `ack` (idempotencia por requestId).
                    return ack(intent, 'noop', estadoAtual());
                }
                const vereditoNonce = deps.confirm.consumirComVeredito(intent.nonce ?? '', 'reset');
                if (vereditoNonce !== 'ok') {
                    // CTL-021/022: nonce desconhecido/consumido ou expirado. NADA corre e
                    // o `requestId` NAO fica marcado — um clique tardio tem de poder
                    // voltar com um nonce novo (ver o `processadas` acima).
                    return { ...ack(intent, 'rejected', estadoAtual()), code: 'NONCE_INVALID' };
                }
                if (tarefa === 'chat.new') {
                    const prompt = intent.params?.prompt;
                    const worktree = intent.params?.worktree;
                    if (prompt === undefined) {
                        // Defesa em profundidade: o codec ja recusou esta forma (a intent
                        // sem params nao passa do canal); se chegou aqui, e defeito nosso.
                        return erro(intent, 'INTERNAL', 'Nao foi possivel processar o pedido. Tente novamente.');
                    }
                    if (!promptDeChatValido(prompt) || (worktree !== undefined && !nomeDeWorktreeValido(worktree))) {
                        // REVALIDACAO S6 (host): contrato congelado `prompt` texto limpo
                        // <= 4096 + `worktree` `/^[a-z0-9-]{1,40}$/`. Recusa com o vocabulario
                        // FECHADO de codigos (`INTERNAL` e o catch-all; nao ha codigo de
                        // "params invalidos" e o contrato nao cresce).
                        marcarProcessada(intent.requestId);
                        log.warn(`intencao 'chat.new' com params fora do contrato; recusada.`);
                        return { ...ack(intent, 'rejected', estadoAtual()), code: 'INTERNAL' };
                    }
                    const decidido = deps.tarefas.novoChat({
                        prompt,
                        ...(worktree === undefined ? {} : { worktree }),
                        origem: `telegram:${intent.from}`,
                    });
                    marcarProcessada(intent.requestId);
                    if (!decidido.ok) {
                        // RECUSA DE POLITICA (teto/harness) — a mensagem accionavel segue o
                        // padrao de `agent.dispatch` (o vocabulario de codigos nao tem
                        // "teto atingido"; quem mostra texto ao dono e o `error`).
                        return erro(intent, 'INTERNAL', decidido.motivo === 'teto-atingido'
                            ? 'Ja ha tarefas a correr ate o limite (config agents.maxRuns). Espera uma terminar ou cancela uma.'
                            : 'O harness nao esta disponivel para criar chats.');
                    }
                    return ack(intent, 'accepted', estadoAtual());
                }
                // `worktree.create` — `{ nome, base? }`.
                const nome = intent.params?.nome;
                const base = intent.params?.base;
                if (nome === undefined) {
                    return erro(intent, 'INTERNAL', 'Nao foi possivel processar o pedido. Tente novamente.');
                }
                if (!nomeDeWorktreeValido(nome) || (base !== undefined && !baseDeWorktreeValida(base))) {
                    // REVALIDACAO S6 (host): nome `/^[a-z0-9-]{1,40}$/` + ref de partida
                    // com higiene de ref (ver `src/agents/worktrees.ts`).
                    marcarProcessada(intent.requestId);
                    log.warn(`intencao 'worktree.create' com params fora do contrato; recusada.`);
                    return { ...ack(intent, 'rejected', estadoAtual()), code: 'INTERNAL' };
                }
                const decidido = deps.tarefas.novoWorktree({
                    nome,
                    ...(base === undefined ? {} : { base }),
                    origem: `telegram:${intent.from}`,
                });
                marcarProcessada(intent.requestId);
                if (!decidido.ok) {
                    return erro(intent, 'INTERNAL', decidido.motivo === 'teto-atingido'
                        ? 'Ja ha tarefas a correr ate o limite (config agents.maxRuns). Espera uma terminar ou cancela uma.'
                        : 'O harness nao esta disponivel para criar worktrees.');
                }
                // `jaExistia` e o NOOP honesto: o worktree pedido ja estava la ("ja
                // estava no estado pedido") — e nada foi destruido, nunca.
                return ack(intent, decidido.jaExistia === true ? 'noop' : 'accepted', estadoAtual());
            }
            case 'secret.rotate': {
                // Item 5 (costura): /rotacionar regenera o segredo e invalida as
                // sessoes vivas (SECRET-008 — o SecretStore revoga ANTES de publicar).
                // O nonce e exigido (AUMENTA o risco de bloqueio do atacante) e e
                // consumido AQUI, no HOST (S5); a ponte do worker pediu-o como 'reset'
                // (EMENDA-COSTURA-5). A senha nova NUNCA sai pelo chat: so a
                // instrucao do caminho local/terminal.
                if (deps.secretos === undefined || deps.confirm === undefined || deps.notificarDono === undefined) {
                    log.warn(`intencao 'secret.rotate' sem rotacao fiada; respondida INTERNAL (fail-closed).`);
                    return erro(intent, 'INTERNAL', 'Este comando ainda nao esta disponivel nesta instalacao.');
                }
                const veredito = deps.confirm.consumirComVeredito(intent.nonce ?? '', 'reset');
                if (veredito !== 'ok') {
                    // CTL-021/022: nonce desconhecido/consumido ou expirado.
                    return { ...ack(intent, 'rejected', estadoAtual()), code: 'NONCE_INVALID' };
                }
                // O retorno carrega o display (que contem a senha) — ignorado aqui de
                // proposito: nunca logado, nunca enviado (S3/Q-4).
                void deps.secretos.rotate();
                deps.notificarDono('Chave de acesso nova gerada: a anterior foi revogada e as sessões ' +
                    'atuais invalidadas. O link novo que o bot enviar terá a chave ' +
                    'nova embutida — quem usar um link antigo não entra mais.');
                return ack(intent, 'accepted', estadoAtual());
            }
        }
    };
}
export function criarRespondedorDeNonce(deps) {
    const { log } = deps;
    return (request) => {
        if (deps.controller === undefined) {
            log.warn(`pedido de nonce sem controlador (modo loopback); respondido EXPOSURE_DISABLED (acao ${request.acao}).`);
            return {
                v: IPC_PROTOCOL_VERSION,
                type: 'error',
                requestId: request.requestId,
                code: 'EXPOSURE_DISABLED',
                message: 'A exposicao esta desativada nesta instalacao. Defina exposure.mode como tunnel para ligar o tunel.',
            };
        }
        const emitido = deps.controller.emitirNonce(request.acao);
        // S3: o VALOR do nonce nunca vai ao log nem ao texto — so o prazo, que e
        // o que o worker precisa para expirar o teclado de confirmacao.
        log.debug(`nonce emitido para ${request.acao} (expira em ${String(emitido.expiresAt)}).`);
        return {
            v: IPC_PROTOCOL_VERSION,
            type: 'nonce.issued',
            acao: request.acao,
            requestId: request.requestId,
            nonce: emitido.valor,
            expiresAt: emitido.expiresAt,
        };
    };
}
//# sourceMappingURL=surface-ipc.js.map