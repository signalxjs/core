/**
 * Props accessor for component setup functions.
 * Provides a reactive proxy for accessing component props.
 */

import { toRaw } from '@sigx/reactivity';
import { PropsAccessor } from '../component.js';

/**
 * Structural vnode check (type + props + children + dom are all assigned at
 * vnode creation — see jsx-runtime). Runs on RAW objects only, so the
 * property reads are plain and untracked.
 */
function isVNodeLike(v: any): boolean {
    return v.type !== undefined && v.props !== undefined && v.children !== undefined && 'dom' in v;
}

/**
 * VNodes are renderer-owned descriptors — the renderer writes its dom
 * bookkeeping onto them and compares them by identity. A vnode that reaches
 * the renderer wrapped in a reactive proxy corrupts both (#191), so a
 * vnode-valued prop (or an array of vnodes, e.g. a fallback or icon prop)
 * is handed back RAW. The property READ itself still goes through the
 * reactive props signal first, so replacing the prop re-renders as usual.
 */
function unwrapVNodeValue<T>(v: T): T {
    if (v && typeof v === 'object') {
        const raw = toRaw(v as object) as any;
        if (isVNodeLike(raw)) return raw;
        if (Array.isArray(raw) && raw.length > 0 && raw[0] && typeof raw[0] === 'object' && isVNodeLike(raw[0])) {
            return raw as T;
        }
    }
    return v;
}

/**
 * Creates a props accessor - a simple reactive proxy for props.
 * Use destructuring with defaults for optional props.
 *
 * @example
 * ```ts
 * // In component setup:
 * const { count = 0, label = 'Default' } = ctx.props;
 *
 * // Or spread to forward props
 * <ChildComponent {...ctx.props} />
 * ```
 */
export function createPropsAccessor<TProps extends Record<string, any>>(
    reactiveProps: TProps
): PropsAccessor<TProps> {
    const handler: ProxyHandler<TProps> = {
        get(target, key: string | symbol) {
            if (typeof key === 'symbol') return undefined;
            return unwrapVNodeValue((target as any)[key]);
        },

        has(target, key: string | symbol) {
            if (typeof key === 'symbol') return false;
            return key in target;
        },

        ownKeys(target) {
            return Object.keys(target);
        },

        getOwnPropertyDescriptor(target, key: string | symbol) {
            if (typeof key === 'symbol') return undefined;
            if (key in target) {
                return { enumerable: true, configurable: true, writable: false };
            }
            return undefined;
        }
    };

    // Use a regular object as the proxy target - enables spreading
    const proxy = new Proxy(reactiveProps, handler);

    return proxy as PropsAccessor<TProps>;
}
