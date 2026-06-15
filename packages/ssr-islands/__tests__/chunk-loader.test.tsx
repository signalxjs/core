/**
 * Tests for the island chunk loader — focuses on the paths not covered by
 * lazy-islands.test.tsx, namely the direct chunkUrl import path
 * (loadFromChunkUrl) and prefetchIslandChunks.
 *
 * The chunkUrl path uses `import(url)`; we drive it with `data:` URLs, which
 * Node's ESM loader resolves to real modules, so we can exercise the named /
 * default / first-component unwrap branches and the failure path for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import { registerComponent } from '../src/client/registry';
import { loadIslandComponent, prefetchIslandChunks } from '../src/client/chunk-loader';
import { cleanupScripts } from './test-utils';

let testId = 0;
function uniqueName(base: string): string {
    return `Chunk_${base}_${++testId}`;
}

/**
 * Build a `data:` URL whose module exports component-shaped factories
 * (plain functions carrying a `__setup` property — the shape the loader
 * sniffs for). Each call produces a unique module body so the in-flight
 * chunk cache (keyed by URL) never collides between tests.
 */
function dataModule(body: string): string {
    const tag = `\n//${++testId}`; // unique suffix → unique URL → no cache collision
    return 'data:text/javascript,' + encodeURIComponent(body + tag);
}

const FACTORY = `var f = function(){}; f.__setup = function(){};`;

beforeEach(() => {
    cleanupScripts();
});

afterEach(() => {
    cleanupScripts();
    vi.restoreAllMocks();
});

describe('loadIslandComponent — chunkUrl path', () => {
    it('loads via the named export matching exportName', async () => {
        const url = dataModule(`${FACTORY} export { f as Widget };`);
        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: uniqueName('Named'),
            chunkUrl: url,
            exportName: 'Widget',
            props: {}
        });
        expect(typeof result).toBe('function');
        expect('__setup' in (result as any)).toBe(true);
    });

    it('falls back to the default export when exportName is "default"', async () => {
        const url = dataModule(`${FACTORY} export default f;`);
        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: uniqueName('Default'),
            chunkUrl: url,
            // no exportName → loader defaults to 'default'
            props: {}
        });
        expect(typeof result).toBe('function');
        expect('__setup' in (result as any)).toBe(true);
    });

    it('falls back to the first component export when neither name nor default match', async () => {
        const url = dataModule(`${FACTORY} export { f as somethingUnrelated };`);
        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: uniqueName('First'),
            chunkUrl: url,
            exportName: 'NotThere',
            props: {}
        });
        expect(typeof result).toBe('function');
    });

    it('returns undefined and warns when the chunk has no component', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const url = dataModule(`export const x = 1;`);
        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: uniqueName('Empty'),
            chunkUrl: url,
            props: {}
        });
        expect(result).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
    });

    it('returns undefined and logs when the chunk import fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Syntax error in the module body → import() rejects.
        const url = dataModule(`this is not valid javascript @@@`);
        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: uniqueName('Fail'),
            chunkUrl: url,
            props: {}
        });
        expect(result).toBeUndefined();
        expect(errorSpy).toHaveBeenCalled();
    });

    it('deduplicates concurrent loads of the same chunk URL', async () => {
        const url = dataModule(`${FACTORY} export default f;`);
        const info = {
            strategy: 'load' as const,
            componentId: uniqueName('Dedup'),
            chunkUrl: url,
            props: {}
        };
        const [a, b] = await Promise.all([
            loadIslandComponent(info),
            loadIslandComponent({ ...info, componentId: uniqueName('Dedup2') })
        ]);
        // Same cached module promise → identical factory reference.
        expect(a).toBe(b);
        expect(typeof a).toBe('function');
    });

    it('prefers an eagerly registered component over the chunk URL', async () => {
        const name = uniqueName('EagerOverChunk');
        const Eager = component(() => () => <span>eager</span>, { name });
        registerComponent(name, Eager);

        const result = await loadIslandComponent({
            strategy: 'load',
            componentId: name,
            // A bogus chunk URL that would fail if it were ever imported.
            chunkUrl: dataModule(`@@@ invalid`),
            props: {}
        });
        expect(result).toBe(Eager);
    });
});

describe('prefetchIslandChunks', () => {
    afterEach(() => {
        // Remove any modulepreload links we appended.
        document.head.querySelectorAll('link[rel="modulepreload"]').forEach(l => l.remove());
    });

    function preloadHrefs(): string[] {
        return [...document.head.querySelectorAll('link[rel="modulepreload"]')]
            .map(l => (l as HTMLLinkElement).getAttribute('href') || '');
    }

    it('appends a modulepreload link for each deferred island chunk (default strategies)', () => {
        prefetchIslandChunks({
            '1': { strategy: 'idle', componentId: 'A', chunkUrl: '/chunks/a.js', props: {} },
            '2': { strategy: 'visible', componentId: 'B', chunkUrl: '/chunks/b.js', props: {} },
            '3': { strategy: 'media', componentId: 'C', chunkUrl: '/chunks/c.js', props: {} },
        });
        const hrefs = preloadHrefs();
        expect(hrefs).toContain('/chunks/a.js');
        expect(hrefs).toContain('/chunks/b.js');
        expect(hrefs).toContain('/chunks/c.js');
    });

    it('skips islands without a chunkUrl and skips strategies not in the list', () => {
        prefetchIslandChunks({
            // No chunkUrl → skipped.
            '1': { strategy: 'idle', componentId: 'A', props: {} },
            // strategy 'load' not in the requested list → skipped.
            '2': { strategy: 'load', componentId: 'B', chunkUrl: '/chunks/load.js', props: {} },
            // matches the requested list.
            '3': { strategy: 'idle', componentId: 'C', chunkUrl: '/chunks/idle.js', props: {} },
        }, ['idle']);
        const hrefs = preloadHrefs();
        expect(hrefs).toContain('/chunks/idle.js');
        expect(hrefs).not.toContain('/chunks/load.js');
    });

    it('deduplicates a chunk URL shared by multiple islands', () => {
        prefetchIslandChunks({
            '1': { strategy: 'idle', componentId: 'A', chunkUrl: '/chunks/shared.js', props: {} },
            '2': { strategy: 'visible', componentId: 'B', chunkUrl: '/chunks/shared.js', props: {} },
        });
        const shared = preloadHrefs().filter(h => h === '/chunks/shared.js');
        expect(shared.length).toBe(1);
    });

    it('prefetches all strategies when given an empty strategy list', () => {
        prefetchIslandChunks({
            '1': { strategy: 'load', componentId: 'A', chunkUrl: '/chunks/all-load.js', props: {} },
            '2': { strategy: 'idle', componentId: 'B', chunkUrl: '/chunks/all-idle.js', props: {} },
        }, []);
        const hrefs = preloadHrefs();
        expect(hrefs).toContain('/chunks/all-load.js');
        expect(hrefs).toContain('/chunks/all-idle.js');
    });
});
