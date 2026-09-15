// HMR runtime for sigx - runs in the browser
// NOTE: registerComponentPlugin is imported lazily to avoid circular dependency
// during module initialization (sigx/internals → runtime-core → reactivity → model.ts
// may call registerHMRModule before this module's let bindings are initialized).
import type { ComponentSetupContext } from 'sigx/internals';

interface InstanceEntry {
    ctx: ComponentSetupContext;
}

// Track instances by component ID (moduleId:index)
const instancesByComponentId = new Map<string, Set<InstanceEntry>>();

// Track component definition order within each module
const moduleComponentIndex = new Map<string, number>();

// Current module being registered
let currentModuleId: string | null = null;

let installed = false;

/**
 * Register a component instance for HMR tracking: add it to the registry for
 * its component ID and wire an onUnmounted cleanup that removes it again.
 *
 * Called both at initial mount (from the wrapped `factory.__setup`) and after
 * a hot-update reload (the reload runs the instance's onUnmounted hooks —
 * including this very cleanup — so the entry must be re-registered).
 */
function trackInstance(instance: InstanceEntry, componentId: string): void {
    let instances = instancesByComponentId.get(componentId);
    if (!instances) {
        instances = new Set();
        instancesByComponentId.set(componentId, instances);
    }
    instances.add(instance);
    instance.ctx.onUnmounted(() => {
        const set = instancesByComponentId.get(componentId);
        if (set) set.delete(instance);
    });
}

/**
 * Register the current module for HMR tracking.
 * Called at the top of each transformed module.
 */
export function registerHMRModule(moduleId: string): void {
    currentModuleId = moduleId;
    // Reset the component index for this module (start fresh on re-execution)
    moduleComponentIndex.set(moduleId, 0);
}

/**
 * Get the next component ID for the current module
 */
function getNextComponentId(): string | null {
    if (!currentModuleId) return null;

    const index = moduleComponentIndex.get(currentModuleId) || 0;
    moduleComponentIndex.set(currentModuleId, index + 1);

    return `${currentModuleId}:${index}`;
}

/**
 * Install the HMR plugin. Called once on first module load.
 */
export async function installHMRPlugin(): Promise<void> {
    if (installed) return;
    installed = true;

    const { registerComponentPlugin, setCurrentInstance } = await import('sigx/internals');

    registerComponentPlugin({
        onDefine(name: string | undefined, factory: any, setup: Function) {
            const componentId = getNextComponentId();
            if (!componentId) return;

            // Store the component ID on the factory for debugging
            factory.__hmrId = componentId;

            // Check for existing instances with this component ID
            const existingInstances = instancesByComponentId.get(componentId);

            if (existingInstances && existingInstances.size > 0) {
                // HMR update: reload all existing instances against the new setup.
                // Iterate a SNAPSHOT — the reload runs each instance's onUnmounted
                // hooks, one of which (the tracking cleanup) mutates this very Set.
                [...existingInstances].forEach(instance => {
                    try {
                        const ctx = instance.ctx as ComponentSetupContext & {
                            __hmrReload?: (setup: Function) => void;
                        };
                        if (typeof ctx.__hmrReload === 'function') {
                            // Preferred path: the renderer disposes the previous
                            // run's hooks, clears the lists (no accumulation,
                            // core#107), re-runs setup, and re-fires created/
                            // mounted before re-rendering.
                            ctx.__hmrReload(setup);
                            // __hmrReload ran the tracking cleanup registered
                            // below, removing this instance from the registry —
                            // re-register so future hot updates still reach it.
                            trackInstance(instance, componentId);
                        } else {
                            // Legacy fallback (core without __hmrReload; sigx is a
                            // "*" peer dep). Re-run with the instance current so
                            // module-level lifecycle hooks register (#105). Hooks
                            // still accumulate (core#107), but nothing worse.
                            const prevInstance = setCurrentInstance(instance.ctx);
                            try {
                                instance.ctx.renderFn = setup(instance.ctx);
                            } finally {
                                setCurrentInstance(prevInstance);
                            }
                            instance.ctx.update();
                        }
                    } catch (e) {
                        console.error(`[sigx] HMR failed for ${name || 'component'}:`, e);
                    }
                });
            }

            // Wrap setup to track instances
            const originalSetup = setup;

            factory.__setup = (ctx: ComponentSetupContext) => {
                // Run the original setup
                const renderFn = originalSetup(ctx);

                // Register this instance for HMR tracking (adds to the registry
                // + wires the onUnmounted de-registration).
                trackInstance({ ctx }, componentId);

                // Return the render function as-is
                return renderFn;
            };
        }
    });
}

