/**
 * Shared server-function types — split from index.ts so the WinterCG request
 * handler (`./server`) can import them without pulling the marker module in.
 */
import type { ServerFnContext } from './context';

/** Identity of the function being invoked, as the transports know it. */
export interface ServerFnInfo {
    /**
     * The content-hashed transport symbol (`<name>_fn_<hash8>`). Empty on
     * in-process calls — the symbol exists only where a transport does.
     */
    symbol: string;
    /** The export name of the function. */
    name: string;
}

/**
 * Guard/middleware: veto by throwing (a `ServerFnError` sets the response
 * status); hand results downstream via `rq.locals`.
 */
export type ServerFnGuard = (rq: ServerFnContext, fn: ServerFnInfo) => void | Promise<void>;

/**
 * The full invocation pipeline (`use` guards → `input` validation → handler)
 * stamped on every wrapped function as `__sigxFn`. Transports call this with
 * a live context; the public callable wraps it with a detached one.
 */
export type ServerFnInvoke = (
    rq: ServerFnContext,
    info: ServerFnInfo,
    args: unknown[]
) => Promise<unknown>;

/** A wrapped server function, as transports and registries see it. */
export interface WrappedServerFn {
    __sigxFn: ServerFnInvoke;
    __sigxName: string;
    /**
     * Present (true) on `serverStream` wrappers: `__sigxFn` resolves to an
     * AsyncGenerator and the endpoint streams NDJSON instead of buffering a
     * JSON envelope (rfc-server §6.1).
     */
    __sigxStream?: boolean;
    /**
     * Present when the options form declared `invalidates` (rfc-server
     * §6.2): VALIDATED input (stashed on the request context by the
     * pipeline) + settled result → cache keys the endpoint attaches to the
     * envelope as `$cache.invalidates`.
     */
    __sigxInvalidates?(
        input: unknown,
        result: unknown
    ):
        | ReadonlyArray<string | readonly unknown[]>
        | Promise<ReadonlyArray<string | readonly unknown[]>>;
}

/**
 * Minimal structural typing of the Standard Schema spec
 * (https://standardschema.dev — the interface Zod/Valibot/ArkType all
 * implement). Type-only: validating is calling `~standard.validate`, so no
 * runtime dependency is taken on any validator library.
 */
export interface StandardSchemaV1<Output = unknown> {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        validate(
            value: unknown
        ): StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    };
}

export type StandardSchemaResult<Output> =
    | { value: Output; issues?: undefined }
    | { issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<PropertyKey | { key: PropertyKey }> }> };
