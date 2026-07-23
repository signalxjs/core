/**
 * SSR Context — tracks component boundaries and rendering state.
 *
 * This is the core SSR context, free of any strategy-specific logic (islands, etc.).
 * Plugins extend it via the generic `_pluginData` map.
 */

import type { SSRPlugin } from '../plugin';
import type { SSRBoundaryRecord } from '../boundary';
import type { ResponseState } from '../response';
import type { HeadConfig, AppContext } from 'sigx';

/**
 * Core-managed pending async component.
 * Created by render-core when streaming mode is active and no plugin overrides.
 */
export interface CorePendingAsync {
    /** Component ID */
    id: number;
    /** Resolves to rendered HTML when the component's useAsync/useStream work completes */
    promise: Promise<string>;
}

/**
 * What failed, and where in the request (rfc-ssr-platform §2.2). Component
 * fields are present for per-component render failures; shell-preparation
 * and stream-level failures carry only the phase.
 */
export interface SSRErrorInfo {
    /** 'shell' before the first byte could flush; 'stream' after. */
    phase: 'shell' | 'stream';
    /** The failed component's numeric id (the `<!--$c:ID-->` scheme). */
    componentId?: number;
    /** The failed component's `__name` (or 'Anonymous'). */
    componentName?: string;
    /** Present when the failed component is a recorded boundary. */
    boundaryId?: number;
}

export interface SSRContextOptions {
    /**
     * Enable streaming mode (default: true)
     */
    streaming?: boolean;

    /**
     * The one error callback for the request (rfc-ssr-platform §2.2):
     * per-component render failures (sync during the shell AND streamed
     * deferred renders), shell-preparation failures, and stream-level
     * failures all land here, distinguished by `info`.
     */
    onError?: (error: Error, info: SSRErrorInfo) => void;

    /**
     * The HTML rendered in place of a failed component. Default: the
     * `<!--ssr-error:ID-->` boundary comment, plus a visible diagnostic box
     * in development.
     */
    renderError?: (error: Error, info: SSRErrorInfo) => string;

    /**
     * CSP nonce applied to every `<script>` tag the renderer emits — the
     * boundary table, state blobs, streaming protocol + replacement scripts,
     * and the completion script. Apps pass their per-request CSP nonce.
     */
    nonce?: string;

    /**
     * Seed for the component-id counter (default 0 — the first id is 1).
     * A single-flight boundary refresh (rfc-server §6.3) re-renders one
     * component in a fresh context; seeding a high floor guarantees the
     * fresh HTML's `<!--$c:N-->` markers and `data-sigx-b` ids can never
     * collide with ids already live on the page it patches into.
     */
    baseComponentId?: number;
}

export interface RenderOptions {
    /**
     * Custom SSR context (created automatically if not provided)
     */
    context?: SSRContext;
}

export interface SSRContext {
    /**
     * Unique ID counter for component markers
     */
    _componentId: number;

    /**
     * Stack of component IDs for nested tracking
     */
    _componentStack: number[];

    /**
     * Collected head elements (scripts, styles, etc.)
     */
    _head: string[];

    /**
     * The request's error callback (per-component, shell, and stream-level
     * failures — see SSRErrorInfo).
     */
    _onError?: (error: Error, info: SSRErrorInfo) => void;

    /**
     * Failure-HTML hook — what renders in place of a failed component.
     */
    _renderError?: (error: Error, info: SSRErrorInfo) => string;

    /**
     * The request's CSP nonce — stamped on every renderer-emitted `<script>`
     * tag (see SSRContextOptions.nonce). Undefined → plain `<script>`.
     */
    _nonce?: string;

    /**
     * Which request phase the walk is in: 'shell' until the shell has been
     * produced, 'stream' while deferred renders replay. Feeds SSRErrorInfo.
     */
    _phase: 'shell' | 'stream';

    /**
     * Registered SSR plugins
     */
    _plugins?: SSRPlugin[];

