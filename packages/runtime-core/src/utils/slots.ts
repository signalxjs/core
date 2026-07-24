/**
 * Slots system for component children.
 * Supports default and named slots with reactivity.
 */

import { signal } from '@sigx/reactivity';

/**
 * Map a slot's extracted children, invoking any *function* items with the
 * scoped props (render-prop / scoped-slot semantics) and passing element
 * children through untouched. A function child — `<Comp>{(p) => …}</Comp>` —
 * is thereby called with the same `scopedProps` the `slots` prop form receives,
 * instead of reaching the renderer as a bare function and being dropped as an
 * empty node.
 *
 * Returns a fresh array, preserving the accessor's defensive-copy contract, and
 * normalises a function's result exactly like the `slots` prop branch does:
 * `null`/`undefined` is dropped, an array is flattened one level.
 *
 * Single pass: element children are copied into a fresh, pre-sized array as
 * they are scanned; only once the first function is found does it truncate to
 * the copied prefix and switch to append-mode for the rest. The common case
 * (no function children — every element-based named slot, and any default slot
 * without a render-prop child) never allocates a second traversal.
 */
export function invokeFunctionChildren(list: any[], scopedProps?: any): any[] {
    const n = list.length;
    const out: any[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const item = list[i];
        if (typeof item === 'function') {
            // First function: keep the copied [0, i) prefix, then append the
            // remaining items — invoking functions with the scoped props.
            out.length = i;
            for (let j = i; j < n; j++) {
                const it = list[j];
                if (typeof it === 'function') {
                    const r = it(scopedProps);
                    if (r == null) continue;
                    if (Array.isArray(r)) {
                        for (const x of r) out.push(x);
                    } else {
                        out.push(r);
                    }
                } else {
                    out.push(it);
                }
            }
            return out;
        }
        out[i] = item;
    }
    return out;
}

/**
 * Internal slots object with tracking properties.
 *
 * A slot accessor is present (a callable) only when content was provided for
 * that slot — including `default`; an unprovided slot reads as `undefined`.
 */
export interface InternalSlotsObject {
    default?: (scopedProps?: any) => any[];
    _children: any;
    _version: { v: number };
    _slotsFromProps: Record<string, any>;
    _isPatching?: boolean;
    [key: string]: any;
}

/**
 * Create slots object from children and slots prop.
 * Uses a version signal to trigger re-renders when children change.
 *
 * A slot reads as a callable accessor **only when content was provided** for
 * it; an unprovided slot — `default` included — reads as `undefined`. So
 * presence is a plain truthiness/optional-call check (`slots.header?.()`,
 * `slots.header?.() ?? fallback`), and presence stays reactive: the accessor
 * lookup reads the version signal, so a slot appearing or disappearing
 * re-renders the consumer.
 *
 * Supports named slots via:
 * - `slots` prop object (e.g., `slots={{ header: () => <div>...</div> }}`)
 * - `slot` prop on children (e.g., `<div slot="header">...</div>`)
 *
 * @example
 * ```tsx
 * // Parent component
 * <Card slots={{ header: () => <h1>Title</h1> }}>
 *   <p>Default content</p>
 *   <span slot="footer">Footer text</span>
 * </Card>
 *
 * // Card component setup
 * const slots = createSlots(children, slotsFromProps);
 * return () => (
 *   <div>
 *     {slots.header?.() ?? <h2>Fallback heading</h2>}
 *     {slots.default?.()}
 *     {slots.footer?.()}
 *   </div>
 * );
 * ```
 */
