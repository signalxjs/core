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

    // Extract named slots from children with slot prop
    function extractNamedSlotsFromChildren(c: any): { defaultChildren: any[]; namedSlots: Record<string, any[]> } {
        const defaultChildren: any[] = [];
        const namedSlots: Record<string, any[]> = {};

        if (c == null) return { defaultChildren, namedSlots };

        const items = Array.isArray(c) ? c : [c];

        for (const child of items) {
            if (child && typeof child === 'object' && child.props && child.props.slot) {
                const slotName = child.props.slot;
                if (!namedSlots[slotName]) {
                    namedSlots[slotName] = [];
                }
                namedSlots[slotName].push(child);
            } else {
                defaultChildren.push(child);
            }
        }

        return { defaultChildren, namedSlots };
    }

    const slotsObj = {
        _children: children,
        _slotsFromProps: slotsFromProps || {},
        _version: versionSignal,
        _isPatching: false,  // Flag to prevent infinite loops during patching
        default: function () {
            // Reading version creates a reactive dependency
            void this._version.v;
            const c = this._children;
            const { defaultChildren } = extractNamedSlotsFromChildren(c);
            // Filter out null, undefined, false, true (conditional rendering results)
            return defaultChildren.filter((child: any) => child != null && child !== false && child !== true);
        }
    };

    // Create a proxy to handle named slot access dynamically
    return new Proxy(slotsObj, {
        get(target, prop) {
            if (prop in target) {
                return (target as any)[prop];
            }

            // Handle named slot access
            if (typeof prop === 'string') {
                return function (scopedProps?: any) {
                    // Reading version creates a reactive dependency
                    const _ = target._version.v;

                    // First check for slots from the `slots` prop
                    if (target._slotsFromProps && typeof target._slotsFromProps[prop] === 'function') {
                        const result = target._slotsFromProps[prop](scopedProps);
                        if (result == null) return [];
                        return Array.isArray(result) ? result : [result];
                    }

                    // Then check for element-based slots (children with slot prop)
                    const { namedSlots } = extractNamedSlotsFromChildren(target._children);
                    return namedSlots[prop] || [];
                };
            }

            return undefined;
        }
    }) as InternalSlotsObject;
}