/**
 * The `__SIGX_SERVERFN_CACHE__` seam at this (calling) end — the same shape
 * `@sigx/server/client` calls when a response carries `$cache`, and
 * `@sigx/cache` stamps at install; `docs/seams.md` carries the contract.
 */
type ServerFnCacheSeamGlobal = {
    __SIGX_SERVERFN_CACHE__?: (d: { invalidates?: ReadonlyArray<string | readonly unknown[]> }) => void;
};

/** The slice of Vite's `ImportMetaHot` a stub module hands us. */
interface StubHotContext {
    invalidate(message?: string): void;
}

/**
 * A server-function stub module re-evaluated under dev HMR (#716) — the
 * `*.server.ts` (or inline-carrier) file, or a server-only module behind
 * it, was edited. `keys` are the module's fn stable keys.
 *
 * Called from the tail `@sigx/vite/server` appends to every dev stub
 * module, on its SECOND and later evaluations only. The backend half is
 * already live (the dev endpoint `ssrLoadModule`s per request); this is
 * the browser half: every mounted `useData(fn)` cell on one of these keys
 * refetches in place, and the SSR blob entries are swept so a later mount
 * does not restore the stale value.
 *
 * Delivered through the same path a server-declared `invalidates` takes —
 * the cache seam when a pack stamped it (its handler drops the pack's own
 * entries AND delegates the mounted refresh to `invalidateKeys`), core's
 * `invalidateKeys` otherwise — so one edit means one refetch per key.
 *
 * Then the decision the helper exists for: is anything on this page reading
 * these keys LIVE? If not — a zero-JS resume page whose handler chunk
 * imported the stub, server-rendered HTML with no cell, a route that is not
 * mounted — an in-place refresh changes nothing the user can see, so the
 * update is handed back to Vite (`hot.invalidate()`) to propagate through
 * the importers: an accepting component module re-runs, a non-accepting one
 * means the full reload the page got before #716. The blob sweep above has
 * already run either way. `mountedKeys()` answers this, not the sweep's
 * touched count: the blob holds keys nothing reads on exactly those pages.
 */
export async function serverFnHotUpdate(hot: StubHotContext, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const patterns: readonly (readonly string[])[] = keys.map((key) => [key]);
    const { invalidateKeys, mountedKeys, preparePattern } = await import('sigx/internals');
    // Decide BEFORE sweeping: a refetch that settles synchronously could
    // re-register, and the answer must describe the page as the edit found it.
    const matchers = patterns.map(preparePattern);
    let live = false;
    // `sigx` is a "*" peer: a core predating `mountedKeys` cannot say what is
    // live, and "nothing" is the answer that never leaves a page stale.
    for (const key of typeof mountedKeys === 'function' ? mountedKeys() : []) {
        if (matchers.some((m) => m.match(key))) {
            live = true;
            break;
        }
    }
    const seam = (globalThis as ServerFnCacheSeamGlobal).__SIGX_SERVERFN_CACHE__;
    if (seam) seam({ invalidates: patterns });
    else invalidateKeys(patterns);
    if (!live) hot.invalidate('[sigx] no mounted reader for a hot-updated server function');
}

// Auto-install when this module is loaded — the injected BROWSER runtime
// path (the transform only injects into client transforms). Skipped
// server-side: the node plugin re-exports from this module, and a
// fire-and-forget dynamic import there is pure liability — HMR is a browser
// concern, and a test environment can tear down before the import settles
// (the EnvironmentTeardownError flake, core#307).
if (typeof window !== 'undefined') {
    void installHMRPlugin();
}
