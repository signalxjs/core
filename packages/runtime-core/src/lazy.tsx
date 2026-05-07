/**
 * Lazy loading utilities for sigx components.
 * 
 * Provides runtime-only lazy loading with no build dependencies.
 * Works with any bundler that supports dynamic import().
 */

import { batch } from '@sigx/reactivity';
import { component, type AnyComponentFactory } from './component.js';
import { jsx, type JSXElement } from './jsx-runtime.js';
import {
    getCurrentSuspenseBoundarySafe,
    setCurrentSuspenseBoundarySafe
} from './async-context.js';

// ============================================================================
// Types
// ============================================================================

/**
 * State for a lazy-loaded component
 */
type LazyState = 'pending' | 'resolved' | 'rejected';

/**
 * Module with default export
 */
type ModuleWithDefault<T> = { default: T };

/**
 * Loader function that returns a component or module with default export
 */
type ComponentLoader<T> = () => Promise<T | ModuleWithDefault<T>>;

/**
 * Extended component factory with lazy loading methods
 */
export type LazyComponentFactory<T extends AnyComponentFactory> = T & {
    /** Preload the component without rendering */
    preload: () => Promise<T>;
    /** Check if the component is loaded */
    isLoaded: () => boolean;
    /** @internal Marker for lazy components */
    __lazy: true;
};

/**
 * Props for the Suspense component
 */
export type SuspenseProps = {
    /** Fallback content to show while loading */
    fallback?: JSXElement | (() => JSXElement);
};

// ============================================================================
// Suspense Context
// ============================================================================

/**
 * Suspense boundary context for tracking pending async operations
 */
type SuspenseBoundary = {
    pending: Set<Promise<any>>;
    onResolve: () => void;
};

// Module-level fallback for browser environments
let currentSuspenseBoundary: SuspenseBoundary | null = null;

/**
 * Register a promise with the current Suspense boundary
 * @internal
 */
export function registerPendingPromise(promise: Promise<any>): boolean {
    // Capture the boundary at registration time, not when promise resolves
    // Use async-safe storage (server) with module-level fallback (browser)
    const boundary = getCurrentSuspenseBoundarySafe() ?? currentSuspenseBoundary;
    if (boundary) {
        boundary.pending.add(promise);
        promise.finally(() => {
            boundary.pending.delete(promise);
            if (boundary.pending.size === 0) {
                boundary.onResolve();
            }
        });
        return true;
    }
    return false;
}

// ============================================================================
// lazy()
// ============================================================================

/**
 * Create a lazy-loaded component wrapper.
 * 
 * The component will be loaded on first render. Use with `<Suspense>` to show
 * a fallback while loading.
 * 
 * @param loader - Function that returns a Promise resolving to the component
 * @returns A component factory that loads the real component on demand
 * 
 * @example
 * ```tsx
 * import { lazy, Suspense } from 'sigx';
 * 
 * // Component will be in a separate chunk
 * const HeavyChart = lazy(() => import('./components/HeavyChart'));
 * 
 * // Usage
 * <Suspense fallback={<Spinner />}>
 *     <HeavyChart data={chartData} />
 * </Suspense>
 * 
 * // Preload on hover
 * <button onMouseEnter={() => HeavyChart.preload()}>
 *     Show Chart
 * </button>
 * ```
 */
export function lazy<T extends AnyComponentFactory>(
    loader: ComponentLoader<T>
): LazyComponentFactory<T> {
    let Component: T | null = null;
    let promise: Promise<T> | null = null;
    let error: Error | null = null;
    let state: LazyState = 'pending';

    // Create a wrapper component that handles the async loading
    const LazyWrapper = component((ctx) => {
        // Use object-based signal (sigx signals wrap objects, not primitives)
        const loadState = ctx.signal({ state: state as LazyState, tick: 0 });

        // Helper: forward wrapper's props, children, and named slots to inner component
        function renderInner(Comp: T): JSXElement {
            const fwdProps: any = { ...ctx.props };
            const defaultContent = ctx.slots.default();
            if (defaultContent.length > 0) {
                fwdProps.children = defaultContent;
            }
            // Forward named slots (access internal _slotsFromProps for enumeration)
            const slotsFromProps = (ctx.slots as any)._slotsFromProps;
            if (slotsFromProps) {
                const namedSlots: Record<string, any> = {};
                let hasNamed = false;
                for (const key of Object.keys(slotsFromProps)) {
                    namedSlots[key] = slotsFromProps[key];
                    hasNamed = true;
                }
                if (hasNamed) {
                    fwdProps.slots = namedSlots;
                }
            }
            return jsx(Comp, fwdProps);
        }

        // Start loading if not already started
        if (!promise) {
            promise = loader()
                .then((mod) => {
                    // Handle both default exports and direct exports
                    Component = 'default' in mod ? (mod as ModuleWithDefault<T>).default : mod;
                    state = 'resolved';
                    batch(() => {
                        loadState.state = 'resolved';
                        loadState.tick++;
                    });
                    return Component;
                })
                .catch((err) => {
                    error = err instanceof Error ? err : new Error(String(err));
                    state = 'rejected';
                    batch(() => {
                        loadState.state = 'rejected';
                        loadState.tick++;
                    });
                    throw error;
                });
        } else if (state === 'pending') {
            // The promise was created by a previous instance that may now be
            // unmounted (effect stopped). Subscribe THIS instance's loadState
            // so it gets notified when the promise resolves.
            promise.then(() => {
                if (loadState.state === 'pending') {
                    batch(() => {
                        loadState.state = 'resolved';
                        loadState.tick++;
                    });
                }
            }).catch(() => {
                if (loadState.state === 'pending') {
                    batch(() => {
                        loadState.state = 'rejected';
                        loadState.tick++;
                    });
                }
            });
        }

        // If already resolved, render immediately
        if (state === 'resolved' && Component) {
            return () => renderInner(Component!);
        }

        // If already rejected, throw the error
        if (state === 'rejected' && error) {
            throw error;
        }

        // Register with Suspense boundary if available
        const registered = registerPendingPromise(promise!);

        // If no Suspense boundary, handle loading state ourselves
        if (!registered) {
            promise!.catch(() => {
                // Error handling done in state update
            });
        }

        return () => {
            // Trigger reactivity by reading state
            const currentState = loadState.state;
            void loadState.tick;

            // Check current state
            if (currentState === 'resolved' && Component) {
                return renderInner(Component);
            }

            if (currentState === 'rejected' && error) {
                throw error;
            }

            // Still loading - render nothing (Suspense boundary handles fallback)
            return null;
        };
    }, { name: 'LazyComponent' }) as unknown as LazyComponentFactory<T>;

    // Add lazy-specific methods
    (LazyWrapper as any).__lazy = true;

    (LazyWrapper as any).preload = (): Promise<T> => {
        if (!promise) {
            promise = loader()
                .then((mod) => {
                    Component = 'default' in mod ? (mod as ModuleWithDefault<T>).default : mod;
                    state = 'resolved';
                    return Component;
                })
                .catch((err) => {
                    error = err instanceof Error ? err : new Error(String(err));
                    state = 'rejected';
                    throw error;
                });
        }
        return promise;
    };

    (LazyWrapper as any).isLoaded = (): boolean => {
        return state === 'resolved';
    };

    return LazyWrapper as LazyComponentFactory<T>;
}

