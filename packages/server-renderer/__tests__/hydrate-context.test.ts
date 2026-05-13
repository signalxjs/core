/**
 * Tests for client/hydrate-context.ts internals.
 *
 * Covers createRestoringSignal, plugin registry, app context tracking,
 * normalizeElement, and the pending-server-state branch of the context extension.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Text } from 'sigx';
import {
    createRestoringSignal,
    registerClientPlugin,
    getClientPlugins,
    clearClientPlugins,
    setPendingServerState,
    getCurrentAppContext,
    setCurrentAppContext,
    normalizeElement
} from '../src/client/hydrate-context';
import type { SSRPlugin } from '../src/plugin';

beforeEach(() => {
    clearClientPlugins();
    setCurrentAppContext(null);
    setPendingServerState(null);
});

afterEach(() => {
    clearClientPlugins();
    setCurrentAppContext(null);
    setPendingServerState(null);
});

describe('createRestoringSignal', () => {
    it('returns a signal carrying the restored server value for a named key', () => {
        // Named signals use the bare name as the key (see generateSignalKey)
        const restoring = createRestoringSignal({ count: 42 });
        const s = restoring(0, 'count');
        expect(s.value).toBe(42);
    });

    it('restores via positional keys ($0, $1, ...) when called unnamed', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const restoring = createRestoringSignal({ '$0': 'first', '$1': 'second' });
        const a = restoring('fallback-a');
        const b = restoring('fallback-b');
        expect(a.value).toBe('first');
        expect(b.value).toBe('second');
        warn.mockRestore();
    });

    it('falls back to the initial value when no server entry matches', () => {
        const restoring = createRestoringSignal({});
        const s = restoring('fallback', 'unused-key');
        expect(s.value).toBe('fallback');
    });

    it('uses positional keys when called without a name', () => {
        // The key is generated from positional index — we just verify behavior:
        // two unnamed signal calls in the same factory get distinct keys, but
        // they can still pick up data from server state if those positional
        // keys happen to be present.
        const restoring = createRestoringSignal({});
        const a = restoring(1);
        const b = restoring(2);
        expect(a.value).toBe(1);
        expect(b.value).toBe(2);
    });

    it('warns exactly once per restoring-signal instance for unnamed signals (dev)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const restoring = createRestoringSignal({});
        restoring(0);
        restoring(0);
        restoring(0);
        // Only one warning regardless of how many unnamed signals get created
        const positionalWarnings = warn.mock.calls.filter(c =>
            typeof c[0] === 'string' && c[0].includes('SSR Hydration')
        );
        expect(positionalWarnings.length).toBe(1);
        warn.mockRestore();
    });

    it('does NOT warn when every signal is named', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const restoring = createRestoringSignal({});
        restoring(0, 'a');
        restoring(0, 'b');
        const positionalWarnings = warn.mock.calls.filter(c =>
            typeof c[0] === 'string' && c[0].includes('SSR Hydration')
        );
        expect(positionalWarnings.length).toBe(0);
        warn.mockRestore();
    });
});

describe('Client plugin registry', () => {
    it('registers and retrieves plugins', () => {
        const p1: SSRPlugin = { name: 'a' };
        const p2: SSRPlugin = { name: 'b' };
        registerClientPlugin(p1);
        registerClientPlugin(p2);
        const plugins = getClientPlugins();
        expect(plugins).toEqual([p1, p2]);
    });

    it('clearClientPlugins resets the registry', () => {
        registerClientPlugin({ name: 'x' });
        expect(getClientPlugins()).toHaveLength(1);
        clearClientPlugins();
        expect(getClientPlugins()).toEqual([]);
    });
});

describe('Current app context tracking', () => {
    it('round-trips an AppContext through set/get', () => {
        const ctx = { id: 'app-1' } as any;
        expect(getCurrentAppContext()).toBeNull();
        setCurrentAppContext(ctx);
        expect(getCurrentAppContext()).toBe(ctx);
        setCurrentAppContext(null);
        expect(getCurrentAppContext()).toBeNull();
    });
});

describe('normalizeElement', () => {
    it('returns null for null / undefined / boolean inputs', () => {
        expect(normalizeElement(null)).toBeNull();
        expect(normalizeElement(undefined)).toBeNull();
        expect(normalizeElement(true)).toBeNull();
        expect(normalizeElement(false)).toBeNull();
    });

    it('wraps a string in a Text VNode', () => {
        const v = normalizeElement('hi')!;
        expect(v.type).toBe(Text);
        expect(v.text).toBe('hi');
        expect(v.children).toEqual([]);
    });

    it('wraps a number in a Text VNode', () => {
        const v = normalizeElement(42)!;
        expect(v.type).toBe(Text);
        expect(v.text).toBe(42);
    });

    it('passes through a VNode unchanged', () => {
        const vnode = { type: 'div', props: {}, key: null, children: [], dom: null };
        expect(normalizeElement(vnode)).toBe(vnode);
    });
});

describe('Context extension behavior (via component setup)', () => {
    // The context extension at the bottom of hydrate-context.ts runs on every
    // component setup. We can exercise it by spinning up a fake instance with
    // applyContextExtensions.
    it('attaches a default client-side ssr helper when no pending state exists', async () => {
        const { applyContextExtensions } = await import('sigx/internals');
        const ctx: any = {};
        applyContextExtensions(ctx);
        expect(ctx.ssr).toBeDefined();
        expect(ctx.ssr.isServer).toBe(false);
        expect(ctx.ssr.isHydrating).toBe(false);
        expect(typeof ctx.ssr.load).toBe('function');
    });

    it('runs the loader and reports errors to console.error', async () => {
        const { applyContextExtensions } = await import('sigx/internals');
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const ctx: any = {};
        applyContextExtensions(ctx);
        await ctx.ssr.load(async () => { throw new Error('load-boom'); });
        // load is fire-and-forget; wait a couple of microtasks
        for (let i = 0; i < 5; i++) await Promise.resolve();
        expect(errSpy).toHaveBeenCalled();
        errSpy.mockRestore();
    });

    it('switches to a no-op ssr.load when _serverState is already set', async () => {
        const { applyContextExtensions } = await import('sigx/internals');
        const ctx: any = { _serverState: { 'name:count': 1 } };
        applyContextExtensions(ctx);
        expect(ctx.ssr.isHydrating).toBe(true);
        // Should not throw, should not call the inner function
        let calls = 0;
        await ctx.ssr.load(async () => { calls++; });
        expect(calls).toBe(0);
    });

    it('consumes pending server state — overrides signal fn and clears the pending slot', async () => {
        const { applyContextExtensions } = await import('sigx/internals');
        const state = { foo: 'restored' };
        setPendingServerState(state);

        const ctx: any = {};
        applyContextExtensions(ctx);

        expect(ctx._serverState).toBe(state);
        expect(ctx.ssr.isHydrating).toBe(true);
        // signal fn was replaced — it should produce a signal whose value
        // matches the restored state for a known name.
        const s = ctx.signal('default', 'foo');
        expect(s.value).toBe('restored');

        // A second component setup should not see the pending state
        const ctx2: any = {};
        applyContextExtensions(ctx2);
        expect(ctx2._serverState).toBeUndefined();
    });
});
