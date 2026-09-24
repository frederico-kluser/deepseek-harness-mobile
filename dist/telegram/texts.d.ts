/**
 * O TEXTO do onboarding (registo de T4.1, TG-070): as quatro mensagens que a
 * pessoa le em cada estado, os titulos, os avisos obrigatorios e o comando CLI.
 *
 * Extraido de `src/telegram/onboarding.ts` pela COSTURA da Onda 5 (item 6): o
 * detector (`detectarEstado`/`proximoPasso`) continua em `onboarding.ts`; o
 * TEXTO — artefacto revisavel, nao improviso de quem implementa — vive aqui.
 *
 * REGRAS (herdadas): portugues sem jargao; sem stack trace nem simbolo
 * interno; sem caminho absoluto que identifique o utilizador; sem segredo. O
 * codigo de pareamento aparece EXATAMENTE num sitio (o texto de
 * `TOKEN_OK_SEM_DONO`) e a funcao que o compoe exige-o como parametro
 * explicito (PAIR-010).
 */
import type { ProviderId } from '../proc/env.ts';
import type { RetratoDoAmbiente } from './onboarding.ts';
/** Comando publicado no `PATH` pelo pacote. Aparece em todas as instrucoes. */
export declare const COMANDO_CLI = "dsh-guard-setup";
/**
 * Os CINCO AVISOS OBRIGATORIOS (TG-072), exibidos ANTES do primeiro tunel.
 *
 * Nao sao decoracao nem letra pequena: sao as cinco coisas que mudam no
 * instante em que o tunel sobe e que, se a pessoa so descobrir depois, ja
 * descobriu tarde. Cada um tem fonte no plano:
 *   1. `trustedRemotes` inerte -- `01-ARQUITETURA.md` 4 e `src/index.ts`;
 *   2. o tunel e uma ligacao de DENTRO para FORA, logo nao ha regra de entrada
 *      que o pare -- `docs/spikes/cloudflared.md`;
 *   3. TLS termina na borda da Cloudflare -- `01-ARQUITETURA.md` 4;
 *   4. amostragem publica (urlscan.io) devolveu dezenas de hostnames vivos;
 *   5. reputacao de malware do dominio -- `07-COMUNIDADE.md` 9.7.
 */
export declare const AVISOS_ANTES_DO_TUNEL = "Antes de abrir o t\u00FAnel pela primeira vez, cinco coisas mudam \u2014 leia-as uma vez:\n\n  1. A sua lista de endere\u00E7os de confian\u00E7a (trustedRemotes) fica INERTE.\n     Sob t\u00FAnel, todo o tr\u00E1fego chega de 127.0.0.1, porque quem o entrega \u00E9 o\n     cliente do t\u00FAnel a correr nesta mesma m\u00E1quina. A senha passa a ser a \u00FAnica\n     barreira que resta.\n\n  2. O t\u00FAnel fura a firewall da sua rede. Ele n\u00E3o abre porta nenhuma para\n     dentro: sai de dentro para fora e mant\u00E9m a liga\u00E7\u00E3o aberta. Nenhuma regra\n     de entrada o bloqueia \u2014 \u00E9 assim que ele foi feito para funcionar.\n\n  3. A Cloudflare v\u00EA o seu tr\u00E1fego em texto claro na borda. O TLS termina l\u00E1,\n     n\u00E3o aqui, e n\u00E3o h\u00E1 cifra ponta a ponta. \u00C9 exatamente isso que permite o\n     WAF, o Access e a cache; e tamb\u00E9m quer dizer que o que aparece no ecr\u00E3\n     passa leg\u00EDvel por um terceiro.\n\n  4. O endere\u00E7o do t\u00FAnel N\u00C3O \u00E9 segredo. Uma amostragem p\u00FAblica devolveu dezenas\n     de endere\u00E7os *.trycloudflare.com vivos naquele momento. Conte com a senha,\n     nunca com o facto de o nome do endere\u00E7o ser estranho.\n\n  5. trycloudflare.com tem reputa\u00E7\u00E3o de malware em alguns filtros. Desde 2024\n     h\u00E1 campanhas a distribuir malware por t\u00FAneis descart\u00E1veis; por isso muitas\n     redes de empresa bloqueiam o dom\u00EDnio e alguns antiv\u00EDrus assinalam o\n     programa do t\u00FAnel. Em m\u00E1quina de trabalho, fale antes com quem cuida da\n     seguran\u00E7a.";
export declare const TITULO_SEM_TOKEN = "Falta criar o bot no Telegram.";
export declare const TITULO_TOKEN_INVALIDO = "A chave do bot n\u00E3o foi aceite pelo Telegram.";
export declare const TITULO_SEM_DONO = "O bot j\u00E1 responde. Falta dizer-lhe quem \u00E9 o dono.";
export declare const TITULO_PRONTO = "Est\u00E1 tudo ligado.";
/**
 * Titulo do estado SEM_TOKEN, por provedor.
 *
 * As constantes {@link TITULO_SEM_TOKEN} continuam a ser o titulo do telegram
 * (o que os testes e o CLI historico asseram); a funcao e o ponto unico de
 * escolha por provedor, usado por `proximoPasso` (`onboarding.ts`).
 */
