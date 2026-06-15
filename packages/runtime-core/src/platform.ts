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

// Private holders - no TDZ issues since this module has no circular deps.
// Two tiers: extension processors (registered by packs/userland, tried first,
// FIFO among themselves) and the platform processor (registered by the
// platform package — DOM, Lynx, Terminal — as part of platform identity,
// tried last as the fallback). First processor returning true wins.
let platformModelProcessor: ModelProcessor | null = null;
const extensionModelProcessors: ModelProcessor[] = [];
let orderedProcessors: readonly ModelProcessor[] = [];

function rebuildOrdered(): void {
    orderedProcessors = platformModelProcessor
        ? [...extensionModelProcessors, platformModelProcessor]
        : [...extensionModelProcessors];
}

/**
 * Set the platform-specific model processor for intrinsic elements.
 * Called by the platform package (e.g. runtime-dom for checkbox/radio/select
 * model bindings) — one per platform, always the last processor tried.
 */
export function setPlatformModelProcessor(fn: ModelProcessor): void {
    platformModelProcessor = fn;
    rebuildOrdered();
}

/**
 * Get the current platform model processor (for internal use).
 */
export function getPlatformModelProcessor(): ModelProcessor | null {
    return platformModelProcessor;
}

/**
 * Register an extension model processor for intrinsic elements.
 *
 * Extension processors run BEFORE the platform processor, in registration
 * order, until one returns true — so packs (custom elements, widget
 * libraries) can add model handling without replacing the platform's.
 * Registering the same function twice is a no-op.
 */
export function registerModelProcessor(fn: ModelProcessor): void {
    if (extensionModelProcessors.includes(fn)) return;
    extensionModelProcessors.push(fn);
    rebuildOrdered();
}

/**
 * All model processors in invocation order: extensions first (FIFO), then
 * the platform processor. For internal use by the JSX runtime.
 */
export function getModelProcessors(): readonly ModelProcessor[] {
    return orderedProcessors;
}
