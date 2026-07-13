/**
 * Lazy loading for sigx components — runtime-only, no build dependencies;
 * works with any bundler that supports dynamic import().
 *
 * A lazy wrapper reads its factory's load state REACTIVELY: while the chunk
 * loads it renders null (an enclosing <Defer> shows the fallback — the
 * wrapper registered its promise with it at setup time), on resolution it
 * renders the real component in place, and on rejection it throws the load
 * error from render — routing through the standard error path (nearest
 * errorScope, then app onError).
 *
 * There is no thrown-promise protocol and no register-during-render
 * ordering — those were removed with <Suspense> (docs/rfc-async.md rev 8).
 */

import { signal, batch } from '@sigx/reactivity';
import { withoutOwnerTracking } from '@sigx/reactivity/internals';
import { component, type AnyComponentFactory } from './component.js';
import { jsx, type JSXElement } from './jsx-runtime.js';
import { getDeferCollector } from './defer.js';

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

// ============================================================================
// lazy()
// ============================================================================

/**
 * Create a lazy-loaded component wrapper.
 *
 * The component loads on first render (or `preload()`). Wrap it in
 * `<Defer fallback={…}>` to show a fallback while the chunk loads.
 *
 * @param loader - Function that returns a Promise resolving to the component
 * @returns A component factory that loads the real component on demand
 *
 * @example
 * ```tsx
 * import { lazy, Defer } from 'sigx';
 *
 * // Component will be in a separate chunk
 * const HeavyChart = lazy(() => import('./components/HeavyChart'));
 *
 * // Usage
 * <Defer fallback={<Spinner />}>
 *     <HeavyChart data={chartData} />
 * </Defer>
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
    /** Plain mirror for preload()/isLoaded()/the server walk — no accidental subscriptions. */
    let state: LazyState = 'pending';

    // ONE factory-level reactive cell shared by every mounted instance:
    // each wrapper's render effect subscribes to it, so all instances
    // re-render when the chunk settles — no per-instance re-subscription.
    // (withoutOwnerTracking: the signal belongs to the factory, not to
    // whichever component setup happened to call lazy().)
    const loadState = withoutOwnerTracking(() => signal({ state: 'pending' as LazyState }));

    /** Start (or join) the load — shared by setup and preload(). */
    function ensureLoad(): Promise<T> {
        if (!promise) {
            promise = loader().then(
                (mod) => {
                    // Handle both default exports and direct exports
                    Component = 'default' in mod ? (mod as ModuleWithDefault<T>).default : mod;
                    state = 'resolved';
                    batch(() => {
                        loadState.state = 'resolved';
                    });
                    return Component;
                },
                (err) => {
                    error = err instanceof Error ? err : new Error(String(err));
                    state = 'rejected';
                    batch(() => {
                        loadState.state = 'rejected';
                    });
                    throw error;
                }
            );
        }
        return promise;
    }

    const LazyWrapper = component((ctx) => {
        // Helper: forward wrapper's props, children, and named slots to inner component
        function renderInner(Comp: T): JSXElement {
            const fwdProps: any = { ...ctx.props };
            const defaultContent = ctx.slots.default?.() ?? [];
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

        if (state === 'pending') {
            const p = ensureLoad();
            // The render throw is the error path — the raw load promise must
            // not surface an unhandled rejection of its own.
            p.catch(() => { });
            // Register with the nearest <Defer> (setup-time, via DI) so it
            // can cover the load with its fallback.
            getDeferCollector()?.add(p);
        }

        return () => {
            switch (loadState.state) {
                case 'resolved':
                    return renderInner(Component!);
                case 'rejected':
                    // Routes through the render-effect catch → nearest
                    // errorScope → app onError.
                    throw error;
                default:
                    // Still loading — render nothing (<Defer> shows the fallback).
                    return null;
            }
        };
    }, { name: 'LazyComponent' }) as unknown as LazyComponentFactory<T>;

    // Add lazy-specific methods
    (LazyWrapper as any).__lazy = true;
    (LazyWrapper as any).preload = ensureLoad;
    (LazyWrapper as any).isLoaded = (): boolean => state === 'resolved';

    return LazyWrapper as LazyComponentFactory<T>;
}

// ============================================================================
// Utility: isLazyComponent
// ============================================================================

/**
 * Check if a component is a lazy-loaded component
 */
export function isLazyComponent(component: any): component is LazyComponentFactory<any> {
    return component && component.__lazy === true;
}
