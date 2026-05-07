import { describe, it, expect, vi } from 'vitest';
import { ErrorBoundary } from '../src/error-boundary';

function createMockCtx(props: any, defaultSlot: () => any) {
    const signalState = { hasError: false, error: null as Error | null };
    const state = new Proxy(signalState, {
        get(target, prop) { return target[prop as keyof typeof target]; },
        set(target, prop, value) { (target as any)[prop as keyof typeof target] = value; return true; }
    });
    return {
        props,
        slots: { default: defaultSlot },
        signal: vi.fn(() => state),
        _signalState: signalState
    };
}

describe('ErrorBoundary', () => {
    describe('component structure', () => {
        it('is a component factory with __setup and __name', () => {
            expect(typeof ErrorBoundary).toBe('function');
            expect(ErrorBoundary.__setup).toBeDefined();
            expect(typeof ErrorBoundary.__setup).toBe('function');
        });

        it('has name "ErrorBoundary"', () => {
            expect(ErrorBoundary.__name).toBe('ErrorBoundary');
        });
    });

    describe('setup function behavior', () => {
        it('returns slot content when default slot renders without error', () => {
            const slotContent = { type: 'div', props: {}, children: ['hello'] };
            const ctx = createMockCtx({ fallback: undefined }, () => slotContent);

            const render = ErrorBoundary.__setup(ctx as any) as () => any;
            expect(render()).toBe(slotContent);
        });

        it('catches Error thrown by default slot and sets state', () => {
            const thrownError = new Error('render failed');
            const ctx = createMockCtx({ fallback: undefined }, () => { throw thrownError; });

            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const render = ErrorBoundary.__setup(ctx as any) as () => any;
            render();
            consoleError.mockRestore();

            expect(ctx._signalState.hasError).toBe(true);
            expect(ctx._signalState.error).toBe(thrownError);
        });

        it('wraps non-Error thrown values in an Error', () => {
            const ctx = createMockCtx({ fallback: undefined }, () => { throw 'string error'; });

            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const render = ErrorBoundary.__setup(ctx as any) as () => any;
            render();
            consoleError.mockRestore();

            expect(ctx._signalState.error).toBeInstanceOf(Error);
            expect(ctx._signalState.error!.message).toBe('string error');
        });

        it('calls function fallback with (error, retry) when slot throws', () => {
            const thrownError = new Error('boom');
            const fallbackResult = { type: 'span', props: {}, children: ['fallback'] };
            const fallback = vi.fn(() => fallbackResult);
            const ctx = createMockCtx({ fallback }, () => { throw thrownError; });

            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const render = ErrorBoundary.__setup(ctx as any) as () => any;
            const result = render();
            consoleError.mockRestore();

            expect(fallback).toHaveBeenCalledTimes(1);
            expect(fallback).toHaveBeenCalledWith(thrownError, expect.any(Function));
            expect(result).toBe(fallbackResult);
        });

        it('returns JSXElement fallback when slot throws', () => {
            const fallbackElement = { type: 'div', props: {}, children: ['error ui'] };
            const ctx = createMockCtx({ fallback: fallbackElement }, () => { throw new Error('fail'); });

            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const render = ErrorBoundary.__setup(ctx as any) as () => any;
            const result = render();
            consoleError.mockRestore();

            expect(result).toBe(fallbackElement);
        });

        it('returns null when no fallback is provided and slot throws', () => {
            const ctx = createMockCtx({ fallback: undefined }, () => { throw new Error('fail'); });

            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const render = ErrorBoundary.__setup(ctx as any) as () => any;
            const result = render();
            consoleError.mockRestore();

            expect(result).toBeNull();
        });

        it('retry resets hasError and error to initial values', () => {
            const fallback = vi.fn((_error: Error, retry: () => void) => {
                retry();
                return null;
            });
            const ctx = createMockCtx({ fallback }, () => { throw new Error('fail'); });

            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const render = ErrorBoundary.__setup(ctx as any) as () => any;
            render();
            consoleError.mockRestore();

            expect(ctx._signalState.hasError).toBe(false);
            expect(ctx._signalState.error).toBeNull();
        });

        it('re-renders slot content after retry when slot succeeds', () => {
            let shouldThrow = true;
            const slotContent = { type: 'div', props: {}, children: ['recovered'] };
            const defaultSlot = () => {
                if (shouldThrow) throw new Error('fail');
                return slotContent;
            };

            let capturedRetry: (() => void) | null = null;
            const fallback = vi.fn((error: Error, retry: () => void) => {
                capturedRetry = retry;
                return { type: 'span', props: {}, children: ['error'] };
            });
            const ctx = createMockCtx({ fallback }, defaultSlot);

            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const render = ErrorBoundary.__setup(ctx as any) as () => any;

            // First render: throws, shows fallback
            render();
            expect(ctx._signalState.hasError).toBe(true);

            // Call retry and fix the slot
            shouldThrow = false;
            capturedRetry!();
            expect(ctx._signalState.hasError).toBe(false);
            expect(ctx._signalState.error).toBeNull();

            // Next render: slot succeeds
            const result = render();
            consoleError.mockRestore();

            expect(result).toBe(slotContent);
        });

        it('uses function fallback on subsequent render when still in error state', () => {
            const thrownError = new Error('persistent');
            const fallbackResult = { type: 'span', props: {}, children: ['still broken'] };
            const fallback = vi.fn(() => fallbackResult);
            const ctx = createMockCtx({ fallback }, () => { throw thrownError; });

            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            const render = ErrorBoundary.__setup(ctx as any) as () => any;

            // First render: catches error
            render();
            // Second render: state.hasError is true, uses fallback branch directly
            const result = render();
            consoleError.mockRestore();

            expect(fallback).toHaveBeenCalledTimes(2);
            expect(result).toBe(fallbackResult);
        });
    });
});
