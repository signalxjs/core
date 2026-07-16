import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ComponentSetupContext } from 'sigx/internals';
// Module identity note: these static imports stay consistent with what the
// freshly imported HMR module sees, despite `vi.resetModules()` in
// loadFreshHmrModule(). `vi.resetModules()` does NOT reset mocked modules,
// so 'sigx/internals' (mocked below, spreading the real module captured by
// importOriginal at file load) is the same instance for this file and for
// hmr.ts's lazy import. 'sigx' is imported only here, once, at file load —
// the same epoch as importOriginal — so its onUnmounted reads the same
// runtime-core current-instance state that setCurrentInstance writes.
// (Re-importing 'sigx' dynamically after a reset would instead create a
// second runtime-core instance and split that state.)
import { setCurrentInstance, getCurrentInstance } from 'sigx/internals';
import { onUnmounted } from 'sigx';

type ComponentPlugin = {
    onDefine?: (name: string | undefined, factory: any, setup: Function) => void;
};

// Capture registered plugins via a mocked sigx/internals. Everything else
// (setCurrentInstance & co.) stays real so module-level lifecycle hooks
// behave as they do in an app. vi.hoisted: the mock factory is hoisted
// above the static `sigx/internals` import, so its state must be too.
const { registeredPlugins, registerComponentPluginMock } = vi.hoisted(() => {
    const registeredPlugins: ComponentPlugin[] = [];
    return {
        registeredPlugins,
        registerComponentPluginMock: vi.fn((plugin: ComponentPlugin) => {
            registeredPlugins.push(plugin);
        })
    };
});

vi.mock('sigx/internals', async (importOriginal) => ({
    ...await importOriginal<typeof import('sigx/internals')>(),
    registerComponentPlugin: registerComponentPluginMock
}));

function makeCtx(): ComponentSetupContext & { update: ReturnType<typeof vi.fn>; onUnmounted: ReturnType<typeof vi.fn>; renderFn: any; unmountCbs: Array<() => void> } {
    const unmountCbs: Array<() => void> = [];
    return {
        renderFn: undefined as any,
        update: vi.fn(),
        onUnmounted: vi.fn((cb: () => void) => { unmountCbs.push(cb); }),
        unmountCbs
    } as any;
}

/**
 * A ctx that advertises the runtime-core `__hmrReload` primitive (dev builds).
 * The spy mimics the renderer: it runs and drains the registered onUnmounted
 * cleanups (including the HMR runtime's own instance-tracking cleanup, which
 * de-registers the instance) — exactly what the real primitive does before
 * re-running setup.
 */
function makeReloadCtx(): ReturnType<typeof makeCtx> & { __hmrReload: ReturnType<typeof vi.fn> } {
    const ctx = makeCtx() as ReturnType<typeof makeCtx> & { __hmrReload: ReturnType<typeof vi.fn> };
    ctx.__hmrReload = vi.fn(() => {
        const cbs = ctx.unmountCbs.splice(0, ctx.unmountCbs.length);
        cbs.forEach(cb => cb());
    });
    return ctx;
}

async function loadFreshHmrModule(): Promise<{
    registerHMRModule: (id: string) => void;
    installHMRPlugin: () => Promise<void>;
    plugin: ComponentPlugin;
}> {
    vi.resetModules();
    registeredPlugins.length = 0;
    registerComponentPluginMock.mockClear();

    const mod = await import('../src/hmr');

    // Auto-install kicks off at module load via fire-and-forget `installHMRPlugin()`.
    // That async function has already set `installed = true` synchronously, so the
    // next `installHMRPlugin()` call short-circuits. We need to wait for the
    // original auto-install's dynamic import to flush. Poll for the mock to fire.
    for (let i = 0; i < 50 && registerComponentPluginMock.mock.calls.length === 0; i++) {
        await Promise.resolve();
    }
    expect(registerComponentPluginMock).toHaveBeenCalled();
    const plugin = registeredPlugins[0];
    expect(plugin).toBeDefined();

    return {
        registerHMRModule: mod.registerHMRModule,
        installHMRPlugin: mod.installHMRPlugin,
        plugin
    };
}