// ============================================================================
// Suspense Component
// ============================================================================

/**
 * Suspense boundary component for handling async loading states.
 * 
 * Wraps lazy-loaded components and shows a fallback while they load.
 * 
 * @example
 * ```tsx
 * import { lazy, Suspense } from 'sigx';
 * 
 * const LazyDashboard = lazy(() => import('./Dashboard'));
 * 
 * // Basic usage
 * <Suspense fallback={<div>Loading...</div>}>
 *     <LazyDashboard />
 * </Suspense>
 * 
 * // With spinner component
 * <Suspense fallback={<Spinner size="large" />}>
 *     <LazyDashboard />
 *     <LazyCharts />
 * </Suspense>
 * ```
 */
export const Suspense = component<SuspenseProps>(
    (ctx) => {
        const { props, slots } = ctx;
        const state = ctx.signal({ isReady: false, pendingCount: 0 });

        // Create a Suspense boundary context
        const boundary: SuspenseBoundary = {
            pending: new Set(),
            onResolve: () => {
                state.pendingCount = boundary.pending.size;
                if (boundary.pending.size === 0) {
                    state.isReady = true;
                }
            }
        };

        // Set up the boundary for child components
        ctx.onMounted(() => {
            // After first render, if no pending promises, we're ready
            if (boundary.pending.size === 0) {
                state.isReady = true;
            }
        });

        return () => {
            // Read reactive state to trigger re-render when children finish loading
            // This is crucial: when onResolve() sets isReady=true, this causes Suspense to re-render
            void state.isReady;
            void state.pendingCount;

            // Set current boundary for children to register with
            const prevBoundary = getCurrentSuspenseBoundarySafe() ?? currentSuspenseBoundary;
            currentSuspenseBoundary = boundary;
            setCurrentSuspenseBoundarySafe(boundary);

            try {
                // Try to render children
                const children = slots.default();

                // If we have pending promises (registered during slots.default() call), show fallback
                // Check AFTER rendering children because that's when lazy components register
                if (boundary.pending.size > 0) {
                    const fallback = props.fallback;
                    if (typeof fallback === 'function') {
                        return (fallback as () => JSXElement)();
                    }
                    return fallback ?? null;
                }

                // No pending - return children (could be an array, single element, or null)
                // Filter out nulls from conditional rendering
                if (Array.isArray(children)) {
                    const filtered = children.filter((c: any) => c != null && c !== false && c !== true);
                    if (filtered.length === 0) return null;
                    if (filtered.length === 1) return filtered[0];
                    return filtered;
                }

                return children;
            } catch (err) {
                // If a promise was thrown (Suspense protocol), handle it
                if (err instanceof Promise) {
                    registerPendingPromise(err);
                    const fallback = props.fallback;
                    if (typeof fallback === 'function') {
                        return (fallback as () => JSXElement)();
                    }
                    return fallback ?? null;
                }
                // Re-throw other errors
                throw err;
            } finally {
                currentSuspenseBoundary = prevBoundary;
                setCurrentSuspenseBoundarySafe(prevBoundary);
            }
        };
    },
    { name: 'Suspense' }
);

// ============================================================================
// Utility: isLazyComponent
// ============================================================================

/**
 * Check if a component is a lazy-loaded component
 */
export function isLazyComponent(component: any): component is LazyComponentFactory<any> {
    return component && component.__lazy === true;
}
