/**
 * FONTE: @deepseek-ai/cordis@4.0.1, package/lib/types/utils.d.ts
 * VERIFICADO EM: 2026-08-20 por T0.1 (Onda 0, spike da API real do DSH)
 * DIVERGENCIAS DELIBERADAS: nenhuma -- copia byte-a-byte do tarball publicado.
 * TARBALL: https://registry.npmjs.org/@deepseek-ai/cordis/-/cordis-4.0.1.tgz
 * SHA256 : 31e96b8e13d5c55bfd4316c08ac8925510e0eed86d48a3a9cc86046623074613
 * FAIXA SUPORTADA: @deepseek-ai/dsh 0.1.0-rc.7 .. rc.9 (06-REPO-E-CI.md). Regenerar: `pnpm types:fetch`.
 * NAO EDITAR A MAO: tudo abaixo desta linha e o que o pacote publicou (regra Q-1).
 */
import type { Context, Service } from './index.ts';
/** Ordered collection of disposable values with O(1) deletion by value. */
export declare class DisposableList<T extends WeakKey> {
    private sn;
    private map;
    private weak;
    get length(): number;
    push(value: T): () => boolean;
    delete(value: T): boolean;
    clear(): T[];
    [Symbol.iterator](): MapIterator<T>;
}
/** Metadata used by traceable proxies to rebind `ctx` and associated services. */
export interface Tracker {
    associate?: string;
    property?: string;
    noShadow?: boolean;
}
/** Shared symbols used to avoid public property-name collisions. */
export declare const symbols: {
    shadow: symbol;
    receiver: symbol;
    original: symbol;
    metadata: symbol;
    initHooks: symbol;
    checkProto: symbol;
    effect: typeof Context.effect;
    filter: typeof Context.filter;
    isolate: typeof Context.isolate;
    intercept: typeof Context.intercept;
    init: typeof Service.init;
    check: typeof Service.check;
    config: typeof Service.config;
    invoke: typeof Service.invoke;
    extend: typeof Service.extend;
    tracker: typeof Service.tracker;
    resolveConfig: typeof Service.resolveConfig;
};
/** Return true when a plugin callback should be constructed with `new`. */
export declare function isConstructor(func: any): func is new (...args: any) => any;
/** Merge two prototype chains while preserving descriptors from `proto1`. */
export declare function joinPrototype(proto1: {}, proto2: {}): any;
/** Return true for non-null objects and functions. */
export declare function isObject(value: any): value is {};
/** Find a property descriptor by walking an object's prototype chain. */
export declare function getPropertyDescriptor(target: any, prop: string | symbol): TypedPropertyDescriptor<any> | undefined;
/** Wrap services/functions so method calls see the caller's active context. */
export declare function getTraceable<T>(ctx: Context, value: T): T;
/** Return a proxy that overlays readonly or writable properties onto a target. */
export declare function withProps(target: any, props?: {}): any;
/** Create a callable service object that dispatches through `symbols.invoke`. */
export declare function createCallable(name: string, proto: {}, tracker: Tracker): any;
interface StackInfo {
    offset: number;
    error: Error;
}
/** Run a callback and splice outer call-site frames into thrown async errors. */
export declare function composeError<T>(callback: (info: StackInfo) => T, getOuterStack?: () => string[]): T;
/** Capture a lazy stack-frame supplier for later error composition. */
export declare function buildOuterStack(offset?: number): () => string[];
export {};
//# sourceMappingURL=utils.d.ts.map