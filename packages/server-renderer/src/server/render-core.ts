/**
 * Core rendering logic for SSR
 *
 * The walk is a SYNCHRONOUS generator (`renderNode`) that pushes HTML into a
 * shared buffer and only yields at suspension points:
 *
 * - `{ p: Promise }` — the driver awaits the promise and resumes the walk
 *   with the resolved value (or throws the rejection back in, so component
 *   error fallbacks behave exactly like an inline `await`).
 * - `FLUSH` — a hint that the buffer passed the flush threshold; streaming
 *   drivers emit a chunk, string drivers ignore it.
 *
 * Fully synchronous trees therefore render in a single `gen.next()` call with
 * zero promise allocations, while async trees pay for exactly one suspension
 * per await — instead of the per-vnode-per-level microtask overhead of the
 * previous AsyncGenerator walk.
 *
 * This module is strategy-agnostic. Strategy-specific logic (signal tracking,
 * hydration directives, async streaming, selective hydration, etc.) is
 * injected through the SSRPlugin hooks.
 */

import {
    VNode,
    Fragment,
    signal,
    Text,
    Comment,
    isComponent,
    isDirective,
    isModel
} from 'sigx';
import type { JSXElement, ComponentSetupContext, SlotsObject, DirectiveDefinition, AppContext } from 'sigx';
import {
    setCurrentInstance,
    getCurrentInstance,
    createPropsAccessor,
    provideAppContext,
    resolveBuiltInDirective,
    matchAsyncState,
    ERROR_SCOPE_TOKEN,
    getProvided,
    invokeFunctionChildren,
    invokeSlotFn,
    namedSlotFor,
    splitComponentProps,
    // Moved into @sigx/runtime-core when mergeProps needed the same parser.
    // Re-exported below so this module's surface is unchanged.
    parseStringStyle,
} from 'sigx/internals';
export { parseStringStyle };
import type { SSRContext, SSRErrorInfo } from './context';
import type { ResolvedBoundary, SSRBoundaryRecord } from '../boundary';
import { generateAppendScript } from './streaming';
import { serializeBoundaryProps, getTypeHandlers } from './serialize';

// ============= HTML Utilities =============

