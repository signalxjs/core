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
        const ssr = createSSR().use(islandsPlugin({
            manifest: {
                ManifestIsland: { chunkUrl: '/assets/manifest-island.abc.js', exportName: 'ManifestIsland' }
            }
        }));

        const html = await ssr.render(<ManifestIsland client:visible initial={7} />);
        const island = Object.values(parseIslandData(html))[0] as any;

        expect(island.componentId).toBe('ManifestIsland');
        expect(island.chunkUrl).toBe('/assets/manifest-island.abc.js');
        expect(island.exportName).toBe('ManifestIsland');
    });

    it('leaves chunkUrl unset when the component is absent from the manifest', async () => {
        const ssr = createSSR().use(islandsPlugin({
            manifest: {
                SomeOtherComponent: { chunkUrl: '/assets/other.js', exportName: 'SomeOtherComponent' }
            }
        }));

        const html = await ssr.render(<ManifestIsland client:load />);
        const island = Object.values(parseIslandData(html))[0] as any;

        expect(island.componentId).toBe('ManifestIsland');
        expect(island.chunkUrl).toBeUndefined();
        expect(island.exportName).toBeUndefined();
    });
});
