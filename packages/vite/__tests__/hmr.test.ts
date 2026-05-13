import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ComponentSetupContext } from 'sigx/internals';

type ComponentPlugin = {
    onDefine?: (name: string | undefined, factory: any, setup: Function) => void;
};

// Capture registered plugins via a mocked sigx/internals
const registeredPlugins: ComponentPlugin[] = [];
const registerComponentPluginMock = vi.fn((plugin: ComponentPlugin) => {
    registeredPlugins.push(plugin);
});

vi.mock('sigx/internals', () => ({
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
});
