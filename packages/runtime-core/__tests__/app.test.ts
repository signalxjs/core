/**
 * Comprehensive unit tests for defineApp, app lifecycle,
 * plugin system, and notification hooks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    defineApp,
    setDefaultMount,
    getDefaultMount,
    notifyComponentCreated,
    notifyComponentMounted,
    notifyComponentUnmounted,
    notifyComponentUpdated,
    handleComponentError,
} from '../src/app';
import { SigxError, SigxErrorCode } from '../src/errors';
import { defineDirective } from '../src/directives';
import type { AppContext, ComponentInstance, MountFn, Plugin, PluginInstallFn, AppLifecycleHooks } from '../src/app-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal JSXElement stand-in */
const rootEl = { type: 'div', props: {}, children: [] } as any;

/** Create a mock InjectableFunction with _token and _factory */
function mockInjectable<T>(factory: () => T) {
    const fn = (() => factory()) as any;
    fn._factory = factory;
    fn._token = Symbol('test-token');
    return fn;
}

/** Create a minimal ComponentInstance for notification tests */
function mockInstance(name = 'TestComponent'): ComponentInstance {
    return { name, ctx: {} as any, vnode: {} as any };
}

// ---------------------------------------------------------------------------
// setDefaultMount / getDefaultMount
// ---------------------------------------------------------------------------

describe('setDefaultMount / getDefaultMount', () => {
    afterEach(() => {
        setDefaultMount(null as any);
    });

    it('returns null when no default has been set', () => {
        setDefaultMount(null as any);
        expect(getDefaultMount()).toBeNull();
    });

    it('sets and returns the default mount function', () => {
        const mountFn: MountFn = vi.fn();
        setDefaultMount(mountFn);
        expect(getDefaultMount()).toBe(mountFn);
    });
});

// ---------------------------------------------------------------------------
// defineApp – basic shape
// ---------------------------------------------------------------------------

