/**
 * Tests for client/hydrate-context.ts internals.
 *
 * Covers the client plugin registry, app context tracking, normalizeElement,
 * and the client-side `ssr` environment-flags context extension.
 * (Server-state restoration lives in useData/useStream — see
 * async-state.test.tsx and the runtime-core use-async tests.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Text } from 'sigx';
import {
    registerClientPlugin,
    getClientPlugins,
    clearClientPlugins,
    getCurrentAppContext,
    setCurrentAppContext,
    normalizeElement
} from '../src/client/hydrate-context';
import type { SSRPlugin } from '../src/plugin';

beforeEach(() => {
    clearClientPlugins();
    setCurrentAppContext(null);
});

afterEach(() => {
    clearClientPlugins();
    setCurrentAppContext(null);
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
    it('attaches client-side environment flags only (no data loading API)', async () => {
        const { applyContextExtensions } = await import('sigx/internals');
        const ctx: any = {};
        applyContextExtensions(ctx);
        expect(ctx.ssr).toBeDefined();
        expect(ctx.ssr.isServer).toBe(false);
        expect(ctx.ssr.isHydrating).toBe(false);
        // Data loading moved to useData/useStream — ctx.ssr is flags only
        expect((ctx.ssr as any).load).toBeUndefined();
        expect((ctx.ssr as any).stream).toBeUndefined();
    });
});
