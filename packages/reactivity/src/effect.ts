// ============================================================================
// Effect System - Core reactivity primitives
// ============================================================================

import type { Dep, EffectFn, EffectRunner, Subscriber } from './types';
import { getDevtoolsHook } from './devtools-hook';

/** Create a dependency slot (see {@link Dep}). */
export function createDep(): Dep {
    return { subs: new Set<Subscriber>(), version: 0 };
}

// Subscriber dirtiness flags (Subscriber.flags).
export const CLEAN = 0;
/** A direct source definitely changed: must re-run / recompute. */
export const DIRTY = 1 << 0;
/** A computed source was invalidated: validate before running. */
export const MAYBE_DIRTY = 1 << 1;
/** Cycle guard: this computed's getter is currently executing. */
export const COMPUTING = 1 << 2;

/**
 * Pull-validate a subscriber whose sources are all "maybe dirty":
 * refresh computed sources and report whether any source's version
 * actually advanced past the version recorded at track time.
 */
export function sourcesChanged(sub: Subscriber): boolean {
    for (const link of sub.deps) {
        const computedSub = link.dep.computed;
        if (computedSub) {
            computedSub.refresh!();
        }
        if (link.dep.version !== link.version) {
            return true;
        }
    }
    return false;
}

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
            flushPendingEffects();
        }
    }
}

function flushPendingEffects(): void {
    while (pendingEffects.size > 0) {
        const effects = Array.from(pendingEffects);
        pendingEffects.clear();
        for (const effect of effects) {
            effect();
        }
    }
}

export function cleanup(effect: Subscriber): void {
    if (!effect.deps) return;
    for (const link of effect.deps) {
        link.dep.subs.delete(effect);
    }
    effect.deps.length = 0;
}

export function track(dep: Dep): void {
    if (!currentSubscriber) return;
    dep.subs.add(currentSubscriber);
    currentSubscriber.deps.push({ dep, version: dep.version });
}

/**
 * Two-pass push: first MARK the whole downstream graph (computeds become
 * maybe-dirty, effects are queued and deduped), then FLUSH the queued
 * effects. Marking everything before running anything is what makes a
 * diamond (s → c1,c2 → e) glitch-free and single-run: when `e` executes,
 * both branches already know they must (re)validate.
 *
 * Effects still flush synchronously before the signal write returns
 * (unless an outer batch() is open), so write-then-assert code keeps
 * working unchanged.
 */
export function trigger(dep: Dep): void {
    // Every trigger is a definite value change (callers already gate on
    // Object.is), so the version always advances.
    dep.version++;
    batchDepth++;
    try {
        mark(dep, DIRTY);
    } finally {
        batchDepth--;
        if (batchDepth === 0) {
            flushPendingEffects();
        }
    }
}

function mark(dep: Dep, bit: number): void {
    // The mark phase runs no user code, so dep.subs cannot mutate
    // mid-iteration — no snapshot needed.
    for (const sub of dep.subs) {
        const prev = sub.flags;
        sub.flags = prev | bit;
        if (sub.ownDep) {
            // Computed node: propagate downstream once per wave. An
            // already-flagged computed has already propagated (this also
            // terminates cycles).
            if ((prev & (DIRTY | MAYBE_DIRTY)) === 0) {
                mark(sub.ownDep, MAYBE_DIRTY);
            }
        } else {
            pendingEffects.add(sub);
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
        if (running) {
            // Dropped re-entrant invocation: clear flags so a stale dirt
            // bit can't skew the next real validation.
            effectFn.flags = CLEAN;
            return;
        }
        const flags = effectFn.flags;
        effectFn.flags = CLEAN;
        if ((flags & MAYBE_DIRTY) !== 0 && (flags & DIRTY) === 0) {
            // Only computed sources were invalidated: pull-validate them
            // and skip the run entirely if no value actually changed.
            if (!sourcesChanged(effectFn)) {
                return;
            }
        }
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
    effectFn.flags = DIRTY;
    effectFn();

    // Return the effect as a runner with a stop method. Manual runs are
    // forced: they bypass validation by marking the effect dirty first.
    const runner = (() => {
        effectFn.flags |= DIRTY;
        return effectFn();
    }) as EffectRunner;
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
    if (activeScope) {
        activeScope._effects.push(runner);
    }
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
export function effectScope(detached?: boolean): {
    run<T>(fn: () => T): T | undefined;
    stop(fromParent?: boolean): void;
} {
    const effects: EffectRunner[] = [];
    const childScopes: InternalScope[] = [];
    let active = true;

    const scope: InternalScope = {
        _effects: effects,
        _childScopes: childScopes,
        run<T>(fn: () => T): T | undefined {
            if (!active) return undefined;
            const prevScope = activeScope;
            activeScope = scope;
            try {
                return fn();
            } finally {
                activeScope = prevScope;
            }
        },
        stop(fromParent?: boolean) {
            if (!active) return;
            active = false;
            for (const runner of effects) {
                runner.stop();
            }
            effects.length = 0;
            for (const child of childScopes) {
                child.stop(true);
            }
            childScopes.length = 0;
            // Detach from the parent so a long-lived parent scope doesn't
            // retain stopped children.
            if (!fromParent && parentScope) {
                const siblings = parentScope._childScopes;
                const i = siblings.indexOf(scope);
                if (i !== -1) siblings.splice(i, 1);
            }
        },
    };

    const parentScope = detached ? null : activeScope;
    if (parentScope) {
        parentScope._childScopes.push(scope);
    }

    return scope;
}

interface InternalScope {
    _effects: EffectRunner[];
    _childScopes: InternalScope[];
    run<T>(fn: () => T): T | undefined;
    stop(fromParent?: boolean): void;
}

let activeScope: InternalScope | null = null;
