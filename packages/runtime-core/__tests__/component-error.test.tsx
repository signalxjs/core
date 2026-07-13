import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx, defineApp, signal, errorScope } from '@sigx/runtime-core';

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

describe('component error handling', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    // Tests without error handlers MUST run before defineApp tests
    // because defineApp sets a module-level currentAppContext that persists.

    it('should throw error when setup throws and no handler registered', () => {
        const setupError = new Error('setup exploded');

        const Comp = component(() => {
            throw setupError;
        });

        expect(() => render(jsx(Comp, {}), container)).toThrow(setupError);
    });

    it('should throw error when render function throws and no handler', () => {
        const renderError = new Error('render exploded');

        const Comp = component(() => {
            return () => {
                throw renderError;
            };
        });

        expect(() => render(jsx(Comp, {}), container)).toThrow(renderError);
    });

    it('should throw on async setup in client/browser', () => {
        const Comp = component(async () => {
            return () => jsx('div', { children: 'async' });
        });

        expect(() => render(jsx(Comp, {}), container)).toThrow(
            /Async setup.*is only supported during SSR/
        );
    });

    it('should catch setup error with registered onError handler', () => {
        const setupError = new Error('setup exploded');
        const onError = vi.fn().mockReturnValue(true);

        const Comp = component(() => {
            throw setupError;
        });

        const app = defineApp(jsx(Comp, {}));
        app.config.onError = onError;
        app.mount(container);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            setupError,
            expect.objectContaining({ vnode: expect.any(Object) }),
            'setup'
        );
    });

    it('should catch render error with registered onError handler', () => {
        const renderError = new Error('render exploded');
        const onError = vi.fn().mockReturnValue(true);

        const Comp = component(() => {
            return () => {
                throw renderError;
            };
        });

        const app = defineApp(jsx(Comp, {}));
        app.config.onError = onError;
        app.mount(container);

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            renderError,
            expect.objectContaining({ vnode: expect.any(Object) }),
            'render'
        );
    });

    it('should route errors thrown during reactive RE-renders to onError with info "render"', async () => {
        const updateError = new Error('update exploded');
        const onError = vi.fn().mockReturnValue(true);
        const state = signal({ fail: false });

        const Comp = component(() => {
            return () => {
                if (state.fail) {
                    throw updateError;
                }
                return <div class="ok">fine</div>;
            };
        });

        const app = defineApp(jsx(Comp, {}));
        app.config.onError = onError;
        app.mount(container);

        // Initial render succeeded, no error yet
        expect(container.querySelector('.ok')).toBeTruthy();
        expect(onError).not.toHaveBeenCalled();

        // Flip the signal — the scheduled re-render throws
        state.fail = true;
        await tick();
        await tick();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(
            updateError,
            expect.objectContaining({ vnode: expect.any(Object) }),
            'render'
        );
    });

    it('should NOT reach app onError when an errorScope handles the error', async () => {
        const boomError = new Error('scoped boom');
        const onError = vi.fn().mockReturnValue(true);
        const state = signal({ fail: false });

        const Child = component(() => {
            return () => {
                if (state.fail) {
                    throw boomError;
                }
                return <div class="child">child ok</div>;
            };
        });

        const Parent = component(() => {
            errorScope({
                fallback: (error) => <div class="fallback">{error.message}</div>,
            });
            return () => jsx(Child, {});
        });

        const app = defineApp(jsx(Parent, {}));
        app.config.onError = onError;
        app.mount(container);

        expect(container.querySelector('.child')).toBeTruthy();

        // Trip the child's render on a reactive update
        state.fail = true;
        await tick();
        await tick();

        // The scope took the error: fallback renders, app handler never sees it
        expect(container.querySelector('.fallback')?.textContent).toBe('scoped boom');
        expect(onError).not.toHaveBeenCalled();
    });
});
