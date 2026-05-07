import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '../src/index';
import { component, jsx } from '@sigx/runtime-core';
import { signal, effect } from '@sigx/reactivity';

/**
 * Tests for effect() used inside component setup functions.
 * 
 * These tests ensure that effects created within components properly track
 * and re-run when component-local signals change.
 */
describe('effect inside component', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        container.id = 'app';
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('should re-run effect when signal changes via click handler', async () => {
        const logSpy = vi.fn();

        const Button = component(({ signal: componentSignal }) => {
            const count = componentSignal(1);

            effect(() => {
                logSpy(`hello${count.value}`);
            });

            return () => (
                jsx('button', {
                    onClick: () => { count.value++; },
                    children: String(count.value)
                })
            );
        });

        render(jsx(Button, {}), container);

        // Effect should run once on mount
        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith('hello1');

        // Simulate click
        const button = container.querySelector('button')!;
        button.click();

        // Effect should re-run
        expect(logSpy).toHaveBeenCalledTimes(2);
        expect(logSpy).toHaveBeenCalledWith('hello2');

        // Another click
        button.click();
        expect(logSpy).toHaveBeenCalledTimes(3);
        expect(logSpy).toHaveBeenCalledWith('hello3');
    });

    it('should re-run effect when using signal from context', async () => {
        const logSpy = vi.fn();

        const Counter = component(({ signal }) => {
            const state = signal({ count: 1 });

            effect(() => {
                logSpy(`count is ${state.count}`);
            });

            return () => (
                jsx('button', {
                    onClick: () => { state.count++; },
                    children: String(state.count)
                })
            );
        });

        render(jsx(Counter, {}), container);

        expect(logSpy).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith('count is 1');

        // Click the button
        container.querySelector('button')!.click();

        expect(logSpy).toHaveBeenCalledTimes(2);
        expect(logSpy).toHaveBeenCalledWith('count is 2');
    });
});
