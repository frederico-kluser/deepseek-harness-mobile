/**
 * Painel HTML autocontido: sem CDN, sem build, sem recurso externo.
 *
 * DONO: T3.4 -> T5.3.
 *
 * ------------------------------------------------------------------------
 * PORQUE ZERO RECURSOS EXTERNOS -- sao DUAS razoes, e a segunda e de seguranca
 * ------------------------------------------------------------------------
 * (a) QUEBRA OFFLINE. Metade do caso de uso deste plugin e a maquina de casa
 *     alcancada de fora; a outra metade e o proprio dono em `127.0.0.1` sem
 *     rede nenhuma. Uma folha de estilo num CDN transforma "o painel abre" numa
 *     aposta sobre a rede de um terceiro.
 * (b) VAZA O `Referer`. Um `<script src>` ou uma fonte remota faz o navegador
 *     pedir esse recurso E ANUNCIAR de onde veio. Sob tunel rapido, "de onde
 *     veio" e literalmente a URL do quick tunnel -- que e o endereco publico da
 *     maquina do dono. Um unico recurso externo entrega essa URL a um terceiro
 *     que nunca foi convidado. `Referrer-Policy: no-referrer` mitiga, mas a
 *     unica forma de nao vazar e nao pedir.
 *
 * A garantia nao fica so na disciplina de quem escreve: a CSP servida com cada
 * pagina e `default-src 'none'`, o que faz o proprio navegador RECUSAR qualquer
 * carregamento externo que venha a ser introduzido aqui por engano. E
 * `test/unit/panel/html.test.ts` procura `http://`, `https://`, `//`,
 * `<script src=`, `@import` e `url(` no HTML servido.
 *
 * ------------------------------------------------------------------------
 * PORQUE `nonce` E NAO `'unsafe-inline'`
 * ------------------------------------------------------------------------
 * `script-src 'unsafe-inline'` autorizaria QUALQUER script inline, incluindo um
 * que um defeito futuro injetasse. Com nonce, so os blocos que ESTA funcao
 * escreveu correm. Custo: um valor aleatorio por resposta, o que torna o HTML
 * nao-determinista -- e por isso os testes comparam por forma, nao por igualdade
 * de ficheiro.
 *
 * ------------------------------------------------------------------------
 * OS ROTULOS EM PORTUGUES VIVEM AQUI, E SO AQUI (D7)
 * ------------------------------------------------------------------------
 * O vocabulario de estado e ingles em codigo, teste e payload IPC. "desligado",
 * "online" e companhia sao TEXTO DE INTERFACE. `src/contracts/tunnel.ts` e
 * explicito: eles existem apenas em `src/panel/**` e no bot. Um teste que
 * escrevesse o rotulo em vez de o importar daqui criaria a segunda fonte da
 * verdade que D7 existe para impedir.
 */
import type { ControlRecusa } from '../contracts/control.ts';
import type { TunnelState } from '../contracts/tunnel.ts';
export declare const PANEL_HTML_CONTENT_TYPE = "text/html; charset=utf-8";
/**
 * TEXTO DE INTERFACE. Ver a nota do cabecalho: nenhum outro ficheiro escreve
 * estas strings a mao -- quem precisa delas importa este mapa.
 */
export declare const TUNNEL_STATE_LABEL: Readonly<Record<TunnelState, string>>;
/**
 * TEXTO DE INTERFACE das recusas do controlador (D7: portugues vive aqui, e so
 * aqui). O payload da API transporta o CODIGO em ingles (`ControlRecusa`,
 * contrato congelado); quem o converte em frase legivel e esta mapa, embutido
 * na pagina. O botao de LIGAR cai aqui quando o controlador recusa -- modo
 * restrito ativo (CTL-015), nonce repetido ou expirado (CTL-021/022), estado
 * terminal (CTL-011) ou desligamento em curso (CTL-007/D29).
 */
export declare const CONTROL_RECUSA_LABEL: Readonly<Record<ControlRecusa, string>>;
/** Valor novo de nonce, em base64url (sem `/` e sem `+`, logo sem `//`). */
export declare function newNonce(): string;
/**
 * Escapa para contexto de TEXTO e de ATRIBUTO com aspas.
 *
 * `'` e `"` entram os dois porque a mesma funcao serve os dois contextos: uma
 * funcao "so para texto" e outra "so para atributo" e como se usa a errada.
 */