describe('hmr — installHMRPlugin', () => {
    beforeEach(() => {
        registeredPlugins.length = 0;
        registerComponentPluginMock.mockClear();
    });

    it('auto-installs the plugin and is idempotent on repeat calls', async () => {
        const { installHMRPlugin } = await loadFreshHmrModule();
        const callsAfterFirst = registerComponentPluginMock.mock.calls.length;
        await installHMRPlugin();
        await installHMRPlugin();
        expect(registerComponentPluginMock.mock.calls.length).toBe(callsAfterFirst);
    });
});

describe('hmr — registerHMRModule + onDefine indexing', () => {
    it('assigns sequential component IDs within a module', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        registerHMRModule('moduleA');

        const factoryA: any = {};
        const factoryB: any = {};
        plugin.onDefine!('A', factoryA, () => () => null);
        plugin.onDefine!('B', factoryB, () => () => null);

        expect(factoryA.__hmrId).toBe('moduleA:0');
        expect(factoryB.__hmrId).toBe('moduleA:1');
    });

    it('resets the index when registerHMRModule is called again for the same module', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        registerHMRModule('moduleR');
        plugin.onDefine!('first', {} as any, () => () => null);

        // Module re-executes: index resets to 0
        registerHMRModule('moduleR');
        const f: any = {};
        plugin.onDefine!('first-reload', f, () => () => null);
        expect(f.__hmrId).toBe('moduleR:0');
    });

    it('returns early in onDefine when no current module is set', async () => {
        const { plugin } = await loadFreshHmrModule();
        // No registerHMRModule call — currentModuleId starts at null
        const factory: any = {};
        plugin.onDefine!('Orphan', factory, () => () => null);
        expect(factory.__hmrId).toBeUndefined();
        expect(factory.__setup).toBeUndefined();
    });

    it('wraps factory.__setup so component instances track themselves', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        registerHMRModule('moduleW');

        const factory: any = {};
        const renderFn = () => null;
        plugin.onDefine!('W', factory, () => renderFn);

        expect(typeof factory.__setup).toBe('function');
        const ctx = makeCtx();
        const result = factory.__setup(ctx);
        expect(result).toBe(renderFn);
        expect(ctx.onUnmounted).toHaveBeenCalledTimes(1);
    });
});

