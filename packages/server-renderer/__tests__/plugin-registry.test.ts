/**
 * The eager client plugin registry (`client/plugin-registry`): lazy plugin
 * sources, name dedupe, and failure/retry semantics. These are the
 * guarantees the scheduler/core split leans on — `loadHydrationCore()`
 * awaits `resolveClientPlugins()` so synchronous hydration hooks always see
 * resolved plugins.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    registerClientPlugin,
    getClientPlugins,
    clearClientPlugins,
    resolveClientPlugins,
    hasPendingClientPlugins
} from '../src/client/plugin-registry';
import type { SSRPlugin } from '../src/plugin';

const plugin = (name: string): SSRPlugin => ({ name, client: {} });

describe('client plugin registry', () => {
    beforeEach(() => {
        clearClientPlugins();
    });

    it('registers plain plugin objects immediately', () => {
        const p = plugin('a');
        registerClientPlugin(p);
        expect(getClientPlugins()).toEqual([p]);
        expect(hasPendingClientPlugins()).toBe(false);
    });

    it('lazy sources are invisible until resolved', async () => {
        const p = plugin('lazy');
        registerClientPlugin({ name: 'lazy', load: () => Promise.resolve(p) });
        expect(getClientPlugins()).toEqual([]);
        expect(hasPendingClientPlugins()).toBe(true);

        const resolved = await resolveClientPlugins();
        expect(resolved).toEqual([p]);
        expect(getClientPlugins()).toEqual([p]);
        expect(hasPendingClientPlugins()).toBe(false);
    });

    it('unwraps a default export from the lazy module', async () => {
        const p = plugin('via-default');
        registerClientPlugin({ name: 'via-default', load: () => Promise.resolve({ default: p }) });
        expect(await resolveClientPlugins()).toEqual([p]);
    });

    it('resolves lazy sources in registration order', async () => {
        const first = plugin('first');
        const second = plugin('second');
        registerClientPlugin({ name: 'first', load: () => Promise.resolve(first) });
        registerClientPlugin({ name: 'second', load: () => Promise.resolve(second) });
        expect(await resolveClientPlugins()).toEqual([first, second]);
    });

    it('dedupes by name, first-wins: object then lazy source', async () => {
        const eager = plugin('islands');
        const loader = vi.fn(() => Promise.resolve(plugin('islands')));
        registerClientPlugin(eager);
        registerClientPlugin({ name: 'islands', load: loader });

        expect(await resolveClientPlugins()).toEqual([eager]);
        expect(loader).not.toHaveBeenCalled();
    });

    it('dedupes by name, first-wins: lazy source then object', async () => {
        const lazy = plugin('islands');
        registerClientPlugin({ name: 'islands', load: () => Promise.resolve(lazy) });
        registerClientPlugin(plugin('islands'));

        expect(await resolveClientPlugins()).toEqual([lazy]);
    });

    it('load() runs once — concurrent resolves share the promise', async () => {
        const loader = vi.fn(() => Promise.resolve(plugin('once')));
        registerClientPlugin({ name: 'once', load: loader });

        await Promise.all([resolveClientPlugins(), resolveClientPlugins()]);
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('a failed load is reported, not thrown, and retried on the next resolve', async () => {
        let attempts = 0;
        const p = plugin('flaky');
        registerClientPlugin({
            name: 'flaky',
            load: () => {
                attempts++;
                return attempts === 1 ? Promise.reject(new Error('network')) : Promise.resolve(p);
            }
        });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        // First trigger: the load fails; other plugins would still hydrate.
        expect(await resolveClientPlugins()).toEqual([]);
        expect(hasPendingClientPlugins()).toBe(true);

        // Next trigger retries the source.
        expect(await resolveClientPlugins()).toEqual([p]);
        expect(attempts).toBe(2);
        errorSpy.mockRestore();
    });

    it('one failing source does not block the others', async () => {
        const ok = plugin('ok');
        registerClientPlugin({ name: 'broken', load: () => Promise.reject(new Error('boom')) });
        registerClientPlugin({ name: 'ok', load: () => Promise.resolve(ok) });
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(await resolveClientPlugins()).toEqual([ok]);
        errorSpy.mockRestore();
    });

    it('clearClientPlugins drops resolved plugins, lazy sources, and dedupe names', async () => {
        registerClientPlugin(plugin('a'));
        registerClientPlugin({ name: 'b', load: () => Promise.resolve(plugin('b')) });
        clearClientPlugins();

        expect(getClientPlugins()).toEqual([]);
        expect(hasPendingClientPlugins()).toBe(false);

        // The names are forgotten too — re-registration works.
        const again = plugin('a');
        registerClientPlugin(again);
        expect(getClientPlugins()).toEqual([again]);
    });
});
