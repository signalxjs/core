/**
 * The ONE resolver behind every endpoint entry (rfc-server-v5 §1.6): the
 * WinterCG handler, `createServerApp().serverFns()`, the Node adapter and the
 * Vite dev middleware all hand their `functions` registry (or `resolve`
 * escape hatch) here, so the own-property + callable guard (#555) and the
 * version read live in one place instead of three.
 */

import type { ServerFnRegistry } from '../types';

/** What the endpoint gets back for a key: the wrapped function and, when a
 *  registry answered, the build's version tag for it. */
export interface ResolvedServerFn {
    fn: unknown;
    /** Absent through the `resolve` escape hatch — no skew detection there. */
    version?: string;
}

export type ServerFnResolver = (key: string) => Promise<ResolvedServerFn | null>;

/** The two ways an endpoint learns its functions — exactly one is required. */
export interface ServerFnResolverOptions {
    functions?: ServerFnRegistry;
    resolve?(key: string): unknown | Promise<unknown>;
}

/**
 * Build the resolver. Throws at CONSTRUCTION (mount / handler creation, or
 * the first `handleServerFnRequest` call) when both or neither of
 * `functions` / `resolve` is given — a misconfiguration is a boot failure,
 * never a per-request 500.
 *
 * Registry path: own-property + shape checks so `POST …/__proto__` or
 * `…/constructor` is a structured 404, not a TypeError out of
 * `Object.prototype` (`hasOwnProperty.call`, not `Object.hasOwn`: the
 * package builds against the ES2020 lib). A throwing `load()` propagates —
 * the endpoint masks it per §5 like any resolve failure.
 */
export function createServerFnResolver(options: ServerFnResolverOptions): ServerFnResolver {
    // `null` is absent (a JSON-shaped config, an optional-chained import
    // that missed), never "provided": it would pass the exactly-one gate and
    // then throw inside `hasOwnProperty.call` on the first request.
    const functions = options.functions ?? undefined;
    const resolve = options.resolve ?? undefined;
    if ((functions === undefined) === (resolve === undefined)) {
        throw new Error(
            functions === undefined
                ? '[sigx server] the endpoint needs its functions: pass `functions` (the ' +
                  "`serverFns` export of 'virtual:sigx-server-fns') or a `resolve(key)` callback."
                : '[sigx server] pass EITHER `functions` OR `resolve` to the endpoint, not both — ' +
                  'two sources of truth for one route table cannot agree by construction.'
        );
    }
    if (functions !== undefined && (typeof functions !== 'object' || functions === null)) {
        throw new TypeError(
            `[sigx server] \`functions\` must be the registry object (key → { version, load }); ` +
            `got ${typeof functions}.`
        );
    }
    if (typeof resolve === 'function') {
        return async (key) => {
            const fn = await resolve(key);
            return fn === null || fn === undefined ? null : { fn };
        };
    }
    const registry = functions!;
    return async (key) => {
        if (!Object.prototype.hasOwnProperty.call(registry, key)) return null;
        const entry = registry[key] as unknown;
        if (typeof entry !== 'object' || entry === null) return null;
        const { load, version } = entry as { load?: unknown; version?: unknown };
        if (typeof load !== 'function') return null;
        const fn = await (load as () => unknown)();
        if (fn === null || fn === undefined) return null;
        return typeof version === 'string' ? { fn, version } : { fn };
    };
}
