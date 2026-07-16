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

// Auto-install when this module is loaded
installHMRPlugin();
