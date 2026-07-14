/**
 * The SSR boundary model (rfc-ssr-platform §1) — one concept with two
 * orthogonal axes covering what previously lived as three: <Defer> flush
 * points, islands `client:*` directives, and streaming placeholders.
 *
 * - `flush` is the server axis: how the boundary's HTML reaches the page.
 * - `hydrate` is the client axis: when the boundary's component wakes up.
 *
 * Plugins contribute the decision through the `resolveBoundary` server hook;
 * core derives `id` and the props snapshot, records accepted boundaries in
 * the per-request table (`SSRContext._boundaries`), and emits them as
 * `window.__SIGX_BOUNDARIES__` for the client hydrator.
 */

import type { JSXElement } from 'sigx';

export type BoundaryFlush = 'inline' | 'stream' | 'skip';
//  inline: await content, emit in place (blocking/string modes)
//  stream: emit fallback + placeholder now, $SIGX_REPLACE later
//  skip:   do not server-render at all (client:only)

export type BoundaryHydrate = 'load' | 'idle' | 'visible' | 'media' | 'interaction' | 'never';

/**
 * The full boundary model. `fallback` is server-only — rendered in place of
 * content for `stream`/`skip` boundaries — and never serialized.
 */
export interface SSRBoundary {
    /** Stable per request — the existing numeric component-id scheme. */
    id: number;
    flush: BoundaryFlush;
    hydrate: BoundaryHydrate;
    /** Required iff `hydrate: 'media'` — the media query string. */
    media?: string;
    /**
     * `flush: 'stream' | 'skip'` only — emitted in place of content, inside
     * the core-owned placeholder wrapper. The thunk gets no id and must not
     * emit its own wrapper element.
     */
    fallback?: () => JSXElement;
    /** Module ref for boundaries that load their component on demand. */
    chunk?: { url: string; export?: string };
    /** Props snapshot for client-side mounting. */
    props?: Record<string, unknown>;
}

/**
 * One entry of the per-request boundary table — the wire shape serialized
 * into `__SIGX_BOUNDARIES__` (the record's id is the table key).
 */
export interface SSRBoundaryRecord {
    /**
     * Present only when 'skip' — tells the client to fresh-mount into the
     * placeholder instead of hydrating in place. Other flush values are a
     * server-side concern and never serialized.
     */
    flush?: BoundaryFlush;
    /** Omitted = inherit the app default hydrate strategy. */
    hydrate?: BoundaryHydrate;
    media?: string;
    props?: Record<string, unknown>;
    /**
     * Captured signal-state snapshot (#120) — written by packs through
     * `ctx.getBoundary(id)` after render / async resolution.
     */
    state?: Record<string, unknown>;
    chunk?: { url: string; export?: string };
    /**
     * Registry key for client component resolution (core-derived:
     * `vnode.type.__islandId || __name`).
     */
    component?: string;
}

/**
 * What a plugin's `resolveBoundary` returns. `id` is core-derived (the
 * component-id scheme); `props` defaults to a core-derived snapshot of
 * `vnode.props` — packs override it to strip their directive vocabulary.
 */
export type ResolvedBoundary = Partial<
    Pick<SSRBoundary, 'flush' | 'hydrate' | 'media' | 'fallback' | 'chunk' | 'props'>
>;
