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
import { randomInt, timingSafeEqual } from 'node:crypto';
import { PLUGIN_NAME } from "../errors.js";
/* ========================================================================== */
/* Constantes                                                                 */
/* ========================================================================== */
/** Seis digitos: o que uma pessoa copia do terminal para o telemovel sem errar. */
export const DIGITOS_DO_CODIGO = 6;
/** Espaco do codigo: `10 ** DIGITOS_DO_CODIGO`. */
const ESPACO_DO_CODIGO = 1_000_000;
/** TTL de 5 minutos (`02-SEGURANCA.md` 7.2, passo 3). */
export const TTL_DO_CODIGO_MS = 5 * 60 * 1000;
/**
 * Codigos ERRADOS tolerados antes de a sessao se esgotar.
 *
 * Cinco, e nao "sem limite": ver o cabecalho. E nao 1, porque a pessoa digita
 * no telemovel e um digito trocado nao pode custar-lhe recomecar o onboarding.
 */
export const TENTATIVAS_MAXIMAS = 5;
/** A forma que o dono digita no chat. O nome do comando e canonico (D5). */
export const COMANDO_DE_PAREAMENTO = '/parear';
export class PairingError extends Error {
    name = 'PairingError';
    code;
    // Campo a mao: strip-only mode recusa parameter properties.
    constructor(code, detail) {
        super(`[${PLUGIN_NAME}] ${code}: ${detail}`);
        this.code = code;
    }
}
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
export function gerarCodigoDePareamento(fonte = randomInt) {
    const valor = fonte(0, ESPACO_DO_CODIGO);
    return String(valor).padStart(DIGITOS_DO_CODIGO, '0');
}
/** `^\d{6}$` — nada de espacos, sinal, separador ou notacao cientifica. */
const FORMA_DO_CODIGO = /^\d{6}$/u;
export function codigoTemFormaValida(candidato) {
    return FORMA_DO_CODIGO.test(candidato);
}
/**
 * Compara dois codigos em tempo constante.
 *
 * Nao e teatro por serem so 6 digitos: as tentativas chegam pela rede e a
 * comparacao curta-circuito de `===` vaza o prefixo acertado. Custa uma
 * chamada; a alternativa e um oraculo que reduz 10^6 a 60 tentativas.
 * `timingSafeEqual` EXIGE comprimentos iguais (lanca `RangeError` se diferirem),
 * por isso o comprimento e verificado antes — e o comprimento nao e segredo.
 */
export function codigosSaoIguais(a, b) {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    if (x.byteLength !== y.byteLength)
        return false;
    return timingSafeEqual(x, y);
}
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
export function lerComandoDePareamento(update) {
    const mensagem = propriedade(update, 'message');
    const texto = propriedade(mensagem, 'text');
    if (typeof texto !== 'string')
        return { descarte: 'nao-e-comando-de-pareamento' };
    const codigo = extrairCodigo(texto);
    if (codigo === undefined)
        return { descarte: 'nao-e-comando-de-pareamento' };
    const userId = idNumerico(propriedade(propriedade(mensagem, 'from'), 'id'));
    if (userId === undefined)
        return { descarte: 'sem-remetente' };
    const chat = propriedade(mensagem, 'chat');
    const chatId = idNumerico(propriedade(chat, 'id'));
    if (chatId === undefined)
        return { descarte: 'sem-conversa' };
    if (propriedade(chat, 'type') !== 'private')
        return { descarte: 'conversa-nao-privada' };
    // A FRONTEIRA (V2): o id nasce number no update cru e vira string AQUI,
    // uma unica vez — o que sair deste parser ja e o formato canonico.
    return { userId: String(userId), chatId: String(chatId), codigo };
}
/**
 * `/parear 123456`, `/parear@meu_bot 123456`, com espacos a volta.
 *
 * `\d{6}` ancorado no fim e nao `\d+`, para que `/parear 1234567` nao seja lido
 * como `123456` com lixo atras — truncar seria parear com um codigo que ninguem
 * escreveu.
 *
 * CONSEQUENCIA MEDIDA, e ela e DELIBERADA: uma mensagem que nao case com esta
 * forma nao e uma tentativa, e portanto NAO gasta o teto de tentativas. Se
 * gastasse, qualquer estranho esgotaria o teto com cinco mensagens de texto
 * livre e negava o onboarding — que e exatamente a classe de ataque que o teto
 * existe para conter, virada do avesso. O teto conta CODIGOS de 6 digitos
 * errados, e so esses.
 *
 * Sem `u` maiusculo no comando, porque `#botcommand` fixa que o comando e
 * minusculo.
 */
const FORMA_DO_COMANDO = /^\/parear(?:@[A-Za-z0-9_]{1,32})?\s+(\d{6})\s*$/u;
function extrairCodigo(texto) {
    const casamento = FORMA_DO_COMANDO.exec(texto.trim());
    return casamento?.[1];
}
/** Acesso a uma propriedade de um valor de origem desconhecida, sem lancar. */
function propriedade(valor, chave) {
    if (typeof valor !== 'object' || valor === null)
        return undefined;
    return valor[chave];
}
/**
 * `Chat.id` / `User.id` tem ate 52 bits significativos (`#chat`), logo o
 * `number` do JS (double, exato ate 2^53) chega. O que NAO chega e `int32`, e o
 * que nao serve e um id nao inteiro ou nao finito vindo de JSON adulterado.
 */
