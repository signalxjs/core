/**
 * DevTools hook smoke tests. Verifies:
 *   - the hook installs idempotently
 *   - buffer drains on `on()` subscribe
 *   - `notifyComponent*` emits the right events when a hook is present
 *   - `notifyComponent*` is a no-op when no hook is present
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    DEVTOOLS_HOOK_KEY,
    getDevtoolsHook,
    ensureDevtoolsHook,
    type DevtoolsEvent,
} from '../src/devtools-hook';
import {
    notifyComponentMounted,
    notifyComponentUpdated,
    notifyComponentUnmounted,
    handleComponentError,
} from '../src/app';
import {
    setCurrentInstance,
    getInstanceId,
    getParentInstanceId,
} from '../src/component-lifecycle';
import type { AppContext, ComponentInstance } from '../src/app-types';
import type { ComponentSetupContext } from '../src/component-types';

function makeContext(): AppContext {
    return {
        app: null!,
        provides: new Map(),
        config: {},
        hooks: [],
        directives: new Map(),
    };
}

function makeInstance(name = 'Foo'): ComponentInstance {
    return { name, ctx: {} as any, vnode: {} as any };
}

describe('devtools hook', () => {
    beforeEach(() => {
        delete (globalThis as any)[DEVTOOLS_HOOK_KEY];
    });
    afterEach(() => {
        delete (globalThis as any)[DEVTOOLS_HOOK_KEY];
    });

    it('is null when not installed', () => {
        expect(getDevtoolsHook()).toBeNull();
    });

    it('ensureDevtoolsHook is idempotent', () => {
        const a = ensureDevtoolsHook();
        const b = ensureDevtoolsHook();
        expect(a).toBe(b);
        expect(getDevtoolsHook()).toBe(a);
    });

    it('buffers events until a listener attaches, then drains', () => {
        const hook = ensureDevtoolsHook();
        const ctx = makeContext();
        const inst = makeInstance();

        notifyComponentMounted(ctx, inst);
        notifyComponentMounted(ctx, makeInstance('Bar'));

        const seen: string[] = [];
        hook.on(raw => {
            const event = raw as DevtoolsEvent;
            if (event.type === 'component:mounted') seen.push(event.instance.name!);
        });

        expect(seen).toEqual(['Foo', 'Bar']);
    });

    it('emits live events to subscribers', () => {
        const hook = ensureDevtoolsHook();
        const events: string[] = [];
        hook.on(event => events.push(event.type));

        const ctx = makeContext();
        const inst = makeInstance();
        notifyComponentMounted(ctx, inst);
        notifyComponentUpdated(ctx, inst);
        notifyComponentUnmounted(ctx, inst);
        handleComponentError(ctx, new Error('boom'), inst, 'render');

        expect(events).toEqual([
            'component:mounted',
            'component:updated',
            'component:unmounted',
            'component:error',
        ]);
    });

    it('is a complete no-op when no hook is installed', () => {
        // No assertion here beyond "does not throw" — the point of this
        // test is to lock in the runtime's behavior when devtools is
        // absent (the common production case).
        const ctx = makeContext();
        const inst = makeInstance();
        expect(() => {
            notifyComponentMounted(ctx, inst);
            notifyComponentUpdated(ctx, inst);
            notifyComponentUnmounted(ctx, inst);
            handleComponentError(ctx, new Error('x'), inst, 'render');
        }).not.toThrow();
        expect(getDevtoolsHook()).toBeNull();
    });

    it('caps the buffer at 1000 entries to avoid unbounded growth', () => {
        const hook = ensureDevtoolsHook();
        const ctx = makeContext();
        for (let i = 0; i < 1500; i++) {
            notifyComponentMounted(ctx, makeInstance(`C${i}`));
        }
        expect(hook.buffer.length).toBe(1000);
        // Latest events win, oldest are dropped.
        const last = hook.buffer[hook.buffer.length - 1] as DevtoolsEvent;
        expect(last.type).toBe('component:mounted');
        if (last.type === 'component:mounted') {
            expect(last.instance.name).toBe('C1499');
        }
    });

    it('a listener throwing does not break the runtime', () => {
        const hook = ensureDevtoolsHook();
        hook.on(() => { throw new Error('listener bug'); });
        const ctx = makeContext();
        // Should swallow the listener error rather than propagate.
        expect(() => notifyComponentMounted(ctx, makeInstance())).not.toThrow();
    });

    it('a listener throwing during buffer replay does not break attach', () => {
        const hook = ensureDevtoolsHook();
        // Buffer an event before any subscriber attaches.
        notifyComponentMounted(makeContext(), makeInstance());
        // Now subscribe a buggy listener — replay should swallow the
        // throw and let the listener continue receiving live events.
        let liveSeen = 0;
        hook.on(() => { throw new Error('replay bug'); });
        // Subsequent live emits still flow.
        const goodListener = () => { liveSeen += 1; };
        hook.on(goodListener);
        notifyComponentMounted(makeContext(), makeInstance());
        expect(liveSeen).toBe(1);
    });

    it('setCurrentInstance mints an id per ctx and updates currentOwner', () => {
        const hook = ensureDevtoolsHook();
        const parent = { __ctx: 'parent' } as unknown as ComponentSetupContext<any, any, any>;
        const child = { __ctx: 'child', parent } as unknown as ComponentSetupContext<any, any, any>;

        expect(getInstanceId(parent)).toBeNull();
        expect(hook.currentOwner).toBeNull();

        const prevOuter = setCurrentInstance(parent);
        const parentId = getInstanceId(parent);
        expect(typeof parentId).toBe('number');
        expect(hook.currentOwner).toBe(parentId);

        const prevInner = setCurrentInstance(child);
        const childId = getInstanceId(child);
        expect(typeof childId).toBe('number');
        expect(childId).not.toBe(parentId);
        expect(hook.currentOwner).toBe(childId);
        // Child's parent id resolves via ctx.parent (the same field DI uses).
        expect(getParentInstanceId(child)).toBe(parentId);

        // Restore in reverse.
        setCurrentInstance(prevInner);
        expect(hook.currentOwner).toBe(parentId);
        setCurrentInstance(prevOuter);
        expect(hook.currentOwner).toBeNull();
    });

    it('setCurrentInstance returns null helpers when no hook is installed', () => {
        // Hook NOT installed in this test (beforeEach already deleted it).
        const ctx = { __ctx: 'lonely' } as unknown as ComponentSetupContext<any, any, any>;
        setCurrentInstance(ctx);
        // No hook → no id minted.
        expect(getInstanceId(ctx)).toBeNull();
        expect(getParentInstanceId(ctx)).toBeNull();
        expect(getParentInstanceId(null)).toBeNull();
        setCurrentInstance(null);
    });
});
