/**
 * `app.use(resumePlugin())` on the CLIENT must coexist with normal hydration
 * (#483).
 *
 * It used to declare `boundaries: 'explicit'` unconditionally. That takes
 * `hydrate()` down the no-root-walk path — it schedules the table's
 * boundaries and returns before `hydrateNode()` ever runs — and every resume
 * record is `hydrate: 'never'`, which the table scheduler skips outright. So
 * an app that installed the plugin the way the docstring showed hydrated
 * NOTHING: a dead shell, no error, no warning. The working recipe had to be
 * reverse-engineered by the first app to try it.
 *
 * Resume's boundary isolation comes from the server-set `hydrate: 'never'`,
 * not from a client-side hydration default — unlike islands, where explicit
 * mode IS the pack's semantics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { component, signal } from 'sigx';
import { hydrate } from '../../server-renderer/src/client/hydrate-core';
import { getHydrateDefaults } from '../../server-renderer/src/client/hydrate-defaults';
import { cleanupPendingHydrations, invalidateMarkerIndex } from '../../server-renderer/src/client/scheduler';
import { clearClientPlugins } from '../../server-renderer/src/client/hydrate-context';
import { resumePlugin } from '../src/plugin';

function makeApp(): any {
    return { _context: { provides: new Map<symbol, unknown>() } };
}

function container(html: string): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'app';
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
}

describe('resumePlugin() client install (#483)', () => {
    let el: HTMLDivElement | null = null;

    beforeEach(() => {
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
    });

    afterEach(() => {
        el?.remove();
        el = null;
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.restoreAllMocks();
    });

    it('declares no hydration mode by default — the app keeps the root walk', () => {
        const app = makeApp();
        resumePlugin().install(app);

        // Nothing provided ⇒ core's default ('auto'), which is what an
        // app-rooted install wants: an app with a root has a root to hydrate.
        expect(getHydrateDefaults(app._context).boundaries).not.toBe('explicit');
    });

    it('hydrates the app around a resume boundary, not instead of it', async () => {
        let setups = 0;
        const Counter = component(() => {
            setups++;
            const n = signal(0);
            return () => <button class="live">{n.value}</button>;
        }, { name: 'Counter' });
        const App = component(() => () => (
            <main>
                <Counter />
                <span data-sigx-b="7">resumable, untouched</span>
            </main>
        ), { name: 'App' });

        el = container('<main><button class="live">0</button><!--$c:2--><span data-sigx-b="7">resumable, untouched</span></main><!--$c:1-->');
        const app = makeApp();
        resumePlugin().install(app);

        hydrate((App as any)({}), el, app._context);
        await Promise.resolve();

        // THE regression: with the unconditional 'explicit' provide this was 0
        // and the page was inert.
        expect(setups).toBe(1);
        expect((el as any)._vnode).toBeTruthy();
        expect(el.querySelectorAll('.live').length).toBe(1);
    });

    it('{ boundaries: "explicit" } still opts out of the root walk', async () => {
        let setups = 0;
        const App = component(() => {
            setups++;
            return () => <main>nope</main>;
        }, { name: 'App' });

        el = container('<main>nope</main><!--$c:1-->');
        const app = makeApp();
        resumePlugin({ boundaries: 'explicit' }).install(app);

        expect(getHydrateDefaults(app._context).boundaries).toBe('explicit');

        hydrate((App as any)({}), el, app._context);
        await Promise.resolve();

        // The app-less / islands posture: no root walk, so nothing hydrates
        // unless the boundary table names it.
        expect(setups).toBe(0);
    });
});
