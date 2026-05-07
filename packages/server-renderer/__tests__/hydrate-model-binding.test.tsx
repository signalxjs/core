/**
 * Model binding hydration tests
 *
 * Tests that model binding works correctly after hydrate() attaches
 * event handlers and reactivity to SSR-rendered DOM.
 * Moved from runtime-dom — hydrate() lives in server-renderer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { component, jsx, signal, Fragment } from 'sigx';
import type { Define } from 'sigx';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick
} from './test-utils';

describe('model binding — hydration', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
    });

    it('should attach model binding during hydration of native input', async () => {
        container = createSSRContainer('<input type="text" value="ssr-value" /><!--$c:1-->');

        const state = signal({ name: 'ssr-value' });
        const App = component(() => {
            return () => <input type="text" model={() => state.name} />;
        });

        hydrate(jsx(App, {}), container);
        await nextTick();

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('ssr-value');

        // Simulate user typing — model binding must work after hydration
        input.value = 'after-hydrate';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.name).toBe('after-hydrate');
    });

    it('should attach model binding during hydration of component-wrapped input', async () => {
        const InputComponent = component<Define.Model<string>>(({ props }) => {
            return () => (
                <input
                    type="text"
                    class="input"
                    value={props.model?.value != null ? String(props.model.value) : ''}
                    onInput={(e) => {
                        const value = (e.target as HTMLInputElement).value;
                        if (props.model) props.model.value = value;
                    }}
                />
            );
        }, { name: 'InputComponent' });

        container = createSSRContainer(
            '<input type="text" class="input" value="ssr-value" /><!--$c:2--><!--$c:1-->'
        );

        const state = signal({ name: 'ssr-value' });
        const App = component(() => {
            return () => <InputComponent model={() => state.name} />;
        });

        hydrate(jsx(App, {}), container);
        await nextTick();

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('ssr-value');

        input.value = 'after-hydrate';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.name).toBe('after-hydrate');
    });

    it('should respond to input events on component-wrapped input after hydration', async () => {
        const InputComponent = component<Define.Model<string>>(({ props }) => {
            return () => (
                <input
                    type="text"
                    class="input"
                    value={props.model?.value != null ? String(props.model.value) : ''}
                    onInput={(e) => {
                        const value = (e.target as HTMLInputElement).value;
                        if (props.model) props.model.value = value;
                    }}
                />
            );
        }, { name: 'InputComponent' });

        container = createSSRContainer(
            '<input type="text" class="input" value="" /><!--$c:2--><!--$c:1-->'
        );

        const state = signal({ name: '' });
        const App = component(() => {
            return () => <InputComponent model={() => state.name} />;
        });

        hydrate(jsx(App, {}), container);
        await nextTick();

        const input = container.querySelector('input') as HTMLInputElement;
        input.value = 'typed-value';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.name).toBe('typed-value');
    });

    it('should update hydrated input DOM when signal changes', async () => {
        container = createSSRContainer('<input type="text" value="initial" /><!--$c:1-->');

        const state = signal({ name: 'initial' });
        const App = component(() => {
            return () => <input type="text" model={() => state.name} />;
        });

        hydrate(jsx(App, {}), container);
        await nextTick();

        const input = container.querySelector('input') as HTMLInputElement;
        expect(input.value).toBe('initial');

        state.name = 'changed';
        await nextTick();
        expect(input.value).toBe('changed');
    });

    it('should handle form with multiple model-bound inputs after hydration', async () => {
        container = createSSRContainer([
            '<form>',
            '<input type="text" value="" />',
            '<input type="password" value="" />',
            '<button type="submit">Login</button>',
            '</form>',
            '<!--$c:1-->'
        ].join(''));

        const state = signal({ username: '', password: '' });
        const App = component(() => {
            return () => (
                <form>
                    <input type="text" model={() => state.username} />
                    <input type="password" model={() => state.password} />
                    <button type="submit">Login</button>
                </form>
            );
        });

        hydrate(jsx(App, {}), container);
        await nextTick();

        const [usernameInput, passwordInput] = container.querySelectorAll('input') as NodeListOf<HTMLInputElement>;

        usernameInput.value = 'admin';
        usernameInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.username).toBe('admin');

        passwordInput.value = 'secret';
        passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(state.password).toBe('secret');
    });
});
