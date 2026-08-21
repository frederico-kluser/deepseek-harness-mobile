/**
 * FONTE: @deepseek-ai/dsh-host-frontend-static@0.1.1-rc.1, package/lib/types/invariant.d.ts
 * VERIFICADO EM: 2026-08-20 por T0.1 (Onda 0, spike da API real do DSH)
 * DIVERGENCIAS DELIBERADAS: nenhuma -- copia byte-a-byte do tarball publicado.
 * TARBALL: https://registry.npmjs.org/@deepseek-ai/dsh-host-frontend-static/-/dsh-host-frontend-static-0.1.1-rc.1.tgz
 * SHA256 : fd29723bfb8f214ec258c386ecf10256791d289901af2348ef41c0b19f8bba4e
 * FAIXA SUPORTADA: @deepseek-ai/dsh 0.1.0-rc.7 .. 0.1.1-rc.1 (06-REPO-E-CI.md). Regenerar: `pnpm types:fetch`.
 * NAO EDITAR A MAO: tudo abaixo desta linha e o que o pacote publicou (regra Q-1).
 */
/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-frontend-static`.
 * @module @deepseek-ai/dsh-host-frontend-static/invariant
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis companion plugin name. */
export declare const name = "host-frontend-static-invariant";
/** Service required before the companion can register. */
export declare const inject: string[];
/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export declare const apply: (ctx: Context) => Promise<() => void>;
//# sourceMappingURL=invariant.d.ts.map