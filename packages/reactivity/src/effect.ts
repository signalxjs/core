// ============================================================================
// Effect System - Core reactivity primitives
// ============================================================================

import type { Dep, EffectFn, EffectOptions, EffectRunner, EffectScheduler, Link, Subscriber } from './types';
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
/** Already sitting in the pending-effects queue (dedup without a Set). */
const QUEUED = 1 << 3;
/**
 * The computed's last refresh threw. A computed normally propagates
 * downstream only on its first dirtying per wave; an errored computed
 * stays DIRTY across waves, which would suppress that propagation and
 * wedge its subscribers after a transient getter error. This bit forces
 * one extra downstream propagation per mark (cleared on propagation, so
 * cycle termination is preserved) until a refresh succeeds.
 */
export const ERRORED = 1 << 4;

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
// Deduplicated via the QUEUED subscriber flag — cheaper than a Set on
// the per-write hot path.
const pendingEffects: Subscriber[] = [];

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
    startBatch();
    try {
        fn();
    } finally {
        endBatch();
    }
}

/**
 * Imperative batch bounds for hot paths that cannot afford a closure per
 * call (array mutator instrumentations, multi-dep writes). Callers MUST
 * pair them in try/finally — an unbalanced startBatch leaves batchDepth
 * stuck and effects never flush again.
 * @internal
 */
export function startBatch(): void {
    batchDepth++;
}

/** @internal see {@link startBatch} */
export function endBatch(): void {
    batchDepth--;
    if (__DEV__ && batchDepth < 0) {
        // Mis-paired start/end would leave a negative depth and silently
        // prevent every future flush — fail fast instead.
        batchDepth = 0;
        throw new Error('[SignalX] endBatch() without a matching startBatch()');
    }
    if (batchDepth === 0) {
        flushPendingEffects();
    }
}

/**
 * Dev-only runaway-wave guard (#111).
 *
 * An effect cascade that keeps writing reactive state effects depend on
 * can re-trigger itself forever — synchronously — and wedge the main
 * thread with zero feedback. Nested triggers flush depth-first via
 * recursive `flushPendingEffects` calls, so the run counter is
 * module-level and scoped to the OUTERMOST wave (counts accumulate
 * across nesting, reset when the outermost flush unwinds). Loops that
 * re-trigger on microtask cadence (each write in its own wave) cannot be
 * caught here — the counter resets between waves by design.
 *
 * The limit is far above any legitimate wave; the check is compiled out
 * of production builds. `setMaxWaveEffectRuns` exists for tests only.
 */
const MAX_WAVE_EFFECT_RUNS = 100000;
let maxWaveEffectRuns = MAX_WAVE_EFFECT_RUNS;
let waveRuns = 0;
let waveDepth = 0;

/**
 * Test-only override for the dev-mode runaway-wave limit (the default is
 * deliberately too large to reach in a unit test). Pass `null` to restore.
 * @internal
 */
export function setMaxWaveEffectRuns(limit: number | null): void {
    maxWaveEffectRuns = limit ?? MAX_WAVE_EFFECT_RUNS;
}

function flushPendingEffects(): void {
    if (__DEV__) waveDepth++;
    try {
        while (pendingEffects.length > 0) {
            // Snapshot-and-clear: a nested trigger during a run flushes its
            // own wave immediately (depth-first), exactly as before.
            const effects = pendingEffects.splice(0, pendingEffects.length);
            let i = 0;
            try {
                for (; i < effects.length; i++) {
                    const effect = effects[i];
                    effect.flags &= ~QUEUED;
                    if (__DEV__ && ++waveRuns > maxWaveEffectRuns) {
                        throw new Error(
                            `Runaway notification wave: more than ${maxWaveEffectRuns} effect ` +
                            `runs in a single wave — an effect cascade is writing reactive ` +
                            `state it depends on (directly or transitively).`
                        );
                    }
                    effect();
                }
            } finally {
                // A throwing effect abandons the rest of the snapshot. Those
                // effects are no longer in pendingEffects, so leaving QUEUED
                // set would wedge them forever — clear it so a later write
                // can re-queue them.
                for (let j = i + 1; j < effects.length; j++) {
                    effects[j].flags &= ~QUEUED;
                }
            }
        }
        // Every notification wave ends by draining scheduled work (e.g. the
        // renderer's render queue), so scheduler users never need their own
        // "am I mid-batch?" probe.
        if (flushHandler) flushHandler();
    } finally {
        if (__DEV__ && --waveDepth === 0) {
            waveRuns = 0;
        }
    }
}

