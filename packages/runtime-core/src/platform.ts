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
