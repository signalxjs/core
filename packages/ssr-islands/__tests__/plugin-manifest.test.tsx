/**
 * Tests for the islandsPlugin manifest option — attaches chunkUrl/exportName to
 * island data so the client can load chunks on demand. Covers the manifest
 * branch in transformComponentContext that the other plugin tests don't reach.
 */

import { describe, it, expect } from 'vitest';
import { component } from 'sigx';
import { createSSR } from '../../server-renderer/src/ssr';
import { islandsPlugin } from '../src/plugin';
import '../src/client-directives';
import { parseIslandData } from './test-utils';

const ManifestIsland = component<{ initial?: number }>((ctx) => {
    const count = ctx.signal(ctx.props.initial ?? 0);
    return () => <div class="mfi">{count.value}</div>;
}, { name: 'ManifestIsland' });

describe('islandsPlugin manifest', () => {
    it('attaches chunkUrl and exportName from the manifest to island data', async () => {
        const ssr = createSSR({ plugins: [islandsPlugin({
            manifest: {
                ManifestIsland: { chunkUrl: '/assets/manifest-island.abc.js', exportName: 'ManifestIsland' }
            }
        })] });

        const html = await ssr.render(<ManifestIsland client:visible initial={7} />);
        const island = Object.values(parseIslandData(html))[0] as any;

        expect(island.componentId).toBe('ManifestIsland');
        expect(island.chunkUrl).toBe('/assets/manifest-island.abc.js');
        expect(island.exportName).toBe('ManifestIsland');
    });

    it('leaves chunkUrl unset when the component is absent from the manifest', async () => {
        const ssr = createSSR({ plugins: [islandsPlugin({
            manifest: {
                SomeOtherComponent: { chunkUrl: '/assets/other.js', exportName: 'SomeOtherComponent' }
            }
        })] });

        const html = await ssr.render(<ManifestIsland client:load />);
        const island = Object.values(parseIslandData(html))[0] as any;

        expect(island.componentId).toBe('ManifestIsland');
        expect(island.chunkUrl).toBeUndefined();
        expect(island.exportName).toBeUndefined();
    });

    it('accepts manifest v2 and reads islands from the nested map', async () => {
        const ssr = createSSR({ plugins: [islandsPlugin({
            manifest: {
                version: 2,
                islands: {
                    ManifestIsland: { chunkUrl: '/assets/v2-island.js', exportName: 'ManifestIsland' }
                },
                runtimePreload: ['/assets/hydrate-core-x.js']
            }
        })] });

        const html = await ssr.render(<ManifestIsland client:visible />);
        const island = Object.values(parseIslandData(html))[0] as any;
        expect(island.chunkUrl).toBe('/assets/v2-island.js');
    });

    it('a legacy flat manifest with an island literally named "islands" stays legacy', async () => {
        // The v2 discriminator is the version TAG — an entry named "islands"
        // (an object!) must not flip shape detection.
        const Islands = component(() => () => <div class="named-islands" />, { name: 'islands' });
        const ssr = createSSR({ plugins: [islandsPlugin({
            manifest: {
                islands: { chunkUrl: '/assets/islands-island.js', exportName: 'islands' }
            }
        })] });

        const html = await ssr.render(<Islands client:visible />);
        const island = Object.values(parseIslandData(html))[0] as any;
        expect(island.chunkUrl).toBe('/assets/islands-island.js');
    });

    it('modulepreloads runtimePreload chunks via the assets hook when islands are schedulable', async () => {
        const TEMPLATE = `<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>`;
        const plugin = islandsPlugin({
            manifest: { version: 2, islands: {}, runtimePreload: ['/assets/hydrate-core-x.js', '/assets/sigx-y.js'] }
        });

        // A schedulable island on the page → both runtime chunks preload.
        const withIsland = await createSSR({ plugins: [plugin] }).renderDocument(
            (ManifestIsland as any)({ 'client:visible': true }), { template: TEMPLATE });
        expect(withIsland).toContain('<link rel="modulepreload" href="/assets/hydrate-core-x.js">');
        expect(withIsland).toContain('<link rel="modulepreload" href="/assets/sigx-y.js">');

        // No islands → no speculative runtime bytes.
        const Plain = component(() => () => <p>static</p>, { name: 'Plain' });
        const without = await createSSR({ plugins: [plugin] }).renderDocument(
            (Plain as any)({}), { template: TEMPLATE });
        expect(without).not.toContain('modulepreload');
    });
});
