/**
 * Component setup must run untracked (issue #111).
 *
 * Children mount synchronously inside the parent's render effect. Without
 * untracking, every reactive read in a descendant's setup registers as a
 * dependency of the PARENT's render effect — a later write to any of those
 * signals re-renders the parent, remounts descendants, re-registers the same
 * deps, and the flush never terminates (observed as a full-page freeze in a
 * production app after one store write).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

describe('setup runs untracked (issue #111)', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('a signal read only in a child setup does not become a parent dep', () => {
        const theme = signal('light');
        let parentRenders = 0;
        let childSetups = 0;

        const Child = component(() => {
            childSetups++;
            // Setup-time read — common pattern: capturing an initial value
            const initial = theme.value;
            return () => jsx('span', { children: initial });
        });

        const Parent = component(() => {
            return () => {
                parentRenders++;
                return jsx('div', { children: jsx(Child, {}) });
            };
        });

        render(jsx(Parent, {}), container);
        expect(parentRenders).toBe(1);
        expect(childSetups).toBe(1);

        // Write the signal that was read ONLY in the child's setup:
        // the parent's render effect must not re-run.
        theme.value = 'dark';

        expect(parentRenders).toBe(1);
        expect(childSetups).toBe(1);
    });

    it('a setup that reads and later writes the same signal cannot loop the parent', () => {
        const loaded = signal(false);
        let parentRenders = 0;

        const Child = component(() => {
            // read-then-write in setup — e.g. "fetch unless already loaded"
            if (!loaded.value) {
                loaded.value = true;
            }
            return () => jsx('span', { children: 'child' });
        });

        const Parent = component(() => {
            return () => {
                parentRenders++;
                return jsx('div', { children: jsx(Child, {}) });
            };
        });

        render(jsx(Parent, {}), container);

        // Without untracked setup this is a self-triggering dependency:
        // the parent tracked `loaded`, the child wrote it during mount.
        expect(parentRenders).toBe(1);
    });

    it('reactive reads in onCreated hooks do not become ancestor deps', () => {
        // Created hooks run right after setup, still inside the parent's
        // render effect — they must be untracked for the same reason.
        const s = signal(0);
        let parentRenders = 0;

        const Child = component((ctx) => {
            ctx.onCreated(() => { void s.value; });
            return () => jsx('span', { children: 'child' });
        });
        const Parent = component(() => () => {
            parentRenders++;
            return jsx('div', { children: jsx(Child, {}) });
        });

        render(jsx(Parent, {}), container);
        s.value = 1;

        expect(parentRenders).toBe(1);
    });

    it('grandchild setup reads do not leak into ancestor effects', () => {
        const store = signal(0);
        let topRenders = 0;
        let midRenders = 0;

        const Leaf = component(() => {
            const captured = store.value;
            return () => jsx('i', { children: String(captured) });
        });
        const Mid = component(() => {
            return () => {
                midRenders++;
                return jsx('p', { children: jsx(Leaf, {}) });
            };
        });
        const Top = component(() => {
            return () => {
                topRenders++;
                return jsx('div', { children: jsx(Mid, {}) });
            };
        });

        render(jsx(Top, {}), container);
        store.value = 42;

        expect(topRenders).toBe(1);
        expect(midRenders).toBe(1);
    });
});
