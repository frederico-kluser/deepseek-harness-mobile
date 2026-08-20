/**
 * FONTE: @deepseek-ai/dsh-subprocess-local@0.1.0-rc.7, package/lib/types/index.d.ts
 * VERIFICADO EM: 2026-08-20 por T0.1 (Onda 0, spike da API real do DSH)
 * DIVERGENCIAS DELIBERADAS: nenhuma -- copia byte-a-byte do tarball publicado.
 * TARBALL: https://registry.npmjs.org/@deepseek-ai/dsh-subprocess-local/-/dsh-subprocess-local-0.1.0-rc.7.tgz
 * SHA256 : ce00c135e16ef8237f2027a677b71b0c21b5081a07eb6b671c95e78f9742c67f
 * FAIXA SUPORTADA: @deepseek-ai/dsh 0.1.0-rc.7 .. rc.9 (06-REPO-E-CI.md). Regenerar: `pnpm types:fetch`.
 * NAO EDITAR A MAO: tudo abaixo desta linha e o que o pacote publicou (regra Q-1).
 */
/**
 * Local Service Provider for the subprocess capability seam. Each spawn is a detached
 * process tree with the spec's per-stream stdio dispositions. Normal disposal
 * terminates and joins live trees; Node's synchronous exit phase force-stops
 * any trees the service still owns. It has no config: every disposition and
 * limit arrives on the spec, so the deployment-varying choices stay with the
 * caller's config (the bash executor's, the LSP host's, …).
 * @module @deepseek-ai/dsh-subprocess-local
 */
import { Context } from '@deepseek-ai/cordis';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import type { SubprocessHandle, SubprocessSpawnSpec, SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess';
import type { SpawnInternals } from './spawn.ts';
import type { ProcessInspector } from './process-inspector.ts';
/**
 * Local subprocess service: detached process trees, Node-shaped stdio
 * dispositions (raw pipes, inherit, bounded tail-keep collection with spill
 * files), credential-scrubbed environment, and tree-scoped signalling with
 * SIGTERM→grace→SIGKILL escalation, plus synchronous final termination during
 * JavaScript-observable host exit.
 */
export declare class LocalSubprocessRuntime extends SubprocessRuntime {
    /** Live handles retained for normal disposal and synchronous host-exit finalization. */
    private live;
    /** Live terminals retained through normal quiescence or host-exit finalization. */
    private terminals;
    /** Test hook: spill and platform knobs forwarded to spawnSubprocess. */
    internals: SpawnInternals;
    /** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
    terminalInspector: ProcessInspector | undefined;
    constructor(ctx: Context);
    private terminateForHostExit;
    private disposeManagedProcesses;
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    private executableCandidates;
    spawn(spec: SubprocessSpawnSpec): SubprocessHandle;
    spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle>;
}
export default LocalSubprocessRuntime;
//# sourceMappingURL=index.d.ts.map