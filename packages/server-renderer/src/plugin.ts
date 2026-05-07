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
         * Called when a component has pending `ssr.load()` calls.
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
         * - `script`: extra script content to inject alongside the replacement
         *
         * Return void to accept the default (plain HTML replacement).
         *
         * @example Islands plugin captures signal state and injects island data update
         */
        onAsyncComponentResolved?(
            id: number,
            html: string,
            ctx: SSRContext
        ): { html?: string; script?: string } | void;

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
