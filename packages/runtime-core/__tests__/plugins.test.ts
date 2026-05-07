/**
 * Plugin system tests for runtime-core.
 *
 * Tests registerComponentPlugin, getComponentPlugins,
 * registerContextExtension, and applyContextExtensions.
 *
 * Note: plugins and contextExtensions are module-level singletons,
 * so tests track array length before each operation and assert relative to that.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    registerComponentPlugin,
    getComponentPlugins,
    registerContextExtension,
    applyContextExtensions,
} from '../src/plugins';
import type { ComponentPlugin } from '../src/plugins';

describe('registerComponentPlugin', () => {
    it('should add a plugin that is retrievable via getComponentPlugins', () => {
        const before = getComponentPlugins().length;
        const plugin: ComponentPlugin = {};
        registerComponentPlugin(plugin);
        const after = getComponentPlugins();
        expect(after.length).toBe(before + 1);
        expect(after[after.length - 1]).toBe(plugin);
    });

    it('should add multiple plugins in registration order', () => {
        const before = getComponentPlugins().length;
        const p1: ComponentPlugin = {};
        const p2: ComponentPlugin = {};
        const p3: ComponentPlugin = {};
        registerComponentPlugin(p1);
        registerComponentPlugin(p2);
        registerComponentPlugin(p3);
        const after = getComponentPlugins();
        expect(after.length).toBe(before + 3);
        expect(after[before]).toBe(p1);
        expect(after[before + 1]).toBe(p2);
        expect(after[before + 2]).toBe(p3);
    });
});

describe('getComponentPlugins', () => {
    it('should return a readonly array (same reference on repeated calls)', () => {
        const a = getComponentPlugins();
        const b = getComponentPlugins();
        expect(a).toBe(b);
    });

    it('should reflect newly registered plugins on the same reference', () => {
        const arr = getComponentPlugins();
        const before = arr.length;
        registerComponentPlugin({});
        expect(arr.length).toBe(before + 1);
    });
});

describe('registerContextExtension', () => {
    it('should register an extension that is later applied', () => {
        const ext = vi.fn((ctx: object) => {
            (ctx as any).added = true;
        });
        registerContextExtension(ext);

        const ctx: Record<string, unknown> = {};
        applyContextExtensions(ctx);
        expect(ext).toHaveBeenCalled();
        expect(ctx.added).toBe(true);
    });
});

describe('applyContextExtensions', () => {
    it('should call all registered extensions with the context object', () => {
        const ext1 = vi.fn();
        const ext2 = vi.fn();
        registerContextExtension(ext1);
        registerContextExtension(ext2);

        const ctx = {};
        applyContextExtensions(ctx);

        expect(ext1).toHaveBeenCalledWith(ctx);
        expect(ext2).toHaveBeenCalledWith(ctx);
    });

    it('should call extensions in registration order', () => {
        const order: number[] = [];
        registerContextExtension(() => order.push(1));
        registerContextExtension(() => order.push(2));
        registerContextExtension(() => order.push(3));

        applyContextExtensions({});

        // The last three entries must be 1, 2, 3 (prior extensions may also run)
        const tail = order.slice(-3);
        expect(tail).toEqual([1, 2, 3]);
    });

    it('should mutate the provided context object', () => {
        registerContextExtension((ctx) => {
            (ctx as any).ssr = { load: () => 'data' };
        });
        registerContextExtension((ctx) => {
            (ctx as any).devtools = true;
        });

        const ctx: Record<string, unknown> = {};
        applyContextExtensions(ctx);

        expect(ctx.ssr).toBeDefined();
        expect((ctx.ssr as any).load()).toBe('data');
        expect(ctx.devtools).toBe(true);
    });
});

describe('multiple plugins and extensions coexist', () => {
    it('should allow registering both plugins and extensions independently', () => {
        const pluginsBefore = getComponentPlugins().length;

        const plugin: ComponentPlugin = { onDefine: vi.fn() };
        registerComponentPlugin(plugin);

        const ext = vi.fn((ctx: object) => {
            (ctx as any).extra = 42;
        });
        registerContextExtension(ext);

        // Plugin registered
        expect(getComponentPlugins().length).toBe(pluginsBefore + 1);
        expect(getComponentPlugins()[pluginsBefore]).toBe(plugin);

        // Extension works
        const ctx: Record<string, unknown> = {};
        applyContextExtensions(ctx);
        expect(ext).toHaveBeenCalledWith(ctx);
        expect(ctx.extra).toBe(42);
    });
});

describe('plugin with onDefine callback', () => {
    it('should store plugin with onDefine and allow invoking the callback', () => {
        const onDefine = vi.fn();
        const plugin: ComponentPlugin = { onDefine };
        const before = getComponentPlugins().length;

        registerComponentPlugin(plugin);

        const registered = getComponentPlugins()[before];
        expect(registered).toBe(plugin);
        expect(registered.onDefine).toBe(onDefine);

        // Simulate how the runtime would call onDefine
        registered.onDefine!('MyComponent', function factory() {}, function setup() {});
        expect(onDefine).toHaveBeenCalledTimes(1);
        expect(onDefine).toHaveBeenCalledWith(
            'MyComponent',
            expect.any(Function),
            expect.any(Function),
        );
    });

    it('should invoke onDefine with undefined name', () => {
        const onDefine = vi.fn();
        registerComponentPlugin({ onDefine });

        const plugins = getComponentPlugins();
        plugins[plugins.length - 1].onDefine!(undefined, () => {}, () => {});
        expect(onDefine).toHaveBeenCalledWith(undefined, expect.any(Function), expect.any(Function));
    });
});
