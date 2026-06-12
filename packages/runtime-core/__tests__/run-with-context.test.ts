/**
 * Integration tests for app.runWithContext(): DI factory resolution outside
 * component setup (router guards, socket handlers, entry-scope code) must hit
 * the SAME app-context instances components receive — on a real client app
 * (DOM mount) and on a server-rendered app object alike. See issue #101.
 */

import { describe, it, expect } from 'vitest';
import { component, jsx, defineApp, defineFactory } from '@sigx/runtime-core';
// Side effect: registers the DOM default mount so app.mount(container) works.
import '@sigx/runtime-dom';
import { renderToString } from '@sigx/server-renderer';

describe('app.runWithContext integration', () => {
    it('client app: a guard-style callback resolves the instance the mounted components use', () => {
        const useStore = defineFactory(() => ({ user: null as string | null }), 'scoped');

        let inComponent: unknown;
        const Comp = component(() => {
            inComponent = useStore();
            return () => jsx('div', { children: 'client' });
        });

        const app = defineApp(jsx(Comp, {}));
        const container = document.createElement('div');
        document.body.appendChild(container);
        app.mount(container);

        try {
            expect(inComponent).toBeDefined();
            // The issue-#101 failure mode: outside the context this would be a
            // second realm instance and auth state would silently split.
            const inGuard = app.runWithContext(() => useStore());
            expect(inGuard).toBe(inComponent);
            expect(useStore()).not.toBe(inComponent); // bare call: realm fallback
        } finally {
            app.unmount();
            container.remove();
        }
    });

    it('server-rendered app: runWithContext resolves the instance SSR components used', async () => {
        const useStore = defineFactory(() => ({ hits: 0 }), 'scoped');

        let inComponent: { hits: number } | undefined;
        const Comp = component(() => {
            inComponent = useStore();
            inComponent.hits++;
            return () => jsx('div', { children: 'ssr' });
        });

        const app = defineApp(jsx(Comp, {}));
        const html = await renderToString(app);

        expect(html).toContain('ssr');
        expect(inComponent).toBeDefined();

        const outside = app.runWithContext(() => useStore());
        expect(outside).toBe(inComponent);
        expect(outside.hits).toBe(1);
    });

    it('plugin installed via app.use can capture the app and wrap callbacks (router-guard pattern)', () => {
        const useStore = defineFactory(() => ({ id: {} }), 'scoped');

        let guard: (() => unknown) | undefined;
        const routerLikePlugin = (pluginApp: ReturnType<typeof defineApp>) => {
            guard = () => pluginApp.runWithContext(() => useStore());
        };

        let inComponent: unknown;
        const Comp = component(() => {
            inComponent = useStore();
            return () => jsx('div', { children: 'x' });
        });

        const app = defineApp(jsx(Comp, {}));
        app.use(routerLikePlugin);

        const container = document.createElement('div');
        document.body.appendChild(container);
        app.mount(container);

        try {
            expect(guard!()).toBe(inComponent);
        } finally {
            app.unmount();
            container.remove();
        }
    });
});
