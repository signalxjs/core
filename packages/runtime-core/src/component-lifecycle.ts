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
import { getDevtoolsHook } from './devtools-hook.js';

// Dev mode - can be set to false in production builds
const _DEV = true;

let currentComponentContext: ComponentSetupContext<any, any, any> | null = null;

/**
 * Devtools instance ids — minted lazily the first time `setCurrentInstance`
 * sees each ctx, only when a hook is installed. Used so the runtime's
 * component events and reactivity's `ownerComponentId` field share one
 * id space. When no hook is installed the map stays empty.
 */
const ctxInstanceIds = new WeakMap<ComponentSetupContext<any, any, any>, number>();

/**
 * Get the devtools instance id assigned to a ctx, or `null` if none
 * was minted (no hook was installed when the ctx was first set as
 * current). Used by `notifyComponent*` to tag events with the same
 * id reactivity events reference via `ownerComponentId`.
 *
 * @internal
 */
export function getInstanceId(ctx: ComponentSetupContext<any, any, any> | null | undefined): number | null {
    if (!ctx) return null;
    return ctxInstanceIds.get(ctx) ?? null;
}

/**
 * Get the parent component's instance id by following `ctx.parent`
 * — the same field the DI system uses for `inject()` traversal
 * (set by the renderer at the point of component setup). Returns
 * `null` for roots.
 *
 * @internal
 */
export function getParentInstanceId(ctx: ComponentSetupContext<any, any, any> | null | undefined): number | null {
    if (!ctx) return null;
    const parent = (ctx as { parent?: ComponentSetupContext<any, any, any> | null }).parent;
    if (!parent) return null;
    return ctxInstanceIds.get(parent) ?? null;
}

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

    // Devtools: mint an id for this ctx the first time we see it, and
    // update the hook's currentOwner so reactivity primitives created
    // during this setup can be attributed back to this component.
    // On exit (ctx === null or another ctx), we set currentOwner to
    // the new ctx's id (or null) — this naturally restores parent
    // ownership when nested setups finish.
    const hook = getDevtoolsHook();
    if (hook) {
        if (ctx) {
            let id = ctxInstanceIds.get(ctx);
            if (id === undefined) {
                id = hook.nextId();
                ctxInstanceIds.set(ctx, id);
            }
            hook.currentOwner = id;
        } else {
            hook.currentOwner = null;
        }
    }

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
