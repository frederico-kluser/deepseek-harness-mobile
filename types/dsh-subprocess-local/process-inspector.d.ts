/**
 * FONTE: @deepseek-ai/dsh-subprocess-local@0.1.1-rc.1, package/lib/types/process-inspector.d.ts
 * VERIFICADO EM: 2026-08-20 por T0.1 (Onda 0, spike da API real do DSH)
 * DIVERGENCIAS DELIBERADAS: nenhuma -- copia byte-a-byte do tarball publicado.
 * TARBALL: https://registry.npmjs.org/@deepseek-ai/dsh-subprocess-local/-/dsh-subprocess-local-0.1.1-rc.1.tgz
 * SHA256 : 46a7d2429ae04aed56f5bdebff1a5c1d6cdf1e25b6ac2eeea52f5ab151de7502
 * FAIXA SUPORTADA: @deepseek-ai/dsh 0.1.0-rc.7 .. 0.1.1-rc.1 (06-REPO-E-CI.md). Regenerar: `pnpm types:fetch`.
 * NAO EDITAR A MAO: tudo abaixo desta linha e o que o pacote publicou (regra Q-1).
 */
/** Platform process-table inspection for terminal readiness, signals, and teardown. */
import type { SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess';
/** PID plus start identity, preventing teardown escalation after PID reuse. */
export interface ProcessIdentity {
    pid: number;
    started: string;
}
/** Injectable OS process operations used by one local PTY session. */
export interface ProcessInspector {
    foregroundPgid(shellPid: number): number | undefined;
    isStdinWaiting(pgid: number): boolean;
    /** Return the root and its current transitive descendants, children first. */
    processTree(rootPid: number): ProcessIdentity[];
    /** Return current members of one POSIX process session when the platform exposes them. */
    processSession(sessionId: number): ProcessIdentity[];
    /** Return whether the exact identity remains a non-quiescent process. */
    isAlive(identity: ProcessIdentity): boolean;
    signalGroup(pgid: number, signal: SubprocessTerminalSignal): void;
    signalProcess(identity: ProcessIdentity, signal: 'SIGTERM' | 'SIGKILL'): void;
}
/** Testable boundary around filesystem, process-table, and signal syscalls. */
export interface ProcessInspectorInternals {
    readFile(path: string): string;
    readDir(path: string): string[];
    open(path: string): number;
    read(fd: number, buffer: Buffer, length: number, position: number): number;
    close(fd: number): void;
    exec(file: string, args: string[]): string;
    kill(pid: number, signal: NodeJS.Signals): void;
}
interface ProcStat {
    pid: number;
    parentPid: number;
    pgrp: number;
    session: number;
    state: string;
    tpgid: number;
    started: string;
}
/**
 * Parse fields used from Linux `/proc/<pid>/stat`, including parenthesized comm text.
 * @param text - complete stat line.
 * @returns Parsed identity/group fields, or undefined for malformed input.
 */
export declare function parseProcStat(text: string): ProcStat | undefined;
/**
 * Report whether a Linux process group has an executing member. `false`
 * means the group contains only zombie/dead entries; `undefined` means the
 * process table could not prove either outcome.
 * @param processGroupId - POSIX process-group id to inspect.
 * @param internals - injectable process-table operations.
 * @returns Live-member presence, or `undefined` when unavailable/absent.
 */
export declare function linuxProcessGroupHasLiveMembers(processGroupId: number, internals?: ProcessInspectorInternals): boolean | undefined;
/**
 * Create the supported platform inspector or fail at plugin load.
 * @param platform - target Node platform.
 * @param arch - target CPU architecture for Linux syscall numbers.
 * @param internals - filesystem/process boundary, injectable for deterministic tests.
 * @returns Platform process inspector.
 */
export declare function createProcessInspector(platform?: NodeJS.Platform, arch?: NodeJS.Architecture, internals?: ProcessInspectorInternals): ProcessInspector;
export {};
//# sourceMappingURL=process-inspector.d.ts.map