describe('defineApp', () => {
    afterEach(() => {
        setDefaultMount(null as any);
    });

    it('returns an app object with all expected properties', () => {
        const app = defineApp(rootEl);
        expect(app).toHaveProperty('config');
        expect(app).toHaveProperty('use');
        expect(app).toHaveProperty('defineProvide');
        expect(app).toHaveProperty('hook');
        expect(app).toHaveProperty('directive');
        expect(app).toHaveProperty('mount');
        expect(app).toHaveProperty('unmount');
        expect(app).toHaveProperty('_context');
        expect(app).toHaveProperty('_isMounted');
        expect(app).toHaveProperty('_container');
        expect(app).toHaveProperty('_rootComponent');
    });

    it('_rootComponent returns the root component passed to defineApp', () => {
        const app = defineApp(rootEl);
        expect(app._rootComponent).toBe(rootEl);
    });

    it('_isMounted is false initially', () => {
        const app = defineApp(rootEl);
        expect(app._isMounted).toBe(false);
    });

    it('_container is null initially', () => {
        const app = defineApp(rootEl);
        expect(app._container).toBeNull();
    });

    describe('_context shape', () => {
        it('has a provides Map', () => {
            const app = defineApp(rootEl);
            expect(app._context.provides).toBeInstanceOf(Map);
        });

        it('has a hooks array', () => {
            const app = defineApp(rootEl);
            expect(Array.isArray(app._context.hooks)).toBe(true);
            expect(app._context.hooks).toHaveLength(0);
        });

        it('has a directives Map', () => {
            const app = defineApp(rootEl);
            expect(app._context.directives).toBeInstanceOf(Map);
        });

        it('has a config object', () => {
            const app = defineApp(rootEl);
            expect(app._context.config).toBeDefined();
            expect(typeof app._context.config).toBe('object');
        });

        it('context.app points back to the app', () => {
            const app = defineApp(rootEl);
            expect(app._context.app).toBe(app);
        });

        it('provides contains the AppContext itself (via appContextToken)', () => {
            const app = defineApp(rootEl);
            const providedValues = [...app._context.provides.values()];
            expect(providedValues).toContain(app._context);
        });
    });

    // -----------------------------------------------------------------------
    // app.use() – Plugin System
    // -----------------------------------------------------------------------

    describe('app.use()', () => {
        it('calls install() on object-style plugin', () => {
            const plugin: Plugin = { name: 'test', install: vi.fn() };
            const app = defineApp(rootEl);
            app.use(plugin);
            expect(plugin.install).toHaveBeenCalledOnce();
            expect(plugin.install).toHaveBeenCalledWith(app, undefined);
        });

        it('calls function-style plugin directly', () => {
            const plugin: PluginInstallFn = vi.fn();
            const app = defineApp(rootEl);
            app.use(plugin);
            expect(plugin).toHaveBeenCalledOnce();
            expect(plugin).toHaveBeenCalledWith(app, undefined);
        });

        it('passes options to object-style plugin', () => {
            const plugin: Plugin<{ debug: boolean }> = { install: vi.fn() };
            const app = defineApp(rootEl);
            app.use(plugin, { debug: true });
            expect(plugin.install).toHaveBeenCalledWith(app, { debug: true });
        });

        it('passes options to function-style plugin', () => {
            const plugin: PluginInstallFn<{ level: number }> = vi.fn();
            const app = defineApp(rootEl);
            app.use(plugin, { level: 3 });
            expect(plugin).toHaveBeenCalledWith(app, { level: 3 });
        });

        it('skips duplicate plugin installation and warns', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const plugin: Plugin = { name: 'dup', install: vi.fn() };
            const app = defineApp(rootEl);
            app.use(plugin);
            app.use(plugin);
            expect(plugin.install).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already installed'));
            warnSpy.mockRestore();
        });

        it('skips duplicate function-style plugin installation', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const plugin: PluginInstallFn = vi.fn();
            const app = defineApp(rootEl);
            app.use(plugin);
            app.use(plugin);
            expect(plugin).toHaveBeenCalledTimes(1);
            warnSpy.mockRestore();
        });

        it('warns for invalid plugin (not a function, no install)', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = defineApp(rootEl);
            app.use({} as any);
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid plugin'));
            warnSpy.mockRestore();
        });

        it('returns the app for chaining', () => {
            const app = defineApp(rootEl);
            const result = app.use({ install: vi.fn() });
            expect(result).toBe(app);
        });
    });

    // -----------------------------------------------------------------------
    // app.defineProvide()
    // -----------------------------------------------------------------------

    describe('app.defineProvide()', () => {
        it('creates instance using injectable default factory', () => {
            const injectable = mockInjectable(() => ({ value: 42 }));
            const app = defineApp(rootEl);
            const instance = app.defineProvide(injectable);
            expect(instance).toEqual({ value: 42 });
        });

        it('creates instance using custom factory when provided', () => {
            const injectable = mockInjectable(() => ({ value: 1 }));
            const app = defineApp(rootEl);
            const instance = app.defineProvide(injectable, () => ({ value: 99 }));
            expect(instance).toEqual({ value: 99 });
        });

        it('stores instance in context.provides', () => {
            const injectable = mockInjectable(() => 'hello');
            const app = defineApp(rootEl);
            app.defineProvide(injectable);
            expect(app._context.provides.get(injectable._token)).toBe('hello');
        });

        it('throws SigxError when injectable has no _factory and no custom factory', () => {
            const bad = (() => {}) as any;
            bad._token = Symbol('t');
            // no _factory
            const app = defineApp(rootEl);
            expect(() => app.defineProvide(bad)).toThrow(SigxError);
        });

        it('throws SigxError when injectable has no _token', () => {
            const bad = (() => {}) as any;
            bad._factory = () => 'x';
            // no _token
            const app = defineApp(rootEl);
            expect(() => app.defineProvide(bad)).toThrow(SigxError);
        });

        it('thrown error has PROVIDE_INVALID_INJECTABLE code', () => {
            const bad = (() => {}) as any;
            const app = defineApp(rootEl);
            try {
                app.defineProvide(bad);
                expect.unreachable('should have thrown');
            } catch (e: any) {
                expect(e).toBeInstanceOf(SigxError);
                expect(e.code).toBe(SigxErrorCode.PROVIDE_INVALID_INJECTABLE);
            }
        });
    });

    // -----------------------------------------------------------------------
    // app.hook()
    // -----------------------------------------------------------------------

    describe('app.hook()', () => {
        it('registers lifecycle hooks in context', () => {
            const hooks: AppLifecycleHooks = { onComponentCreated: vi.fn() };
            const app = defineApp(rootEl);
            app.hook(hooks);
            expect(app._context.hooks).toHaveLength(1);
            expect(app._context.hooks[0]).toBe(hooks);
        });

        it('supports multiple hook registrations', () => {
            const app = defineApp(rootEl);
            app.hook({ onComponentCreated: vi.fn() });
            app.hook({ onComponentMounted: vi.fn() });
            expect(app._context.hooks).toHaveLength(2);
        });

        it('returns app for chaining', () => {
            const app = defineApp(rootEl);
            const result = app.hook({});
            expect(result).toBe(app);
        });
    });

    // -----------------------------------------------------------------------
    // app.directive()
    // -----------------------------------------------------------------------

    describe('app.directive()', () => {
        it('registers a directive and retrieves it', () => {
            const dir = defineDirective({ mounted() {} });
            const app = defineApp(rootEl);
            app.directive('tooltip', dir);
            expect(app.directive('tooltip')).toBe(dir);
        });

        it('returns undefined for unregistered directive', () => {
            const app = defineApp(rootEl);
            expect(app.directive('nope')).toBeUndefined();
        });

        it('warns for non-directive definition values', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = defineApp(rootEl);
            app.directive('bad', { mounted() {} } as any); // not created via defineDirective
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not a valid directive'));
            warnSpy.mockRestore();
        });

        it('stores the value even when it is not a proper directive', () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const raw = { mounted() {} };
            const app = defineApp(rootEl);
            app.directive('raw', raw as any);
            expect(app.directive('raw')).toBe(raw);
            vi.restoreAllMocks();
        });

        it('returns app for chaining when registering', () => {
            const dir = defineDirective({});
            const app = defineApp(rootEl);
            const result = app.directive('d', dir);
            expect(result).toBe(app);
        });
    });

    // -----------------------------------------------------------------------
    // app.mount()
    // -----------------------------------------------------------------------

    describe('app.mount()', () => {
        afterEach(() => {
            setDefaultMount(null as any);
        });

        it('calls mount function with rootComponent, container, and context', () => {
            const mountFn: MountFn = vi.fn();
            const container = { id: 'root' };
            const app = defineApp(rootEl);
            app.mount(container, mountFn);
            expect(mountFn).toHaveBeenCalledWith(rootEl, container, app._context);
        });

        it('sets _isMounted to true after mounting', () => {
            const app = defineApp(rootEl);
            app.mount({}, vi.fn());
            expect(app._isMounted).toBe(true);
        });

        it('sets _container to the provided target', () => {
            const container = { el: 'test' };
            const app = defineApp(rootEl);
            app.mount(container, vi.fn());
            expect(app._container).toBe(container);
        });

        it('stores unmount callback returned by mount function', () => {
            const unmountCb = vi.fn();
            const mountFn: MountFn = vi.fn(() => unmountCb);
            const app = defineApp(rootEl);
            app.mount({}, mountFn);
            app.unmount();
            expect(unmountCb).toHaveBeenCalledOnce();
        });

        it('does not store unmount callback when mount returns void', () => {
            const mountFn: MountFn = vi.fn(() => undefined);
            const app = defineApp(rootEl);
            app.mount({}, mountFn);
            // unmount should not throw even with no stored callback
            expect(() => app.unmount()).not.toThrow();
        });

        it('throws SigxError when no mount function and no default', () => {
            setDefaultMount(null as any);
            const app = defineApp(rootEl);
            expect(() => app.mount({})).toThrow(SigxError);
            try {
                app.mount({});
            } catch (e: any) {
                expect(e.code).toBe(SigxErrorCode.NO_MOUNT_FUNCTION);
            }
        });

        it('warns when already mounted', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = defineApp(rootEl);
            app.mount({}, vi.fn());
            app.mount({}, vi.fn());
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already mounted'));
            warnSpy.mockRestore();
        });

        it('returns app when already mounted (no-op)', () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = defineApp(rootEl);
            app.mount({}, vi.fn());
            const result = app.mount({}, vi.fn());
            expect(result).toBe(app);
            vi.restoreAllMocks();
        });

        it('uses setDefaultMount() as fallback when no renderFn given', () => {
            const defaultFn: MountFn = vi.fn();
            setDefaultMount(defaultFn);
            const container = {};
            const app = defineApp(rootEl);
            app.mount(container);
            expect(defaultFn).toHaveBeenCalledWith(rootEl, container, app._context);
        });

        it('returns app for chaining', () => {
            const app = defineApp(rootEl);
            const result = app.mount({}, vi.fn());
            expect(result).toBe(app);
        });
    });

    // -----------------------------------------------------------------------
    // app.unmount()
    // -----------------------------------------------------------------------

    describe('app.unmount()', () => {
        it('calls the stored unmount function', () => {
            const unmountCb = vi.fn();
            const app = defineApp(rootEl);
            app.mount({}, vi.fn(() => unmountCb));
            app.unmount();
            expect(unmountCb).toHaveBeenCalledOnce();
        });

        it('clears provides', () => {
            const injectable = mockInjectable(() => 'val');
            const app = defineApp(rootEl);
            app.defineProvide(injectable);
            app.mount({}, vi.fn());
            expect(app._context.provides.size).toBeGreaterThan(0);
            app.unmount();
            expect(app._context.provides.size).toBe(0);
        });

        it('sets _isMounted to false', () => {
            const app = defineApp(rootEl);
            app.mount({}, vi.fn());
            expect(app._isMounted).toBe(true);
            app.unmount();
            expect(app._isMounted).toBe(false);
        });

        it('sets _container to null', () => {
            const app = defineApp(rootEl);
            app.mount({ el: 'x' }, vi.fn());
            expect(app._container).not.toBeNull();
            app.unmount();
            expect(app._container).toBeNull();
        });

        it('warns when not mounted', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const app = defineApp(rootEl);
            app.unmount();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('not mounted'));
            warnSpy.mockRestore();
        });
    });
});

