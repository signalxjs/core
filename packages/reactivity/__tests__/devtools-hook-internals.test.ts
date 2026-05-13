/**
 * Coverage for devtools-hook.ts internals not exercised by devtools-events.test.ts:
 * - withoutOwnerTracking restoration (including throw-then-restore)
 * - notifySignalUpdated short-circuit on null id
 * - getReactiveById WeakRef garbage-collection path
 * - Buffer growth past 1000 with shift()
 * - Listener exceptions handled by the hook
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    DEVTOOLS_HOOK_KEY,
    ensureDevtoolsHook,
    getDevtoolsHook,
    withoutOwnerTracking,
    notifySignalUpdated,
    registerReactiveProxy,
    getReactiveById
} from '../src/devtools-hook';

beforeEach(() => {
    delete (globalThis as any)[DEVTOOLS_HOOK_KEY];
});

afterEach(() => {
    delete (globalThis as any)[DEVTOOLS_HOOK_KEY];
});

describe('getDevtoolsHook / ensureDevtoolsHook', () => {
    it('returns null when no hook is installed', () => {
        expect(getDevtoolsHook()).toBeNull();
    });

    it('installs a hook on first call and returns the same instance on subsequent calls', () => {
        const h1 = ensureDevtoolsHook();
        const h2 = ensureDevtoolsHook();
        expect(h1).toBe(h2);
        expect(getDevtoolsHook()).toBe(h1);
    });

    it('mint sequential ids via nextId()', () => {
        const hook = ensureDevtoolsHook();
        const a = hook.nextId();
        const b = hook.nextId();
        const c = hook.nextId();
        expect(b).toBe(a + 1);
        expect(c).toBe(b + 1);
    });
});

describe('withoutOwnerTracking', () => {
    it('runs the function with currentOwner null and restores previous value', () => {
        const hook = ensureDevtoolsHook();
        hook.currentOwner = 42;
        let inner: number | null = -1;
        withoutOwnerTracking(() => {
            inner = hook.currentOwner;
        });
        expect(inner).toBeNull();
        expect(hook.currentOwner).toBe(42);
    });

    it('restores currentOwner even when the function throws', () => {
        const hook = ensureDevtoolsHook();
        hook.currentOwner = 7;
        expect(() => withoutOwnerTracking(() => { throw new Error('boom'); })).toThrow('boom');
        expect(hook.currentOwner).toBe(7);
    });

    it('returns the function value unchanged', () => {
        ensureDevtoolsHook();
        const out = withoutOwnerTracking(() => 'result');
        expect(out).toBe('result');
    });

    it('is a pass-through when no hook is installed', () => {
        const fn = vi.fn(() => 'val');
        const out = withoutOwnerTracking(fn);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(out).toBe('val');
    });
});

describe('notifySignalUpdated', () => {
    it('short-circuits on null signalId without touching the hook', () => {
        const hook = ensureDevtoolsHook();
        const events: any[] = [];
        hook.on(e => events.push(e));
        notifySignalUpdated(null, 'value');
        expect(events).toEqual([]);
    });

    it('no-ops when no hook is installed', () => {
        // Should not throw
        expect(() => notifySignalUpdated(42, 'value')).not.toThrow();
    });

    it('emits a signal:updated event with stringified key', () => {
        const hook = ensureDevtoolsHook();
        const events: any[] = [];
        hook.on(e => events.push(e));
        notifySignalUpdated(7, 'count');
        expect(events).toEqual([{ type: 'signal:updated', id: 7, key: 'count' }]);
    });

    it('converts symbol keys to a stringified form', () => {
        const hook = ensureDevtoolsHook();
        const events: any[] = [];
        hook.on(e => events.push(e));
        const sym = Symbol('s');
        notifySignalUpdated(7, sym);
        expect(events[0].key).toBe(sym.toString());
    });
});

describe('getReactiveById — WeakRef handling', () => {
    it('returns null for an unknown id', () => {
        expect(getReactiveById(999)).toBeNull();
    });

    it('returns the registered proxy while it is alive', () => {
        const obj = { hello: 'world' };
        registerReactiveProxy(123, obj);
        expect(getReactiveById(123)).toBe(obj);
    });

    // Note: we can't reliably force GC in a test environment, but we can
    // exercise the "ref but deref returns undefined" branch by faking a
    // WeakRef whose target was collected. Since registerReactiveProxy wraps
    // the object in a real WeakRef, we patch the internal map by re-registering
    // with a manually-crafted entry via a small helper hack — or skip and
    // rely on the live-proxy path for coverage.
    it('handles a stale (collected) WeakRef by returning null and dropping the entry', () => {
        // Synthesize the collected-WeakRef state by passing an object that
        // never gets a strong reference outside the registry, then forcing
        // the registry to point at a WeakRef that derefs to undefined.
        // We can simulate this by using a stub on the underlying WeakRef.
        const id = 555;
        // Inject a fake WeakRef-like entry through the public API. We can't
        // patch the private map, but we can verify the same code path via a
        // synthetic WeakRef whose deref returns undefined right away.
        const fakeWeakRef = { deref: () => undefined };
        // Build a small bridge: replace globalThis.WeakRef temporarily so
        // registerReactiveProxy stores our stub.
        const RealWeakRef = (globalThis as any).WeakRef;
        (globalThis as any).WeakRef = class {
            constructor() {}
            deref() { return undefined; }
        };
        try {
            registerReactiveProxy(id, {});
        } finally {
            (globalThis as any).WeakRef = RealWeakRef;
        }

        // First call sees the stale ref and deletes it
        expect(getReactiveById(id)).toBeNull();
        // Second call sees no entry
        expect(getReactiveById(id)).toBeNull();
    });
});

describe('emit / buffer behavior', () => {
    it('buffers events when no listeners are attached and replays them on .on()', () => {
        const hook = ensureDevtoolsHook();
        hook.emit({ type: 'first' });
        hook.emit({ type: 'second' });
        const seen: any[] = [];
        const unsub = hook.on(e => seen.push(e));
        expect(seen.map(e => e.type)).toEqual(['first', 'second']);
        // Buffer was drained
        expect(hook.buffer).toEqual([]);
        unsub();
    });

    it('caps the buffer at 1000 entries via shift()', () => {
        const hook = ensureDevtoolsHook();
        for (let i = 0; i < 1200; i++) {
            hook.emit({ type: 'tick', i } as any);
        }
        expect(hook.buffer.length).toBe(1000);
        // Oldest 200 dropped
        expect((hook.buffer[0] as any).i).toBe(200);
        expect((hook.buffer[hook.buffer.length - 1] as any).i).toBe(1199);
    });

    it('continues notifying other listeners when one throws', () => {
        const hook = ensureDevtoolsHook();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const seen: any[] = [];
        hook.on(() => { throw new Error('listener-fail'); });
        hook.on(e => seen.push(e));
        hook.emit({ type: 'x' });
        expect(seen.map(e => e.type)).toEqual(['x']);
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it('logs and recovers when a listener throws during buffer replay', () => {
        const hook = ensureDevtoolsHook();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Pre-fill buffer
        hook.emit({ type: 'queued-1' });
        hook.emit({ type: 'queued-2' });
        hook.on(() => { throw new Error('replay-fail'); });
        // Two replay calls = two console.error calls
        const replayErrors = errSpy.mock.calls.filter(c =>
            typeof c[0] === 'string' && c[0].includes('replay')
        );
        expect(replayErrors.length).toBe(2);
        errSpy.mockRestore();
    });
});

describe('on() unsubscribe', () => {
    it('removes the listener from the set', () => {
        const hook = ensureDevtoolsHook();
        const seen: any[] = [];
        const unsub = hook.on(e => seen.push(e));
        hook.emit({ type: 'before' });
        unsub();
        hook.emit({ type: 'after' });
        expect(seen.map(e => e.type)).toEqual(['before']);
    });
});
