import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '../src/index';
import { component, jsx, Fragment, Comment } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

/**
 * Tests that conditional rendering ({cond && <el/>}) does NOT destabilize
 * sibling refs. Comment placeholder VNodes preserve children array positions
 * so the reconciler patches siblings in-place instead of recreating them.
 *
 * Without placeholders, toggling a conditional sibling shifts array indices,
 * causing the positional diff to unmount+remount the ref'd element — orphaning
 * any imperative DOM attachments (CodeMirror, Monaco, chart libs, etc.).
 */
describe('ref stability with conditional siblings', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('should preserve ref identity when conditional sibling toggles off', () => {
        const loading = signal(true);
        let mountEl: HTMLElement | null = null;

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        loading.value && jsx('div', { class: 'spinner', children: 'Loading...' }),
                        jsx('div', {
                            class: 'editor-mount',
                            ref: (el: HTMLElement) => { mountEl = el; }
                        })
                    ]
                });
        });

        render(jsx(App, {}), container);
        const firstMountEl = mountEl;
        expect(firstMountEl).toBeTruthy();
        expect((firstMountEl as unknown as HTMLElement).className).toBe('editor-mount');
        expect(container.querySelector('.spinner')).toBeTruthy();

        // Toggle loading off — conditional sibling disappears
        loading.value = false;

        // The ref should still point to the SAME DOM element
        expect(mountEl).toBe(firstMountEl);
        expect(mountEl!.parentNode).toBeTruthy();
        expect(container.querySelector('.spinner')).toBeNull();
        expect(container.querySelector('.editor-mount')).toBe(firstMountEl);
    });

    it('should preserve ref identity when conditional sibling toggles on', () => {
        const showOverlay = signal(false);
        let mountEl: HTMLElement | null = null;

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        showOverlay.value && jsx('div', { class: 'overlay' }),
                        jsx('div', {
                            class: 'content',
                            ref: (el: HTMLElement) => { if (el) mountEl = el; }
                        })
                    ]
                });
        });

        render(jsx(App, {}), container);
        const firstMountEl = mountEl;
        expect(firstMountEl).toBeTruthy();

        // Toggle overlay on — conditional sibling appears
        showOverlay.value = true;

        expect(mountEl).toBe(firstMountEl);
        expect(container.querySelector('.overlay')).toBeTruthy();
        expect(container.querySelector('.content')).toBe(firstMountEl);
    });

    it('should preserve ref identity with multiple conditional siblings', () => {
        const showA = signal(true);
        const showB = signal(false);
        let mountEl: HTMLElement | null = null;

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        showA.value && jsx('div', { class: 'panel-a' }),
                        showB.value && jsx('div', { class: 'panel-b' }),
                        jsx('div', {
                            class: 'stable-mount',
                            ref: (el: HTMLElement) => { if (el) mountEl = el; }
                        })
                    ]
                });
        });

        render(jsx(App, {}), container);
        const firstMountEl = mountEl;
        expect(firstMountEl).toBeTruthy();

        // Toggle both conditionals
        showA.value = false;
        showB.value = true;

        expect(mountEl).toBe(firstMountEl);
        expect(container.querySelector('.panel-a')).toBeNull();
        expect(container.querySelector('.panel-b')).toBeTruthy();
        expect(container.querySelector('.stable-mount')).toBe(firstMountEl);
    });

    it('should preserve imperative DOM attachment when conditional sibling toggles', () => {
        const loading = signal(true);
        let mountEl: HTMLElement | null = null;
        let imperativeChild: HTMLElement | null = null;

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        loading.value && jsx('div', { class: 'loading', children: 'Please wait...' }),
                        jsx('div', {
                            class: 'mount-point',
                            ref: (el: HTMLElement) => { if (el) mountEl = el; }
                        })
                    ]
                });
        });

        render(jsx(App, {}), container);

        // Simulate imperative DOM mount (like CodeMirror's new EditorView({ parent: el }))
        imperativeChild = document.createElement('div');
        imperativeChild.className = 'imperative-editor';
        imperativeChild.textContent = 'Editor content';
        mountEl!.appendChild(imperativeChild);

        expect(mountEl!.querySelector('.imperative-editor')).toBeTruthy();

        // Toggle loading off
        loading.value = false;

        // The imperative child should still be inside the mount point
        expect(mountEl!.querySelector('.imperative-editor')).toBe(imperativeChild);
        expect(imperativeChild!.textContent).toBe('Editor content');
        expect(container.querySelector('.imperative-editor')).toBe(imperativeChild);
    });

    it('should produce comment placeholder nodes for falsy children', () => {
        const show = signal(false);

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        show.value && jsx('span', { children: 'visible' }),
                        jsx('p', { children: 'always here' })
                    ]
                });
        });

        render(jsx(App, {}), container);
        const wrapper = container.firstElementChild!;

        // Should have a comment node (placeholder) + the <p>
        expect(wrapper.childNodes.length).toBe(2);
        expect(wrapper.childNodes[0].nodeType).toBe(Node.COMMENT_NODE);
        expect(wrapper.childNodes[1].nodeName).toBe('P');

        // Toggle on — comment is replaced with span
        show.value = true;
        expect(wrapper.querySelector('span')).toBeTruthy();
        expect(wrapper.querySelector('p')).toBeTruthy();
    });

    it('should handle rapid toggling without leaking DOM nodes', () => {
        const visible = signal(false);
        let mountEl: HTMLElement | null = null;

        const App = component(() => {
            return () =>
                jsx('div', {
                    children: [
                        visible.value && jsx('div', { class: 'toggle-target' }),
                        jsx('div', {
                            class: 'anchor',
                            ref: (el: HTMLElement) => { if (el) mountEl = el; }
                        })
                    ]
                });
        });

        render(jsx(App, {}), container);
        const firstMountEl = mountEl;

        // Rapidly toggle 10 times
        for (let i = 0; i < 10; i++) {
            visible.value = !visible.value;
        }

        // Ref should still be the same element
        expect(mountEl).toBe(firstMountEl);
        // Parent should have exactly 2 child nodes (comment/element + anchor)
        expect(container.firstElementChild!.childNodes.length).toBe(2);
    });
});
