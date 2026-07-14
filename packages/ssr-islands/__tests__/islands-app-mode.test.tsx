/**
 * The pluggable islands app mode: `app.use(islandsPlugin()).hydrate('#app')`
 * — the plugin's install() provides { boundaries: 'explicit' } through the
 * core hydrate-defaults DI seam and registers the client hooks, so only
 * boundary-table entries hydrate (no root walk). Plus the new
 * client:interaction directive end-to-end (server table → client wake).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, defineApp, signal } from 'sigx';
import { createSSR } from '@sigx/server-renderer';
import {
    ssrClientPlugin,
    clearClientPlugins,
    cleanupPendingHydrations,
    invalidateMarkerIndex,
    getHydrateDefaults
} from '@sigx/server-renderer/client';
import { islandsPlugin } from '../src/plugin';
import { registerComponent } from '../src/client/registry';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    parseBoundaryTable,
    setBoundaryTable,
    nextTick
} from './test-utils';

let testId = 0;
function uniqueName(base: string): string {
    return `AppMode_${base}_${++testId}`;
}

describe('islands app mode (app.use(islandsPlugin()))', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.restoreAllMocks();
    });

    it("install(app) provides { boundaries: 'explicit' } via the DI seam", () => {
        const Root = component(() => () => <div>root</div>, { name: 'Root' });
        const app = defineApp((Root as any)({}));
        app.use(islandsPlugin());
        expect(getHydrateDefaults((app as any)._context)).toEqual({ boundaries: 'explicit' });
    });

    it('app.hydrate() in islands mode skips the root walk and hydrates only islands', async () => {
        let rootSetupRuns = 0;
        let islandSetupRuns = 0;

        const islandName = uniqueName('Widget');
        registerComponent(islandName, component(() => {
            islandSetupRuns++;
            return () => <span class="w">widget</span>;
        }, { name: islandName }) as any);

        const Root = component(() => {
            rootSetupRuns++;
            return () => <div>static page</div>;
        }, { name: 'Root' });

        container = createSSRContainer('<div>static page<span class="w">widget</span><!--$c:2--></div><!--$c:1-->');
        setBoundaryTable({ '2': { hydrate: 'load', component: islandName } });

        const app = defineApp((Root as any)({}));
        app.use(ssrClientPlugin).use(islandsPlugin());
        (app as any).hydrate(container);
        await nextTick();

        expect(rootSetupRuns).toBe(0);   // hydrate: 'never' root — no walk
        expect(islandSetupRuns).toBe(1); // the island woke up
    });

    it('client:interaction is authorable end-to-end: server records it, client wakes on interaction', async () => {
        const name = uniqueName('Tap');
        let clientSetupRuns = 0;
        const Tap = component(() => {
            clientSetupRuns++;
            const n = signal(0, 'n');
            return () => <button class="tap">{n.value}</button>;
        }, { name });

        // Server: the directive maps onto the hydrate axis in the table
        const ssr = createSSR().use(islandsPlugin());
        const html = await ssr.render((Tap as any)({ 'client:interaction': true }));
        const records = parseBoundaryTable(html);
        expect(records['1']).toMatchObject({ hydrate: 'interaction', component: name });

        // Client: schedule from the table, wake on pointerdown
        registerComponent(name, Tap as any);
        const Root = component(() => () => <main>x</main>, { name: 'Root' });
        container = createSSRContainer(html.slice(0, html.indexOf('<script>')));
        setBoundaryTable(records);

        const app = defineApp((Root as any)({}));
        app.use(ssrClientPlugin).use(islandsPlugin());
        (app as any).hydrate(container);
        await nextTick();
        // Setup ran once on the server-free client only after interaction
        expect(clientSetupRuns).toBe(1); // the SSR render above ran setup once

        container.querySelector('.tap')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        await nextTick();
        expect(clientSetupRuns).toBe(2);
    });
});
