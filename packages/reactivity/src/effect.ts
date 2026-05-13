// ============================================================================
// Effect System - Core reactivity primitives
// ============================================================================

import type { EffectFn, EffectRunner, Subscriber } from './types';
import { getDevtoolsHook } from './devtools-hook';

export let currentSubscriber: Subscriber | null = null;
let batchDepth = 0;
const pendingEffects = new Set<Subscriber>();

export function setCurrentSubscriber(effect: Subscriber | null): void {
    currentSubscriber = effect;
}

export function getCurrentSubscriber(): Subscriber | null {
    return currentSubscriber;
}

/**
 * Batch multiple reactive updates into a single flush.
 * Effects are deferred until the batch completes, avoiding redundant re-renders.
 *
 * @example
 * ```ts
 * batch(() => {
 *   count.value++;
 *   name.value = 'Alice';
 * }); // effects run once after both updates
 * ```
 */
export function batch(fn: () => void) {
    batchDepth++;
    try {
        fn();
    } finally {
        batchDepth--;
        if (batchDepth === 0) {
            const effects = Array.from(pendingEffects);
            pendingEffects.clear();
            for (const effect of effects) {
                effect();
            }
        }
    }
}

export function cleanup(effect: Subscriber): void {
    if (!effect.deps) return;
    for (const dep of effect.deps) {
        dep.delete(effect);
    }
    effect.deps.length = 0;
}

export function track(depSet: Set<Subscriber>): void {
    if (!currentSubscriber) return;
    depSet.add(currentSubscriber);
    currentSubscriber.deps.push(depSet);
}

export function trigger(depSet: Set<Subscriber>): void {
    const effects = Array.from(depSet);
    for (const effect of effects) {
        if (batchDepth > 0) {
            pendingEffects.add(effect);
        } else {
            effect();
        }
    }
}

function runEffect(fn: EffectFn): EffectRunner {
    let stopped = false;
    // Re-entrancy guard. If a running effect synchronously triggers a
    // signal that lists itself as a subscriber (e.g. an unmount hook
    // does `if (state.x === id) state.x = null` while the parent's
    // render effect is on the stack), we must not invoke the effect
    // again while the previous invocation has not unwound — that would
    // overwrite freshly-rebuilt deps and corrupt any state the outer
    // run is mid-mutating (in practice, the renderer's subtree ref).
    let running = false;

    // Devtools id minted at create time when a hook is installed.
    // `null` means "untracked by devtools" — the hot path in the
    // effect's body skips emission entirely.
    const hookAtCreate = getDevtoolsHook();
    const effectId: number | null = hookAtCreate ? hookAtCreate.nextId() : null;
    if (hookAtCreate && effectId !== null) {
        hookAtCreate.emit({
            type: 'effect:created',
            id: effectId,
            ownerComponentId: hookAtCreate.currentOwner,
        });
    }

    const effectFn: Subscriber = function () {
        if (stopped) return;
        if (running) return;
        running = true;
        cleanup(effectFn);
        const prev = currentSubscriber;
        currentSubscriber = effectFn;
        if (effectId === null) {
            try {
                fn();
            } finally {
                currentSubscriber = prev;
                running = false;
            }
            return;
        }
        // Devtools path: measure duration and emit. We don't catch
        // errors from `fn()` here — letting them propagate keeps
        // user error-handling behavior identical to the non-devtools
        // path. The `finally` still emits with whatever elapsed time.
        const start = performance.now();
        try {
            fn();
        } finally {
            currentSubscriber = prev;
            running = false;
            const hook = getDevtoolsHook();
            if (hook) {
                hook.emit({
                    type: 'effect:run',
                    id: effectId,
                    durationMs: performance.now() - start,
                });
            }
        }
    } as Subscriber;

    effectFn.deps = [];
    effectFn();

    // Return the effect as a runner with a stop method
    const runner = (() => effectFn()) as EffectRunner;
    runner.stop = () => {
        stopped = true;
        cleanup(effectFn);
        if (effectId !== null) {
            const hook = getDevtoolsHook();
            if (hook) {
                hook.emit({ type: 'effect:stopped', id: effectId });
            }
        }
    };
    return runner;
}

/**
 * Create a reactive effect that re-runs whenever its tracked dependencies change.
 * Returns a runner with a `.stop()` method to dispose the effect.
 *
 * @example
 * ```ts
 * const count = signal(0);
 * const runner = effect(() => console.log(count.value));
 * count.value++; // logs: 1
 * runner.stop();
 * ```
 */
export function effect(fn: EffectFn): EffectRunner {
    return runEffect(fn);
}

/**
 * Execute a function without tracking any reactive dependencies.
 * Useful for reading signals inside an effect without creating a subscription.
 *
 * @example
 * ```ts
 * effect(() => {
 *   const val = untrack(() => someSignal.value); // not tracked
 * });
 * ```
 */
export function untrack<T>(fn: () => T): T {
    const prev = currentSubscriber;
    currentSubscriber = null;
    try {
        return fn();
    } finally {
        currentSubscriber = prev;
    }
}

/**
 * Create an effect scope that collects reactive effects for bulk disposal.
 *
 * @example
 * ```ts
 * const scope = effectScope();
 * scope.run(() => {
 *   effect(() => console.log(count.value));
 *   effect(() => console.log(name.value));
 * });
 * scope.stop(); // disposes both effects
 * ```
 */
export function effectScope(_detached?: boolean): {
    run<T>(fn: () => T): T | undefined;
    stop(fromParent?: boolean): void;
} {
    const effects: (() => void)[] = [];
    let active = true;

    return {
        run<T>(fn: () => T): T | undefined {
            if (!active) return undefined;
            return fn();
        },
        stop() {
            active = false;
            effects.forEach(e => e());
        }
    };
}