export declare function tituloSemToken(_provedor?: ProviderId): string;
/** Titulo do estado TOKEN_INVALIDO, por provedor. Ver {@link tituloSemToken}. */
export declare function tituloTokenInvalido(_provedor?: ProviderId): string;
export interface OpcoesDePasso {
    /**
     * O PROVEDOR de mensageria a que o texto se dirige.
     *
     * Omissa = `telegram` (D1): quem chama sem provedor le hoje os mesmos
     * rotulos de sempre (@BotFather). O texto e artefacto revisavel (TG-070),
     * e os rotulos sao parte do texto.
     */
    readonly provedor?: ProviderId | undefined;
    /**
     * Caminho do `secrets.env`, JA tornado apresentavel. Ver
     * {@link caminhoApresentavel} — o texto nunca leva `/home/<nome>`.
     */
    readonly caminhoSecretsEnv: string;
    /**
     * O codigo de pareamento, para `TOKEN_OK_SEM_DONO`.
     *
     * PARAMETRO EXPLICITO, e nao lido de dentro: quem compoe este texto tem de
     * ter ido buscar o codigo de proposito, com um `revelarCodigo()` no meio.
     * Nenhum chamador o recebe por acaso (PAIR-010).
     */
    readonly codigo?: string | undefined;
    /** Minutos de validade do codigo, para o texto nao ter numero magico. */
    readonly minutosDoCodigo?: number | undefined;
}
/**
 * TG-060 — o passo do BotFather COM O TEXTO EXACTO A DIGITAR.
 *
 * "Sem jargao" e uma exigencia com consequencia: nao se escreve "envie o
 * comando `/newbot` ao BotFather", escreve-se o que aparece no ecra e o que a
 * pessoa escreve, por ordem, com um exemplo de cada resposta. As regras do
 * username (5-32, `[A-Za-z0-9_]`, sufixo `bot`, IMUTAVEL) estao citadas de
 * `bots/features` e sao a causa numero um de a pessoa ficar presa neste passo.
 */
export declare function textoSemToken(opcoes: OpcoesDePasso): string;
/**
 * TG-062 — o texto do token recusado, com o `/token` do BotFather.
 *
 * O plano dizia "mostra o erro cru da API". NAO se mostra o erro cru: o erro
 * cru e `Unauthorized: invalid token specified`, em ingles, e nao diz a
 * ninguem que a cura e pedir uma chave nova ao BotFather. O que se mostra e o
 * DIAGNOSTICO em portugues e o passo seguinte; a `description` original fica na
 * mesma acessivel a quem chama, dentro de {@link FalhaDoGetMe}.
 */
export declare function textoTokenInvalido(retrato: RetratoDoAmbiente, opcoes?: {
    readonly provedor?: ProviderId | undefined;
}): string;
/**
 * TG-063 — o codigo de pareamento, e a instrucao de mandar `/parear <codigo>`.
 *
 * TRES coisas que este texto tem de fazer:
 *   1. NAO instruir a mandar `/start`, e dizer com todas as letras que nenhum
 *      `/start` pareia ninguem (D8);
 *   2. Explicar que um bot NAO CONSEGUE COMECAR UMA CONVERSA (limitacao da
 *      plataforma — sem esta frase, quem nunca escreveu ao bot fica a olhar
 *      para um terminal que "nao faz nada");
 *   3. Dizer PORQUE existe o codigo: a posse do terminal e a prova.
 */
export declare function textoSemDono(bot: string, opcoes: OpcoesDePasso): string;
/**
 * TG-067 — "pronto", e a promessa de IDEMPOTENCIA escrita no proprio texto.
 *
 * A frase "executar outra vez nao gera codigo novo, nao troca a senha e nao
 * reabre o pareamento" nao e conforto: e o contrato que o teste assere e a
 * razao pela qual a execucao por omissao desta ferramenta NAO ESCREVE NADA.
 */
export declare function textoPronto(bot: string, opcoes: OpcoesDePasso): string;
//# sourceMappingURL=texts.d.ts.map