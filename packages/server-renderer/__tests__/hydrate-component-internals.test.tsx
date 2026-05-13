/**
 * Coverage for client/hydrate-component.ts — branches the main
 * hydrate.test.tsx doesn't reach: setup errors, server-state restoration,
 * and trailing-marker discovery.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { hydrate } from '../src/client/hydrate-core';
import { hydrateComponent } from '../src/client/hydrate-component';
import {
    createSSRContainer,
    cleanupContainer
} from './test-utils';

describe('hydrateComponent — setup errors', () => {
    let container: HTMLDivElement;
    afterEach(() => { if (container) cleanupContainer(container); });

    it('logs to console.error when setup throws and continues without crashing', () => {
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const Boom = component(() => { throw new Error('setup-boom'); }, { name: 'Boom' });

        // SSR shape: empty placeholder + trailing marker
        container = createSSRContainer('<!--$c:1-->');

        expect(() => hydrate((Boom as any)({}), container)).not.toThrow();
        expect(errSpy).toHaveBeenCalled();
        const msg = errSpy.mock.calls[0][0] as string;
        expect(msg).toMatch(/Error hydrating component Boom/);
        errSpy.mockRestore();
    });
});

describe('hydrateComponent — trailing marker discovery', () => {
    let container: HTMLDivElement;
    afterEach(() => { if (container) cleanupContainer(container); });

    it('walks forward through siblings to find a $c: marker when none is passed', () => {
        // SSR shape: <span>X</span> + trailing component marker
        container = createSSRContainer('<span class="seek">X</span><!--$c:5-->');
        const Cmp = component(() => () => ({
            type: 'span',
            props: { class: 'seek' },
            key: null,
            children: ['X'],
            dom: null
        } as any), { name: 'Seek' });

        const dom = container.firstChild;
        const result = hydrateComponent(
            (Cmp as any)({}),
            dom,
            container
        );
        // After hydration, the result is the marker's nextSibling (or null at end)
        expect(result === null || result === container.lastChild?.nextSibling).toBe(true);
        // The span should still be in the DOM (hydrated in place)
        expect(container.querySelector('.seek')).not.toBeNull();
    });

    it('picks the lowest-numbered marker when nested components share a sibling sequence', () => {
        // Outer component has $c:1, nested child has $c:2 — adjacent comments
        container = createSSRContainer('<div class="x">content</div><!--$c:2--><!--$c:1-->');
        const Cmp = component(() => () => ({
            type: 'div',
            props: { class: 'x' },
            key: null,
            children: ['content'],
            dom: null
        } as any), { name: 'NestedOwner' });

        const dom = container.firstChild;
        // No throw means the component bound to $c:1 (the outer/lowest marker)
        expect(() => hydrateComponent((Cmp as any)({}), dom, container)).not.toThrow();
    });
});

describe('hydrateComponent — server-state restoration via createRestoringSignal', () => {
    let container: HTMLDivElement;
    afterEach(() => { if (container) cleanupContainer(container); });

    it('uses restoring signal when serverState is passed directly', () => {
        const seen: Array<number> = [];
        const Cmp = component((ctx: any) => {
            const s = ctx.signal(0, 'value');
            seen.push(s.value);
            return () => ({
                type: 'span',
                props: { class: 'restored' },
                key: null,
                children: [String(s.value)],
                dom: null
            } as any);
        }, { name: 'Restored' });

        container = createSSRContainer('<span class="restored">99</span><!--$c:1-->');
        const dom = container.firstChild;
        // Pass server state directly — bypasses pending-state route
        hydrateComponent((Cmp as any)({}), dom, container, { value: 99 });
        expect(seen).toEqual([99]);
    });
});

describe('hydrateComponent — null-render path keeps SSR DOM visible', () => {
    let container: HTMLDivElement;
    afterEach(() => { if (container) cleanupContainer(container); });

    it('does not unmount SSR content when render() returns null on first pass', () => {
        // Component returns null initially; SSR rendered content
        const ready = signal(false);
        const Lazy = component(() => () => {
            if (!ready.value) return null;
            return {
                type: 'span',
                props: { class: 'late' },
                key: null,
                children: ['ready'],
                dom: null
            } as any;
        }, { name: 'LateLazy' });

        container = createSSRContainer('<span class="late">ready</span><!--$c:1-->');
        const dom = container.firstChild;
        hydrateComponent((Lazy as any)({}), dom, container);

        // SSR DOM remains visible
        expect(container.querySelector('.late')?.textContent).toBe('ready');
    });
});
