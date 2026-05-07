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

    const { registerComponentPlugin } = await import('sigx/internals');

    registerComponentPlugin({
        onDefine(name: string | undefined, factory: any, setup: Function) {
            const componentId = getNextComponentId();
            if (!componentId) return;

            // Store the component ID on the factory for debugging
            factory.__hmrId = componentId;

            // Check for existing instances with this component ID
            const existingInstances = instancesByComponentId.get(componentId);

            if (existingInstances && existingInstances.size > 0) {
                // HMR update: update all existing instances with new setup/render function
                existingInstances.forEach(instance => {
                    try {
                        // Re-run the NEW setup with the existing context to get new render fn
                        const newRenderFn = setup(instance.ctx);
                        // Set the new render function and trigger re-render
                        instance.ctx.renderFn = newRenderFn;
                        instance.ctx.update();
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

                const instance: InstanceEntry = { ctx };

                // Register instance by component ID
                let instances = instancesByComponentId.get(componentId);
                if (!instances) {
                    instances = new Set();
                    instancesByComponentId.set(componentId, instances);
                }
                instances.add(instance);

                // Cleanup on unmount
                ctx.onUnmounted(() => {
                    const instances = instancesByComponentId.get(componentId);
                    if (instances) instances.delete(instance);
                });

                // Return the render function as-is
                return renderFn;
            };
        }
    });
}

// Auto-install when this module is loaded
installHMRPlugin();
