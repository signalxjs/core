/**
 * SSR Plugin Interface
 *
 * Defines a generic, strategy-agnostic extension point for server-side rendering.
 * Plugins can control component context creation, async behavior, HTML injection,
 * and client-side hydration — enabling custom hydration strategies, resumable SSR,
 * streaming Defer boundaries, progressive enhancement, or any future strategy without
 * core changes.
 */

import type { VNode, ComponentSetupContext } from 'sigx';
import type { SSRContext } from './server/context';
import type { ResolvedBoundary } from './boundary';

/**
 * SSR Plugin interface for extending server rendering and client hydration.
 *
 * The core renderer is strategy-agnostic. Hydration strategies (selective
 * hydration, resumability, streaming Defer boundaries, progressive enhancement, etc.)
 * are implemented as plugins that hook into the lifecycle below.
 */
export interface SSRPlugin {
    /** Unique plugin name */
    name: string;

    /** Server-side hooks (run during renderToString / renderToStream) */
    server?: {
        /**
         * Called once before rendering starts.
         * Use to initialize plugin-specific data via `ctx.setPluginData()`.
         */
        setup?(ctx: SSRContext): void;

        /**
         * The boundary seam (rfc-ssr-platform §1.3). Called once per component,
         * after its id is allocated and pushed (read `ctx._componentStack` top
         * if needed) but BEFORE the setup context is built and before
         * `vnode.type.__setup` runs. First plugin to return an object wins.
         *
         * The returned axes flow into the render:
         * - `flush: 'skip'` suppresses the server render entirely: setup never
         *   runs, `transformComponentContext` and `afterRenderComponent` are
         *   NOT called, and core emits the placeholder wrapper
         *   `<div data-boundary="ID" style="display:contents;">` around the
         *   (optional) `fallback` render, followed by the standard trailing
         *   `<!--$c:ID-->` marker. The client fresh-mounts into the wrapper.
         * - `flush: 'stream'` streams the boundary when it has pending async
         *   setup work (keyed useAsync/useStream) and the render is streaming;
         *   with no async work (or in string mode) it degrades to inline —
         *   there is nothing to defer. `fallback`, when present, renders
         *   inside the placeholder INSTEAD of the initial-state pass.
         * - `flush: 'inline'` awaits async work in place even in streaming mode.
         * - Omitted `flush` = today's default (stream in streaming mode,
         *   block/inline otherwise).
         * - `hydrate`/`media`/`chunk` are recorded in the per-request boundary
         *   table (`__SIGX_BOUNDARIES__`) for the client hydrator; `props`
         *   overrides the core-derived snapshot of `vnode.props` (packs strip
         *   their directive vocabulary — core cannot know it).
         *
         * The placeholder wrappers are core protocol: `fallback` thunks get no
         * id and must not emit their own wrapper element.
         *
         * @example Islands maps `client:only` → `{ flush: 'skip', hydrate: 'load' }`
         * @example Islands maps `client:visible` → `{ hydrate: 'visible' }`
         */
        resolveBoundary?(vnode: VNode, ctx: SSRContext): ResolvedBoundary | undefined | void;

        /**
         * Called after ComponentSetupContext is constructed but BEFORE setup() runs.
         * Plugin can mutate or replace the context — swap signal fn, modify ssr helper,
         * filter/transform props, add metadata.
         *
         * Return a new context to replace the default, or void to accept as-is.
         *
         * @example Islands plugin swaps `ctx.signal` with a tracking variant
         * @example Resumable plugin wraps ALL signals with serializing proxies
         */
        transformComponentContext?(
            ctx: SSRContext,
            vnode: VNode,
            componentCtx: ComponentSetupContext
        ): ComponentSetupContext | void;

        /**
         * Called after a component renders — APPEND-only. Output accumulates
         * in one shared buffer (that is what makes streaming cheap), so there
         * is no per-component HTML to intercept: the `html` argument is
         * always `''`, and a returned string is appended between the
         * component's content and its trailing `<!--$c:ID-->` marker. Typical
         * use: capture per-boundary state into `ctx.getBoundary(id)`, the way
         * the islands pack's plugin does. To influence what a component RENDERS, use
         * `transformComponentContext` instead — wrapping or rewriting the
         * emitted markup is deliberately not supported (#253).
         */
        afterRenderComponent?(
            id: number,
            vnode: VNode,
            html: string,
            ctx: SSRContext
        ): string | void;

        /**
         * Called after a core-managed async component resolves its deferred render.
         * Allows plugins to capture state, inject extra data, or modify the replacement.
         *
         * Return an object with:
         * - `html`: replacement HTML (modified or as-is)
         * - `script`: extra script content to run AFTER the `$SIGX_REPLACE`
         *   call (i.e. after hydration listeners may have fired)
         * - `preScript`: script content to run BEFORE the `$SIGX_REPLACE`
         *   call — use this for state that must be installed before the
         *   replace dispatches `sigx:async-ready`
         *
         * Return void to accept the default (plain HTML replacement).
         *
         * @example Islands plugin captures signal state and injects island data update
         */
        onAsyncComponentResolved?(
            id: number,
            html: string,
            ctx: SSRContext
        ): { html?: string; script?: string; preScript?: string } | void;

        /**
         * Contribute asset hints to the document shell. Called by
         * `renderDocument`'s asset-links pass (after the initial walk, so
         * `ctx` reflects the boundaries this request actually recorded).
         * Returned `modulepreload` URLs are emitted as
         * `<link rel="modulepreload">`, deduped against the caller's assets
         * and core's per-boundary chunk preloads.
         *
         * This is the pack-owned side of the preload policy (#281): core
         * only warms chunks IT will schedule, so a pack whose runtime or
         * wake-up machinery loads lazily uses this hook to keep the fetch
         * off the critical path without core knowing what the chunk is.
         *
         * @example Islands preloads its lazily-imported hydration runtime
         *          whenever the request recorded a schedulable boundary.
         */
        assets?(ctx: SSRContext): { modulepreload?: string[] } | void;

        /**
         * Called after rendering finishes. Return HTML to append after the rendered content.
         * Use for injecting scripts, JSON data, ready events, etc.
         */
        getInjectedHTML?(ctx: SSRContext): string | Promise<string>;

        /**
         * Called after all synchronous rendering for streaming mode.
         * Returns an async generator of HTML chunks to append (e.g., streaming replacement scripts).
         * Return void if no streaming chunks needed.
         */
        getStreamingChunks?(ctx: SSRContext): AsyncGenerator<string> | void;

        /**
         * Called exactly once after the streaming race loop drains (all
         * deferred renders, useStream pumps, and plugin chunk generators
         * done) — the LAST emission point of a request. Use it for state
         * that no later flush would carry (#407: `registerSerializedState`
         * calls made from a chunk generator that finishes last). Also called
         * at the end of blocking (string-mode) renders after plugin
         * generators drain. Return full HTML; stamp `ctx._nonce` on any
         * `<script>` you emit.
         *
         * Ordering vs the completion script: on the chunk-generator drivers
         * (`renderChunks`/`renderStream`/`renderDocument*`) the drain is
         * yielded BEFORE the `__SIGX_STREAMING_COMPLETE__` script.
         * `renderStreamWithCallbacks` ships that script with the shell
         * (pre-existing shape of that driver), so there the drain arrives
         * as the final `onAsyncChunk` instead — still the last bytes of the
         * request.
         */
        onStreamEnd?(ctx: SSRContext): string | void;
    };

