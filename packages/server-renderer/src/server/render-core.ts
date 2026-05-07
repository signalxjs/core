/**
 * Core rendering logic for SSR
 *
 * The async generator `renderToChunks` walks a VNode tree and yields HTML strings.
 * Handles text, fragments, host elements, and delegates components to the
 * component renderer.
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

// ============= HTML Utilities =============

const ESCAPE: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ESCAPE[c]);
}

/** Cache for camelCase → kebab-case conversions (same properties repeat across elements) */
const kebabCache: Record<string, string> = {};

/** Void elements that cannot have children — hoisted to module scope as a Set for O(1) lookup */
const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export function camelToKebab(str: string): string {
    // CSS custom properties (--foo) are already kebab-case
    if (str.startsWith('--')) return str;
    return kebabCache[str] ||= str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

// ============= Style Parsing =============

/**
 * Parse a CSS string into a style object.
 *
 * Handles edge cases: parens in values (e.g., `linear-gradient(...)`),
 * CSS comments, and colons in values.
 */
const styleCommentRE = /\/\*[^]*?\*\//g;

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

/**
 * Render element to string chunks (generator for streaming)
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
    if (element == null || element === false || element === true) {
        return;
    }

    // Explicit Comment VNode (normalizeChildren creates these for falsy array items)
    if ((element as VNode).type === Comment) {
        yield '<!---->';
        return;
    }

    if (typeof element === 'string' || typeof element === 'number') {
        yield escapeHtml(String(element));
        return;
    }

    const vnode = element as VNode;

    if (vnode.type === Text) {
        yield escapeHtml(String(vnode.text));
        return;
    }

    if (vnode.type === Fragment) {
        for (const child of vnode.children) {
            yield* renderToChunks(child, ctx, parentCtx, appContext);
        }
        return;
    }

    // Handle Components
    if (isComponent(vnode.type)) {
        const setup = vnode.type.__setup;
        const componentName = vnode.type.__name || 'Anonymous';
        const allProps = vnode.props || {};

        // Destructure props (filter out framework-internal keys)
        const { children, slots: slotsFromProps, $models: modelsData, ...propsData } = allProps;

        const id = ctx.nextId();
        ctx.pushComponent(id);

        // Create slots from children
        const slots: SlotsObject<any> = {
            default: () => children ? (Array.isArray(children) ? children : [children]) : [],
            ...slotsFromProps
        };

        // Track SSR loads for this component
        const ssrLoads: Promise<void>[] = [];

        // Create SSR helper for async data loading
        const ssrHelper = {
            load(fn: () => Promise<void>): void {
                ssrLoads.push(fn());
            },
            isServer: true,
            isHydrating: false
        };

        let componentCtx: ComponentSetupContext = {
            el: null as any,
            signal: signal,
            props: createPropsAccessor(propsData),
            slots: slots,
            emit: () => { },
            parent: parentCtx,
            onMounted: () => { },
            onUnmounted: () => { },
            onCreated: () => { },
            onUpdated: () => { },
            expose: () => { },
            renderFn: null,
            update: () => { },
            ssr: ssrHelper,
            _ssrLoads: ssrLoads
        };

        // Plugin hook: transformComponentContext
        // Allows plugins (e.g., islands) to swap signal fn, filter props, set up tracking, etc.
        if (ctx._plugins) {
            for (const plugin of ctx._plugins) {
                const transformed = plugin.server?.transformComponentContext?.(ctx, vnode, componentCtx);
                if (transformed) {
                    componentCtx = transformed;
                }
            }
        }

        // For ROOT component only (no parent), provide the AppContext
        if (!parentCtx && appContext) {
            provideAppContext(componentCtx, appContext);
        }

        const prev = setCurrentInstance(componentCtx);
        try {
            // Run setup synchronously — it registers ssr.load() callbacks
            let renderFn = setup(componentCtx);

            // Support legacy async setup — await if it returns a promise
            if (renderFn && typeof (renderFn as any).then === 'function') {
                renderFn = await (renderFn as Promise<any>);
            }

            // Check if we have pending ssr.load() calls
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
                    yield placeholder;

                    // Render with initial state (before data loads)
                    if (renderFn) {
                        const result = (renderFn as () => any)();
                        if (result) {
                            if (Array.isArray(result)) {
                                for (const item of result) {
                                    yield* renderToChunks(item, ctx, componentCtx, appContext);
                                }
                            } else {
                                yield* renderToChunks(result, ctx, componentCtx, appContext);
                            }
                        }
                    }

                    yield `</div>`;

                    // If no plugin handled this, core manages the deferred render
                    if (!pluginHandled) {
                        const capturedRenderFn = renderFn;
                        const capturedCtx = ctx;
                        const capturedAppContext = appContext;

                        const deferredRender = (async () => {
                            await Promise.all(ssrLoads);

                            let html = '';
                            if (capturedRenderFn) {
                                const result = (capturedRenderFn as () => any)();
                                if (result) {
                                    html = await renderVNodeToString(result, capturedCtx, capturedAppContext);
                                }
                            }

                            return html;
                        })();

                        ctx._pendingAsync.push({ id, promise: deferredRender });
                    }
                } else if (asyncMode === 'skip') {
                    // Plugin says skip — don't render content
                } else {
                    // Default: block — wait for all async loads
                    await Promise.all(ssrLoads);

                    if (renderFn) {
                        const result = (renderFn as () => any)();
                        if (result) {
                            if (Array.isArray(result)) {
                                for (const item of result) {
                                    yield* renderToChunks(item, ctx, componentCtx, appContext);
                                }
                            } else {
                                yield* renderToChunks(result, ctx, componentCtx, appContext);
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
                                yield* renderToChunks(item, ctx, componentCtx, appContext);
                            }
                        } else {
                            yield* renderToChunks(result, ctx, componentCtx, appContext);
                        }
                    }
                }
            }
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            let fallbackHtml: string | null = null;

            if (ctx._onComponentError) {
                fallbackHtml = ctx._onComponentError(error, componentName, id);
            }

            if (fallbackHtml === null || fallbackHtml === undefined) {
                fallbackHtml = `<!--ssr-error:${id}-->`;
            }

            if (fallbackHtml) {
                yield fallbackHtml;
            }

            if (process.env.NODE_ENV !== 'production') {
                console.error(`Error rendering component ${componentName}:`, e);
            }
        } finally {
            setCurrentInstance(prev || null);
        }

        // Collect rendered HTML for plugin post-processing
        // Note: For streaming, afterRenderComponent receives empty string
        // since chunks were already yielded. Plugins that need to wrap
        // content should use transformComponentContext to set up wrapping.

        // Plugin hook: afterRenderComponent
        if (ctx._plugins) {
            for (const plugin of ctx._plugins) {
                const transformed = plugin.server?.afterRenderComponent?.(id, vnode, '', ctx);
                if (transformed) {
                    yield transformed;
                }
            }
        }

        // Emit trailing component marker
        yield `<!--$c:${id}-->`;
        ctx.popComponent();
        return;
    }

    // Handle host elements
    if (typeof vnode.type === 'string') {
        const tagName = vnode.type;
        let props = '';

        // Collect SSR props from use:* directive props (getSSRProps hook)
        let directiveSSRProps: Record<string, any> | null = null;
        if (vnode.props) {
            for (const key in vnode.props) {
                if (key.startsWith('use:')) {
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

            if (key === 'style') {
                const styleString = typeof value === 'object'
                    ? stringifyStyle(value)
                    : String(value);
                props += ` style="${escapeHtml(styleString)}"`;
            } else if (key === 'className') {
                props += ` class="${escapeHtml(String(value))}"`;
            } else if (key.startsWith('on')) {
                // Skip event listeners on server
            } else if (value === true) {
                props += ` ${key}`;
            } else if (value !== false && value != null) {
                props += ` ${key}="${escapeHtml(String(value))}"`;
            }
        }

        // Void elements
        if (VOID_ELEMENTS.has(tagName)) {
            yield `<${tagName}${props}>`;
            return;
        }

        // Fast path: if all children are leaf types (text/number/null/bool),
        // render entire element as a single string to avoid per-child yields.
        if (vnode.children.length > 0 && allChildrenAreLeaves(vnode.children)) {
            let html = `<${tagName}${props}>`;
            let prevWasText = false;
            for (const child of vnode.children) {
                const isText = isTextContent(child);
                if (isText && prevWasText) html += '<!--t-->';
                if (child != null && (child as any) !== false && (child as any) !== true) {
                    const cv = child as VNode;
                    html += escapeHtml(String(cv.type === Text ? cv.text : child));
                }
                prevWasText = isText;
            }
            html += `</${tagName}>`;
            yield html;
            return;
        }

        yield `<${tagName}${props}>`;

        // Render children with text boundary markers
        // Adjacent text nodes get merged by the browser, so we insert <!--t--> markers
        let prevWasText = false;
        for (const child of vnode.children) {
            const isText = isTextContent(child);
            if (isText && prevWasText) {
                // Insert marker between adjacent text nodes
                yield '<!--t-->';
            }
            yield* renderToChunks(child, ctx, parentCtx, appContext);
            prevWasText = isText;
        }

        yield `</${tagName}>`;
    }
}

/**
 * Helper to render a VNode to string (for deferred async content)
 */
export async function renderVNodeToString(element: JSXElement, ctx: SSRContext, appContext: AppContext | null = null): Promise<string> {
    let result = '';
    for await (const chunk of renderToChunks(element, ctx, null, appContext)) {
        result += chunk;
    }
    return result;
}

// ============= Synchronous String Renderer =============

/**
 * Synchronous render-to-string that avoids async generator overhead.
 * Returns null if any async operation is encountered (caller should fall back
 * to the async generator path).
 *
 * For purely synchronous component trees this eliminates thousands of
 * microtask/Promise allocations from the AsyncGenerator protocol.
 */
export function renderToStringSync(
    element: JSXElement,
    ctx: SSRContext,
    parentCtx: ComponentSetupContext | null,
    appContext: AppContext | null,
    buf: string[]
): boolean {
    if (element == null || element === false || element === true) {
        return true;
    }

    // Explicit Comment VNode (normalizeChildren creates these for falsy array items)
    if ((element as VNode).type === Comment) {
        buf.push('<!---->');
        return true;
    }

    if (typeof element === 'string' || typeof element === 'number') {
        buf.push(escapeHtml(String(element)));
        return true;
    }

    const vnode = element as VNode;

    if (vnode.type === Text) {
        buf.push(escapeHtml(String(vnode.text)));
        return true;
    }

    if (vnode.type === Fragment) {
        for (const child of vnode.children) {
            if (!renderToStringSync(child, ctx, parentCtx, appContext, buf)) return false;
        }
        return true;
    }

    // Handle Components
    if (isComponent(vnode.type)) {
        const setup = vnode.type.__setup;
        const componentName = vnode.type.__name || 'Anonymous';
        const allProps = vnode.props || {};

        const { children, slots: slotsFromProps, $models: modelsData, ...propsData } = allProps;

        const id = ctx.nextId();
        ctx.pushComponent(id);

        const slots: SlotsObject<any> = {
            default: () => children ? (Array.isArray(children) ? children : [children]) : [],
            ...slotsFromProps
        };

        const ssrLoads: Promise<void>[] = [];

        const ssrHelper = {
            load(fn: () => Promise<void>): void {
                ssrLoads.push(fn());
            },
            isServer: true,
            isHydrating: false
        };

        let componentCtx: ComponentSetupContext = {
            el: null as any,
            signal: signal,
            props: createPropsAccessor(propsData),
            slots: slots,
            emit: () => { },
            parent: parentCtx,
            onMounted: () => { },
            onUnmounted: () => { },
            onCreated: () => { },
            onUpdated: () => { },
            expose: () => { },
            renderFn: null,
            update: () => { },
            ssr: ssrHelper,
            _ssrLoads: ssrLoads
        };

        if (ctx._plugins) {
            for (const plugin of ctx._plugins) {
                const transformed = plugin.server?.transformComponentContext?.(ctx, vnode, componentCtx);
                if (transformed) {
                    componentCtx = transformed;
                }
            }
        }

        if (!parentCtx && appContext) {
            provideAppContext(componentCtx, appContext);
        }

        const prev = setCurrentInstance(componentCtx);
        try {
            let renderFn = setup(componentCtx);

            // Bail out if setup is async
            if (renderFn && typeof (renderFn as any).then === 'function') {
                for (const p of ssrLoads) p.catch(() => {});
                setCurrentInstance(prev || null);
                ctx.popComponent();
                return false;
            }

            // Bail out if there are ssr.load() calls
            if (ssrLoads.length > 0) {
                // Suppress unhandled rejections — the async path will re-run these
                for (const p of ssrLoads) p.catch(() => {});
                setCurrentInstance(prev || null);
                ctx.popComponent();
                return false;
            }

            if (renderFn) {
                const result = (renderFn as () => any)();
                if (result) {
                    if (Array.isArray(result)) {
                        for (const item of result) {
                            if (!renderToStringSync(item, ctx, componentCtx, appContext, buf)) {
                                setCurrentInstance(prev || null);
                                ctx.popComponent();
                                return false;
                            }
                        }
                    } else {
                        if (!renderToStringSync(result, ctx, componentCtx, appContext, buf)) {
                            setCurrentInstance(prev || null);
                            ctx.popComponent();
                            return false;
                        }
                    }
                }
            }
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            let fallbackHtml: string | null = null;

            if (ctx._onComponentError) {
                fallbackHtml = ctx._onComponentError(error, componentName, id);
            }

            if (fallbackHtml === null || fallbackHtml === undefined) {
                fallbackHtml = `<!--ssr-error:${id}-->`;
            }

            if (fallbackHtml) {
                buf.push(fallbackHtml);
            }
        } finally {
            setCurrentInstance(prev || null);
        }

        if (ctx._plugins) {
            for (const plugin of ctx._plugins) {
                const transformed = plugin.server?.afterRenderComponent?.(id, vnode, '', ctx);
                if (transformed) {
                    buf.push(transformed);
                }
            }
        }

        buf.push(`<!--$c:${id}-->`);
        ctx.popComponent();
        return true;
    }

    // Handle host elements
    if (typeof vnode.type === 'string') {
        const tagName = vnode.type;
        let props = '';

        let directiveSSRProps: Record<string, any> | null = null;
        if (vnode.props) {
            for (const key in vnode.props) {
                if (key.startsWith('use:')) {
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

        const allProps = directiveSSRProps
            ? { ...vnode.props, ...directiveSSRProps, style: mergeSSRStyles(vnode.props?.style, directiveSSRProps?.style) }
            : vnode.props;

        for (const key in allProps) {
            const value = allProps[key];
            if (key === 'children' || key === 'key' || key === 'ref') continue;
            if (key.startsWith('client:')) continue;
            if (key.startsWith('use:')) continue;

            if (key === 'style') {
                const styleString = typeof value === 'object'
                    ? stringifyStyle(value)
                    : String(value);
                props += ` style="${escapeHtml(styleString)}"`;
            } else if (key === 'className') {
                props += ` class="${escapeHtml(String(value))}"`;
            } else if (key.startsWith('on')) {
                // Skip event listeners on server
            } else if (value === true) {
                props += ` ${key}`;
            } else if (value !== false && value != null) {
                props += ` ${key}="${escapeHtml(String(value))}"`;
            }
        }

        if (VOID_ELEMENTS.has(tagName)) {
            buf.push(`<${tagName}${props}>`);
            return true;
        }

        buf.push(`<${tagName}${props}>`);

        let prevWasText = false;
        for (const child of vnode.children) {
            const isText = isTextContent(child);
            if (isText && prevWasText) {
                buf.push('<!--t-->');
            }
            if (!renderToStringSync(child, ctx, parentCtx, appContext, buf)) return false;
            prevWasText = isText;
        }

        buf.push(`</${tagName}>`);
        return true;
    }

    return true;
}
