/**
 * Slot reactivity regression tests.
 *
 * Slot presence is now resolved lazily in the slots accessor (an unprovided
 * slot reads as `undefined`), and presence is read alongside the version
 * signal. These mounted-component tests prove that moving presence into the
 * accessor lookup did NOT break reactivity: slot *content* still updates, and
 * slot *presence* still flips both ways and re-renders the consumer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('slot reactivity', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('updates default-slot content when the parent swaps the children', async () => {
        const text = signal({ value: 'first' });
        const Child = component(({ slots }) =>
            () => jsx('div', { class: 'child', children: slots.default?.() }));
        const Parent = component(() =>
            () => jsx(Child, { children: jsx('p', { class: 'content', children: text.value }) }));

        render(jsx(Parent, {}), container);
        await tick();
        expect(container.querySelector('.content')?.textContent).toBe('first');

        text.value = 'second';
        await tick();
        expect(container.querySelector('.content')?.textContent).toBe('second');
    });

    it('re-renders a named slot when a signal it reads changes, without re-rendering the parent', async () => {
        const label = signal({ value: 'A' });
        let parentRenders = 0;
        const Child = component(({ slots }) =>
            () => jsx('div', { class: 'child', children: (slots as any).label?.() }));
        const Parent = component(() =>
            () => {
                parentRenders++;
                return jsx(Child, { slots: { label: () => jsx('span', { class: 'lbl', children: label.value }) } });
            });

        render(jsx(Parent, {}), container);
        await tick();
        expect(container.querySelector('.lbl')?.textContent).toBe('A');
        const rendersBefore = parentRenders;

        label.value = 'B';
        await tick();
        // The child re-evaluated the slot via its own reactive scope...
        expect(container.querySelector('.lbl')?.textContent).toBe('B');
        // ...and the parent did not need to re-render.
        expect(parentRenders).toBe(rendersBefore);
    });

    it('updates a named slot provided via a slot-prop child', async () => {
        const text = signal({ value: 'x' });
        const Child = component(({ slots }) =>
            () => jsx('div', { class: 'child', children: (slots as any).footer?.() }));
        const Parent = component(() =>
            () => jsx(Child, { children: jsx('div', { slot: 'footer', class: 'foot', children: text.value }) }));

        render(jsx(Parent, {}), container);
        await tick();
        expect(container.querySelector('.foot')?.textContent).toBe('x');

        text.value = 'y';
        await tick();
        expect(container.querySelector('.foot')?.textContent).toBe('y');
    });

    it('flips default-slot presence: fallback when childless, content once children appear (and back)', async () => {
        const show = signal({ value: false });
        const Child = component(({ slots }) =>
            () => jsx('div', {
                class: 'child',
                children: slots.default?.() ?? jsx('span', { class: 'fb', children: 'fallback' })
            }));
        const Parent = component(() =>
            () => jsx(Child, { children: show.value ? jsx('p', { class: 'real', children: 'real' }) : null }));

        render(jsx(Parent, {}), container);
        await tick();
        // Absent default slot → documented `?? fallback` renders.
        expect(container.querySelector('.fb')).toBeTruthy();
        expect(container.querySelector('.real')).toBeFalsy();

        show.value = true;
        await tick();
        // Slot appeared → content replaces the fallback. This proves the
        // short-circuited `slots.default?.()` on an absent slot still
        // subscribed the child to the version signal.
        expect(container.querySelector('.fb')).toBeFalsy();
        expect(container.querySelector('.real')?.textContent).toBe('real');

        show.value = false;
        await tick();
        // Slot disappeared → back to the fallback.
        expect(container.querySelector('.fb')).toBeTruthy();
        expect(container.querySelector('.real')).toBeFalsy();
    });

    it('flips named-slot presence provided via the slots prop (and back)', async () => {
        const show = signal({ value: false });
        const Child = component(({ slots }) =>
            () => jsx('div', {
                class: 'child',
                children: (slots as any).header?.() ?? jsx('span', { class: 'hfb', children: 'no header' })
            }));
        const Parent = component(() =>
            () => jsx(Child, {
                slots: show.value ? { header: () => jsx('h1', { class: 'h', children: 'H' }) } : {}
            }));

        render(jsx(Parent, {}), container);
        await tick();
        expect(container.querySelector('.hfb')).toBeTruthy();
        expect(container.querySelector('.h')).toBeFalsy();

        show.value = true;
        await tick();
        expect(container.querySelector('.h')?.textContent).toBe('H');
        expect(container.querySelector('.hfb')).toBeFalsy();

        show.value = false;
        await tick();
        expect(container.querySelector('.hfb')).toBeTruthy();
        expect(container.querySelector('.h')).toBeFalsy();
    });
});
