/**
 * Integration tests for app.runWithContext(): DI factory resolution outside
 * component setup (router guards, socket handlers, entry-scope code) must hit
 * the SAME app-context instances components receive — on a real client app
 * (DOM mount) and on a server-rendered app object alike. See issue #101.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, jsx, defineApp, defineFactory } from '@sigx/runtime-core';
// Side effect: registers the DOM default mount so app.mount(container) works.
import '@sigx/runtime-dom';
import { renderToString } from '@sigx/server-renderer';

describe('app.runWithContext integration', () => {
    // Guaranteed spy cleanup even when an assertion throws mid-test.
    afterEach(() => {
        vi.restoreAllMocks();
    });

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

    it('dev-warns once per app when the callback returns a Promise, passing the value through', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp(jsx('div', {}));

        const p = app.runWithContext(async () => 'value');
        app.runWithContext(async () => 'again');

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('synchronous portion');
        await expect(p).resolves.toBe('value');

        // A second app warns independently.
        const app2 = defineApp(jsx('div', {}));
        void app2.runWithContext(async () => 'other');
        expect(warn).toHaveBeenCalledTimes(2);
    });

    it('asyncAdvice string replaces the remediation sentence, keeping the diagnosis', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp(jsx('div', {}));

        void app.runWithContext(async () => 'value', {
            asyncAdvice: '(from lib) resolve dependencies before the first await.'
        });

        expect(warn).toHaveBeenCalledTimes(1);
        const message = warn.mock.calls[0][0] as string;
        expect(message).toContain('synchronous portion');
        expect(message).toContain('(from lib) resolve dependencies before the first await.');
        expect(message).not.toContain('re-enter with another runWithContext');
    });

    it('asyncAdvice: false suppresses without consuming the once-per-app slot', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp(jsx('div', {}));

        void app.runWithContext(async () => 'deliberate', { asyncAdvice: false });
        expect(warn).not.toHaveBeenCalled();

        // A later unmarked async callback on the same app still warns.
        void app.runWithContext(async () => 'misuse');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('re-enter with another runWithContext');
    });

    it('warns once per app across default and asyncAdvice variants', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp(jsx('div', {}));

        void app.runWithContext(async () => 'first');
        void app.runWithContext(async () => 'second', { asyncAdvice: '(from lib) advice.' });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('re-enter with another runWithContext');
    });

    it('stays silent for synchronous callbacks', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp(jsx('div', {}));

        expect(app.runWithContext(() => 7)).toBe(7);

        expect(warn).not.toHaveBeenCalled();
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
