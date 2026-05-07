/**
 * Component type checking utilities
 * 
 * Separated to avoid circular dependencies between jsx-runtime and renderer.
 */

/**
 * Minimal interface for component detection.
 * Full ComponentFactory type is generic and complex, so we use this minimal
 * interface for the type guard.
 */
export interface ComponentLike {
    __setup: Function;
    __name?: string;
}

/**
 * Check if a value is a SignalX component (has __setup).
 * 
 * SignalX components are created with component() and have a __setup
 * property containing the setup function.
 * 
 * @example
 * ```ts
 * const MyComponent = component((ctx) => () => <div/>);
 * isComponent(MyComponent); // true
 * isComponent(() => <div/>); // false (plain function component)
 * isComponent('div'); // false
 * ```
 */
export function isComponent(type: unknown): type is ComponentLike {
    return typeof type === 'function' && '__setup' in type;
}
