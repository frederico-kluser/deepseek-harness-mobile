/**
 * O estado do BOT de mensageria da superficie de UI nativa do DSH —
 * OFFLINE/ONLINE — e as instrucoes que o clique mostra.
 *
 * PROVEDOR-AGNOSTICO: este modulo nao conhece o provedor ativo (telegram hoje,
 * outros no futuro) — recebe apenas boleanos (token configurado, pareamento) e
 * devolve `online`+`motivo`. A costura em `src/index.ts` resolve o token do
 * provedor ativo e passa-a aqui sob a forma de boleano. Este ficheiro foi
 * extirpado do nome que tinha na antiga pasta `src/ui-contrib/` (estado
 * do "Telegram") para `bot-state.ts` no desacoplamento do bot -> provedores
 * (Onda 5b).
 *
 * REGRA DO DONO: o estado reflete o que esta EM DISCO, nunca uma rede `getMe`:
 *
 *   ONLINE  sse (token configurado) E (pareamento feito).
 *   OFFLINE caso contrario, com o motivo aproximado.
 *
 * Token configurado = `config.worker.token` nao-vazio OU `secrets.env` presente
 * (a costura em `src/index.ts` decid-e-o). Pareamento feito = `pairing` com dono
 * no `state.json`.
 *
 * O SEGREDO NUNCA ENTRA NESTE MODULO: a derivacao recebe so boleanos
 * (`tokenConfigurado`) e a presenca de `pairing` — o valor do token e o codigo
 * de pareamento ficam onde estao (disco/CLI). A UI so ve `online`+`motivo`, e o
 * clique devolve TEXTO DE INSTRUCOES SEM NUMEROS NEM CHAVES (`/parear <codigo>`
 * mostra um espaco reservado, NAO o codigo real — o codigo so o CLI o exibe).
 *
 * A derivacao e PURA e exportada para que os tres estados e a ausencia de
 * vazaamento sejam verificaveis sem host, sem rede e sem disco.
 */
/** O comando de terminal que o ecra mostra (o mesmo que `bin/dsh-guard-setup`). */
export declare const COMANDO_CLI = "dsh-guard-setup";
/** O comando que se envia dentro da conversa com o bot. */
export declare const COMANDO_DE_PAREAMENTO = "/parear";
/** O motivo OFFLINE. `sem-chave` = ainda nao ha token configurado. */
export type MotivoDoBot = 'sem-chave' | 'sem-pareamento';
/** O estado que a superficie expoe. Nenhum segredo aqui. */
export type BotEstado = 
/** Online: token configurado E pareamento feito. */
{
    readonly online: true;
    readonly handle?: string | undefined;
}
/** Offline: falta configurar a chave ou parear. */
 | {
    readonly online: false;
    readonly motivo: MotivoDoBot;
};
export interface DerivarBotInput {
    /** `true` sse ha token configurado (config.worker.token ou secrets.env). */
    readonly tokenConfigurado: boolean;
    /** O `pairing` do `state.json`; `undefined` = pareamento por fazer. Os eixos sao STRING (V2 — EMENDA ONDA-1-IPC-ENVELOPE-STRING); so a PRESENCA importa aqui. */
    readonly pairing: {
        readonly ownerUserId: string;
        readonly ownerChatId: string;
        readonly pairedAt: number;
    } | undefined;
}
/**
 * A FUNCAO DE DECISAO. PURA e o coracao das perguntas falsificaveis:
 *  - sem token (pareado ou nao) -> OFFLINE `sem-chave`;
 *  - token presente, sem dono    -> OFFLINE `sem-pareamento`;
 *  - token E dono                -> ONLINE.
 * O `handle` (o `@` do bot) NAO se deriva do disco: o username so o `getMe`
 * sabe, e este modulo nao fala com a rede. Quando algum dia existir, e um campo
 * opcional preenchido pela costura.
 */
export declare function derivarEstadoDoBot(input: DerivarBotInput): BotEstado;
export interface Passo {
    readonly titulo: string;
    readonly texto: string;
}
/**
 * O TEXTO que o clique mostra. `sem-chave` e `sem-pareamento` recebem os
 * quatro passos para ligar o bot (estao quase sempre ambos em falta); `online`
 * recebe as dicas de como usar. NENHUM segredo aqui: nem a chave, nem o codigo
 * de pareamento real (o espaco reservado `/<codigo>` diz ao dono que o numero
 * sai no terminal, nao aqui).
 */
export declare function passosDoBot(estado: BotEstado): ReadonlyArray<Passo>;
/** Ligar um bot do Telegram, passo a passo — sem segredo nenhum. */
export declare const PASSOS_DO_CONECTOR: ReadonlyArray<Passo>;
/** Deixar este modulo sem uma rota de uso nao faz sentido: dicas de uso no ON. */
export declare const PASSOS_DE_USO: ReadonlyArray<Passo>;
//# sourceMappingURL=bot-state.d.ts.map