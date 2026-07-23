/**
 * #413 — one install shape: `app.use(islandsPlugin())` carries the SERVER
 * render hooks too (via provideSSRPlugin), so the entry-server's per-request
 * app factory is the whole install. The app-carried form must render
 * byte-identically to the instance form, and a per-request SERVER app must
 * not touch the module-level client registry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, defineApp } from 'sigx';
import { createSSR } from '@sigx/server-renderer';
import { getSSRPlugins, getClientPlugins, clearClientPlugins } from '@sigx/server-renderer/client';
import { islandsPlugin } from '../src/plugin';
import { cleanupScripts, parseBoundaryTable } from './test-utils';

let testId = 0;
function uniqueName(base: string): string {
    return `AppInstall_${base}_${++testId}`;
}

describe('islands app-carried install (#413)', () => {
    beforeEach(() => {
        cleanupScripts();
        clearClientPlugins();
    });

    afterEach(() => {
        cleanupScripts();
        clearClientPlugins();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('install(app) provides the SSR plugin on the app context', () => {
        const Root = component(() => () => <div>root</div>, { name: 'Root' });
        const app = defineApp((Root as any)({}));
        app.use(islandsPlugin());
        const carried = getSSRPlugins((app as any)._context);
        expect(carried.map(p => p.name)).toEqual(['islands']);
    });

    it('the app-carried form renders identically to the instance form', async () => {
        const name = uniqueName('Card');
        const makeCard = () => component(() => () => <span class="card">hi</span>, { name });

        const instanceHtml = await createSSR({ plugins: [islandsPlugin()] })
            .render((makeCard() as any)({ 'client:load': true }));

        const app = defineApp((makeCard() as any)({ 'client:load': true }));
        app.use(islandsPlugin());
        const appHtml = await createSSR().render(app);

        expect(appHtml).toBe(instanceHtml);
        const records = parseBoundaryTable(appHtml);
        expect(records['1']).toMatchObject({ hydrate: 'load', component: name });
    });

    it('a server-side install (no document) skips the client plugin registry', () => {
        vi.stubGlobal('document', undefined);
        const Root = component(() => () => <div>root</div>, { name: 'Root' });
        const app = defineApp((Root as any)({}));
        app.use(islandsPlugin());

        // The SSR seam is provided either way…
        expect(getSSRPlugins((app as any)._context)).toHaveLength(1);
        // …but the module-level client registry stays untouched.
        expect(getClientPlugins()).toHaveLength(0);
    });

    it('a client install registers the client hooks (document present)', () => {
        const Root = component(() => () => <div>root</div>, { name: 'Root' });
        const app = defineApp((Root as any)({}));
        app.use(islandsPlugin());
        expect(getClientPlugins().map(p => p.name)).toContain('islands');
    });
});