let flushHandler: (() => void) | null = null;

/**
 * Register a callback invoked at the end of every notification wave
 * (after all pending effects have run). Used by renderers to drain a
 * deduplicated job queue filled via the effect `scheduler` option.
 *
 * @internal exported via `@sigx/reactivity/internals`
 */
export function setFlushHandler(fn: (() => void) | null): void {
    flushHandler = fn;
}

/**
 * Full teardown — used on disposal (runner.stop, scope stop), NOT on
 * re-runs (those use startTracking/endTracking link reuse). Also repairs
 * dep.active pointers in case the subscriber is stopped mid-own-run.
 */
export function cleanup(effect: Subscriber): void {
    if (!effect.deps) return;
    for (const link of effect.deps) {
        link.dep.subs.delete(effect);
        // Splice this link out of the dep's active-link stack wherever it
        // sits — not just at the top. A subscriber disposed while nested
        // runs are stacked above it would otherwise be restored as a stale
        // dep.active tombstone by the inner runs' endTracking (retaining
        // the stopped subscriber). The stack is at most nesting-deep.
        let cur = link.dep.active;
        if (cur === link) {
            link.dep.active = link.prevActive;
        } else {
            while (cur !== undefined) {
                if (cur.prevActive === link) {
                    cur.prevActive = link.prevActive;
                    break;
                }
                cur = cur.prevActive;
            }
        }
        link.prevActive = undefined;
    }
    effect.deps.length = 0;
}

/**
 * Open a re-run's tracking window: install each existing link as its
 * dep's `active` link (saving the previous one for LIFO restore) and
 * clear its `seen` flag. track() then reuses installed links with a
 * single identity compare — no allocation, no Set operations — and
 * endTracking() sweeps whatever wasn't re-read.
 */
export function startTracking(sub: Subscriber): void {
    const deps = sub.deps;
    for (let i = 0; i < deps.length; i++) {
        const link = deps[i];
        link.seen = false;
        link.prevActive = link.dep.active;
        link.dep.active = link;
    }
}

/**
 * Close a tracking window: restore each dep's previous `active` link
 * (LIFO — nested runs are strictly stacked), keep re-read links, and
 * unsubscribe from deps that were not read this run.
 */
export function endTracking(sub: Subscriber): void {
    const deps = sub.deps;
    let write = 0;
    for (let i = 0; i < deps.length; i++) {
        const link = deps[i];
        link.dep.active = link.prevActive;
        link.prevActive = undefined;
        if (link.seen) {
            deps[write++] = link;
        } else {
            link.dep.subs.delete(sub);
        }
    }
    deps.length = write;
}

export function track(dep: Dep): void {
    const sub = currentSubscriber;
    if (!sub) return;
    const link = dep.active;
    if (link !== undefined && link.sub === sub) {
        // Reuse the existing subscription — this branch is both the
        // re-run fast path AND the within-run duplicate-read dedup.
        if (!link.seen) {
            link.seen = true;
            link.version = dep.version;
        }
        return;
    }
    const newLink: Link = { dep, sub, version: dep.version, seen: true, prevActive: dep.active };
    // New links join the window so endTracking restores dep.active for
    // them too (they saved the previous active above).
    dep.active = newLink;
    dep.subs.add(sub);
    sub.deps.push(newLink);
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
    startBatch();
    try {
        mark(dep, DIRTY);
    } finally {
        endBatch();
    }
}

