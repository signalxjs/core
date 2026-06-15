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
    isDirective
} from 'sigx';
import type { JSXElement, ComponentSetupContext, SlotsObject, DirectiveDefinition, AppContext } from 'sigx';
import {
    setCurrentInstance,
    createPropsAccessor,
    provideAppContext,
    resolveBuiltInDirective,
} from 'sigx/internals';
import type { SSRContext } from './context';
import { generateAppendScript } from './streaming';

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

const styleCommentRE = /\/\*[^]*?\*\//g;

/**
 * Parse a CSS string into a style object.
 *
 * Handles edge cases: parens in values (e.g., `linear-gradient(...)`),
 * CSS comments, and colons in values.
 *
 * @internal exported for direct unit tests only
 */
export function parseStringStyle(cssText: string): Record<string, string> {
    const ret: Record<string, string> = {};
    const stripped = cssText.replace(styleCommentRE, '');
    let start = 0;
    let depth = 0;

    for (let i = 0; i <= stripped.length; i++) {
        const ch = stripped.charCodeAt(i);
        if (ch === 40 /* ( */) { depth++; continue; }
        if (ch === 41 /* ) */) { depth--; continue; }
        // Split on ';' only outside parentheses, or at end of string
        if ((ch === 59 /* ; */ && depth === 0) || i === stripped.length) {
            const decl = stripped.slice(start, i);
            start = i + 1;
            const colon = decl.indexOf(':');
            if (colon > 0) {
                const prop = decl.slice(0, colon).trim();
                const value = decl.slice(colon + 1).trim();
                if (prop) ret[prop] = value;
            }
        }
    }
    return ret;
}

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
    appContext: AppContext | null
): ComponentRenderState {
    const componentName = (vnode.type as any).__name || 'Anonymous';
    const allProps = vnode.props || {};

    // Destructure props (filter out framework-internal keys)
    const { children, slots: slotsFromProps, $models: _modelsData, ...propsData } = allProps;

    const id = ctx.nextId();
    ctx.pushComponent(id);

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
    if (children != null && typeof children !== 'boolean') {
        const items = Array.isArray(children) ? children : [children];
        for (const child of items) {
            if (child && typeof child === 'object' && child.props && child.props.slot) {
                const name = child.props.slot;
                (elementNamed[name] ?? (elementNamed[name] = [])).push(child);
            } else if (child != null && child !== false && child !== true) {
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
        slots.default = () => defaultChildren.slice();
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
        slots[name] = () => list.slice();
    }
    // Slots provided via the `slots` prop take precedence over element-based
    // ones of the same name, matching the client extractor.
    if (slotsFromProps) {
        for (const name of Object.keys(slotsFromProps)) {
            if (typeof slotsFromProps[name] === 'function') {
                slots[name] = slotsFromProps[name];
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
        // setup() will actually receive.
        if (!(componentCtx as any)._useAsync) {
            (componentCtx as any).__ssrCtx = ctx;
            (componentCtx as any).__ssrId = id;
            (componentCtx as any)._useAsync = serverUseAsync;
            (componentCtx as any)._useStream = serverUseStream;
        }
    }

    // For ROOT component only (no parent), provide the AppContext
    if (!parentCtx && appContext) {
        provideAppContext(componentCtx, appContext);
    }

    return { componentName, id, ssrLoads, componentCtx };
}

/** Append a serialization key to the component's record (for streaming preScripts). */
function recordComponentKey(ctx: SSRContext, id: number, key: string): void {
    const keys = ctx._asyncKeysByComponent.get(id);
    if (keys) {
        if (!keys.includes(key)) keys.push(key);
    } else {
        ctx._asyncKeysByComponent.set(id, [key]);
    }
}

/** Shared inert state for unkeyed / { server: false } calls on the server. */
const INERT_ASYNC_STATE = {
    value: null,
    loading: true,
    error: null,
    refresh: () => Promise.resolve()
};

/**
 * useAsync server provider (shared; invoked as instance._useAsync(...)).
 *
 * Keyed calls fetch on the server (deduped per request by key), settle
 * through the component's ssrLoads (block: awaited inline; streaming:
 * deferred behind the placeholder), and record their value for the
 * __SIGX_ASYNC__ hydration blob. Unkeyed / { server: false } calls never
 * run here — the loading branch renders into the HTML and the client
 * fetches after hydration.
 */
function serverUseAsync(
    this: any,
    key: string | null,
    fetcher: (fctx: { signal: AbortSignal }) => Promise<unknown>,
    options: { throwOnError?: boolean; server?: boolean } = {}
) {
    if (key === null || options.server === false) {
        return INERT_ASYNC_STATE;
    }

    const ctx: SSRContext = this.__ssrCtx;
    const id: number = this.__ssrId;
    const ssrLoads: Promise<void>[] = this._ssrLoads;

    const state = { data: null as unknown, pending: true, failure: null as Error | null };

    // Request-level dedupe: same key → one fetch, shared result
    let promise = ctx._asyncCache.get(key);
    if (!promise) {
        promise = fetcher({ signal: new AbortController().signal });
        ctx._asyncCache.set(key, promise);
    }

    const settled = (promise as Promise<unknown>).then(value => {
        state.data = value;
        state.pending = false;
        ctx._asyncResults.set(key, value);
        recordComponentKey(ctx, id, key);
    }, e => {
        state.failure = e instanceof Error ? e : new Error(String(e));
        state.pending = false;
        if (options.throwOnError) {
            // Reject the load → component error fallback (block mode) or
            // error replacement (streaming) — same as a setup throw.
            throw state.failure;
        }
        // Soft failure: the component renders its own error branch.
        // Nothing is serialized — the client refetches (fail-safe).
    });
    ssrLoads.push(settled);

    return {
        get value() { return state.data; },
        get loading() { return state.pending; },
        get error() {
            if (options.throwOnError && state.failure) throw state.failure;
            return state.failure;
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
    if (process.env.NODE_ENV !== 'production') {
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
        recordComponentKey(ctx, id, key);
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
                    yield generateAppendScript(id, token);
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
 * Error fallback for a failed component. Returns the HTML to emit in place of
 * the component ('' emits nothing).
 */
function componentErrorFallback(e: unknown, ctx: SSRContext, componentName: string, id: number): string {
    const error = e instanceof Error ? e : new Error(String(e));
    let fallbackHtml: string | null = null;

    if (ctx._onComponentError) {
        fallbackHtml = ctx._onComponentError(error, componentName, id);
    }

    if (fallbackHtml === null || fallbackHtml === undefined) {
        fallbackHtml = `<!--ssr-error:${id}-->`;
    }

    if (process.env.NODE_ENV !== 'production') {
        console.error(`Error rendering component ${componentName}:`, e);
    }

    return fallbackHtml;
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
        return true;
    }

    if (typeof element === 'string' || typeof element === 'number') {
        const s = escapeHtml(typeof element === 'string' ? element : String(element));
        buf.push(s);
        state.len += s.length;
        return true;
    }

    const vnode = element as VNode;

    if (vnode.type === Text) {
        const s = escapeHtml(typeof vnode.text === 'string' ? vnode.text : String(vnode.text));
        buf.push(s);
        state.len += s.length;
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

        if (VOID_ELEMENTS.has(tagName)) {
            const tag = `<${tagName}${props}>`;
            buf.push(tag);
            state.len += tag.length;
            return true;
        }

        const openTag = `<${tagName}${props}>`;
        buf.push(openTag);
        state.len += openTag.length;

        let prevWasText = false;
        for (const child of vnode.children) {
            const isText = isTextContent(child);
            if (isText && prevWasText) {
                buf.push('<!--t-->');
                state.len += 8;
            }
            if (!syncSubtreeWorker(child, appContext, buf, state)) return false;
            prevWasText = isText;
        }

        const closeTag = `</${tagName}>`;
        buf.push(closeTag);
        state.len += closeTag.length;
        return true;
    }

    // Components (and anything unrecognized) need the full generator walk
    return false;
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
    if (syncSubtreeWorker(element, appContext, buf, state)) return true;
    buf.length = mark;
    state.len = lenMark;
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
        return;
    }

    if (typeof element === 'string' || typeof element === 'number') {
        const s = escapeHtml(typeof element === 'string' ? element : String(element));
        buf.push(s);
        state.len += s.length;
        return;
    }

    const vnode = element as VNode;

    if (vnode.type === Text) {
        const s = escapeHtml(typeof vnode.text === 'string' ? vnode.text : String(vnode.text));
        buf.push(s);
        state.len += s.length;
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

        // Suspense boundaries in streaming mode: stream the fallback now,
        // replace with the real children once their lazy deps resolve —
        // reusing the standard placeholder/$SIGX_REPLACE machinery. In
        // blocking/string mode Suspense needs no special handling: lazy
        // children await inline (above), so the boundary never has pending
        // promises and Suspense renders its children directly.
        if (factory.__suspense && ctx._streaming) {
            const id = ctx.nextId();
            const props = vnode.props || {};

            const placeholder = `<div data-async-placeholder="${id}" style="display:contents;">`;
            buf.push(placeholder);
            state.len += placeholder.length;

            const fallback = typeof props.fallback === 'function' ? props.fallback() : props.fallback;
            if (fallback != null) {
                yield* renderNode(fallback, ctx, parentCtx, appContext, buf, state);
            }

            buf.push('</div>');
            state.len += 6;

            const children = props.children;
            const items: JSXElement[] = Array.isArray(children)
                ? children
                : children != null ? [children] : [];
            const capturedParentCtx = parentCtx;

            const deferredRender = (async () => {
                let html = '';
                for (const item of items) {
                    // The deferred driver awaits unresolved lazy() preloads
                    // inline (rule above), so this resolves to real content.
                    html += await renderVNodeToString(item, ctx, appContext, capturedParentCtx);
                }
                return html;
            })();

            ctx._pendingAsync.push({ id, promise: deferredRender });

            // Trailing marker for hydration parity with regular components —
            // the client's component walk anchors on it.
            const marker = `<!--$c:${id}-->`;
            buf.push(marker);
            state.len += marker.length;

            if (state.len >= state.threshold) yield FLUSH;
            return;
        }

        const setup = vnode.type.__setup;
        const { componentName, id, ssrLoads, componentCtx } = createComponentState(vnode, ctx, parentCtx, appContext);

        const prev = setCurrentInstance(componentCtx);
        try {
            // Run setup synchronously — it registers useAsync/useStream work
            let renderFn = setup(componentCtx);

            // Support legacy async setup — suspend if it returns a promise
            if (renderFn && typeof (renderFn as any).then === 'function') {
                renderFn = (yield { p: renderFn as Promise<any> }) as any;
            }

            // Check if we have pending useAsync/useStream work
            if (ssrLoads.length > 0) {
                // Plugin hook: handleAsyncSetup
                // Plugins can override the async mode.
                // Default: 'stream' in streaming mode, 'block' in string mode.
                let asyncMode: 'block' | 'stream' | 'skip' = ctx._streaming ? 'stream' : 'block';
                let asyncPlaceholder: string | undefined;
                let pluginHandled = false;

                if (ctx._plugins) {
                    for (const plugin of ctx._plugins) {
                        const result = plugin.server?.handleAsyncSetup?.(id, ssrLoads, renderFn as () => any, ctx);
                        if (result) {
                            asyncMode = result.mode;
                            asyncPlaceholder = result.placeholder;
                            pluginHandled = true;
                            break; // First plugin to handle wins
                        }
                    }
                }

                if (asyncMode === 'stream') {
                    // Use default placeholder if none provided by plugin
                    const placeholder = asyncPlaceholder || `<div data-async-placeholder="${id}" style="display:contents;">`;

                    // Render placeholder immediately
                    buf.push(placeholder);
                    state.len += placeholder.length;

                    // Render with initial state (before data loads)
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

                    buf.push('</div>');
                    state.len += 6;

                    // If no plugin handled this, core manages the deferred render
                    if (!pluginHandled) {
                        const capturedRenderFn = renderFn;
                        const capturedCtx = ctx;
                        const capturedAppContext = appContext;
                        const capturedComponentCtx = componentCtx;

                        const deferredRender = (async () => {
                            await Promise.all(ssrLoads);

                            let html = '';
                            if (capturedRenderFn) {
                                const result = (capturedRenderFn as () => any)();
                                if (result) {
                                    html = await renderVNodeToString(result, capturedCtx, capturedAppContext, capturedComponentCtx);
                                }
                            }

                            return html;
                        })();

                        ctx._pendingAsync.push({ id, promise: deferredRender });
                    }
                } else if (asyncMode === 'skip') {
                    // Plugin says skip — don't render content
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
            const fallbackHtml = componentErrorFallback(e, ctx, componentName, id);
            if (fallbackHtml) {
                buf.push(fallbackHtml);
                state.len += fallbackHtml.length;
            }
        } finally {
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
                }
            }
        }

        // Emit trailing component marker
        const marker = `<!--$c:${id}-->`;
        buf.push(marker);
        state.len += marker.length;
        ctx.popComponent();

        if (state.len >= state.threshold) yield FLUSH;
        return;
    }

    // Handle host elements
    if (typeof vnode.type === 'string') {
        const tagName = vnode.type;
        const props = serializeOpenTagProps(vnode, appContext);

        // Void elements
        if (VOID_ELEMENTS.has(tagName)) {
            const tag = `<${tagName}${props}>`;
            buf.push(tag);
            state.len += tag.length;
            if (state.len >= state.threshold) yield FLUSH;
            return;
        }

        // Fast path: if all children are leaf types (text/number/null/bool),
        // render entire element as a single string.
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

        // Render children with text boundary markers
        // Adjacent text nodes get merged by the browser, so we insert <!--t--> markers
        let prevWasText = false;
        for (const child of vnode.children) {
            const isText = isTextContent(child);
            if (isText && prevWasText) {
                // Insert marker between adjacent text nodes
                buf.push('<!--t-->');
                state.len += 8;
            }
            if (!renderSyncSubtree(child, appContext, buf, state)) {
                yield* renderNode(child, ctx, parentCtx, appContext, buf, state);
            } else if (state.len >= state.threshold) {
                yield FLUSH;
            }
            prevWasText = isText;
        }

        const closeTag = `</${tagName}>`;
        buf.push(closeTag);
        state.len += closeTag.length;

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
    const state: RenderBufState = { len: 0, threshold: STREAM_FLUSH_THRESHOLD };
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
            try {
                const v = await suspend.p;
                result = gen.next(v);
            } catch (e) {
                // Route the rejection into the walk — the component-level
                // catch produces its error fallback, same as an inline await.
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
export async function renderVNodeToString(element: JSXElement, ctx: SSRContext, appContext: AppContext | null = null, parentCtx: ComponentSetupContext | null = null): Promise<string> {
    const buf: string[] = [];
    const state: RenderBufState = { len: 0, threshold: Infinity };
    const gen = renderNode(element, ctx, parentCtx, appContext, buf, state);

    let result = gen.next();
    while (!result.done) {
        const suspend = result.value;
        if (suspend === FLUSH) {
            result = gen.next();
            continue;
        }
        try {
            const v = await suspend.p;
            result = gen.next(v);
        } catch (e) {
            result = gen.throw(e);
        }
    }

    return buf.join('');
}
