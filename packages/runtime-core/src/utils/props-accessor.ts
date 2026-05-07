/**
 * Props accessor for component setup functions.
 * Provides a reactive proxy for accessing component props.
 */

import { PropsAccessor } from '../component.js';

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
            return (target as any)[key];
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
