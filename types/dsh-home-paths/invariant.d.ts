/**
 * FONTE: @deepseek-ai/dsh-home-paths@0.1.1-rc.1, package/lib/types/invariant.d.ts
 * VERIFICADO EM: 2026-08-20 por T0.1 (Onda 0, spike da API real do DSH)
 * DIVERGENCIAS DELIBERADAS: nenhuma -- copia byte-a-byte do tarball publicado.
 * TARBALL: https://registry.npmjs.org/@deepseek-ai/dsh-home-paths/-/dsh-home-paths-0.1.1-rc.1.tgz
 * SHA256 : 4d31051c845b7ca97b3830d263b1be1fc7c8466753c91ae456c802b3c9994e9c
 * FAIXA SUPORTADA: @deepseek-ai/dsh 0.1.0-rc.7 .. 0.1.1-rc.1 (06-REPO-E-CI.md). Regenerar: `pnpm types:fetch`.
 * NAO EDITAR A MAO: tudo abaixo desta linha e o que o pacote publicou (regra Q-1).
 */
/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-home-paths`.
 * @module @deepseek-ai/dsh-home-paths/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "home-paths-invariant";
/** Service required before the companion can reserve package ownership. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map