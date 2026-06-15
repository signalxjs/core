/**
 * Shared, pluggable primitive for `model` directive modifiers.
 *
 * Modifiers come in two flavours:
 * - **value transforms** (`trim`, `number`, custom) — pure value→value functions
 *   applied at the write-back boundary in the JSX runtime, so every binding path
 *   (default `model`, named `model:name`, generic fallback, custom processors,
 *   components) and every platform (DOM, Lynx, SSR) honors them with no extra code.
 * - **timing** (`lazy`, `debounce`) — a declarative hint platforms map to their own
 *   event model (DOM `input`→`change`; Lynx `bindinput`/blur). Debounce scheduling
 *   is platform-agnostic ({@link createDebounceScheduler}) but the platform owns the
 *   event wiring and cleanup, since the cancel handle is tied to its listener lifecycle.
 *
 * This module is dependency-free (mirrors `platform.ts`) so it can be imported from
 * any layer without circular-init concerns.
 */

export type ModelModifierTiming = 'lazy' | 'debounce';

export interface ModelModifierContext {
    /** The raw modifier value, e.g. `true`, `300`, or a custom config object. */
    option: unknown;
    /** The full modifiers object, so a transform can read sibling flags. */
    modifiers: Record<string, unknown>;
}

export interface ModelModifierDef {
    /**
     * Platform-agnostic value transform applied at write-back. Receives the raw
     * value the platform extracted and returns the value to write to the binding.
     */
    transform?: (value: any, ctx: ModelModifierContext) => any;
    /**
     * Declarative timing hint platforms map to their own event model. Modifiers
     * with a `timing` (and no `transform`) are skipped by {@link applyModelTransforms}.
     */
    timing?: ModelModifierTiming;
}

const registry = new Map<string, ModelModifierDef>();

/**
 * Register a `model` modifier (public API), symmetric with `registerModelProcessor`.
 *
 * A modifier is either a value transform, a timing hint, or both. Built-ins
 * (`trim`, `number`, `lazy`, `debounce`) are registered through this same
 * mechanism. To make a custom modifier type-check in JSX, also augment the
 * matching capability group ({@link ValueModelModifiers} for transforms,
 * {@link TimingModelModifiers} for timing) via declaration merging.
 *
 * @returns An unregister function that removes this modifier.
 *
 * @example
 * ```ts
 * declare module '@sigx/runtime-core' {
 *   interface ValueModelModifiers { uppercase?: boolean }
 * }
 * registerModelModifier('uppercase', {
 *   transform: (v) => typeof v === 'string' ? v.toUpperCase() : v,
 * });
 * ```
 */
export function registerModelModifier(name: string, def: ModelModifierDef): () => void {
    registry.set(name, def);
    return () => {
        if (registry.get(name) === def) registry.delete(name);
    };
}

/** Look up a registered modifier definition (internal). */
export function getModelModifier(name: string): ModelModifierDef | undefined {
    return registry.get(name);
}

/**
 * Apply every active value-transform in `modifiers` to `value`, in authoring
 * order (the key order of the `modelModifiers` object literal). Falsy/nullish
 * modifier options and timing-only modifiers are skipped.
 */
export function applyModelTransforms(value: any, modifiers: Record<string, any> | undefined): any {
    if (!modifiers) return value;
    let v = value;
    for (const name in modifiers) {
        const option = modifiers[name];
        if (option === false || option == null) continue;
        const def = registry.get(name);
        if (def?.transform) v = def.transform(v, { option, modifiers });
    }
    return v;
}

/** Resolved, platform-neutral timing contract derived from a modifiers object. */
export interface ResolvedTiming {
    /** Sync on the platform's lazy event (DOM `change`) instead of the eager one. */
    lazy: boolean;
    /** Trailing-edge debounce in ms, or `null` when no debounce is requested. */
    debounceMs: number | null;
}

/**
 * Derive the timing contract from a modifiers object by consulting each
 * registered modifier's `timing` hint — so platforms need no hardcoded knowledge
 * of which modifier names imply which timing. `debounce: true` ⇒ 300ms.
 */
export function resolveTiming(modifiers: Record<string, any> | undefined): ResolvedTiming {
    let lazy = false;
    let debounceMs: number | null = null;
    if (modifiers) {
        for (const name in modifiers) {
            const option = modifiers[name];
            if (option === false || option == null) continue;
            const timing = registry.get(name)?.timing;
            if (timing === 'lazy') lazy = true;
            else if (timing === 'debounce') debounceMs = typeof option === 'number' ? option : 300;
        }
    }
    return { lazy, debounceMs };
}

