/**
 * Component instance management and lifecycle hooks.
 *
 * Manages the current component context during setup and provides
 * lifecycle hook registration (onMounted, onUnmounted, onCreated, onUpdated).
 */

import type { ComponentSetupContext, MountContext } from './component-types.js';
import {
    getCurrentInstanceSafe,
    setCurrentInstanceSafe
} from './async-context.js';

// Dev mode - can be set to false in production builds
const _DEV = true;

let currentComponentContext: ComponentSetupContext<any, any, any> | null = null;

/**
 * Returns the setup context of the currently executing component, or `null` if called outside setup.
 *
 * Use this to access the component context (props, emit, etc.) from composable functions
 * or lifecycle hooks that run during component setup.
 *
 * @example
 * ```ts
 * function useMyComposable() {
 *     const ctx = getCurrentInstance();
 *     if (!ctx) throw new Error('Must be called during component setup');
 *     ctx.onMounted(({ el }) => console.log('Mounted to', el));
 * }
 * ```
 */
export function getCurrentInstance() {
    // Prefer async-safe storage (AsyncLocalStorage on server), fallback to module-level
    return getCurrentInstanceSafe() ?? currentComponentContext;
}

export function setCurrentInstance(ctx: ComponentSetupContext<any, any, any> | null) {
    // Update both: async-safe storage AND module-level fallback
    const prevSafe = setCurrentInstanceSafe(ctx);
    const prevModule = currentComponentContext;
    currentComponentContext = ctx;
    // Return the previous value — prefer async-safe if it was set
    return prevSafe ?? prevModule;
}

/**
 * Register a callback to run after the component is mounted to the DOM.
 * Must be called during component setup.
 *
 * @param fn - Callback receiving a {@link MountContext} with the component's root element.
 *
 * @example
 * ```ts
 * const MyComponent = component(() => {
 *     onMounted(({ el }) => {
 *         console.log('Mounted to', el);
 *     });
 *     return () => <div>Hello</div>;
 * });
 * ```
 */
export function onMounted(fn: (ctx: MountContext) => void) {
    if (currentComponentContext) {
        currentComponentContext.onMounted(fn);
    } else if (_DEV) {
        console.warn("onMounted called outside of component setup");
    }
}

/**
 * Register a callback to run when the component is unmounted from the DOM.
 * Must be called during component setup. Use for cleanup (event listeners, timers, subscriptions).
 *
 * @param fn - Callback receiving a {@link MountContext} with the component's root element.
 *
 * @example
 * ```ts
 * const MyComponent = component(() => {
 *     const timer = setInterval(() => tick(), 1000);
 *     onUnmounted(() => clearInterval(timer));
 *     return () => <div>Tick</div>;
 * });
 * ```
 */
export function onUnmounted(fn: (ctx: MountContext) => void) {
    if (currentComponentContext) {
        currentComponentContext.onUnmounted(fn);
    } else if (_DEV) {
        console.warn("onUnmounted called outside of component setup");
    }
}

/**
 * Register a callback to run immediately after component setup completes,
 * before the first render. Must be called during component setup.
 *
 * @example
 * ```ts
 * const MyComponent = component(() => {
 *     onCreated(() => console.log('Setup done, about to render'));
 *     return () => <div>Hello</div>;
 * });
 * ```
 */
export function onCreated(fn: () => void) {
    if (currentComponentContext) {
        currentComponentContext.onCreated(fn);
    } else if (_DEV) {
        console.warn("onCreated called outside of component setup");
    }
}

/**
 * Register a callback to run after every reactive re-render of the component.
 * Must be called during component setup.
 *
 * @example
 * ```ts
 * const Counter = component(() => {
 *     const state = signal({ count: 0 });
 *     onUpdated(() => console.log('Re-rendered with count:', state.count));
 *     return () => <button onClick={() => state.count++}>{state.count}</button>;
 * });
 * ```
 */
export function onUpdated(fn: () => void) {
    if (currentComponentContext) {
        currentComponentContext.onUpdated(fn);
    } else if (_DEV) {
        console.warn("onUpdated called outside of component setup");
    }
}
