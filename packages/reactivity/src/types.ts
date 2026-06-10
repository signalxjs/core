// ============================================================================
// Type Definitions
// ============================================================================

/** Symbol to identify computed values */
export const ComputedSymbol: unique symbol = Symbol('computed');

export type EffectFn = () => void;

/**
 * Custom scheduling hook for effects. When provided, notifications hand
 * the effect's `run` job to the scheduler instead of executing it; the
 * scheduler decides when (and whether once-deduplicated) to invoke it.
 * The job validates its sources when invoked, so a queued job whose
 * sources turn out unchanged is a no-op, as is a job whose effect was
 * stopped in the meantime.
 */
export type EffectScheduler = (run: () => void) => void;

export interface EffectOptions {
    scheduler?: EffectScheduler;
}

export interface EffectRunner<T = void> {
    (): T;
    stop: () => void;
}

/**
 * A dependency slot: one tracked property/key of one signal, or a
 * computed's output. `version` increments on every definite value change,
 * letting subscribers validate "did this source really change?" without
 * recomputing.
 */
export interface Dep {
    subs: Set<Subscriber>;
    version: number;
    /** Present iff this dep is a computed's output dep. */
    computed?: Subscriber;
}

/** A subscriber's edge to one Dep, with the version seen at track time. */
export interface Link {
    dep: Dep;
    version: number;
}

export interface Subscriber extends EffectFn {
    deps: Link[];
    /** Dirtiness state (CLEAN / DIRTY / MAYBE_DIRTY / COMPUTING). */
    flags: number;
    /** Present iff this subscriber is a computed node: its output dep. */
    ownDep?: Dep;
    /** Present iff this subscriber is a computed node: pull/validate. */
    refresh?: () => void;
}

/** 
 * Widens literal types to their base primitive types.
 * e.g., `false` → `boolean`, `"hello"` → `string`, `123` → `number`
 */
export type Widen<T> = 
    T extends boolean ? boolean :
    T extends number ? number :
    T extends string ? string :
    T extends bigint ? bigint :
    T extends symbol ? symbol :
    T;

/** Type for object/array signals - includes $set for replacing the whole object */
export type Signal<T> = T & {
    $set: (newValue: T) => void;
};

/** Type for primitive values that get wrapped in { value: T } - no $set, use .value instead */
export type PrimitiveSignal<T> = { value: Widen<T> };

/** Primitive types that will be wrapped in { value: T } */
export type Primitive = string | number | boolean | symbol | bigint | null | undefined;

// Watch types
export type WatchSource<T = any> = T | (() => T);
export type WatchCallback<V = any, OV = any> = (value: V, oldValue: OV, onCleanup: (fn: () => void) => void) => any;

export interface WatchOptions<Immediate = boolean> {
    immediate?: Immediate;
    deep?: boolean | number;
    once?: boolean;
}

export interface WatchHandle {
    (): void; // callable to stop
    stop: () => void;
    pause: () => void;
    resume: () => void;
}

// Computed types
/** A read-only computed signal - access via .value */
export interface Computed<T> {
    readonly value: T;
    readonly [ComputedSymbol]: true;
}

/** A writable computed signal - access and set via .value */
export interface WritableComputed<T> {
    value: T;
    readonly [ComputedSymbol]: true;
}

export interface ComputedGetter<T> {
    (): T;
}

export interface ComputedSetter<T> {
    (value: T): void;
}

export interface WritableComputedOptions<T> {
    get: ComputedGetter<T>;
    set: ComputedSetter<T>;
}

// Effect scope types
export type EffectScope = {
    run<T>(fn: () => T): T | undefined;
    stop(): void;
}