/** Property carrying the active modifiers on a model write-back handler. */
const MODIFIERS_TAG = '__sigx_modelModifiers';

/**
 * Wrap a model write-back handler so registered value-transforms run before the
 * real write, on every path and platform. The wrapper also carries the modifiers
 * object (under {@link MODIFIERS_TAG}) so the platform can read the timing hints.
 * Returns the handler unchanged when there are no modifiers.
 */
export function wrapModelWriteBack(
    handler: (v: any) => void,
    modifiers: Record<string, any> | undefined,
): (v: any) => void {
    if (!modifiers) return handler;
    const wrapped = (v: any) => handler(applyModelTransforms(v, modifiers));
    (wrapped as any)[MODIFIERS_TAG] = modifiers;
    return wrapped;
}

/** Read the modifiers tag off a write-back handler (internal, platform-side). */
export function getHandlerModifiers(handler: unknown): Record<string, any> | undefined {
    return handler ? (handler as any)[MODIFIERS_TAG] : undefined;
}

/** Trailing-edge debounce scheduler. The platform owns wiring + cleanup. */
export interface DebounceScheduler {
    /** Schedule (or re-schedule) a trailing-edge call with the latest value. */
    invoke: (value: any) => void;
    /** Cancel any pending call (e.g. on handler replacement / unmount). */
    cancel: () => void;
}

/**
 * Create a trailing-edge debounce scheduler. Scheduling is platform-agnostic
 * (`setTimeout`); platforms call this and own the cancel wiring so a pending
 * write can't fire after the handler is torn down.
 */
export function createDebounceScheduler(fn: (v: any) => void, ms: number): DebounceScheduler {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return {
        invoke: (v: any) => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => fn(v), ms);
        },
        cancel: () => {
            if (timer) clearTimeout(timer);
        },
    };
}

// ============================================================================
// Built-in modifiers — registered eagerly so DOM, Lynx, and SSR all share them.
// The `typeof v === 'string'` guards keep trim/number silent no-ops on
// boolean/array values (checkbox/radio/multi-select). The JSX runtime emits a
// dev warning for those structurally-pointless combinations.
// ============================================================================

registerModelModifier('trim', {
    transform: (v) => (typeof v === 'string' ? v.trim() : v),
});

registerModelModifier('number', {
    transform: (v) => {
        if (typeof v !== 'string') return v;
        const n = parseFloat(v);
        return Number.isNaN(n) ? v : n;
    },
});

registerModelModifier('lazy', { timing: 'lazy' });
registerModelModifier('debounce', { timing: 'debounce' });

// ============================================================================
// Types — single source of truth, importable and augmentable.
//
// Capability groups are the declaration-merging seam: a custom value-transform
// augments `ValueModelModifiers` (auto-scoped to value-bearing elements and
// absent from checkbox/radio); a custom timing modifier augments
// `TimingModelModifiers`. Per-element interfaces compose these groups.
// ============================================================================

/**
 * Value-transform modifiers. Meaningful only where the bound value is (or can be)
 * a string — text/number/range/textarea/select. Augment to add custom transforms.
 */
export interface ValueModelModifiers {
    /** Strip leading/trailing whitespace before write-back. */
    trim?: boolean;
    /** Coerce the value to a number (no-op if not numeric). */
    number?: boolean;
}

/**
 * Timing modifiers — change *when* write-back fires. Meaningful on every
 * model-bound element. Augment to add custom timing modifiers.
 */
export interface TimingModelModifiers {
    /** Sync on `change` (blur/enter) instead of every keystroke. */
    lazy?: boolean;
    /** Delay write-back by N ms (`true` ⇒ 300ms). */
    debounce?: number | boolean;
}

/**
 * Full modifier set for value-bearing form elements
 * (text/number/range/textarea/select) — value transforms + timing.
 */
export interface ModelModifiers extends ValueModelModifiers, TimingModelModifiers {}

/**
 * Modifier set for toggle elements (checkbox/radio) — timing only.
 * `trim`/`number` are intentionally absent (no-ops for boolean/array values).
 */
export interface ToggleModelModifiers extends TimingModelModifiers {}