export declare function escapeHtml(value: string): string;
/**
 * Serializa um valor para dentro de um bloco `<script>`.
 *
 * `JSON.stringify` sozinho NAO chega: a sequencia de fecho do elemento dentro de
 * uma string JSON termina o bloco de script para o parser de HTML, que nao
 * conhece JSON. `U+2028`/`U+2029` sao terminadores de linha para o parser de
 * JavaScript e nao sao escapados pelo `JSON.stringify`.
 */
export declare function jsonForScript(value: unknown): string;
/**
 * Cabecalhos de toda resposta HTML do painel.
 *
 * `default-src 'none'` e a linha que torna a promessa "sem recurso externo"
 * EXECUTAVEL pelo navegador em vez de apenas prometida por quem escreveu o
 * ficheiro. `connect-src 'self'` existe porque o painel faz polling da propria
 * API; `form-action 'self'` impede que um defeito de HTML aponte um formulario
 * nosso para fora; `frame-ancestors 'none'` fecha clickjacking sobre um painel
 * que, na Onda 5, ganha botoes destrutivos.
 */
export declare function panelHtmlHeaders(nonce: string): Record<string, string>;
/**
 * O painel NAO leva a URL do tunel embutida no HTML, e isso e desenho e nao
 * acaso: (a) o HTML servido fica com ZERO ocorrencias de `https://`, o que torna
 * a asercao "nenhum recurso externo" verificavel por `grep` sem falso positivo;
 * (b) a URL entra no DOM por `textContent`, que nao interpreta marcacao --
 * interpolar a URL no HTML seria uma injecao a espera de um dia mau.
 *
 * OS BOTOES DE LIGA/DESLIGA SAO T5.3, e vivem aqui ao lado do `<meta>` com o
 * token anti-CSRF. O painel e SUPERFICIE: os botoes chamam
 * `POST /__guard/api/tunnel/start|stop` (com o nonce de confirmacao no
 * `start` e o token anti-CSRF em AMBOS -- NIST SP 800-63B-4 5.1.1), e o
 * controlador unico (T5.1) decide. O painel NAO decide nada: so projeta.
 *
 * A DESAMBIGUACAO ESCRITA NA TELA: "desligar o tunel" derruba a exposicao
 * publica (o processo do cloudflared) -- o DSH continua a funcionar em
 * loopback. Isto NAO desliga o worker do bot nem o DSH; essas duas acoes nao
 * sao este botao, e o texto diz isso com todas as letras.
 */
export declare function renderPanelPage(input: {
    readonly nonce: string;
    readonly csrfToken: string;
}): string;
/**
 * A pagina que o `GET /__guard/magic` serve.
 *
 * ELA NAO CONSOME NADA, e a razao esta no modo de falha e nao no gosto: um link
 * enviado por Telegram e PRE-CARREGADO pelo pre-visualizador do proprio
 * Telegram, por scanners de antiphishing e por clientes de e-mail. Se o `GET`
 * queimasse o `mk`, o link morria antes de o dono lhe tocar e ele veria "link
 * invalido" num link que nunca usou. O consumo e o `POST`, disparado por um
 * CLIQUE explicito -- e o clique e o unico sinal que distingue o dono de um
 * robo que segue hiperligacoes.
 *
 * O `mk` chega no FRAGMENTO (`#`), que o navegador NAO envia ao servidor: por
 * isso esta pagina nao o recebe do lado do servidor e tem de o ler do
 * `location.hash`. E tambem por isso o `mk` nunca aparece num log de servidor
 * nem num `Referer`.
 */
export declare function renderMagicPage(input: {
    readonly nonce: string;
    readonly magicCsrf: string;
    readonly loginCsrf: string;
}): string;
/**
 * A pagina de `GET /__guard/secret?ott=<token>`.
 *
 * `secretPanel` e a saida de `renderSecretPanel()` de T2.1: o segredo agrupado
 * MAIS o QR, na mesma tela. Nao se remonta nada aqui -- o agrupamento e a
 * polaridade do QR sao decisoes daquele modulo, e duplicar o desenho era ficar
 * com duas telas que divergem.
 *
 * O `<pre>` tem fundo PRETO de proposito: `renderQrAscii` desenha para fundo
 * escuro por omissao (o glifo claro e o modulo claro). Sobre fundo branco a
 * polaridade inverte e muitos leitores de QR deixam de ler.
 *
 * SEM `<script>` COM DADOS: o segredo entra por texto escapado e mais nada. Ele
 * aparece nesta resposta HTTP e em sitio nenhum alem dela -- nem em log, nem em
 * mensagem de erro, nem em rasto de pilha.
 */
export declare function renderSecretPage(input: {
    readonly nonce: string;
    readonly secretPanel: string;
}): string;
//# sourceMappingURL=html.d.ts.map