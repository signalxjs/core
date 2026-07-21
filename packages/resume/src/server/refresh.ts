/**
 * Single-flight boundary refresh — the server half (rfc-server §6.3, #313).
 *
 * A mutation server function can name boundaries to refresh; the endpoint
 * (rfc-server's `renderBoundaries` option) hands the client's boundary
 * descriptors to the implementation this factory returns. Each descriptor is
 * re-rendered through the SAME machinery as the original request — the SSR
 * instance's plugin set (resume's tracking-signal capture included), a fresh
 * per-request context — and comes back as `{for, id, html, state, records}`:
 * fresh HTML for the DOM swap plus the re-render's boundary-table patch.
 *
 * Ids: a re-render context starts its component-id counter at a client-chosen
 * floor (`base`), never 0 — the fresh HTML's `<!--$c:N-->` markers and
 * `data-sigx-b` ids must not collide with ids already live on the page.
 * Successive descriptors continue above the previous render's highest
 * emitted marker.
 *
 * Failure posture: a refresh is an optimization riding a mutation that
 * already succeeded — nothing here ever throws outward. A descriptor that
 * cannot be re-rendered (unknown component, lossy snapshot, render throw) is
 * simply omitted from the result; the client converges through `$cache`
 * invalidation instead.
 *
 * @example
 * ```ts
 * import { createBoundaryRefresh } from '@sigx/resume/server';
 *
 * const renderBoundaries = createBoundaryRefresh({
 *     ssr,                                  // the instance with resumePlugin()
 *     components: { Tracker, Cart }         // __resumeId → server component
 * });
 * // pass as handleServerFnRequest({ ..., renderBoundaries })
 * ```
 */

import type { SSRInstance, SSRBoundaryRecord } from '@sigx/server-renderer';
import { renderVNodeToString, getTypeHandlers } from '@sigx/server-renderer/server';
import { jsx } from 'sigx';
import type { App, AppContext, JSXElement } from 'sigx';
import { encodeWithHandlers, reviveWithHandlers } from 'sigx/internals';

/** One boundary the client asks to have re-rendered (untrusted input). */
export interface BoundaryRefreshRequest {
    /** The boundary's id on the live page. */
    id: number;
    /** The component registry key (`record.component`, the transform's `__resumeId`). */
    component: string;
    /** The record's props snapshot, verbatim in encoded (wire) form. */
    props?: Record<string, unknown>;
}

/** One re-rendered boundary in the response envelope's `$boundaries`. */
export interface BoundaryRefreshEntry {
    /** The page boundary this entry replaces. */
    for: number;
    /** The fresh render's root boundary id (its marker id in `html`). */
    id: number;
    /** The boundary's fresh HTML, trailing `<!--$c:id-->` marker included. */
    html: string;
    /** The root record's captured signal state, encoded — the upgraded-path fast lane. */
    state?: Record<string, unknown>;
    /** The re-render's full boundary-table patch (nested boundaries included), encoded. */
    records: Record<number, unknown>;
}

export interface BoundaryRefreshOptions {
    /** The SSR instance with the app's plugins registered (resumePlugin at least). */
    ssr: SSRInstance;
    /**
     * Registry-key → server component. Values may be the component factory
     * itself or a lazy loader (`() => import(...)` resolving to the factory
     * or a module whose default/named export is the factory). Explicitly
     * passed, never ambient — the same posture as the server-fn registry.
     */
    components: Record<string, unknown>;
    /**
     * Per-call app for DI: type handlers (`provideTypeHandlers`) and other
     * app-level provides the re-render should see. Receives whatever context
     * argument the endpoint passes through (the `ServerFnContext` when riding
     * rfc-server's `renderBoundaries` option).
     */
    app?: (rq?: unknown) => App | Promise<App>;
}

/**
 * Room left for one re-render's component ids before the next descriptor's
 * range starts — a floor, not a cap: the walk below advances past the highest
 * marker actually emitted, so bigger subtrees just consume more range.
 */
const MIN_ID_STRIDE = 4096;

const MARKER_RE = /<!--\$c:(\d+)-->/g;

/** The highest `<!--$c:N-->` id in a rendered chunk, or `fallback` when none. */
function highestMarkerId(html: string, fallback: number): number {
    let max = fallback;
    for (const match of html.matchAll(MARKER_RE)) {
        const id = parseInt(match[1], 10);
        if (id > max) max = id;
    }
    return max;
}

/** Resolve a registry value to a component factory, or null. */
async function resolveComponent(value: unknown, key: string): Promise<Function | null> {
    if (typeof value !== 'function') return null;
    // A stamped factory is the component itself; any other function is a
    // lazy loader — await it and unwrap module shapes.
    if ((value as { __resumeId?: string }).__resumeId) return value as Function;
    const loaded = await (value as () => unknown)();
    const module = loaded as Record<string, unknown> | Function | null;
    const candidate =
        typeof module === 'function'
            ? module
            : ((module?.[key] ?? (module as Record<string, unknown>)?.default) as unknown);
    if (typeof candidate === 'function' && (candidate as { __resumeId?: string }).__resumeId) {
        return candidate as Function;
    }
    return null;
}

