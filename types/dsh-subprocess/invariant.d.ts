/**
 * FONTE: @deepseek-ai/dsh-subprocess@0.1.1-rc.1, package/lib/types/invariant.d.ts
 * VERIFICADO EM: 2026-08-20 por T0.1 (Onda 0, spike da API real do DSH)
 * DIVERGENCIAS DELIBERADAS: nenhuma -- copia byte-a-byte do tarball publicado.
 * TARBALL: https://registry.npmjs.org/@deepseek-ai/dsh-subprocess/-/dsh-subprocess-0.1.1-rc.1.tgz
 * SHA256 : d68176f0cdd29fe0bf033d213d483d044df534cc21b747e374ec310a1e557b78
 * FAIXA SUPORTADA: @deepseek-ai/dsh 0.1.0-rc.7 .. 0.1.1-rc.1 (06-REPO-E-CI.md). Regenerar: `pnpm types:fetch`.
 * NAO EDITAR A MAO: tudo abaixo desta linha e o que o pacote publicou (regra Q-1).
 */
/** Package-owned invariant companion for the subprocess seam. @module @deepseek-ai/dsh-subprocess/invariant */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "subprocess-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register the subprocess invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map