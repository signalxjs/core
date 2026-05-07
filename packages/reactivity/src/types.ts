// ============================================================================
// Type Definitions
// ============================================================================

/** Symbol to identify computed values */
export const ComputedSymbol: unique symbol = Symbol('computed');

export type EffectFn = () => void;

export interface EffectRunner<T = void> {
    (): T;
    stop: () => void;
}

export interface Subscriber extends EffectFn {
    deps: Set<Subscriber>[];
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
    stop(fromParent?: boolean): void;
}
