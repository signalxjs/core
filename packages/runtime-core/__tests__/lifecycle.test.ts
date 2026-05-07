import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    onMounted,
    onUnmounted,
    onCreated,
    onUpdated,
    component,
    setCurrentInstance,
    getCurrentInstance,
} from '../src/component';

function createMockContext() {
    return {
        onMounted: vi.fn(),
        onUnmounted: vi.fn(),
        onCreated: vi.fn(),
        onUpdated: vi.fn(),
        props: {},
        signal: vi.fn(),
    } as any;
}

afterEach(() => {
    // Ensure no leftover context leaks between tests
    setCurrentInstance(null);
});

describe('lifecycle hooks called outside component setup', () => {
    it('onMounted warns when called outside setup', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        onMounted(() => {});
        expect(warnSpy).toHaveBeenCalledWith('onMounted called outside of component setup');
        warnSpy.mockRestore();
    });

    it('onUnmounted warns when called outside setup', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        onUnmounted(() => {});
        expect(warnSpy).toHaveBeenCalledWith('onUnmounted called outside of component setup');
        warnSpy.mockRestore();
    });

    it('onCreated warns when called outside setup', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        onCreated(() => {});
        expect(warnSpy).toHaveBeenCalledWith('onCreated called outside of component setup');
        warnSpy.mockRestore();
    });

    it('onUpdated warns when called outside setup', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        onUpdated(() => {});
        expect(warnSpy).toHaveBeenCalledWith('onUpdated called outside of component setup');
        warnSpy.mockRestore();
    });

    it('hooks do not throw when called outside setup', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(() => onMounted(() => {})).not.toThrow();
        expect(() => onUnmounted(() => {})).not.toThrow();
        expect(() => onCreated(() => {})).not.toThrow();
        expect(() => onUpdated(() => {})).not.toThrow();
        warnSpy.mockRestore();
    });
});

describe('lifecycle hooks called inside component setup', () => {
    it('onMounted delegates to context.onMounted', () => {
        const ctx = createMockContext();
        setCurrentInstance(ctx);

        const fn = () => {};
        onMounted(fn);

        expect(ctx.onMounted).toHaveBeenCalledWith(fn);
        expect(ctx.onMounted).toHaveBeenCalledTimes(1);
    });

    it('onUnmounted delegates to context.onUnmounted', () => {
        const ctx = createMockContext();
        setCurrentInstance(ctx);

        const fn = () => {};
        onUnmounted(fn);

        expect(ctx.onUnmounted).toHaveBeenCalledWith(fn);
        expect(ctx.onUnmounted).toHaveBeenCalledTimes(1);
    });

    it('onCreated delegates to context.onCreated', () => {
        const ctx = createMockContext();
        setCurrentInstance(ctx);

        const fn = () => {};
        onCreated(fn);

        expect(ctx.onCreated).toHaveBeenCalledWith(fn);
        expect(ctx.onCreated).toHaveBeenCalledTimes(1);
    });

    it('onUpdated delegates to context.onUpdated', () => {
        const ctx = createMockContext();
        setCurrentInstance(ctx);

        const fn = () => {};
        onUpdated(fn);

        expect(ctx.onUpdated).toHaveBeenCalledWith(fn);
        expect(ctx.onUpdated).toHaveBeenCalledTimes(1);
    });

    it('multiple hooks of the same type register independently', () => {
        const ctx = createMockContext();
        setCurrentInstance(ctx);

        const fn1 = () => {};
        const fn2 = () => {};
        onMounted(fn1);
        onMounted(fn2);

        expect(ctx.onMounted).toHaveBeenCalledTimes(2);
        expect(ctx.onMounted).toHaveBeenNthCalledWith(1, fn1);
        expect(ctx.onMounted).toHaveBeenNthCalledWith(2, fn2);
    });

    it('does not warn when called inside setup', () => {
        const ctx = createMockContext();
        setCurrentInstance(ctx);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        onMounted(() => {});
        onUnmounted(() => {});
        onCreated(() => {});
        onUpdated(() => {});
        expect(warnSpy).not.toHaveBeenCalled();
        warnSpy.mockRestore();
    });
});

describe('setCurrentInstance / getCurrentInstance with lifecycle hooks', () => {
    it('restores previous context after nested setup', () => {
        const outerCtx = createMockContext();
        const innerCtx = createMockContext();

        setCurrentInstance(outerCtx);
        const prev = setCurrentInstance(innerCtx);

        onMounted(() => {});
        expect(innerCtx.onMounted).toHaveBeenCalledTimes(1);
        expect(outerCtx.onMounted).not.toHaveBeenCalled();

        // Restore outer
        setCurrentInstance(prev);
        onMounted(() => {});
        expect(outerCtx.onMounted).toHaveBeenCalledTimes(1);
    });

    it('hooks warn after context is cleared', () => {
        const ctx = createMockContext();
        setCurrentInstance(ctx);
        setCurrentInstance(null);

        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        onMounted(() => {});
        expect(warnSpy).toHaveBeenCalledWith('onMounted called outside of component setup');
        warnSpy.mockRestore();
    });
});

describe('component() factory with lifecycle hooks', () => {
    it('component factory has __setup that can register hooks', () => {
        const mountedFn = vi.fn();
        const TestComponent = component(() => {
            onMounted(mountedFn);
            return () => null;
        });

        expect(TestComponent.__setup).toBeDefined();
        expect(typeof TestComponent.__setup).toBe('function');
    });

    it('component factory stores name from options', () => {
        const Named = component(() => () => null, { name: 'Named' });
        expect(Named.__name).toBe('Named');
    });

    it('component factory has undefined name when not provided', () => {
        const Anonymous = component(() => () => null);
        expect(Anonymous.__name).toBeUndefined();
    });
});
