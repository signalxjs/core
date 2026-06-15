/**
 * SSR Plugin Interface
 *
 * Defines a generic, strategy-agnostic extension point for server-side rendering.
 * Plugins can control component context creation, async behavior, HTML injection,
 * and client-side hydration — enabling custom hydration strategies, resumable SSR,
 * streaming Suspense, progressive enhancement, or any future strategy without
 * core changes.
 */

import type { VNode, ComponentSetupContext } from 'sigx';
import type { SSRContext } from './server/context';

/**
 * SSR Plugin interface for extending server rendering and client hydration.
 *
 * The core renderer is strategy-agnostic. Hydration strategies (selective
 * hydration, resumability, streaming Suspense, progressive enhancement, etc.)
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
         * Called after the component context is built (`transformComponentContext`
         * has run, the component id is assigned and pushed) but BEFORE `setup()`
         * and render. Lets a plugin skip running the component entirely and emit a
         * placeholder string in its place — e.g. islands `client:only` true
         * skip-SSR. Returning **any object** suppresses the render: the component's
         * `setup`/render and `afterRenderComponent` are skipped, and core emits the
         * (optional) `placeholder` string — when present, including an empty string
         * — followed by the standard trailing `<!--$c:id-->` marker for hydration.
         * Return void to render normally. First plugin to return an object wins.
         *
         * @example Islands plugin emits `<div data-island>` for `client:only`
         */
        suppressComponentRender?(
            id: number,
            vnode: VNode,
            ctx: SSRContext
        ): { placeholder?: string } | void;

        /**
         * Called after a component renders. Receives the accumulated HTML string.
         * Can transform it (e.g., wrap with markers, inject attributes).
         * Return a string to replace, or void to pass through.
         */
        afterRenderComponent?(
            id: number,
            vnode: VNode,
            html: string,
            ctx: SSRContext
        ): string | void;

        /**
         * Called when a component has pending async setup work (keyed
         * `useAsync()` fetchers / `useStream()` sources).
         * Plugin decides the async model:
         * - `'block'`: wait inline (overrides streaming default)
         * - `'stream'`: render placeholder now, stream replacement later (this is the default in streaming mode)
         * - `'skip'`: don't render this component server-side
         *
         * Return void to accept the default behavior:
         * - In streaming mode (`renderStream`/`renderStreamWithCallbacks`): defaults to `'stream'`
         * - In string mode (`renderToString`/`render`): defaults to `'block'`
         *
         * When core handles streaming, it manages the deferred render and race loop.
         * Plugins that need to augment the streamed result should use `onAsyncComponentResolved`.
         *
         * Note: this hook keys off useAsync/useStream setup work only. Suspense-boundary async
         * (lazy() children) does not pass through here — Suspense boundaries
         * stream via the same placeholder machinery and are observable on
         * `ctx._pendingAsync` and in `onAsyncComponentResolved`.
         *
         * @example Suspense plugin returns `{ mode: 'stream', placeholder: '<Spinner/>' }`
         * @example A plugin returns `{ mode: 'block' }` to force waiting
         */
        handleAsyncSetup?(
            id: number,
            ssrLoads: Promise<void>[],
            renderFn: () => any,
            ctx: SSRContext
        ): { mode: 'block' | 'stream' | 'skip'; placeholder?: string } | void;

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
         * @example Islands plugin intercepts `client:*` components and schedules deferred hydration
         */
        hydrateComponent?(
            vnode: VNode,
            dom: Node | null,
            parent: Node
        ): Node | null | undefined;

        /**
         * Called after the hydration walk completes.
         *
         * @example Islands plugin calls `hydrateLeftoverAsyncComponents()`
         */
        afterHydrate?(container: Element): void;
    };
}
