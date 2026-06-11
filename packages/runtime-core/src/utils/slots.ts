/**
 * Slots system for component children.
 * Supports default and named slots with reactivity.
 */

import { signal } from '@sigx/reactivity';

/**
 * Internal slots object with tracking properties
 */
export interface InternalSlotsObject {
    default: () => any[];
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
 *     {slots.header()}
 *     {slots.default()}
 *     {slots.footer()}
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
        default: function () {
            // Reading version creates a reactive dependency (and is the
            // cache key)
            const version = this._version.v;
            extract(this, version);
            return cachedDefault.slice();
        }
    };

    // Named-slot accessor functions are minted once per name and reused
    // across renders (they read live state on every call).
    const namedSlotFns = new Map<string, (scopedProps?: any) => any[]>();

    // Create a proxy to handle named slot access dynamically
    return new Proxy(slotsObj, {
        get(target, prop) {
            if (prop in target) {
                return (target as any)[prop];
            }

            // Handle named slot access
            if (typeof prop === 'string') {
                let fn = namedSlotFns.get(prop);
                if (!fn) {
                    fn = function (scopedProps?: any) {
                        // Reading version creates a reactive dependency
                        // (and is the cache key)
                        const version = target._version.v;

                        // First check for slots from the `slots` prop
                        if (target._slotsFromProps && typeof target._slotsFromProps[prop] === 'function') {
                            const result = target._slotsFromProps[prop](scopedProps);
                            if (result == null) return [];
                            return Array.isArray(result) ? result : [result];
                        }

                        // Then check for element-based slots (children with slot prop)
                        extract(target, version);
                        const list = cachedNamed[prop];
                        return list ? list.slice() : [];
                    };
                    namedSlotFns.set(prop, fn);
                }
                return fn;
            }

            return undefined;
        }
    }) as InternalSlotsObject;
}