    /**
     * The app context of the render input (null when rendering a bare
     * element). Set by the render entry points; the DI source for per-app
     * serializer type handlers and other app-level provides read at request
     * time.
     */
    _appContext: AppContext | null;

    /**
     * Plugin-specific data storage, keyed by plugin name.
     * Plugins store their own state here via `getPluginData` / `setPluginData`.
     */
    _pluginData: Map<string, any>;

    /**
     * Whether streaming mode is active.
     * When true, async components default to streaming (placeholder + deferred render)
     * instead of blocking. Set by renderStream / renderStreamWithCallbacks.
     */
    _streaming: boolean;

    /**
     * Core-managed pending async components.
     * Populated by render-core when async components are streamed without a plugin override.
     */
    _pendingAsync: CorePendingAsync[];

    /**
     * Per-request head configs collected from useHead() calls during this
     * render. Unlike the legacy module-level collection in head.ts, this is
     * safe under concurrent renders (each request has its own context).
     */
    _headConfigs: HeadConfig[];

    /**
     * Progressive text streams registered via useStream() in streaming mode.
     * Each generator yields $SIGX_APPEND scripts per token; the streaming
     * race loop consumes them alongside async component replacements.
     */
    _pendingStreams: AsyncGenerator<string>[];

    /**
     * Request-level useAsync dedupe: key → in-flight fetcher promise.
     * Two components using the same key share one fetch.
     */
    _asyncCache: Map<string, Promise<unknown>>;

    /**
     * Resolved useAsync/useStream values by key — the source for the
     * __SIGX_ASYNC__ hydration blob.
     */
    _asyncResults: Map<string, unknown>;

    /**
     * Keys written to `_asyncResults` but not yet emitted to the client.
     * Values registered inside a deferred render are NOT in the shell blob —
     * each stream flush drains this set so they reach `window.__SIGX_ASYNC__`
     * too (#407). A dirty-set, not a flushed-set: draining is O(flush), never
     * a rescan of every result per async resolution (the #279 discipline).
     */
    _unflushedAsyncKeys: Set<string>;

    /**
     * Per-request boundary table (id → record). Populated by core when a
     * plugin's `resolveBoundary` accepts a component; emitted as
     * `__SIGX_BOUNDARIES__` when non-empty.
     */
    _boundaries: Map<number, SSRBoundaryRecord>;
    /**
     * Boundary ids recorded but not yet emitted to the client. Records born
     * inside a deferred render are NOT in the shell table — each stream
     * patch drains this set so they reach `window.__SIGX_BOUNDARIES__` too
     * (#279). A dirty-set, not a flushed-set: draining is O(patch), never a
     * rescan of every boundary per async resolution.
     */
    _unflushedBoundaries: Set<number>;

    /**
     * Per-request response state collected by useResponse() —
     * status/headers/redirect, surfaced on the document shell promise
     * (rfc-ssr-platform §2.1).
     */
    _response: ResponseState;

    /**
     * Generate next component ID
     */
    nextId(): number;

    /**
     * Push a component onto the stack
     */
    pushComponent(id: number): void;

    /**
     * Pop the current component from stack
     */
    popComponent(): number | undefined;

    /**
     * Add a head element
     */
    addHead(html: string): void;

    /**
     * Get collected head HTML
     */
    getHead(): string;

    /**
     * Get plugin-specific data by plugin name.
     */
    getPluginData<T>(pluginName: string): T | undefined;

    /**
     * Set plugin-specific data by plugin name.
     */
    setPluginData<T>(pluginName: string, data: T): void;

    /**
     * Record a boundary in the per-request table. Core calls this from the
     * render walk; exposed for advanced plugins that manage boundaries
     * outside the `resolveBoundary` flow.
     */
    recordBoundary(id: number, record: SSRBoundaryRecord): void;

    /**
     * Read a boundary record for augmentation — packs write captured state
     * through this (e.g. islands' signal snapshot after render / async
     * resolution). Mutations before the shell flush ship with the table;
     * later mutations ship via the per-id mid-stream patch.
     */
    getBoundary(id: number): SSRBoundaryRecord | undefined;