    /** Client-side hooks (run during hydration) */
    client?: {
        /**
         * Called before the hydration DOM walk.
         * Return `false` to prevent the default DOM walk entirely.
         *
         * @example Resumable plugin returns false (sets up event delegation instead)
         * @example Islands plugin returns void (allows default walk)
         */
        beforeHydrate?(container: Element): boolean | void;

        /**
         * Called after the ComponentSetupContext is constructed but BEFORE setup()
         * runs during hydration. Client-side mirror of
         * `server.transformComponentContext` — restores server/client symmetry so
         * hydration is as pluggable as render. The plugin can mutate or replace the
         * context: swap `ctx.signal` with a state-restoring variant, modify the ssr
         * helper, etc.
         *
         * Return a new context to replace the default, or void to accept as-is.
         *
         * Unlike the server hook there is no `SSRContext` during hydration, so only
         * the vnode and the built context are passed.
         *
         * @example Islands plugin swaps `ctx.signal` with a variant that seeds each
         *          signal from the server-captured island state.
         */
        transformComponentContext?(
            vnode: VNode,
            componentCtx: ComponentSetupContext
        ): ComponentSetupContext | void;

        /**
         * Called for each component encountered during the hydration walk.
         * Return a `Node | null` to indicate the plugin handled this component
         * (the returned value is the next DOM sibling to process).
         * Return `undefined` (void) to let the next plugin or default hydration handle it.
         *
         * `regionEnd` is the exclusive end of the sibling range this component
         * may own — the enclosing component's trailing `<!--$c:ID-->` marker,
         * or null at the top of a DOM parent. A pack that locates the
         * component's own marker itself must bound the search by it, or a
         * component followed by sibling content latches a CHILD's marker
         * (#373). Passing it straight through to `scheduleWalkedBoundary` /
         * `hydrateComponent` is all most packs need.
         *
         * @example Islands plugin intercepts `client:*` components and schedules deferred hydration
         */
        hydrateComponent?(
            vnode: VNode,
            dom: Node | null,
            parent: Node,
            regionEnd?: Node | null
        ): Node | null | undefined;

        /**
         * Called after the hydration walk completes.
         *
         * @example Islands plugin calls `hydrateLeftoverAsyncComponents()`
         */
        afterHydrate?(container: Element): void;
    };
}