function idNumerico(valor) {
    if (typeof valor !== 'number' || !Number.isSafeInteger(valor))
        return undefined;
    return valor;
}
/**
 * Abre uma janela de pareamento.
 *
 * A janela e SEMPRE limitada em duas dimensoes — tempo e tentativas — e fecha-se
 * de forma DEFINITIVA no primeiro sucesso. "Fecha-se" aqui e so o fim desta
 * sessao em memoria; o fecho PERMANENTE e o `pairing` gravado no `state.json`
 * pelo chamador, e reabri-lo exige `--reset-pairing` na maquina (PAIR-005/008).
 */
export function criarSessaoDePareamento(opcoes) {
    const ttlMs = opcoes.ttlMs ?? TTL_DO_CODIGO_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new PairingError('PAIRING_CODE_MALFORMED', `o TTL do codigo tem de ser um numero de milissegundos positivo, e nao ${String(ttlMs)}. ` +
            'Um TTL ausente ou zero seria uma janela de pareamento permanente.');
    }
    const tentativasMaximas = opcoes.tentativasMaximas ?? TENTATIVAS_MAXIMAS;
    if (!Number.isInteger(tentativasMaximas) || tentativasMaximas <= 0) {
        throw new PairingError('PAIRING_CODE_MALFORMED', `o teto de tentativas tem de ser um inteiro positivo, e nao ${String(tentativasMaximas)}. ` +
            'Sem teto, seis digitos sao enumeraveis dentro do proprio TTL.');
    }
    // VARIAVEL DE FECHO, e nao propriedade: e isto que impede `console.log` e
    // `util.inspect` de alcancarem o codigo. Ver PAIR-010 no cabecalho.
    const codigo = opcoes.codigo ?? gerarCodigoDePareamento(opcoes.fonte);
    if (!codigoTemFormaValida(codigo)) {
        throw new PairingError('PAIRING_CODE_MALFORMED', `um codigo de pareamento tem exatamente ${String(DIGITOS_DO_CODIGO)} digitos. ` +
            'O codigo recebido nao tem essa forma (o valor nao e mostrado aqui de proposito).');
    }
    const criadoEm = opcoes.clock.now();
    const expiraEm = criadoEm + ttlMs;
    let consumido = false;
    let descartados = 0;
    let tentativas = 0;
    const expirou = () => opcoes.clock.now() >= expiraEm;
    const estado = () => {
        if (consumido)
            return 'consumido';
        if (tentativas >= tentativasMaximas)
            return 'esgotado';
        // A EXPIRACAO E CALCULADA, nao agendada. Um `setTimeout` daria uma janela
        // que sobrevive ao relogio andar para tras e obrigaria a um disposer para
        // nao segurar o event loop do CLI aberto. Ler o relogio nao tem nenhum dos
        // dois problemas.
        return expirou() ? 'expirado' : 'aberto';
    };
    const resumo = () => ({
        estado: estado(),
        criadoEm,
        expiraEm,
        descartados,
        tentativas,
        tentativasRestantes: Math.max(0, tentativasMaximas - tentativas),
    });
    const descartar = (motivo) => {
        descartados += 1;
        return { tipo: 'descartado', motivo };
    };
    return {
        revelarCodigo() {
            const atual = estado();
            if (atual === 'consumido' || atual === 'esgotado') {
                throw new PairingError('PAIRING_SESSION_CLOSED', `esta sessao de pareamento esta ${atual} e o codigo dela ja nao vale. ` +
                    'Gere um codigo novo no terminal.');
            }
            // Um codigo EXPIRADO continua a poder ser mostrado: o terminal precisa de
            // dizer "este codigo era X e expirou" sem que isso seja um erro. O que
            // nao acontece e ele parear — `oferecer` recusa.
            return codigo;
        },
        estado,
        restanteMs: () => Math.max(0, expiraEm - opcoes.clock.now()),
        resumo,
        toJSON: resumo,
        oferecer(update) {
            // A ORDEM DAS GUARDAS E A POLITICA. "Ja ha dono" vem primeiro porque o
            // segundo `/parear` e recusado MESMO COM O CODIGO CERTO (PAIR-005): o
            // fecho e o controlo, e nao a validade do codigo.
            if (consumido)
                return descartar('ja-pareado');
            if (tentativas >= tentativasMaximas)
                return descartar('tentativas-esgotadas');
            const lido = lerComandoDePareamento(update);
            if ('descarte' in lido)
                return descartar(lido.descarte);
            // A EXPIRACAO E VERIFICADA DEPOIS DE LER e ANTES DE COMPARAR. Depois de
            // ler, para que um update qualquer nao consuma tentativa; antes de
            // comparar, para que um codigo certo fora do prazo NAO pareie (PAIR-004)
            // — o prazo e o controlo, nao um aviso.
            if (expirou())
                return descartar('codigo-expirado');
            if (!codigosSaoIguais(lido.codigo, codigo)) {
                // Conta como TENTATIVA (teto de forca bruta) e tambem como descarte.
                tentativas += 1;
                return descartar('codigo-errado');
            }
            // Uso unico: marca-se ANTES de devolver, para que um segundo update com o
            // mesmo codigo no mesmo tick caia em `ja-pareado` (PAIR-009). `oferecer`
            // e sincrono de ponta a ponta — nao ha `await` no meio por onde uma
            // segunda chamada se possa intercalar.
            consumido = true;
            return {
                tipo: 'pareado',
                dono: {
                    // LIDOS DO UPDATE QUE CARREGA O CODIGO CORRECTO, e de mais nenhum
                    // (TG-065). Nao do primeiro update da fila, nao do `/start` anterior.
                    ownerUserId: lido.userId,
                    ownerChatId: lido.chatId,
                    pairedAt: opcoes.clock.now(),
                },
            };
        },
    };
}
//# sourceMappingURL=pairing.js.map