    /**
     * Register a request-scoped value for the `__SIGX_ASYNC__` hydration
     * blob — the public write path for packs that own request state (e.g.
     * `@sigx/store`'s `ssrState`), alongside the keys useAsync/useStream
     * record internally (#407).
     *
     * Emission is handled by `stateSerializationPlugin` (on by default under
     * `renderDocument`): with the shell blob when registered during the shell
     * walk, with the next stream-phase flush otherwise; a final drain before
     * the completion script guarantees delivery. A `{ toJSON }` value is
     * encoded at EMIT time, so state mutated after registration serializes
     * with its final values — `toJSON` may run more than once per flush, keep
     * it pure and cheap. Keys share the useAsync/useStream namespace: prefix
     * yours (`store:cart`). Re-registering an already-emitted key ships a
     * patch (the client-side merge is last-write-wins); non-serializable
     * values are skipped at emit with a dev warning.
     */
    registerSerializedState(key: string, value: unknown): void;
}

/**
 * Create a new SSR context for rendering
 */
export function createSSRContext(options: SSRContextOptions = {}): SSRContext {
    // Coerce the seed to a finite non-negative integer — markers are parsed
    // with parseInt on the client, so a fractional/NaN/negative seed would
    // emit ids the marker index mis-reads.
    const seed = options.baseComponentId;
    let componentId = typeof seed === 'number' && Number.isFinite(seed) && seed > 0
        ? Math.floor(seed)
        : 0;
    const componentStack: number[] = [];
    const head: string[] = [];
    const pluginData = new Map<string, any>();
    const boundaries = new Map<number, SSRBoundaryRecord>();
    const unflushedBoundaries = new Set<number>();
    const asyncResults = new Map<string, unknown>();
    const unflushedAsyncKeys = new Set<string>();

    return {
        _componentId: componentId,
        _componentStack: componentStack,
        _head: head,
        _pluginData: pluginData,
        _onError: options.onError,
        _renderError: options.renderError,
        _nonce: options.nonce,
        _phase: 'shell',
        _appContext: null,
        _streaming: false,
        _pendingAsync: [],
        _headConfigs: [],
        _pendingStreams: [],
        _asyncCache: new Map(),
        _asyncResults: asyncResults,
        _unflushedAsyncKeys: unflushedAsyncKeys,
        _boundaries: boundaries,
        _unflushedBoundaries: unflushedBoundaries,
        // Null-prototype headers bag: names can be caller-derived strings,
        // and special keys (__proto__, constructor) must be plain data.
        _response: { headers: Object.create(null) },

        nextId() {
            return ++componentId;
        },

        pushComponent(id: number) {
            componentStack.push(id);
        },

        popComponent() {
            return componentStack.pop();
        },

        addHead(html: string) {
            head.push(html);
        },

        getHead() {
            return head.join('\n');
        },

        getPluginData<T>(pluginName: string): T | undefined {
            return pluginData.get(pluginName);
        },

        setPluginData<T>(pluginName: string, data: T): void {
            pluginData.set(pluginName, data);
        },

        recordBoundary(id: number, record: SSRBoundaryRecord): void {
            boundaries.set(id, record);
            unflushedBoundaries.add(id);
        },

        getBoundary(id: number): SSRBoundaryRecord | undefined {
            return boundaries.get(id);
        },

        registerSerializedState(key: string, value: unknown): void {
            // Overwriting a not-yet-flushed value means the earlier one never
            // reaches the client — almost always two owners colliding on one
            // key. (Re-registering an already-EMITTED key is the documented
            // patch path and stays silent.)
            if (__DEV__ && unflushedAsyncKeys.has(key)) {
                console.warn(
                    `[SSR] registerSerializedState("${key}") overwrote a value ` +
                    `registered earlier in this request before it was emitted — ` +
                    `last write wins. Namespace the key if this collision is ` +
                    `unintended.`
                );
            }
            asyncResults.set(key, value);
            unflushedAsyncKeys.add(key);
        }
    };
}
