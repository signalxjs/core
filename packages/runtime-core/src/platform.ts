/**
 * Platform-specific hooks for runtime-core.
 * 
 * This module has NO IMPORTS to ensure it's fully initialized before
 * any other module can import from it. This avoids circular dependency
 * issues with ES module initialization.
 */

/**
 * Platform-specific model processor for intrinsic elements.
 * Platforms (DOM, Terminal) can register their own model handling logic.
 * 
 * @param type - The intrinsic element type (e.g., 'input', 'select')
 * @param props - The props object being built (mutable)
 * @param modelBinding - The [stateObj, key] tuple for the model binding
 * @param originalProps - The original props from JSX (read-only)
 * @returns true if handled (skip generic fallback), false to use generic fallback
 */
export type ModelProcessor = (
    type: string,
    props: Record<string, any>,
    modelBinding: [Record<string, any>, string],
    originalProps: Record<string, any>
) => boolean;

// Private holder - no TDZ issues since this module has no circular deps
let platformModelProcessor: ModelProcessor | null = null;

/**
 * Set the platform-specific model processor for intrinsic elements.
 * Called by runtime-dom to handle checkbox/radio/select model bindings.
 */
export function setPlatformModelProcessor(fn: ModelProcessor): void {
    platformModelProcessor = fn;
}

/**
 * Get the current platform model processor (for internal use).
 */
export function getPlatformModelProcessor(): ModelProcessor | null {
    return platformModelProcessor;
}

// User-registered model processors. These run BEFORE the platform processor,
// in registration order; the first one returning `true` wins. This is the
// public extension point for custom elements / web components. The platform
// processor (set above by runtime-dom / lynx-runtime) remains the last-resort
// base layer, so registering a user processor never clobbers native form binding.
const userModelProcessors: ModelProcessor[] = [];

/**
 * Register a model processor for custom elements (public API).
 *
 * Processors run in registration order before the platform's built-in
 * processor; the first returning `true` handles the binding and stops the
 * chain. Return `false` to defer to the next processor (and ultimately the
 * platform/generic fallback).
 *
 * @param fn - The processor: `(type, props, [obj, key], originalProps) => boolean`
 * @returns An unregister function that removes this processor.
 *
 * @example
 * ```tsx
 * registerModelProcessor((type, props, [obj, key], originalProps) => {
 *     if (type !== 'my-toggle') return false;
 *     props.checked = obj[key];
 *     props.onToggle = (e) => { obj[key] = e.detail.value; };
 *     return true;
 * });
 * ```
 */
export function registerModelProcessor(fn: ModelProcessor): () => void {
    userModelProcessors.push(fn);
    return () => {
        const i = userModelProcessors.indexOf(fn);
        if (i >= 0) userModelProcessors.splice(i, 1);
    };
}

/**
 * Get the registered user model processors (for internal use by the JSX runtime).
 */
export function getUserModelProcessors(): ModelProcessor[] {
    return userModelProcessors;
}

/**
 * Run the full model-processor chain for an intrinsic element: user-registered
 * processors first (registration order, first `true` wins), then the platform
 * processor. Returns `true` if any processor handled the binding.
 */
export function runModelProcessors(
    type: string,
    props: Record<string, any>,
    modelBinding: [Record<string, any>, string],
    originalProps: Record<string, any>
): boolean {
    for (const processor of userModelProcessors) {
        if (processor(type, props, modelBinding, originalProps)) return true;
    }
    return platformModelProcessor
        ? platformModelProcessor(type, props, modelBinding, originalProps)
        : false;
}