const escapeRE = /[&<>"']/;

export function escapeHtml(s: string): string {
    // Fast path: most strings contain nothing to escape — return the input
    // without allocating.
    const match = escapeRE.exec(s);
    if (!match) return s;

    let html = '';
    let lastIndex = 0;
    let escaped: string;
    for (let i = match.index; i < s.length; i++) {
        switch (s.charCodeAt(i)) {
            case 38: escaped = '&amp;'; break;
            case 60: escaped = '&lt;'; break;
            case 62: escaped = '&gt;'; break;
            case 34: escaped = '&quot;'; break;
            case 39: escaped = '&#39;'; break;
            default: continue;
        }
        if (lastIndex !== i) html += s.slice(lastIndex, i);
        html += escaped;
        lastIndex = i + 1;
    }
    return lastIndex === s.length ? html : html + s.slice(lastIndex);
}

/**
 * Cache for camelCase → kebab-case conversions (same properties repeat across
 * elements). Null prototype: a plain literal would resolve inherited keys like
 * 'constructor' through Object.prototype.
 */
const kebabCache: Record<string, string> = Object.create(null);

/**
 * Shared no-op for the per-component context slots that are inert on the
 * server (emit, lifecycle hooks, expose, update) — avoids 7 closure
 * allocations per component.
 */
const NOOP = () => { };

/** Void elements that cannot have children — hoisted to module scope as a Set for O(1) lookup */
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** @internal exported for direct unit tests only */
export function camelToKebab(str: string): string {
    // CSS custom properties (--foo) are already kebab-case
    if (str.startsWith('--')) return str;
    return kebabCache[str] ||= str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

// ============= Style Parsing =============


/**
 * Serialize a style object to a CSS string.
 *
 * Uses for...in + string concat (avoids Object.entries/map/join allocations)
 * and cached kebab-case conversion.
 */
export function stringifyStyle(style: Record<string, any>): string {
    let ret = '';
    for (const key in style) {
        const value = style[key];
        if (value != null && value !== '') {
            ret += `${camelToKebab(key)}:${value};`;
        }
    }
    return ret;
}

/**
 * Check if element will render as text content
 */
function isTextContent(element: JSXElement): boolean {
    if (element == null || element === false || element === true) return false;
    if (typeof element === 'string' || typeof element === 'number') return true;
    const vnode = element as VNode;
    return vnode.type === Text;
}

/** Check if all children are leaf types (text, number, null, bool, Text vnode) */
function allChildrenAreLeaves(children: any[]): boolean {
    for (const child of children) {
        if (child == null || child === false || child === true) continue;
        if (typeof child === 'string' || typeof child === 'number') continue;
        const vnode = child as VNode;
        if (vnode.type === Text) continue;
        return false;
    }
    return true;
}

/**
 * Merge style values for SSR (element style + directive SSR style).
 * Either value can be an object, string, or undefined.
 * String styles are parsed into objects before merging.
 */
function mergeSSRStyles(elementStyle: any, directiveStyle: any): Record<string, any> {
    if (!elementStyle) return directiveStyle;
    if (!directiveStyle) return elementStyle;
    // Normalize both to objects — parse CSS strings if needed
    const a = typeof elementStyle === 'string' ? parseStringStyle(elementStyle)
        : (typeof elementStyle === 'object' ? elementStyle : {});
    const b = typeof directiveStyle === 'string' ? parseStringStyle(directiveStyle)
        : (typeof directiveStyle === 'object' ? directiveStyle : {});
    return { ...a, ...b };
}

// ============= Shared walk helpers =============

interface ComponentRenderState {
    componentName: string;
    id: number;
    ssrLoads: Promise<void>[];
    componentCtx: ComponentSetupContext;
}

/**
 * Component preamble: id allocation, slots, ssr helper, setup-context
 * construction, the transformComponentContext plugin hook, and root
 * AppContext provision.
 *
 * Pairs with ctx.popComponent() — the caller owns the pop.
 */
function createComponentState(
    vnode: VNode,
    ctx: SSRContext,
    parentCtx: ComponentSetupContext | null,
    appContext: AppContext | null,
    id: number
): ComponentRenderState {
    const componentName = (vnode.type as any).__name || 'Anonymous';
    const allProps = vnode.props || {};

    // Use the SAME splitter the client mount and hydration paths use, rather
    // than a second destructure that has to be kept in step by hand. It had
    // already drifted: this path discarded `$models` while the client merged
    // each model back into props under its own name, so `props.title` was a
    // `Model` on the client and absent on the server. The three
    // prop-construction paths must agree key-for-key or SSR and hydration
    // disagree on the markup.
    const { children, slotsFromProps, propsWithModels: propsData } = splitComponentProps(allProps);

    // Create slots from children, mirroring the client slot extractor so
    // server and client agree on slot presence (otherwise hydration could
    // mismatch). Un-slotted children form the default slot; children with a
    // `slot` prop group into named slots. A slot accessor exists only when
    // content was provided for it — an absent slot reads as `undefined`, so
    // `slots.x?.()` / `?? fallback` behave the same as on the client.
    // Only null/undefined/boolean mean "no children" — falsy render output
    // like the number 0 or '' is valid slot content.
    const defaultChildren: any[] = [];
    const elementNamed: Record<string, any[]> = Object.create(null);
    let defaultHasFn = false;
    if (children != null && typeof children !== 'boolean') {
        const items = Array.isArray(children) ? children : [children];
        for (const child of items) {
            const name = namedSlotFor(child);
            if (name) {
                (elementNamed[name] ?? (elementNamed[name] = [])).push(child);
            } else if (child != null && child !== false && child !== true) {
                // A function is `typeof 'function'`, never `'object'`, so it can
                // never satisfy `namedSlotFor` — a render-prop child always
                // lands here, in `default`, as does a COMPONENT child even when
                // it carries a `slot` prop (#588; `namedSlotFor` is the shared
                // predicate, so server and client cannot disagree). Recording
                // the function now keeps the ordinary element-children slot
                // read a plain copy.
                if (typeof child === 'function') defaultHasFn = true;
                defaultChildren.push(child);
            }
        }
    }
    // Null-prototype dictionary: slot names come from user-controlled `slot`
    // props and the `slots` prop, so a name like "__proto__" must be a plain
    // key (a normal object would route it through the prototype setter,
    // polluting the prototype and breaking the client's "__proto__"-named
    // slot parity).
    const slots: SlotsObject<any> = Object.create(null);
    if (defaultChildren.length > 0) {
        slots.default = defaultHasFn
            ? (scopedProps?: any) => invokeFunctionChildren(defaultChildren, scopedProps, 'default')
            : () => defaultChildren.slice();
    }
    for (const name in elementNamed) {
        // A child with `slot="default"` is a named slot on the client too,
        // but the client's `default` accessor only reads un-slotted children,
        // so such content is unreachable there. Skip it here for parity —
        // installing it at `slots.default` would render on the server but not
        // the client, causing a hydration mismatch. `slots.default` is driven
        // solely by the un-slotted children above (and the `slots` prop below).
        if (name === 'default') continue;
        const list = elementNamed[name];
        // Element-only by construction (see the scan above), so a named slot is
        // always just a defensive copy.
        slots[name] = () => list.slice();
    }
    // Slots provided via the `slots` prop take precedence over element-based
    // ones of the same name, matching the client extractor — including the
    // client's result normalisation and its `{}` scoped-props default, which is
    // why the fill goes through `invokeSlotFn` instead of being installed raw.
    if (slotsFromProps) {
        for (const name of Object.keys(slotsFromProps)) {
            const fill = slotsFromProps[name];
            if (typeof fill === 'function') {
                slots[name] = (scopedProps?: any) => invokeSlotFn(fill, scopedProps, name);
            }
        }
    }

    // Pending async work for this component (useAsync/useStream register
    // here; block mode awaits these inline, streaming mode defers behind a
    // placeholder)
    const ssrLoads: Promise<void>[] = [];

    // Environment flags exposed as ctx.ssr; _ctx lets per-request consumers
    // (useHead) reach the SSRContext through getCurrentInstance().ssr
    // without module-level state.
    const ssrHelper = {
        isServer: true,
        isHydrating: false,
        _ctx: ctx
    };

    // NOTE: the __ssr*/_use* fields are part of the literal so every
    // component context shares ONE object shape — adding them after creation
    // caused per-component hidden-class transitions (bistable render times
    // on component-heavy pages).
    const componentCtxInit = {
        el: null as any,
        signal: signal,
        props: createPropsAccessor(propsData),
        slots: slots,
        emit: NOOP,
        parent: parentCtx,
        onMounted: NOOP,
        onUnmounted: NOOP,
        onCreated: NOOP,
        onUpdated: NOOP,
        expose: NOOP,
        renderFn: null,
        update: NOOP,
        ssr: ssrHelper,
        _ssrLoads: ssrLoads,
        // useAsync/useStream server providers: SHARED module-level functions
        // reading per-component state through `this` at call time — no
        // closures allocated for components that never load data.
        __ssrCtx: ctx,
        __ssrId: id,
        _useAsync: serverUseAsync,
        _useStream: serverUseStream
    };
    let componentCtx: ComponentSetupContext = componentCtxInit as unknown as ComponentSetupContext;

    // Plugin hook: transformComponentContext
    // Allows plugins (e.g., islands) to swap signal fn, filter props, set up tracking, etc.
    if (ctx._plugins) {
        for (const plugin of ctx._plugins) {
            const transformed = plugin.server?.transformComponentContext?.(ctx, vnode, componentCtx);
            if (transformed) {
                componentCtx = transformed;
            }
        }
        // A plugin may have replaced the context with a fresh object — keep
        // the useAsync/useStream provider wiring intact on whatever object
        // setup() will actually receive. `parent` rides along: the §6.3 dep
        // fold walks it to find the nearest enclosing boundary.
        if (!(componentCtx as any)._useAsync) {
            (componentCtx as any).__ssrCtx = ctx;
            (componentCtx as any).__ssrId = id;
            (componentCtx as any)._useAsync = serverUseAsync;
            (componentCtx as any)._useStream = serverUseStream;
            if (!componentCtx.parent) componentCtx.parent = parentCtx;
        }
    }

    // For ROOT component only (no parent), provide the AppContext
    if (!parentCtx && appContext) {
        provideAppContext(componentCtx, appContext);
    }

    return { componentName, id, ssrLoads, componentCtx };
}

/**
 * Shared inert state for { server: false } calls on the server: the pending
 * arm renders into the HTML and the client fetches after hydration.
 */
const INERT_PENDING_STATE = Object.freeze({
    state: 'pending' as const,
    value: null,
    hasValue: false,
    error: null,
    loading: true,
    match: (arms: { pending?: () => unknown }) => arms.pending?.(),
    refresh: () => Promise.resolve()
});

/**
 * useData server provider (shared; invoked as instance._useAsync(...)).
 *
 * Keyed calls fetch on the server (deduped per request by key), settle
 * through the component's ssrLoads (block: awaited inline; streaming:
 * deferred behind the placeholder), and record their value for the
 * __SIGX_ASYNC__ hydration blob. `{ server: false }` calls never run here —
 * the pending arm renders into the HTML and the client fetches after
 * hydration. Core resolves keys (getter → canonical string) and pre-binds
 * the fetcher's argument before this seam, so server cells are only ever
 * 'pending' | 'ready' | 'errored'.
 *
 * The options bag arrives whole (open AsyncOptions interface) — this
 * provider reads `server` and ignores the rest; pack options are the pack
 * provider's business.
 */
/**
 * §6.3 dep fold: attribute a useData key to the NEAREST enclosing boundary
 * by walking the setup-context parent chain — correct across deferred
 * (streamed) renders, where `ctx._componentStack` has already popped but
 * `capturedComponentCtx` rides in as `parent`. The boundary record exists
 * before setup runs, so `ctx._boundaries` is the membership test.
 */
function recordBoundaryDep(
    ctx: SSRContext,
    start: { __ssrId?: number; parent?: unknown },
    key: string
): void {
    let owner: { __ssrId?: number; parent?: unknown } | undefined = start;
    while (owner) {
        const bid = owner.__ssrId;
        const record = bid !== undefined ? ctx._boundaries.get(bid) : undefined;
        if (record) {
            if (!record.deps) record.deps = [key];
            else if (!record.deps.includes(key)) record.deps.push(key);
            else return; // already recorded — nothing new to flush
            // Re-ship the record if the table already streamed out.
            ctx._unflushedBoundaries.add(bid!);
            return;
        }
        owner = owner.parent as typeof owner;
    }
}

function serverUseAsync(
    this: any,
    key: string | null,
    fetcher: (fctx: { signal: AbortSignal }) => Promise<unknown>,
    options: { server?: boolean } & Record<string, unknown> = {}
) {
    if (key === null || options.server === false) {
        // Deliberately unrecorded as a dep: nothing of this read is baked
        // into the HTML (`server:false` renders the pending arm), so a
        // §6.3 refresh on its account would change nothing.
        return INERT_PENDING_STATE;
    }

    const ctx: SSRContext = this.__ssrCtx;
    const ssrLoads: Promise<void>[] = this._ssrLoads;

    recordBoundaryDep(ctx, this, key);

    const state = {
        st: 'pending' as 'pending' | 'ready' | 'errored',
        data: null as unknown,
        failure: null as Error | null
    };

    // Request-level dedupe: same key → one fetch, shared result
    let promise = ctx._asyncCache.get(key);
    if (!promise) {
        promise = fetcher({ signal: new AbortController().signal });
        ctx._asyncCache.set(key, promise);
    }

    const settled = (promise as Promise<unknown>).then(value => {
        state.st = 'ready';
        state.data = value;
        ctx._asyncResults.set(key, value);
        ctx._unflushedAsyncKeys.add(key);
    }, e => {
        // Soft failure: the component renders its error arm. Nothing is
        // serialized — the client refetches (fail-safe).
        state.st = 'errored';
        state.failure = e instanceof Error ? e : new Error(String(e));
    });
    ssrLoads.push(settled);

    return {
        get state() { return state.st; },
        get value() { return state.data; },
        // 'ready' is the only state that has one, and it is set together with
        // `data` above — so a fetcher resolving `null` still reads as present,
        // matching the client cell (#485).
        get hasValue() { return state.st === 'ready'; },
        get loading() { return state.st === 'pending'; },
        get error() { return state.failure; },
        match(arms: Parameters<typeof matchAsyncState>[1]) {
            return matchAsyncState({
                state: state.st,
                value: state.data,
                // Server cells never hold last-good through 'errored' (one
                // request, no prior success) — the errored empty split.
                hasValue: state.st === 'ready',
                error: state.failure,
                retry: () => { /* no-op on the server */ }
            }, arms);
        },
        refresh: () => Promise.resolve() // no-op on the server
    };
}

/**
 * useStream server provider (shared; invoked as instance._useStream(...)).
 *
 * Streaming mode: tokens append into the placeholder as they arrive; when
 * the source completes the standard deferred re-render swaps in the final
 * markup. Blocking/string mode: drained fully, rendered inline. The final
 * text serializes under the key either way.
 */
function serverUseStream(this: any, key: string, source: () => AsyncIterable<string>) {
    const ctx: SSRContext = this.__ssrCtx;
    const id: number = this.__ssrId;
    const ssrLoads: Promise<void>[] = this._ssrLoads;

    // Streams are per-instance (an AsyncIterable can't be consumed twice),
    // so keys must be UNIQUE per request — unlike useAsync, where sharing a
    // key is the dedupe feature. Duplicates would race on the serialized
    // final text (last finisher wins).
    if (__DEV__) {
        const seen: Set<string> = ((ctx as any)._streamKeys ??= new Set());
        if (seen.has(key)) {
            console.warn(
                `[useStream] duplicate key "${key}" in one request — stream keys ` +
                `must be unique (the serialized text would be last-write-wins). ` +
                `Only useAsync keys are shareable.`
            );
        }
        seen.add(key);
    }

    const state = { text: '' };

    const finish = (acc: string) => {
        state.text = acc;
        ctx._asyncResults.set(key, acc);
        ctx._unflushedAsyncKeys.add(key);
    };

    if (ctx._streaming) {
        let resolveDone!: () => void;
        let rejectDone!: (e: unknown) => void;
        const done = new Promise<void>((res, rej) => { resolveDone = res; rejectDone = rej; });

        const pump = (async function* () {
            let acc = '';
            try {
                for await (const token of source()) {
                    acc += token;
                    yield generateAppendScript(id, token, ctx._nonce);
                }
                finish(acc);
                resolveDone();
            } catch (e) {
                finish(acc);
                rejectDone(e);
            }
        })();

        ctx._pendingStreams.push(pump);
        ssrLoads.push(done);
    } else {
        ssrLoads.push((async () => {
            let acc = '';
            for await (const token of source()) {
                acc += token;
            }
            finish(acc);
        })());
    }

    return { get value() { return state.text; } };
}

/**
 * Internal server-side view of an errorScope (set on the component ctx by
 * errorScope() during setup — see runtime-core/src/error-scope.ts).
 */
interface ServerErrorScope {
    fallback?: (error: Error, retry: () => void) => JSXElement;
}

/**
 * A descendant throw claimed by an enclosing errorScope — rethrown so it
 * propagates up the generator stack to the owning component's frame, which
 * rewinds its subtree output and renders the scope fallback in its place.
 */
class ScopeThrow extends Error {
    constructor(
        public readonly original: Error,
        public readonly scope: ServerErrorScope
    ) {
        super(original.message);
    }
}

/** Nearest errorScope on this component or an ancestor (self first). */
function findEnclosingScope(componentCtx: ComponentSetupContext | null): ServerErrorScope | null {
    let current: any = componentCtx;
    while (current) {
        if (current.__errorScope) return current.__errorScope as ServerErrorScope;
        current = current.parent;
    }
    return null;
}

/**
 * The default failure HTML (rfc-ssr-platform §2.2): the stable
 * `<!--ssr-error:ID-->` boundary comment, plus a visible diagnostic box in
 * development so a failed component is impossible to miss.
 */
export function defaultRenderError(error: Error, info: SSRErrorInfo): string {
    const marker = info.componentId != null ? `<!--ssr-error:${info.componentId}-->` : '';
    if (!__DEV__) {
        return marker;
    }
    const label = escapeHtml(`[SSR] <${info.componentName ?? 'Anonymous'}> failed during ${info.phase}: ${error.message}`);
    return marker
        + `<div style="border:2px solid #c00;border-radius:4px;background:#fff5f5;color:#900;`
        + `padding:8px 12px;font:13px/1.5 ui-monospace,monospace;">${label}</div>`;
}

/**
 * Error fallback for a failed component: report through the request's one
 * error callback, then emit `renderError`'s HTML in its place ('' emits
 * nothing).
 */
function componentErrorFallback(e: unknown, ctx: SSRContext, componentName: string, id: number): string {
    const error = e instanceof Error ? e : new Error(String(e));
    const info: SSRErrorInfo = {
        phase: ctx._phase,
        componentId: id,
        componentName,
        ...(ctx._boundaries.has(id) ? { boundaryId: id } : {})
    };

    try {
        ctx._onError?.(error, info);
    } catch (hookErr) {
        if (__DEV__) {
            console.error('Error in onError callback:', hookErr);
        }
    }

    if (__DEV__) {
        console.error(`Error rendering component ${componentName}:`, e);
    }

    return ctx._renderError ? ctx._renderError(error, info) : defaultRenderError(error, info);
}

/**
 * Serialize a host element's attribute string, merging in SSR props
 * contributed by use:* directives (getSSRProps hook).
 */
function serializeOpenTagProps(vnode: VNode, appContext: AppContext | null): string {
    let props = '';

    // Collect SSR props from use:* directive props (getSSRProps hook)
    let directiveSSRProps: Record<string, any> | null = null;
    if (vnode.props) {
        for (const key in vnode.props) {
            // charCode guard: skip the startsWith call for the common case
            if (key.charCodeAt(0) === 117 /* u */ && key.startsWith('use:')) {
                const propValue = vnode.props[key];
                let def: DirectiveDefinition | undefined;
                let value: any;

                if (isDirective(propValue)) {
                    def = propValue;
                    value = undefined;
                } else if (
                    Array.isArray(propValue) &&
                    propValue.length >= 1 &&
                    isDirective(propValue[0])
                ) {
                    def = propValue[0];
                    value = propValue[1];
                } else {
                    // Try to resolve by name:
                    // 1. Built-in directives (always available, e.g., 'show')
                    // 2. App-registered custom directives (via app.directive())
                    const builtIn = resolveBuiltInDirective(key.slice(4));
                    if (builtIn) {
                        def = builtIn;
                        value = propValue;
                    } else {
                        const custom = appContext?.directives.get(key.slice(4));
                        if (custom) {
                            def = custom;
                            value = propValue;
                        }
                    }
                }

                if (def?.getSSRProps) {
                    const ssrProps = def.getSSRProps({ value });
                    if (ssrProps) {
                        if (!directiveSSRProps) directiveSSRProps = {};
                        for (const k in ssrProps) {
                            if (k === 'style' && directiveSSRProps.style) {
                                directiveSSRProps.style = { ...directiveSSRProps.style, ...ssrProps.style };
                            } else if (k === 'class' && directiveSSRProps.class) {
                                directiveSSRProps.class = directiveSSRProps.class + ' ' + ssrProps.class;
                            } else {
                                directiveSSRProps[k] = ssrProps[k];
                            }
                        }
                    }
                }
            }
        }
    }

    // Merge directive SSR props with element props
    const allProps = directiveSSRProps
        ? { ...vnode.props, ...directiveSSRProps, style: mergeSSRStyles(vnode.props?.style, directiveSSRProps?.style) }
        : vnode.props;

    // Serialize props
    for (const key in allProps) {
        const value = allProps[key];
        if (key === 'children' || key === 'key' || key === 'ref') continue;
        if (key.startsWith('client:')) continue; // Skip client directives
        if (key.startsWith('use:')) continue; // Skip element directives
        // Configures the model directive; never rendered. The client has
        // skipped this since forever (patchProp) — the server did not, so a
        // props spread carrying it emitted modelModifiers="[object Object]"
        // on the server and nothing on the client.
        if (key === 'modelModifiers') continue;
        // A two-way Model reaches props under its own name and would
        // stringify to "[object Object]". Skipped on the client too.
        if (isModel(value)) continue;
        // Nullish/false values omit the attribute entirely — matching the
        // client, where patchProp clears the style and removeAttribute-like
        // semantics apply. Without this, an unset pass-through prop like
        // style={props.style} stringified to style="undefined" (#98).
        if (value == null || value === false) continue;

        if (key === 'style') {
            const styleString = typeof value === 'object'
                ? stringifyStyle(value)
                : String(value);
            props += ` style="${escapeHtml(styleString)}"`;
        } else if (key === 'className') {
            props += ` class="${escapeHtml(typeof value === 'string' ? value : String(value))}"`;
        } else if (key.startsWith('on')) {
            // Skip event listeners on server
        } else if (value === true) {
            props += ` ${key}`;
        } else {
            props += ` ${key}="${escapeHtml(typeof value === 'string' ? value : String(value))}"`;
        }
    }

    return props;
}

// ============= The walk: sync generator with a suspension protocol =============

/** Flush hint: the buffer passed the threshold; streaming drivers emit a chunk. */
const FLUSH = Symbol('flush');

/** A suspension: the driver awaits `p` and resumes the walk with the result. */
type Suspend = { p: Promise<unknown> } | typeof FLUSH;

interface RenderBufState {
    /** Characters accumulated in the buffer since the last flush */
    len: number;
    /** Flush-hint threshold (Infinity in string mode: never hint) */
    threshold: number;
    /**
     * True while rendering inside a <Defer> boundary's deferred render:
     * pending keyed reads are awaited inline (block mode) instead of
     * spawning their own placeholders, so the boundary replaces ONCE with
     * everything beneath it resolved. Per-driver — multiple deferred renders
     * interleave on the shared SSRContext, so this must not live on ctx.
     */
    inDefer?: boolean;
    /**
     * True when the last node emitted into the current insertion parent was
     * text. Drives the `<!--t-->` boundary between adjacent text nodes the
     * browser parser would otherwise merge. Walk state, not buffer state:
     * it crosses Fragment and component boundaries (slot content arrives
     * Fragment-wrapped, #575) and survives streaming flushes; any tag or
     * comment emission clears it, so `true` can only mean "the previous
     * emission into the same DOM parent was text".
     */
    lastWasText: boolean;
}

/**
 * Plain-function fast path for component-free subtrees.
 *
 * Generators cost one iterator-object allocation per `yield*` level; for
 * host/text-only subtrees (table rows, markup-heavy fragments) a plain
 * recursive call is markedly cheaper and nothing in such a subtree can
 * suspend. Returns false the moment it sees a component (or unknown node
 * type) — the CALLER must roll `buf`/`state` back to its saved marks and
 * re-render that child through the generator. Bail-out is side-effect-free:
 * component-free rendering touches nothing but the buffer.
 */
function syncSubtreeWorker(
    element: JSXElement,
    appContext: AppContext | null,
    buf: string[],
    state: RenderBufState
): boolean {
    if (element == null || element === false || element === true) {
        return true;
    }

    if ((element as VNode).type === Comment) {
        buf.push('<!---->');
        state.len += 7;
        state.lastWasText = false;
        return true;
    }

    if (typeof element === 'string' || typeof element === 'number') {
        if (state.lastWasText) {
            buf.push('<!--t-->');
            state.len += 8;
        }
        const s = escapeHtml(typeof element === 'string' ? element : String(element));
        buf.push(s);
        state.len += s.length;
        state.lastWasText = true;
        return true;
    }

    const vnode = element as VNode;

    if (vnode.type === Text) {
        if (state.lastWasText) {
            buf.push('<!--t-->');
            state.len += 8;
        }
        const s = escapeHtml(typeof vnode.text === 'string' ? vnode.text : String(vnode.text));
        buf.push(s);
        state.len += s.length;
        state.lastWasText = true;
        return true;
    }

    if (vnode.type === Fragment) {
        for (const child of vnode.children) {
            if (!syncSubtreeWorker(child, appContext, buf, state)) return false;
        }
        return true;
    }

    if (typeof vnode.type === 'string') {
        const tagName = vnode.type;
        const props = serializeOpenTagProps(vnode, appContext);
        state.lastWasText = false;

        if (VOID_ELEMENTS.has(tagName)) {
            const tag = `<${tagName}${props}>`;
            buf.push(tag);
            state.len += tag.length;
            return true;
        }

        const openTag = `<${tagName}${props}>`;
        buf.push(openTag);
        state.len += openTag.length;

        for (const child of vnode.children) {
            if (!syncSubtreeWorker(child, appContext, buf, state)) return false;
        }

        const closeTag = `</${tagName}>`;
        buf.push(closeTag);
        state.len += closeTag.length;
        state.lastWasText = false;
        return true;
    }

    // Components (and anything unrecognized) need the full generator walk
    return false;
}

/**
 * Emit the streaming placeholder wrapper — the frozen
 * `<div data-async-placeholder="ID" style="display:contents;">` protocol —
 * around optional in-place content (a Defer/boundary fallback or a
 * component's initial pre-data render). Shared by the <Defer> streaming
 * branch and the stream-mode async component branch: one emission path for
 * every `flush: 'stream'` rendering.
 */
function* emitStreamPlaceholder(
    id: number,
    content: JSXElement | null | undefined,
    ctx: SSRContext,
    parentContext: ComponentSetupContext | null,
    appContext: AppContext | null,
    buf: string[],
    state: RenderBufState
): Generator<Suspend, void, unknown> {
    const open = `<div data-async-placeholder="${id}" style="display:contents;">`;
    buf.push(open);
    state.len += open.length;
    state.lastWasText = false;
    if (content != null) {
        yield* renderNode(content, ctx, parentContext, appContext, buf, state);
    }
    buf.push('</div>');
    state.len += 6;
    state.lastWasText = false;
}

/**
 * Wrap a raw item array in a synthetic Fragment so a single walk renders it.
 * Deferred renders need this: their HTML is parsed via `template.innerHTML`
 * ($SIGX_REPLACE), which merges adjacent text exactly like the main document
 * parse, so cross-item `<!--t-->` adjacency must be tracked in ONE walk —
 * and the walker itself has no branch for a bare array (it would render
 * nothing at all).
 */
function fragmentOf(items: JSXElement[]): VNode {
    return { type: Fragment, props: {}, key: null, children: items as VNode[], dom: null } as VNode;
}

/** Rollback wrapper: on bail-out, restores buf/state to the entry marks. */
function renderSyncSubtree(
    element: JSXElement,
    appContext: AppContext | null,
    buf: string[],
    state: RenderBufState
): boolean {
    const mark = buf.length;
    const lenMark = state.len;
    const textMark = state.lastWasText;
    if (syncSubtreeWorker(element, appContext, buf, state)) return true;
    buf.length = mark;
    state.len = lenMark;
    state.lastWasText = textMark;
    return false;
}

/**
 * Walk a JSX element, pushing HTML into `buf`.
 *
 * Yields only at suspension points (see module docs). `yield*` threads
 * resumed values and thrown rejections through nested levels, so component
 * code below behaves exactly as the previous `await`-based walk — including
 * error routing into the component-level catch.
 *
 * Children are first attempted through `renderSyncSubtree` (plain calls, no
 * generator allocation); only subtrees that actually contain components fall
 * through to generator delegation.
 */
function* renderNode(
    element: JSXElement,
    ctx: SSRContext,
    parentCtx: ComponentSetupContext | null,
    appContext: AppContext | null,
    buf: string[],
    state: RenderBufState
): Generator<Suspend, void, unknown> {
    if (element == null || element === false || element === true) {
        return;
    }

    // Explicit Comment VNode (normalizeChildren creates these for falsy array items)
    if ((element as VNode).type === Comment) {
        buf.push('<!---->');
        state.len += 7;
        state.lastWasText = false;
        return;
    }

    if (typeof element === 'string' || typeof element === 'number') {
        if (state.lastWasText) {
            buf.push('<!--t-->');
            state.len += 8;
        }
        const s = escapeHtml(typeof element === 'string' ? element : String(element));
        buf.push(s);
        state.len += s.length;
        state.lastWasText = true;
        return;
    }

    const vnode = element as VNode;

    if (vnode.type === Text) {
        if (state.lastWasText) {
            buf.push('<!--t-->');
            state.len += 8;
        }
        const s = escapeHtml(typeof vnode.text === 'string' ? vnode.text : String(vnode.text));
        buf.push(s);
        state.len += s.length;
        state.lastWasText = true;
        return;
    }

    if (vnode.type === Fragment) {
        for (const child of vnode.children) {
            if (!renderSyncSubtree(child, appContext, buf, state)) {
                yield* renderNode(child, ctx, parentCtx, appContext, buf, state);
            } else if (state.len >= state.threshold) {
                yield FLUSH;
            }
        }
        return;
    }

    // Handle Components
    if (isComponent(vnode.type)) {
        // Lazy components await their module inline. After the suspension the
        // wrapper's setup sees state 'resolved' and renders the real component
        // immediately — no empty output, no fallback-forever (F4).
        const factory = vnode.type as any;
        if (factory.__lazy && !factory.isLoaded()) {
            // Swallow rejection here — setup() rethrows the stored error and
            // routes it through the component error fallback below.
            yield { p: factory.preload().catch(() => undefined) };
        }

        // <Defer> boundaries in streaming mode: stream the fallback now,
        // replace with the real children once everything pending beneath
        // them — lazy chunks AND keyed useData reads — resolves, reusing the
        // standard placeholder/$SIGX_REPLACE machinery. In blocking/string
        // mode Defer needs no special handling: lazy children await inline
        // (above), keyed reads block per component, and the Defer component
        // renders its children directly.
        if (factory.__defer && ctx._streaming) {
            const id = ctx.nextId();
            const props = vnode.props || {};

            const fallback = typeof props.fallback === 'function' ? props.fallback() : props.fallback;
            yield* emitStreamPlaceholder(id, fallback, ctx, parentCtx, appContext, buf, state);

            const children = props.children;
            const items: JSXElement[] = Array.isArray(children)
                ? children
                : children != null ? [children] : [];
            const capturedParentCtx = parentCtx;

            const deferredRender = (async () => {
                // Leading comment mirrors the client Defer's constant render
                // shape ([fallback-or-comment, …children]) so the streamed
                // replacement hydrates against the client's null-fallback slot.
                // One walk over a synthetic Fragment, not a call per item —
                // cross-item text adjacency needs the shared marker state.
                // The deferred driver awaits unresolved lazy() preloads
                // inline (rule above) and — via inDefer — blocks on keyed
                // useData reads too, so this resolves to real content.
                return '<!---->' + await renderVNodeToString(fragmentOf(items), ctx, appContext, capturedParentCtx, { inDefer: true });
            })();

            ctx._pendingAsync.push({ id, promise: deferredRender });

            // Trailing marker for hydration parity with regular components —
            // the client's component walk anchors on it.
            const marker = `<!--$c:${id}-->`;
            buf.push(marker);
            state.len += marker.length;
            state.lastWasText = false;

            if (state.len >= state.threshold) yield FLUSH;
            return;
        }

        // The component id is allocated (and pushed) BEFORE the boundary
        // consult and the setup context — resolveBoundary and
        // transformComponentContext both read their own id at the stack top.
        // The nextId() call order is wire (marker sequence): keep it exactly
        // here, matching where createComponentState allocated it before.
        const id = ctx.nextId();
        ctx.pushComponent(id);

        // Plugin hook: resolveBoundary (rfc-ssr-platform §1.3) — the one
        // pre-setup boundary decision. First plugin to return wins.
        let boundary: ResolvedBoundary | undefined;
        if (ctx._plugins) {
            for (const plugin of ctx._plugins) {
                const resolved = plugin.server?.resolveBoundary?.(vnode, ctx);
                if (resolved) {
                    boundary = resolved;
                    break;
                }
            }
        }

        if (boundary) {
            // Record the boundary for the client hydrator. `flush` is
            // serialized only for 'skip' (fresh-mount vs hydrate is the only
            // client-relevant distinction); everything else on the flush axis
            // is a server-side concern.
            const record: SSRBoundaryRecord = {};
            if (boundary.flush === 'skip') record.flush = 'skip';
            if (boundary.hydrate !== undefined) record.hydrate = boundary.hydrate;
            if (boundary.media !== undefined) record.media = boundary.media;
            if (boundary.chunk !== undefined) record.chunk = boundary.chunk;
            // The winner names its boundary; core derivation is the fallback.
            const registryName =
                boundary.component || (vnode.type as any).__islandId || (vnode.type as any).__name;
            if (registryName) record.component = registryName;
            // A present `props` key wins even when undefined ("no props") —
            // packs pass their filtered snapshot explicitly so the core
            // derivation never re-includes their directive vocabulary.
            const props = 'props' in boundary
                ? boundary.props
                : serializeBoundaryProps(vnode.props, getTypeHandlers(ctx));
            if (props !== undefined) record.props = props;
            ctx.recordBoundary(id, record);
        }

        // flush: 'skip' — true skip-SSR (islands client:only). Setup never
        // runs; transformComponentContext and afterRenderComponent are not
        // called. Core emits the placeholder wrapper (the client's mount
        // container) around the optional fallback, then the standard
        // trailing marker.
        if (boundary && boundary.flush === 'skip') {
            const open = `<div data-boundary="${id}" style="display:contents;">`;
            buf.push(open);
            state.len += open.length;
            state.lastWasText = false;
            if (boundary.fallback) {
                try {
                    yield* renderNode(boundary.fallback(), ctx, parentCtx, appContext, buf, state);
                } catch (e) {
                    const skipName = (vnode.type as any).__name || 'Anonymous';
                    const fallbackHtml = componentErrorFallback(e, ctx, skipName, id);
                    if (fallbackHtml) {
                        buf.push(fallbackHtml);
                        state.len += fallbackHtml.length;
                        state.lastWasText = false;
                    }
                }
            }
            buf.push('</div>');
            state.len += 6;
            const marker = `<!--$c:${id}-->`;
            buf.push(marker);
            state.len += marker.length;
            state.lastWasText = false;
            ctx.popComponent();
            if (state.len >= state.threshold) yield FLUSH;
            return;
        }

        const setup = vnode.type.__setup;
        const { componentName, ssrLoads, componentCtx } = createComponentState(vnode, ctx, parentCtx, appContext, id);

        // Rewind marks for a possible errorScope fallback (consulted only
        // when a scope catches below).
        const bufMark = buf.length;
        const lenMark = state.len;
        const textMark = state.lastWasText;
        let ownScope: ServerErrorScope | null = null;
        let scopeMarks: {
            pendingAsync: number;
            pendingStreams: number;
            headConfigs: number;
            boundaries: number;
            threshold: number;
        } | null = null;

        const prev = setCurrentInstance(componentCtx);
        try {
            // Run setup synchronously — it registers useAsync/useStream work
            let renderFn = setup(componentCtx);

            // Support legacy async setup — suspend if it returns a promise
            if (renderFn && typeof (renderFn as any).then === 'function') {
                renderFn = (yield { p: renderFn as Promise<any> }) as any;
            }

            // errorScope (rfc-ssr-platform §2.2): a scoped subtree must stay
            // rewindable — suppress mid-subtree flushing (bytes that left the
            // process cannot be taken back) and snapshot the per-request
            // containers descendants append to, so a caught throw can undo
            // the partial subtree before the fallback renders in its place.
            ownScope = (componentCtx as any).__errorScope ?? null;
            if (ownScope) {
                scopeMarks = {
                    pendingAsync: ctx._pendingAsync.length,
                    pendingStreams: ctx._pendingStreams.length,
                    headConfigs: ctx._headConfigs.length,
                    boundaries: ctx._boundaries.size,
                    threshold: state.threshold
                };
                state.threshold = Infinity;
            }

            // Check if we have pending useAsync/useStream work
            if (ssrLoads.length > 0) {
                // The flush decision. A resolveBoundary flush wins:
                // - 'inline' awaits in place even in streaming mode;
                // - 'stream' streams when streaming (degrades to block in
                //   string mode — a $SIGX_REPLACE with no stream to ride);
                // - otherwise today's default: 'stream' in streaming mode,
                //   'block' in string mode — and 'block' inside a <Defer>
                //   deferred render, so the boundary's single replacement
                //   carries the resolved data instead of nesting its own
                //   placeholders.
                let asyncMode: 'block' | 'stream';
                if (boundary?.flush === 'inline') {
                    asyncMode = 'block';
                } else if (boundary?.flush === 'stream') {
                    asyncMode = ctx._streaming ? 'stream' : 'block';
                } else {
                    asyncMode = (ctx._streaming && !state.inDefer) ? 'stream' : 'block';
                }

                if (asyncMode === 'stream') {
                    // Render the placeholder wrapper immediately (frozen literal)
                    const placeholder = `<div data-async-placeholder="${id}" style="display:contents;">`;
                    buf.push(placeholder);
                    state.len += placeholder.length;
                    state.lastWasText = false;

                    if (boundary?.fallback) {
                        // A boundary fallback renders in place of content
                        // (rfc-ssr-platform §1) — instead of the initial-state
                        // pass. Rendered under the parent (it is the plugin's
                        // content, not the component's).
                        yield* renderNode(boundary.fallback(), ctx, parentCtx, appContext, buf, state);
                    } else if (renderFn) {
                        // Render with initial state (before data loads)
                        const result = (renderFn as () => any)();
                        if (result) {
                            if (Array.isArray(result)) {
                                for (const item of result) {
                                    if (!renderSyncSubtree(item, appContext, buf, state)) {
                                        yield* renderNode(item, ctx, componentCtx, appContext, buf, state);
                                    }
                                }
                            } else if (!renderSyncSubtree(result, appContext, buf, state)) {
                                yield* renderNode(result, ctx, componentCtx, appContext, buf, state);
                            }
                        }
                    }

                    buf.push('</div>');
                    state.len += 6;
                    state.lastWasText = false;

                    // Core always manages the deferred render and race-loop entry
                    const capturedRenderFn = renderFn;
                    const capturedCtx = ctx;
                    const capturedAppContext = appContext;
                    const capturedComponentCtx = componentCtx;

                    const deferredRender = (async () => {
                        await Promise.all(ssrLoads);

                        let html = '';
                        if (capturedRenderFn) {
                            // This continuation runs with the current-instance
                            // slot wherever the last walk left it. The deferred
                            // render is THIS component's frame — its render
                            // function and the walk of what it returns — so
                            // re-establish it for the span, as the blocking
                            // branch has it set by construction (#552).
                            const prevInstance = setCurrentInstance(capturedComponentCtx);
                            try {
                                const result = (capturedRenderFn as () => any)();
                                if (result) {
                                    html = await renderVNodeToString(result, capturedCtx, capturedAppContext, capturedComponentCtx);
                                }
                            } finally {
                                setCurrentInstance(prevInstance);
                            }
                        }

                        return html;
                    })();

                    ctx._pendingAsync.push({ id, promise: deferredRender });
                } else {
                    // Default: block — suspend until all async loads settle.
                    // A rejection is thrown back in here by the driver, landing
                    // in the catch below exactly like the old inline await.
                    yield { p: Promise.all(ssrLoads) };

                    if (renderFn) {
                        const result = (renderFn as () => any)();
                        if (result) {
                            if (Array.isArray(result)) {
                                for (const item of result) {
                                    if (!renderSyncSubtree(item, appContext, buf, state)) {
                                        yield* renderNode(item, ctx, componentCtx, appContext, buf, state);
                                    }
                                }
                            } else if (!renderSyncSubtree(result, appContext, buf, state)) {
                                yield* renderNode(result, ctx, componentCtx, appContext, buf, state);
                            }
                        }
                    }
                }
            } else {
                // No async loads — render synchronously
                if (renderFn) {
                    const result = (renderFn as () => any)();
                    if (result) {
                        if (Array.isArray(result)) {
                            for (const item of result) {
                                if (!renderSyncSubtree(item, appContext, buf, state)) {
                                    yield* renderNode(item, ctx, componentCtx, appContext, buf, state);
                                }
                            }
                        } else if (!renderSyncSubtree(result, appContext, buf, state)) {
                            yield* renderNode(result, ctx, componentCtx, appContext, buf, state);
                        }
                    }
                }
            }
        } catch (e) {
            const raw = e instanceof ScopeThrow
                ? e.original
                : (e instanceof Error ? e : new Error(String(e)));
            const claimedScope = e instanceof ScopeThrow ? e.scope : findEnclosingScope(componentCtx);
            // Re-read from the ctx: setup may have called errorScope() and
            // THEN thrown, before the post-setup ownScope read ran.
            const ownScopeNow: ServerErrorScope | null =
                ownScope ?? ((componentCtx as any).__errorScope ?? null);

            if (claimedScope && claimedScope !== ownScopeNow) {
                // An enclosing scope owns this error — propagate up the
                // generator stack to the owning component's frame.
                throw e instanceof ScopeThrow ? e : new ScopeThrow(raw, claimedScope);
            }

            if (claimedScope && ownScopeNow && claimedScope === ownScopeNow) {
                // This component's errorScope catches: rewind everything the
                // subtree produced and render the fallback in its place —
                // the same visual contract as the client (rfc-async §4).
                buf.length = bufMark;
                state.len = lenMark;
                state.lastWasText = textMark;
                if (scopeMarks) {
                    ctx._pendingAsync.length = scopeMarks.pendingAsync;
                    ctx._pendingStreams.length = scopeMarks.pendingStreams;
                    ctx._headConfigs.length = scopeMarks.headConfigs;
                    if (ctx._boundaries.size > scopeMarks.boundaries) {
                        // Map preserves insertion order — entries past the
                        // mark belong to the rewound subtree.
                        const doomed = Array.from(ctx._boundaries.keys()).slice(scopeMarks.boundaries);
                        for (const key of doomed) ctx._boundaries.delete(key);
                    }
                }
                // Descendant frames bailed without popping — restore this
                // component to the top of the id stack.
                while (
                    ctx._componentStack.length > 0 &&
                    ctx._componentStack[ctx._componentStack.length - 1] !== id
                ) {
                    ctx.popComponent();
                }

                if (__DEV__) {
                    console.error(`[errorScope] server render failed below <${componentName}>:`, raw);
                }

                // Notify the scope exactly like the client's error walk would
                // (fires the scope's onError observer, marks it errored).
                const handle = getProvided((componentCtx as { provides?: Map<symbol, unknown> }).provides, ERROR_SCOPE_TOKEN);
                handle?.handle(raw, null, 'ssr render');

                if (ownScopeNow.fallback) {
                    // Server-side retry is inert; the boundary marking below
                    // wires the client's retry to a real remount.
                    const retryNoop = () => { /* remounts after hydration */ };
                    try {
                        yield* renderNode(ownScopeNow.fallback(raw, retryNoop), ctx, componentCtx, appContext, buf, state);
                    } catch (fallbackErr) {
                        const fallbackHtml = componentErrorFallback(fallbackErr, ctx, componentName, id);
                        if (fallbackHtml) {
                            buf.push(fallbackHtml);
                            state.len += fallbackHtml.length;
                            state.lastWasText = false;
                        }
                    }
                }

                // Mark the boundary so the hydrator seeds the client scope
                // errored: the fallback hydrates against this exact HTML and
                // retry() performs the remount the server could not.
                ctx.recordBoundary(id, {
                    ...ctx._boundaries.get(id),
                    hydrate: 'load',
                    errorScope: { message: raw.message }
                });
            } else {
                const fallbackHtml = componentErrorFallback(e, ctx, componentName, id);
                if (fallbackHtml) {
                    buf.push(fallbackHtml);
                    state.len += fallbackHtml.length;
                    state.lastWasText = false;
                }
            }
        } finally {
            if (scopeMarks) state.threshold = scopeMarks.threshold;
            setCurrentInstance(prev || null);
        }

        // Collect rendered HTML for plugin post-processing
        // Note: afterRenderComponent receives an empty string — chunks are
        // accumulated in the shared buffer. Plugins that need to wrap content
        // should use transformComponentContext to set up wrapping.

        // Plugin hook: afterRenderComponent
        if (ctx._plugins) {
            for (const plugin of ctx._plugins) {
                const transformed = plugin.server?.afterRenderComponent?.(id, vnode, '', ctx);
                if (transformed) {
                    buf.push(transformed);
                    state.len += transformed.length;
                    state.lastWasText = false;
                }
            }
        }

        // Emit trailing component marker
        const marker = `<!--$c:${id}-->`;
        buf.push(marker);
        state.len += marker.length;
        state.lastWasText = false;
        ctx.popComponent();

        if (state.len >= state.threshold) yield FLUSH;
        return;
    }

    // Handle host elements
    if (typeof vnode.type === 'string') {
        const tagName = vnode.type;
        const props = serializeOpenTagProps(vnode, appContext);
        state.lastWasText = false;

        // Void elements
        if (VOID_ELEMENTS.has(tagName)) {
            const tag = `<${tagName}${props}>`;
            buf.push(tag);
            state.len += tag.length;
            if (state.len >= state.threshold) yield FLUSH;
            return;
        }

        // Fast path: if all children are leaf types (text/number/null/bool),
        // render entire element as a single string. Children start a fresh
        // parent context, so the loop-local adjacency tracking is exact here.
        if (vnode.children.length > 0 && allChildrenAreLeaves(vnode.children)) {
            let html = `<${tagName}${props}>`;
            let prevWasText = false;
            for (const child of vnode.children) {
                const isText = isTextContent(child);
                if (isText && prevWasText) html += '<!--t-->';
                if (child != null && (child as any) !== false && (child as any) !== true) {
                    const cv = child as VNode;
                    const raw = cv.type === Text ? cv.text : child;
                    html += escapeHtml(typeof raw === 'string' ? raw : String(raw));
                }
                prevWasText = isText;
            }
            html += `</${tagName}>`;
            buf.push(html);
            state.len += html.length;
            if (state.len >= state.threshold) yield FLUSH;
            return;
        }

        const openTag = `<${tagName}${props}>`;
        buf.push(openTag);
        state.len += openTag.length;

        // Adjacent text nodes get merged by the browser; the leaf emission
        // sites separate them with <!--t--> via state.lastWasText.
        for (const child of vnode.children) {
            if (!renderSyncSubtree(child, appContext, buf, state)) {
                yield* renderNode(child, ctx, parentCtx, appContext, buf, state);
            } else if (state.len >= state.threshold) {
                yield FLUSH;
            }
        }

        const closeTag = `</${tagName}>`;
        buf.push(closeTag);
        state.len += closeTag.length;
        state.lastWasText = false;

        if (state.len >= state.threshold) yield FLUSH;
    }
}

// ============= Drivers =============

/** Default streaming flush threshold — matches the historical chunk batching. */
const STREAM_FLUSH_THRESHOLD = 4096;

/**
 * Render element to string chunks (async generator for streaming).
 *
 * Drives the sync walk: HTML accumulates in a shared buffer and is emitted
 * as ~4KB chunks at flush hints and before every await, preserving streaming
 * TTFB while removing the per-vnode AsyncGenerator overhead.
 *
 * @param element - The JSX element to render
 * @param ctx - The SSR context for tracking state
 * @param parentCtx - The parent component context for provide/inject
 * @param appContext - The app context for app-level provides (from defineApp)
 */
export async function* renderToChunks(
    element: JSXElement,
    ctx: SSRContext,
    parentCtx: ComponentSetupContext | null = null,
    appContext: AppContext | null = null
): AsyncGenerator<string> {
    const buf: string[] = [];
    // Flushes reset only buf/len below — lastWasText is walk state and must
    // survive chunk boundaries (text in chunk N+1 can follow text in chunk N).
    const state: RenderBufState = { len: 0, threshold: STREAM_FLUSH_THRESHOLD, lastWasText: false };
    const gen = renderNode(element, ctx, parentCtx, appContext, buf, state);

    let result = gen.next();
    while (!result.done) {
        if (buf.length > 0) {
            // Flush before awaiting so pending output isn't held back across
            // async gaps (and at explicit FLUSH hints).
            const chunk = buf.join('');
            buf.length = 0;
            state.len = 0;
            yield chunk;
        }

        const suspend = result.value;
        if (suspend === FLUSH) {
            result = gen.next();
        } else {
            // The suspended frame sits between its setCurrentInstance and
            // its finally, so the slot is ITS component right now — and
            // every other walk in the process (a concurrent render, a
            // deferred closure) is free to move it while we await. Put it
            // back before re-entering the generator, on the throw path
            // too, so getCurrentInstance() is right for the synchronous
            // span that follows the resume (#552).
            const saved = getCurrentInstance();
            try {
                const v = await suspend.p;
                setCurrentInstance(saved);
                result = gen.next(v);
            } catch (e) {
                // Route the rejection into the walk — the component-level
                // catch produces its error fallback, same as an inline await.
                setCurrentInstance(saved);
                result = gen.throw(e);
            }
        }
    }

    if (buf.length > 0) {
        yield buf.join('');
    }
}

/**
 * Helper to render a VNode to string (also used for deferred async content).
 *
 * Fully synchronous trees complete in a single `gen.next()` call with no
 * promise allocations beyond the implicit async-function wrapper.
 *
 * @param parentCtx - optional parent component context so deferred renders
 *   keep their provide/inject chain
 */
export async function renderVNodeToString(element: JSXElement, ctx: SSRContext, appContext: AppContext | null = null, parentCtx: ComponentSetupContext | null = null, opts?: { inDefer?: boolean }): Promise<string> {
    // A component's render function can return a raw array (the walker has
    // no branch for one — it would render NOTHING); deferred renders hand
    // such results straight here. Wrap in a Fragment so the walk consumes it.
    if (Array.isArray(element)) element = fragmentOf(element);
    const buf: string[] = [];
    const state: RenderBufState = { len: 0, threshold: Infinity, inDefer: opts?.inDefer, lastWasText: false };
    const gen = renderNode(element, ctx, parentCtx, appContext, buf, state);

    let result = gen.next();
    while (!result.done) {
        const suspend = result.value;
        if (suspend === FLUSH) {
            result = gen.next();
            continue;
        }
        // Same save/restore as renderToChunks (#552).
        const saved = getCurrentInstance();
        try {
            const v = await suspend.p;
            setCurrentInstance(saved);
            result = gen.next(v);
        } catch (e) {
            setCurrentInstance(saved);
            result = gen.throw(e);
        }
    }

    return buf.join('');
}
