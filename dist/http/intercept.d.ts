/**
 * =============================================================================
 * A BARREIRA: troca de dono do despacho no `node:http.Server` do `webServer`.
 * =============================================================================
 *
 * PORQUE NAO `ctx.intercept('webServer', { register, registerFallback, ... })`,
 * que era o que este ficheiro deveria fiar segundo o plano: porque
 * `ctx.intercept` NAO envolve metodos de servico. O corpo publicado
 * (`cordis@4.0.1`, `src/context.ts:141-145`) e
 *
 *     intercept(name, config) {
 *       const intercept = Object.create(this[symbols.intercept])
 *       intercept[name] = config
 *       return this.extend({ [symbols.intercept]: intercept })
 *     }
 *
 * -- FUSAO DE CONFIGURACAO por servico, herdada pelos plugins carregados abaixo.
 * A sobrecarga `intercept(name: string, config: any): this` fazia a chamada
 * errada COMPILAR EM SILENCIO. Pior: `grep -c resolveConfig` no `lib/index.js`
 * publicado do `webServer` devolve 0 -- para este servico a config de intercept
 * e inerte ate como config. Medido: passou-se um `register` que lanca se for
 * chamado; nunca e chamado, e `/api/state` responde 200.
 *
 * O MECANISMO QUE FUNCIONA (S12, medido: 35 assercoes, 7 rotas reais
 * 200 -> 401 -> 200 atraves do disposer; referencia executavel em
 * `scripts/spike/intercept/barreira.mjs`):
 *
 *   1. resolver o `node:http.Server` interno (`src/dsh/adapter.ts`);
 *   2. capturar `listeners('request')` e `listeners('upgrade')`;
 *   3. `removeAllListeners` e instalar UM listener de cada que DECIDE e so entao
 *      DELEGA aos capturados;
 *   4. disposer SINCRONO que reinstala exatamente os originais.
 *
 * PORQUE COBRE OS TRES CAMINHOS: o roteador do `WebServer` (`match()` ->
 * `fallback`) e a tabela de `upgrades` vivem TODOS por baixo destes dois
 * listeners. Guardar o listener guarda `register` (exact e prefix),
 * `registerFallback` e `registerUpgrade` de uma so vez, sem conhecer rota
 * nenhuma -- e por isso guarda tambem as rotas registadas DEPOIS da instalacao.
 *
 * PORQUE NAO HA EXIGENCIA DE ORDEM DE CARREGAMENTO: o `EventEmitter` resolve a
 * lista de listeners a CADA evento e as rotas vivem nas tabelas por baixo.
 * Instalar depois de toda a gente ja ter registado funciona na mesma. Isso
 * importa porque `dsh-base@0.1.0-rc.7/cordis.patch.yml:12-13` diz literalmente
 * "Row order carries no load semantics".
 *
 * PORQUE NAO `prependListener`: o `EventEmitter` do Node NAO TEM VETO -- um
 * listener prepended corre primeiro mas nao impede os seguintes. Para BLOQUEAR e
 * preciso ser o dono do despacho.
 * =============================================================================
 */
import type { Server } from 'node:http';
import type { WebRequestHandler, WebUpgradeHandler } from '../dsh/adapter.ts';
import type { GuardLogger } from '../logging/logger.ts';
/**
 * Marca de posse gravada nos listeners instalados.
 *
 * `Symbol.for` (registo global) e nao `Symbol()`: duas copias deste modulo
 * carregadas por caminhos diferentes tem de reconhecer a marca uma da outra --
 * caso contrario a recusa de empilhamento nao funciona exatamente no cenario em
 * que e precisa.
 */
export declare const BARRIER_OWNER_MARK: unique symbol;
/** Os dois envelopes de politica que a barreira instala. */
export interface BarrierWrappers {
    /** Recebe o despacho original de `request` e devolve o despacho guardado. */
    wrapRequest(delegate: WebRequestHandler): WebRequestHandler;
    /** Recebe o despacho original de `upgrade` e devolve o despacho guardado. */
    wrapUpgrade(delegate: WebUpgradeHandler): WebUpgradeHandler;
}
/**
 * Instala a barreira. SINCRONA, e o disposer devolvido tambem e sincrono.
 *
 * REGRA Q-2 vs. o host: `Fiber.effect` documenta que os disposers "may be async,
 * in which case unloading awaits them". Este projeto NAO usa essa tolerancia --
 * o disposer e sincrono por regra (05-QUALIDADE-CODIGO.md Q-2), porque a ordem
 * LIFO sem intercalar microtasks e o que impede uma Fiber PENDING de instalar
 * uma segunda barreira antes de a primeira ter saido. A divergencia esta
 * registada, nao silenciada.
 *
 * @throws {GuardError} `BARRIER_UNAVAILABLE` se o servidor nao tiver despacho de
 * `request` (o `WebServer` ainda nao inicializou) -- nunca degradar para "sem
 * barreira".
 * @throws {GuardError} `BARRIER_ALREADY_INSTALLED` se ja houver uma barreira.
 */
export declare function installAuthBarrier(server: Server, wrappers: BarrierWrappers, log: GuardLogger): () => void;
//# sourceMappingURL=intercept.d.ts.map