/**
 * Build a `renderBoundaries` implementation from an SSR instance and an
 * explicit component registry. The returned function is the policy half of
 * rfc-server §6.3: it re-renders each admitted descriptor in an isolated,
 * id-seeded context and encodes the results for the envelope. Descriptors it
 * declines are omitted (never an error — the mutation already succeeded).
 *
 * Trust model: descriptors are client-controlled. The endpoint has already
 * filtered them to the mutation's `refreshes` allowlist; this side re-checks
 * that the registry knows the key and that the re-rendered record itself is
 * refreshable (a smuggled `children` prop, say, turns the re-render lossy
 * and it declines).
 */
export function createBoundaryRefresh(
    options: BoundaryRefreshOptions
): (
    requests: ReadonlyArray<BoundaryRefreshRequest>,
    base: number,
    rq?: unknown
) => Promise<BoundaryRefreshEntry[]> {
    return async function renderBoundaries(requests, base, rq) {
        const entries: BoundaryRefreshEntry[] = [];
        if (!Array.isArray(requests) || requests.length === 0) return entries;

        let appContext: AppContext | null = null;
        if (options.app) {
            try {
                appContext = (await options.app(rq))._context;
            } catch (error) {
                if (__DEV__) {
                    console.warn('[sigx resume] boundary refresh: app() threw — declining all:', error);
                }
                return entries;
            }
        }

        let nextBase = Math.floor(base);
        for (const request of requests) {
            const seeded = nextBase;
            nextBase = seeded + MIN_ID_STRIDE;
            try {
                if (!Number.isFinite(seeded) || seeded <= 0) break;
                // Own-property lookup only: the key is attacker-controlled,
                // and an inherited name (`constructor`, `toString`, …) must
                // never reach the lazy-loader call path.
                const registered = Object.prototype.hasOwnProperty.call(
                    options.components,
                    request.component
                )
                    ? options.components[request.component]
                    : undefined;
                const component = await resolveComponent(registered, request.component);
                if (!component) {
                    if (__DEV__) {
                        console.warn(
                            `[sigx resume] boundary refresh: no component registered for ` +
                            `"${request.component}" — declined. Add it to createBoundaryRefresh's ` +
                            `components map.`
                        );
                    }
                    continue;
                }

                // The renderer contains component failures (error fallback
                // in place, onError routed) — for a refresh that containment
                // is still a decline: fresh-but-broken HTML must not replace
                // stale-but-consistent DOM.
                let failed = false;
                const ctx = options.ssr.createContext({
                    baseComponentId: seeded,
                    onError: () => {
                        failed = true;
                    }
                });
                ctx._appContext = appContext;
                const handlers = getTypeHandlers(ctx);

                // The descriptor's props are the client table's encoded
                // snapshot — revive to the raw values the render expects.
                const props = request.props
                    ? (reviveWithHandlers(request.props, handlers) as Record<string, unknown>)
                    : {};

                const html = await renderVNodeToString(
                    jsx(component, props) as JSXElement,
                    ctx,
                    appContext
                );
                nextBase = highestMarkerId(html, seeded) + MIN_ID_STRIDE;

                // The root component allocates the first id past the seed.
                const rootId = seeded + 1;
                const record = ctx.getBoundary(rootId);
                if (failed || !record || record.refreshable === false) {
                    if (__DEV__) {
                        console.warn(
                            `[sigx resume] boundary refresh: <${request.component}> ${
                                failed
                                    ? 'failed during re-render'
                                    : record
                                      ? 're-rendered lossy (refreshable: false)'
                                      : 'recorded no boundary'
                            } — declined.`
                        );
                    }
                    continue;
                }

                // Encode with the boundary codec — the same discipline as
                // emitBoundaryTable, so the client-side table stays uniform.
                const records: Record<number, unknown> = {};
                ctx._boundaries.forEach((entry: SSRBoundaryRecord, id: number) => {
                    records[id] = encodeWithHandlers(entry, handlers);
                });
                entries.push({
                    for: request.id,
                    id: rootId,
                    html,
                    state: record.state
                        ? (encodeWithHandlers(record.state, handlers) as Record<string, unknown>)
                        : undefined,
                    records
                });
            } catch (error) {
                if (__DEV__) {
                    console.warn(
                        `[sigx resume] boundary refresh: re-render of <${request.component}> ` +
                        `threw — declined:`,
                        error
                    );
                }
            }
        }
        return entries;
    };
}