export function createSlots(children: any, slotsFromProps?: Record<string, any>): InternalSlotsObject {
    // Use a simple version signal - bump version to trigger reactivity
    const versionSignal = signal({ v: 0 });

    // Extraction cache keyed by the version counter. The renderer only
    // reassigns _children together with a version bump, so a matching
    // version means the cached scan of the children is still valid —
    // repeated slot calls per render skip the O(n) walk and its
    // allocations. Results are sliced on return so callers can't
    // corrupt the cache.
    // Null-prototype dictionaries: slot names come from user-controlled
    // `slot` props, so a name like "__proto__" must be a plain key, not
    // a prototype mutation.
    let cachedVersion = -1;
    let cachedDefault: any[] = [];
    let cachedNamed: Record<string, any[]> = Object.create(null);

    // Extract default children (filtered of null/boolean conditional
    // results) and named slots (children with a `slot` prop).
    function extract(target: { _children: any }, version: number): void {
        if (version === cachedVersion) return;
        const defaultChildren: any[] = [];
        const namedSlots: Record<string, any[]> = Object.create(null);
        const c = target._children;
        if (c != null) {
            const items = Array.isArray(c) ? c : [c];
            for (const child of items) {
                if (child && typeof child === 'object' && child.props && child.props.slot) {
                    const slotName = child.props.slot;
                    if (!namedSlots[slotName]) {
                        namedSlots[slotName] = [];
                    }
                    namedSlots[slotName].push(child);
                } else if (child != null && child !== false && child !== true) {
                    defaultChildren.push(child);
                }
            }
        }
        cachedVersion = version;
        cachedDefault = defaultChildren;
        cachedNamed = namedSlots;
    }

    const slotsObj = {
        _children: children,
        _slotsFromProps: slotsFromProps || {},
        _version: versionSignal,
        _isPatching: false,  // Flag to prevent infinite loops during patching
    };

    // Only OWN keys count — both for the internal-property passthrough and
    // for `slots` prop lookups — so inherited `Object.prototype` members
    // (`toString`, `constructor`, …) never masquerade as a present slot.
    const hasOwn = Object.prototype.hasOwnProperty;

    // Slot accessor functions are minted once per name and reused across
    // renders (they read live state on every call). `default` shares this
    // path so it gets the same presence semantics as named slots.
    const slotFns = new Map<string, (scopedProps?: any) => any[]>();

    function accessorFor(name: string): (scopedProps?: any) => any[] {
        let fn = slotFns.get(name);
        if (!fn) {
            fn = function (scopedProps?: any) {
                // Reading version creates a reactive dependency (and is the
                // cache key)
                const version = slotsObj._version.v;

                // First check for slots from the `slots` prop
                const fromProps = slotsObj._slotsFromProps;
                if (fromProps && hasOwn.call(fromProps, name) && typeof fromProps[name] === 'function') {
                    const result = fromProps[name](scopedProps);
                    if (result == null) return [];
                    return Array.isArray(result) ? result : [result];
                }

                // Then fall back to element-based slots: `default` collects
                // the un-slotted children, named slots collect children with
                // a matching `slot` prop. Function items among them are
                // invoked with `scopedProps` (render-prop / scoped-slot form)
                // — the mapping happens on return so the extraction cache keeps
                // caching the RAW children.
                extract(slotsObj, version);
                if (name === 'default') return invokeFunctionChildren(cachedDefault, scopedProps);
                const list = cachedNamed[name];
                return list ? invokeFunctionChildren(list, scopedProps) : [];
            };
            slotFns.set(name, fn);
        }
        return fn;
    }

    // Whether content was provided for a slot. Reads the version signal so
    // presence is reactive — a slot appearing or disappearing across a
    // re-render flips the accessor between a function and `undefined` and
    // re-renders the consumer. A slot provided via the `slots` prop counts as
    // present regardless of what it returns (matching scoped-slot semantics);
    // element-based slots count as present only when they have children.
    function hasContent(name: string): boolean {
        const version = slotsObj._version.v;
        const fromProps = slotsObj._slotsFromProps;
        if (fromProps && hasOwn.call(fromProps, name) && typeof fromProps[name] === 'function') return true;
        extract(slotsObj, version);
        if (name === 'default') return cachedDefault.length > 0;
        const list = cachedNamed[name];
        return list != null && list.length > 0;
    }

    // Create a proxy to handle slot access dynamically
    return new Proxy(slotsObj, {
        get(target, prop) {
            // Pass through only OWN tracking properties (`_children`,
            // `_version`, …). Using `in` here would match inherited
            // `Object.prototype` keys (`toString`, `constructor`,
            // `__proto__`, …), making those slot names unreachable and
            // always-truthy — breaking the `slots.x?.() ?? fallback`
            // presence semantics for them. Own-key check lets every such
            // name fall through to the slot path instead.
            if (hasOwn.call(target, prop)) {
                return (target as any)[prop];
            }

            // Handle slot access (named or `default`): expose a callable
            // accessor only when content was provided, otherwise `undefined`
            // so `slots.x?.()` and `?? fallback` behave intuitively.
            if (typeof prop === 'string') {
                return hasContent(prop) ? accessorFor(prop) : undefined;
            }

            return undefined;
        }
    }) as InternalSlotsObject;
}
