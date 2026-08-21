/**
 * FONTE: @deepseek-ai/dsh-host-frontend-static@0.1.1-rc.1, package/lib/types/index.d.ts
 * VERIFICADO EM: 2026-08-20 por T0.1 (Onda 0, spike da API real do DSH)
 * DIVERGENCIAS DELIBERADAS: nenhuma -- copia byte-a-byte do tarball publicado.
 * TARBALL: https://registry.npmjs.org/@deepseek-ai/dsh-host-frontend-static/-/dsh-host-frontend-static-0.1.1-rc.1.tgz
 * SHA256 : fd29723bfb8f214ec258c386ecf10256791d289901af2348ef41c0b19f8bba4e
 * FAIXA SUPORTADA: @deepseek-ai/dsh 0.1.0-rc.7 .. 0.1.1-rc.1 (06-REPO-E-CI.md). Regenerar: `pnpm types:fetch`.
 * NAO EDITAR A MAO: tudo abaixo desta linha e o que o pacote publicou (regra Q-1).
 */
/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index
 * entry points. A readable index renders at the dist root and configured index
 * path; missing paths return 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every
 * index response runs through the webserver's index render (structured
 * injection rows, then raw taps). The dist location is workspace knowledge of
 * the composing application, so `distIndex` is typically supplied through a
 * `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */
import type { ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Stable Cordis plugin name. */
export declare const name = "frontend-static";
/** Service required before the fallback seat can be claimed. */
export declare const inject: string[];
/** Plugin config: the dist anchor. */
export interface Config {
    /** Absolute path of index.html inside the dist root. */
    distIndex: string;
}
export declare const Config: z<Config>;
/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 */
export declare function serveStatic(pathname: string, res: ServerResponse, distRoot: string, distIndex: string, renderIndex: () => Promise<string>): Promise<void>;
/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map