function mark(dep: Dep, bit: number): void {
    // The mark phase runs no user code, so dep.subs cannot mutate
    // mid-iteration — no snapshot needed.
    for (const sub of dep.subs) {
        const prev = sub.flags;
        if (sub.ownDep) {
            sub.flags = (prev | bit) & ~ERRORED;
            // Computed node: propagate downstream once per wave. An
            // already-flagged computed has already propagated (this also
            // terminates cycles) — unless its last refresh errored, in
            // which case it must re-notify so subscribers can retry.
            if ((prev & (DIRTY | MAYBE_DIRTY)) === 0 || (prev & ERRORED) !== 0) {
                mark(sub.ownDep, MAYBE_DIRTY);
            }
        } else {
            sub.flags = prev | bit | QUEUED;
            if ((prev & QUEUED) === 0) {
                pendingEffects.push(sub);
            }
        }
    }
}

function runEffect(fn: EffectFn, scheduler?: EffectScheduler): EffectRunner {
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
    let effectId: number | null = null;
    const hookAtCreate = __DEV__ ? getDevtoolsHook() : null;
    if (hookAtCreate) {
        effectId = hookAtCreate.nextId();
        hookAtCreate.emit({
            type: 'effect:created',
            id: effectId,
            ownerComponentId: hookAtCreate.currentOwner,
        });
    }

    // The tracked subscriber: invoked on notification. With a scheduler,
    // notifications hand the validating `runJob` to the caller's queue
    // instead of executing it — dedup and ordering become the caller's
    // policy, while validation (and thus the value-equality cutoff) stays
    // inside the job itself.
    const effectFn: Subscriber = function () {
        if (stopped) return;
        if (running) {
            // Re-entrant notification (the effect triggered itself while
            // executing): dropped, never scheduled — matching the long-
            // standing guard that prevents render loops. Clear the dirt
            // bits (but keep QUEUED bookkeeping) so a stale bit can't
            // skew the next real validation.
            effectFn.flags &= QUEUED;
            return;
        }
        if (scheduler) {
            scheduler(runJob);
            return;
        }
        runJob();
    } as Subscriber;

    const runJob = (): void => {
        if (stopped) return;
        if (running) {
            // Late-invoked scheduled job overlapping a manual run: drop.
            effectFn.flags &= QUEUED;
            return;
        }
        const flags = effectFn.flags;
        effectFn.flags &= QUEUED;
        if ((flags & MAYBE_DIRTY) !== 0 && (flags & DIRTY) === 0) {
            // Only computed sources were invalidated: pull-validate them
            // and skip the run entirely if no value actually changed.
            if (!sourcesChanged(effectFn)) {
                return;
            }
        }
        running = true;
        startTracking(effectFn);
        const prev = currentSubscriber;
        currentSubscriber = effectFn;
        if (!__DEV__ || effectId === null) {
            try {
                fn();
            } finally {
                endTracking(effectFn);
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
            endTracking(effectFn);
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
    };

    effectFn.deps = [];
    effectFn.flags = DIRTY;
    // The first run is always immediate and inline, even with a scheduler.
    runJob();

    // Return the effect as a runner with a stop method. Manual runs are
    // forced: they bypass both the scheduler and validation by marking
    // the effect dirty and running the job directly.
    const runner = (() => {
        effectFn.flags |= DIRTY;
        return runJob();
    }) as EffectRunner;
    runner.stop = () => {
        stopped = true;
        cleanup(effectFn);
        if (__DEV__ && effectId !== null) {
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
export function effect(fn: EffectFn, options?: EffectOptions): EffectRunner {
    const runner = runEffect(fn, options?.scheduler);
    registerWithActiveScope(runner.stop);
    return runner;
}

/**
 * Create an effect WITHOUT registering it with the active effect scope.
 * For composite primitives (e.g. `watch`) that register their own, more
 * complete disposer with the scope instead.
 * @internal
 */
export function rawEffect(fn: EffectFn): EffectRunner {
    return runEffect(fn);
}

/**
 * Register a disposer with the currently-active effect scope, if any.
 *
 * When a `collectSetupScope()` region is active (component setup), the disposer
 * is captured into a lazily-allocated array instead — so a setup that creates
 * no reactions allocates nothing.
 * @internal
 */
export function registerWithActiveScope(dispose: () => void): void {
    if (collectingScope) {
        (collectedDisposers ??= []).push(dispose);
    } else {
        activeScopeCleanups?.push(dispose);
    }
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

// Cleanup list of the scope whose run() is currently on the stack.
// effect() pushes its runner's stop here; nested scopes push their own stop
// so they are disposed with their parent (unless created detached).
let activeScopeCleanups: (() => void)[] | null = null;

// Lazy component-setup collector state (see collectSetupScope). When
// `collectingScope` is true, registrations route into `collectedDisposers`,
// which is allocated only on the first reaction — so a setup that creates no
// effect()/watch() costs nothing.
let collectingScope = false;
let collectedDisposers: (() => void)[] | null = null;
let pendingSetupDisposers: (() => void)[] | null = null;

/**
 * Run `fn` (a component's setup) capturing every `effect()`, `watch()`, and
 * non-detached `effectScope()` it creates synchronously. The collected
 * disposers are retrievable via {@link takeSetupDisposers} immediately after —
 * the renderer stores them and runs them on unmount, tying setup reactions to
 * the component's lifetime.
 *
 * Zero-allocation for reaction-less setups: the backing array is created only
 * on the first registration. The region is detached — it owns its reactions
 * regardless of any outer effect scope active at mount time.
 * @internal
 */
export function collectSetupScope<T>(fn: () => T): T {
    const prevCollecting = collectingScope;
    const prevCollected = collectedDisposers;
    const prevScope = activeScopeCleanups;
    collectingScope = true;
    collectedDisposers = null;
    activeScopeCleanups = null;
    try {
        return fn();
    } finally {
        pendingSetupDisposers = collectedDisposers;
        collectingScope = prevCollecting;
        collectedDisposers = prevCollected;
        activeScopeCleanups = prevScope;
    }
}

/**
 * Retrieve (and clear) the disposers collected by the most recent
 * {@link collectSetupScope} call, or `null` if it created no reactions.
 * @internal
 */
export function takeSetupDisposers(): (() => void)[] | null {
    const disposers = pendingSetupDisposers;
    pendingSetupDisposers = null;
    return disposers;
}

/**
 * Create an effect scope that collects reactive effects for bulk disposal.
 * Effects and watchers created synchronously inside `run()` are disposed by
 * `stop()`. Scopes created inside another scope's `run()` are stopped with
 * their parent unless created with `effectScope(true)` (detached).
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
    stop(): void;
} {
    const cleanups: (() => void)[] = [];
    let active = true;

    const scope = {
        run<T>(fn: () => T): T | undefined {
            if (!active) return undefined;
            const prev = activeScopeCleanups;
            const prevCollecting = collectingScope;
            activeScopeCleanups = cleanups;
            // An explicit scope takes precedence over an enclosing setup
            // collector: effects created in this run() belong to THIS scope.
            collectingScope = false;
            try {
                return fn();
            } finally {
                activeScopeCleanups = prev;
                collectingScope = prevCollecting;
            }
        },
        stop() {
            if (!active) return;
            active = false;
            // Drain until empty: a disposer may synchronously create new
            // effects/watchers that register into this scope (when stop() is
            // called while this scope's run() is active) — they must be
            // disposed too, not leaked into a cleared list.
            while (cleanups.length > 0) {
                const toDispose = cleanups.splice(0, cleanups.length);
                toDispose.forEach(dispose => dispose());
            }
            // If stop() was called inside this scope's own run(), detach the
            // registration target so effects created after stop() don't pile
            // into a dead scope's list (they become unscoped instead).
            if (activeScopeCleanups === cleanups) {
                activeScopeCleanups = null;
            }
        }
    };

    // Register this scope's stop with the enclosing scope (or the setup
    // collector, if one is active) so a non-detached scope created in a
    // component's setup is disposed with the component.
    if (!detached) {
        registerWithActiveScope(() => scope.stop());
    }

    return scope;
}