// ---------------------------------------------------------------------------
// Notification hooks
// ---------------------------------------------------------------------------

describe('Notification hooks', () => {
    function makeContext(hooks: AppLifecycleHooks[] = []): AppContext {
        return {
            app: {} as any,
            provides: new Map(),
            config: {},
            hooks,
            directives: new Map(),
        };
    }

    // -----------------------------------------------------------------------
    // notifyComponentCreated
    // -----------------------------------------------------------------------

    describe('notifyComponentCreated', () => {
        it('calls onComponentCreated on registered hooks', () => {
            const hook = vi.fn();
            const ctx = makeContext([{ onComponentCreated: hook }]);
            const inst = mockInstance();
            notifyComponentCreated(ctx, inst);
            expect(hook).toHaveBeenCalledWith(inst);
        });

        it('calls all registered hooks', () => {
            const h1 = vi.fn();
            const h2 = vi.fn();
            const ctx = makeContext([{ onComponentCreated: h1 }, { onComponentCreated: h2 }]);
            notifyComponentCreated(ctx, mockInstance());
            expect(h1).toHaveBeenCalledOnce();
            expect(h2).toHaveBeenCalledOnce();
        });

        it('is a no-op when context is null', () => {
            expect(() => notifyComponentCreated(null, mockInstance())).not.toThrow();
        });

        it('catches and logs hook errors', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const err = new Error('boom');
            const ctx = makeContext([{ onComponentCreated: () => { throw err; } }]);
            notifyComponentCreated(ctx, mockInstance());
            expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('onComponentCreated'), err);
            errorSpy.mockRestore();
        });

        it('continues calling remaining hooks after one throws', () => {
            vi.spyOn(console, 'error').mockImplementation(() => {});
            const h2 = vi.fn();
            const ctx = makeContext([
                { onComponentCreated: () => { throw new Error(); } },
                { onComponentCreated: h2 },
            ]);
            notifyComponentCreated(ctx, mockInstance());
            expect(h2).toHaveBeenCalledOnce();
            vi.restoreAllMocks();
        });
    });

    // -----------------------------------------------------------------------
    // notifyComponentMounted
    // -----------------------------------------------------------------------

    describe('notifyComponentMounted', () => {
        it('calls onComponentMounted on registered hooks', () => {
            const hook = vi.fn();
            const ctx = makeContext([{ onComponentMounted: hook }]);
            const inst = mockInstance();
            notifyComponentMounted(ctx, inst);
            expect(hook).toHaveBeenCalledWith(inst);
        });

        it('is a no-op when context is null', () => {
            expect(() => notifyComponentMounted(null, mockInstance())).not.toThrow();
        });

        it('catches hook errors', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const ctx = makeContext([{ onComponentMounted: () => { throw new Error('fail'); } }]);
            notifyComponentMounted(ctx, mockInstance());
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });
    });

    // -----------------------------------------------------------------------
    // notifyComponentUnmounted
    // -----------------------------------------------------------------------

    describe('notifyComponentUnmounted', () => {
        it('calls onComponentUnmounted on registered hooks', () => {
            const hook = vi.fn();
            const ctx = makeContext([{ onComponentUnmounted: hook }]);
            const inst = mockInstance();
            notifyComponentUnmounted(ctx, inst);
            expect(hook).toHaveBeenCalledWith(inst);
        });

        it('is a no-op when context is null', () => {
            expect(() => notifyComponentUnmounted(null, mockInstance())).not.toThrow();
        });

        it('catches hook errors', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const ctx = makeContext([{ onComponentUnmounted: () => { throw new Error(); } }]);
            notifyComponentUnmounted(ctx, mockInstance());
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });
    });

    // -----------------------------------------------------------------------
    // notifyComponentUpdated
    // -----------------------------------------------------------------------

    describe('notifyComponentUpdated', () => {
        it('calls onComponentUpdated on registered hooks', () => {
            const hook = vi.fn();
            const ctx = makeContext([{ onComponentUpdated: hook }]);
            const inst = mockInstance();
            notifyComponentUpdated(ctx, inst);
            expect(hook).toHaveBeenCalledWith(inst);
        });

        it('is a no-op when context is null', () => {
            expect(() => notifyComponentUpdated(null, mockInstance())).not.toThrow();
        });

        it('catches hook errors', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const ctx = makeContext([{ onComponentUpdated: () => { throw new Error(); } }]);
            notifyComponentUpdated(ctx, mockInstance());
            expect(errorSpy).toHaveBeenCalled();
            errorSpy.mockRestore();
        });
    });

    // -----------------------------------------------------------------------
    // Hook errors delegate to config.errorHandler
    // -----------------------------------------------------------------------

    describe('hook error delegation to config.errorHandler', () => {
        it('forwards hook error to config.errorHandler', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const handler = vi.fn();
            const ctx = makeContext([{ onComponentCreated: () => { throw new Error('oops'); } }]);
            ctx.config.errorHandler = handler;
            notifyComponentCreated(ctx, mockInstance());
            expect(handler).toHaveBeenCalledWith(
                expect.any(Error),
                expect.anything(),
                expect.stringContaining('onComponentCreated'),
            );
            errorSpy.mockRestore();
        });
    });

    // -----------------------------------------------------------------------
    // handleComponentError
    // -----------------------------------------------------------------------

    describe('handleComponentError', () => {
        it('returns false when context is null', () => {
            expect(handleComponentError(null, new Error(), null, 'test')).toBe(false);
        });

        it('returns false when no hooks and no errorHandler', () => {
            const ctx = makeContext();
            expect(handleComponentError(ctx, new Error(), null, 'test')).toBe(false);
        });

        it('calls onComponentError hook and returns true when handled', () => {
            const hook = vi.fn(() => true);
            const ctx = makeContext([{ onComponentError: hook }]);
            const err = new Error('err');
            const inst = mockInstance();
            const result = handleComponentError(ctx, err, inst, 'render');
            expect(hook).toHaveBeenCalledWith(err, inst, 'render');
            expect(result).toBe(true);
        });

        it('returns false when hook does not return true', () => {
            const ctx = makeContext([{ onComponentError: vi.fn() }]);
            expect(handleComponentError(ctx, new Error(), mockInstance(), 'x')).toBe(false);
        });

        it('falls through to config.errorHandler when hook does not handle', () => {
            const handler = vi.fn(() => true);
            const ctx = makeContext([{ onComponentError: vi.fn() }]);
            ctx.config.errorHandler = handler;
            const err = new Error('e');
            const inst = mockInstance();
            const result = handleComponentError(ctx, err, inst, 'info');
            expect(handler).toHaveBeenCalledWith(err, inst, 'info');
            expect(result).toBe(true);
        });

        it('returns false when errorHandler does not return true', () => {
            const ctx = makeContext();
            ctx.config.errorHandler = vi.fn();
            expect(handleComponentError(ctx, new Error(), mockInstance(), 'z')).toBe(false);
        });

        it('catches errors thrown by onComponentError hook and continues', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const handler = vi.fn(() => true);
            const ctx = makeContext([
                { onComponentError: () => { throw new Error('hook crash'); } },
            ]);
            ctx.config.errorHandler = handler;
            const result = handleComponentError(ctx, new Error(), mockInstance(), 'test');
            expect(errorSpy).toHaveBeenCalled();
            expect(handler).toHaveBeenCalled();
            expect(result).toBe(true);
            errorSpy.mockRestore();
        });

        it('catches errors thrown by config.errorHandler', () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            const ctx = makeContext();
            ctx.config.errorHandler = () => { throw new Error('handler crash'); };
            const result = handleComponentError(ctx, new Error(), mockInstance(), 'test');
            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('app.config.errorHandler'),
                expect.any(Error),
            );
            expect(result).toBe(false);
            errorSpy.mockRestore();
        });

        it('stops checking hooks after one returns true', () => {
            const h1 = vi.fn(() => true);
            const h2 = vi.fn();
            const ctx = makeContext([{ onComponentError: h1 }, { onComponentError: h2 }]);
            const result = handleComponentError(ctx, new Error(), mockInstance(), 'x');
            expect(result).toBe(true);
            expect(h1).toHaveBeenCalledOnce();
            expect(h2).not.toHaveBeenCalled();
        });

        it('does not call errorHandler when a hook already handled the error', () => {
            const handler = vi.fn();
            const ctx = makeContext([{ onComponentError: () => true }]);
            ctx.config.errorHandler = handler;
            handleComponentError(ctx, new Error(), mockInstance(), 'x');
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