describe('hmr — HMR update path', () => {
    it('calls update() on every existing instance when component is re-defined', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        registerHMRModule('moduleU');

        const factory: any = {};
        const originalRender = () => 'v1';
        plugin.onDefine!('Cmp', factory, () => originalRender);

        // Mount two instances
        const c1 = makeCtx();
        const c2 = makeCtx();
        factory.__setup(c1);
        factory.__setup(c2);

        // Module re-executes: redefine with new setup
        registerHMRModule('moduleU');
        const newRender = () => 'v2';
        const newFactory: any = {};
        plugin.onDefine!('Cmp', newFactory, () => newRender);

        // Both old instances received the new render function and an update tick
        expect(c1.renderFn).toBe(newRender);
        expect(c2.renderFn).toBe(newRender);
        expect(c1.update).toHaveBeenCalledTimes(1);
        expect(c2.update).toHaveBeenCalledTimes(1);
    });

    it('logs to console.error when the new setup throws, without breaking the loop', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        registerHMRModule('moduleErr');
        const factory: any = {};
        plugin.onDefine!('ErrCmp', factory, () => () => null);

        const c1 = makeCtx();
        const c2 = makeCtx();
        factory.__setup(c1);
        factory.__setup(c2);

        // Redefine with a throwing setup
        registerHMRModule('moduleErr');
        plugin.onDefine!('ErrCmp', {} as any, () => {
            throw new Error('boom');
        });

        expect(errSpy).toHaveBeenCalled();
        expect(errSpy.mock.calls[0][0]).toMatch(/HMR failed/);
        // Update was attempted for both but neither got a new render fn
        expect(c1.renderFn).toBeUndefined();
        expect(c2.renderFn).toBeUndefined();

        errSpy.mockRestore();
    });

    it('sets the current instance during the setup re-run so module-level lifecycle hooks register (#105)', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        registerHMRModule('moduleHooks');
        const factory: any = {};
        const setupWithHook = () => {
            // Module-level hook (imported from sigx) — registers via the
            // global current instance, unlike the ctx-bound setup hooks.
            onUnmounted(() => {});
            return () => null;
        };
        plugin.onDefine!('Hooked', factory, setupWithHook);

        // Initial mount: the renderer sets the current instance around setup.
        const ctx = makeCtx();
        const prev = setCurrentInstance(ctx as any);
        try {
            factory.__setup(ctx);
        } finally {
            setCurrentInstance(prev);
        }
        // 1 from setupWithHook's onUnmounted + 1 from HMR instance tracking
        expect(ctx.onUnmounted).toHaveBeenCalledTimes(2);

        // Hot update: module re-executes and redefines the component. The HMR
        // re-run must set the current instance itself — nothing else does.
        registerHMRModule('moduleHooks');
        plugin.onDefine!('Hooked', {} as any, setupWithHook);

        // The module-level hook must register on the existing instance,
        // not warn and silently drop the cleanup registration.
        expect(warnSpy).not.toHaveBeenCalled();
        expect(ctx.onUnmounted).toHaveBeenCalledTimes(3);
        // And the current instance must be restored afterwards.
        expect(getCurrentInstance()).toBe(null);

        warnSpy.mockRestore();
    });

    it('removes instances from the registry on unmount', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        registerHMRModule('moduleX');

        const factory: any = {};
        plugin.onDefine!('X', factory, () => () => null);

        const ctx = makeCtx();
        factory.__setup(ctx);
        expect(ctx.unmountCbs.length).toBe(1);

        // Simulate unmount — cleanup callback runs and should remove the
        // instance from the HMR registry.
        ctx.unmountCbs[0]();

        // Re-define the same component. Because the original ctx was unmounted,
        // its update() must NOT be called by the HMR update loop.
        registerHMRModule('moduleX');
        const newRender = () => null;
        plugin.onDefine!('X', {} as any, () => newRender);

        expect(ctx.update).not.toHaveBeenCalled();
        expect(ctx.renderFn).toBeUndefined();
    });

    it('prefers ctx.__hmrReload over the legacy re-run when the core exposes it (#107)', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        registerHMRModule('moduleReload');

        const factory: any = {};
        plugin.onDefine!('Cmp', factory, () => () => 'v1');

        const ctx = makeReloadCtx();
        factory.__setup(ctx);
        // Only the HMR instance-tracking cleanup is registered at mount.
        expect(ctx.onUnmounted).toHaveBeenCalledTimes(1);

        // Hot update: redefine with a new setup.
        registerHMRModule('moduleReload');
        const setup2 = () => () => 'v2';
        plugin.onDefine!('Cmp', {} as any, setup2);

        // The renderer primitive owns the reload — the legacy path (which sets
        // ctx.renderFn directly and calls ctx.update()) is NOT used.
        expect(ctx.__hmrReload).toHaveBeenCalledTimes(1);
        expect(ctx.__hmrReload).toHaveBeenCalledWith(setup2);
        expect(ctx.update).not.toHaveBeenCalled();
        expect(ctx.renderFn).toBeUndefined();
    });

    it('re-tracks instances after a __hmrReload so later hot updates still reach them (#107)', async () => {
        const { registerHMRModule, plugin } = await loadFreshHmrModule();
        registerHMRModule('moduleRetrack');

        const factory: any = {};
        plugin.onDefine!('Cmp', factory, () => () => null);

        const ctx = makeReloadCtx();
        factory.__setup(ctx);

        // First hot update: __hmrReload runs the tracking cleanup, removing the
        // instance from the registry.
        registerHMRModule('moduleRetrack');
        plugin.onDefine!('Cmp', {} as any, () => () => null);
        expect(ctx.__hmrReload).toHaveBeenCalledTimes(1);

        // Second hot update must still reach the instance — proving the runtime
        // re-registered it after the reload disposed the previous tracking hook.
        registerHMRModule('moduleRetrack');
        const setup3 = () => () => null;
        plugin.onDefine!('Cmp', {} as any, setup3);
        expect(ctx.__hmrReload).toHaveBeenCalledTimes(2);
        expect(ctx.__hmrReload).toHaveBeenLastCalledWith(setup3);
    });
});
