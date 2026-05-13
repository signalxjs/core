/**
 * DevTools hook contract — single global object that every layer
 * (reactivity, runtime-core, store, router) emits into.
 *
 * The hook lives here in `@sigx/reactivity` because reactivity is at
 * the bottom of the dep stack — runtime-core depends on us, not the
 * other way around. Higher layers extend the event union with their
 * own variants and emit them through the same `hook.emit()`.
 *
 * Performance contract: every emission must short-circuit on the
 * `getDevtoolsHook()` null check. When no hook is installed (the
 * production-without-devtools case), an emission costs one global
 * read plus one null comparison. We do NOT try to make these
 * branches free at module load — Vite's tree-shaking and the JIT
 * handle the rest.
 */

/**
 * Base shape every devtools event satisfies. Layers extend with their
 * own `{ type: 'foo:bar'; …extra fields }` variants — the index
 * signature lets `hook.emit(layeredEvent)` typecheck without forcing
 * every layer's union into the base type. Consumers narrow on `type`.
 */
export interface DevtoolsEventBase {
    readonly type: string;
    readonly [key: string]: unknown;
}

export type DevtoolsListenerBase = (event: DevtoolsEventBase) => void;

export const DEVTOOLS_HOOK_KEY = '__SIGX_DEVTOOLS_HOOK__';

export interface DevtoolsHook {
    /** Hook protocol version. Consumers should check compatibility. */
    readonly version: 1;
    /**
     * Apps registered with the hook. Opaque at this layer — `runtime-core`
     * stores `AppContext` references here. Reactivity doesn't read it.
     */
    readonly apps: Set<unknown>;
    /**
     * Component id of the currently-mounting component, set by
     * `runtime-core` during setup. Reactivity reads this when a signal
     * or effect is created so the devtools can attribute ownership
     * without reactivity importing component types.
     */
    currentOwner: number | null;
    /** Mint a fresh monotonic id. Shared id space across signals, effects, components, etc. */
    nextId(): number;
    /** Push an event into the hook. */
    emit(event: DevtoolsEventBase): void;
    /** Subscribe to events. Returns an unsubscribe. */
    on(listener: DevtoolsListenerBase): () => void;
    /**
     * Events emitted before any listener attached. A late-attaching
     * client drains this on `on()`.
     */
    readonly buffer: DevtoolsEventBase[];
}

declare global {
    // eslint-disable-next-line no-var
    var __SIGX_DEVTOOLS_HOOK__: DevtoolsHook | undefined;
}

/** Get the installed devtools hook, or `null` if none is present. */
export function getDevtoolsHook(): DevtoolsHook | null {
    if (typeof globalThis === 'undefined') return null;
    return globalThis[DEVTOOLS_HOOK_KEY] ?? null;
}

/**
 * Run a function with owner attribution suppressed.
 *
 * Used by the renderer to wrap framework-internal reactives (props
 * wrappers, slots) so they aren't blamed on whichever component's
 * render effect happens to be active. Without this, every remount
 * leaks fresh signals into the parent's "reactives" panel because
 * the parent's render effect is the one running while the child's
 * `reactiveProps = signal(...)` is set up.
 *
 * No-op when no hook is installed.
 */
export function withoutOwnerTracking<T>(fn: () => T): T {
    const hook = getDevtoolsHook();
    if (!hook) return fn();
    const prev = hook.currentOwner;
    hook.currentOwner = null;
    try {
        return fn();
    } finally {
        hook.currentOwner = prev;
    }
}

/**
 * Centralized devtools "signal updated" emit.
 *
 * Called from every mutation path on a reactive signal — the proxy
 * `set` and `deleteProperty` traps in signal.ts, plus the Map/Set
 * instrumentations in collections.ts (`add`, `set`, `delete`,
 * `clear`). Routing every mutation through one function means the
 * panel sees every state change, not just object-property writes.
 *
 * `signalId === null` short-circuits — that's the "signal was created
 * before any devtools hook attached" case, which we deliberately
 * leave invisible (matching the rest of the surface).
 */
export function notifySignalUpdated(signalId: number | null, key: string | symbol): void {
    if (signalId === null) return;
    const hook = getDevtoolsHook();
    if (!hook) return;
    hook.emit({
        type: 'signal:updated',
        id: signalId,
        key: typeof key === 'symbol' ? key.toString() : String(key),
    });
}

// ----------------------------------------------------------------------------
// id → reactive proxy lookup
// ----------------------------------------------------------------------------

/**
 * Reverse index for reactive primitives — lets the @sigx/devtools
 * plugin resolve a wire-side id back to the underlying proxy so it can
 * serialize a current snapshot on demand (`get:reactive-value`). Held
 * weakly so a signal/computed that goes out of scope can still be
 * garbage-collected.
 *
 * Only populated when a hook was installed at creation time. Without
 * devtools, the map stays empty.
 */
const reactiveProxiesById = new Map<number, WeakRef<object>>();

/** @internal */
export function registerReactiveProxy(id: number, proxy: object): void {
    reactiveProxiesById.set(id, new WeakRef(proxy));
}

/**
 * Resolve a reactive proxy by its devtools id, or `null` if it was
 * never registered or has been garbage-collected.
 *
 * @internal
 */
export function getReactiveById(id: number): object | null {
    const ref = reactiveProxiesById.get(id);
    if (!ref) return null;
    const value = ref.deref();
    if (value === undefined) {
        reactiveProxiesById.delete(id);
        return null;
    }
    return value;
}

/**
 * Install a hook if one is not already present.
 *
 * Idempotent: if a hook is already installed (e.g. a content script
 * injected a stub before sigx loaded), this returns the existing hook
 * unchanged. That lets clients race the runtime safely.
 */
export function ensureDevtoolsHook(): DevtoolsHook {
    const existing = getDevtoolsHook();
    if (existing) return existing;

    const listeners = new Set<DevtoolsListenerBase>();
    const buffer: DevtoolsEventBase[] = [];
    let nextIdCounter = 1;

    const hook: DevtoolsHook = {
        version: 1,
        apps: new Set(),
        currentOwner: null,
        buffer,
        nextId() {
            return nextIdCounter++;
        },
        emit(event) {
            if (listeners.size === 0) {
                // Bounded buffer so a page that never attaches a client
                // doesn't grow without bound. 1000 covers the typical
                // load-page-then-open-panel gap.
                if (buffer.length >= 1000) buffer.shift();
                buffer.push(event);
                return;
            }
            for (const l of listeners) {
                try {
                    l(event);
                } catch (err) {
                    console.error('[sigx-devtools] listener threw:', err);
                }
            }
        },
        on(listener) {
            listeners.add(listener);
            if (buffer.length > 0) {
                const drained = buffer.splice(0, buffer.length);
                for (const event of drained) {
                    try {
                        listener(event);
                    } catch (err) {
                        console.error('[sigx-devtools] listener threw during replay:', err);
                    }
                }
            }
            return () => {
                listeners.delete(listener);
            };
        },
    };

    globalThis[DEVTOOLS_HOOK_KEY] = hook;
    return hook;
}
