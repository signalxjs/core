/**
 * Integration tests for app-level DI provides on real apps (issue #213):
 * pre-mount provides resolve in component setup (previously via a mount-time
 * copy onto the root node, now a live read through the root AppContext),
 * provides added after mount become visible to later-mounted components, and
 * required injectables fail loudly instead of minting a global singleton.
 */

import { describe, it, expect, vi } from 'vitest';
import { component, jsx, defineApp, defineInjectable } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';
// Side effect: registers the DOM default mount so app.mount(container) works.
import '@sigx/runtime-dom';

describe('app-level DI provides on a mounted app', () => {
    it('app.defineProvide before mount resolves in component setup', () => {
        const useCfg = defineInjectable(() => ({ src: 'global' }));

        let seen: unknown;
        const Comp = component(() => {
            seen = useCfg();
            return () => jsx('div', { children: 'x' });
        });

        const app = defineApp(jsx(Comp, {}));
        const provided = app.defineProvide(useCfg, () => ({ src: 'app' }));

        const container = document.createElement('div');
        document.body.appendChild(container);
        app.mount(container);

        try {
            expect(seen).toBe(provided);
        } finally {
            app.unmount();
            container.remove();
        }
    });

    it('app.defineProvide after mount is visible to later-mounted components', async () => {
        const useCfg = defineInjectable(() => ({ src: 'global' }));
        const state = signal({ show: false });

        let seen: unknown;
        const Child = component(() => {
            seen = useCfg();
            return () => jsx('div', { children: 'child' });
        });
        const Parent = component(() => {
            return () => (state.show ? jsx(Child, {}) : jsx('div', { children: 'empty' }));
        });

        const app = defineApp(jsx(Parent, {}));
        const container = document.createElement('div');
        document.body.appendChild(container);
        app.mount(container);

        try {
            // Provided only AFTER mount — the old mount-time copy missed this.
            const late = app.defineProvide(useCfg, () => ({ src: 'late' }));
            state.show = true;
            await vi.waitFor(() => expect(seen).toBe(late));
        } finally {
            app.unmount();
            container.remove();
        }
    });

    it('a required injectable throws unprovided and resolves per app once provided', () => {
        const useRouter = defineInjectable<{ path: string }>('Router');
        const app = defineApp(jsx(component(() => () => jsx('div', {})), {}));

        expect(() => app.runWithContext(() => useRouter())).toThrowError(/Injectable "Router"/);

        const router = app.defineProvide(useRouter, () => ({ path: '/' }));
        expect(app.runWithContext(() => useRouter())).toBe(router);
    });
});
