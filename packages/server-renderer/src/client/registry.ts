/**
 * Component registry for boundary hydration.
 *
 * Components can be registered eagerly or lazily for boundary hydration.
 * Lazy registration enables per-boundary code splitting — the component
 * chunk is only downloaded when the hydration strategy triggers.
 *
 * Moved here from the islands pack (rfc-ssr-platform §1.2 — selective
 * hydration is THE hydrator); the islands package re-exports this surface.
 */

import { isComponent as isSigxComponent } from 'sigx';
import type { ComponentFactory as BaseComponentFactory } from './hydrate-component';

/**
 * Minimal type for component factories used in the hydration registry.
 * Extends the hydrator's base factory shape with the stable island identity.
 */
export interface ComponentFactory extends BaseComponentFactory {
    /** Stable island identity based on file path (injected by Vite plugin) */
    __islandId?: string;
}

/**
 * A lazy loader that returns a ComponentFactory when invoked.
 * Used for per-boundary code splitting — the import() only executes on demand.
 */
export type LazyComponentLoader = () => Promise<ComponentFactory | { default: ComponentFactory; [key: string]: any }>;

const componentRegistry = new Map<string, ComponentFactory>();
const lazyRegistry = new Map<string, LazyComponentLoader>();

/** In-flight resolution promises to deduplicate concurrent resolveComponent() calls */
const pendingResolutions = new Map<string, Promise<ComponentFactory | undefined>>();

/**
 * Register a component for boundary hydration (eager — component is already
 * loaded). Components must be registered before the boundary scheduler runs.
 */
export function registerComponent(name: string, component: ComponentFactory): void {
    componentRegistry.set(name, component);
}

/** Register multiple components at once (eager). */
export function registerComponents(components: Record<string, ComponentFactory>): void {
    for (const [name, component] of Object.entries(components)) {
        if (isSigxComponent(component)) {
            registerComponent(name, component);
        }
    }
}

/**
 * Register a lazy boundary component for code-split hydration.
 * The loader function is only called when the hydration strategy triggers.
 * After first resolution, the component is cached in the eager registry.
 *
 * Called automatically by the `sigxIslandsPlugin` Vite transform — users
 * don't need to call this manually.
 */
export function __registerIslandChunk(name: string, loader: LazyComponentLoader): void {
    lazyRegistry.set(name, loader);
}

/**
 * Resolve a component by name — checks eager registry first, then lazy.
 * On lazy resolution, the result is cached in the eager registry for instant
 * subsequent lookups. Concurrent calls for the same name share one Promise.
 */
export async function resolveComponent(name: string): Promise<ComponentFactory | undefined> {
    const eager = componentRegistry.get(name);
    if (eager) return eager;

    const loader = lazyRegistry.get(name);
    if (!loader) return undefined;

    const pending = pendingResolutions.get(name);
    if (pending) return pending;

    const resolution = loader().then(result => {
        // Unwrap: loader may return { default: Component } or Component directly
        const component = unwrapComponentModule(result, name);
        if (component) {
            componentRegistry.set(name, component); // Cache for instant future access
        }
        pendingResolutions.delete(name);
        return component;
    }).catch(err => {
        pendingResolutions.delete(name);
        if (process.env.NODE_ENV !== 'production') {
            console.error(`[Islands] Failed to load island chunk for "${name}":`, err);
        }
        return undefined;
    });

    pendingResolutions.set(name, resolution);
    return resolution;
}

/**
 * Unwrap a dynamic import result to get the ComponentFactory.
 * Handles: direct factory, { default: factory }, or { [name]: factory }
 */
export function unwrapComponentModule(
    mod: ComponentFactory | { default: ComponentFactory; [key: string]: any },
    name: string
): ComponentFactory | undefined {
    // Direct ComponentFactory (has __setup)
    if (mod && typeof mod === 'function' && '__setup' in mod) {
        return mod as ComponentFactory;
    }

    // ES module with default export
    if (mod && typeof mod === 'object') {
        const obj = mod as Record<string, any>;
        if (obj.default && typeof obj.default === 'function' && '__setup' in obj.default) {
            return obj.default as ComponentFactory;
        }
        // Named export matching the component name
        if (obj[name] && typeof obj[name] === 'function' && '__setup' in obj[name]) {
            return obj[name] as ComponentFactory;
        }
        // First component export
        for (const val of Object.values(obj)) {
            if (val && typeof val === 'function' && '__setup' in val) {
                return val as ComponentFactory;
            }
        }
    }

    if (process.env.NODE_ENV !== 'production') {
        console.warn(`[Islands] Could not find component factory in module for "${name}"`);
    }
    return undefined;
}

/** Get a registered component by name (sync — only checks eager registry) */
export function getComponent(name: string): ComponentFactory | undefined {
    return componentRegistry.get(name);
}

/** Check if a component is available (either eager or lazy) */
export function hasComponent(name: string): boolean {
    return componentRegistry.has(name) || lazyRegistry.has(name);
}

/**
 * Hydration Registry class for more advanced use cases
 */
export class HydrationRegistry {
    private components = new Map<string, ComponentFactory>();
    private lazy = new Map<string, LazyComponentLoader>();

    register(name: string, component: ComponentFactory): this {
        this.components.set(name, component);
        return this;
    }

    registerLazy(name: string, loader: LazyComponentLoader): this {
        this.lazy.set(name, loader);
        return this;
    }

    registerAll(components: Record<string, ComponentFactory>): this {
        for (const [name, component] of Object.entries(components)) {
            if (isSigxComponent(component)) {
                this.register(name, component);
            }
        }
        return this;
    }

    get(name: string): ComponentFactory | undefined {
        return this.components.get(name);
    }

    has(name: string): boolean {
        return this.components.has(name) || this.lazy.has(name);
    }

    async resolve(name: string): Promise<ComponentFactory | undefined> {
        const eager = this.components.get(name);
        if (eager) return eager;
        const loader = this.lazy.get(name);
        if (!loader) return undefined;
        const result = await loader();
        const component = unwrapComponentModule(result, name);
        if (component) this.components.set(name, component);
        return component;
    }
}
