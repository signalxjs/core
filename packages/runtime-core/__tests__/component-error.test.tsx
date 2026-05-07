import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx, defineApp } from '@sigx/runtime-core';

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

    it('should catch setup error with registered error handler', () => {
        const setupError = new Error('setup exploded');
        const errorHandler = vi.fn().mockReturnValue(true);

        const Comp = component(() => {
            throw setupError;
        });

        const app = defineApp(jsx(Comp, {}));
        app.config.errorHandler = errorHandler;
        app.mount(container);

        expect(errorHandler).toHaveBeenCalledTimes(1);
        expect(errorHandler).toHaveBeenCalledWith(
            setupError,
            expect.objectContaining({ vnode: expect.any(Object) }),
            'setup'
        );
    });

    it('should catch render error with registered error handler', () => {
        const renderError = new Error('render exploded');
        const errorHandler = vi.fn().mockReturnValue(true);

        const Comp = component(() => {
            return () => {
                throw renderError;
            };
        });

        const app = defineApp(jsx(Comp, {}));
        app.config.errorHandler = errorHandler;
        app.mount(container);

        expect(errorHandler).toHaveBeenCalledTimes(1);
        expect(errorHandler).toHaveBeenCalledWith(
            renderError,
            expect.objectContaining({ vnode: expect.any(Object) }),
            'render'
        );
    });
});
