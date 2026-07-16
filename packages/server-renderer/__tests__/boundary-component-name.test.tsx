/**
 * ResolvedBoundary.component (#255): the resolveBoundary winner can name its
 * boundary record — packs with their own stamp vocabulary (e.g. resume's
 * __resumeId) no longer get anonymous records the client chunk loader
 * refuses. Core's __islandId || __name derivation stays the fallback.
 */

import { describe, it, expect } from 'vitest';
import { component } from 'sigx';
import type { SSRBoundaryRecord, SSRPlugin } from '@sigx/server-renderer';
import { createSSR } from '../src/ssr';

function parseBoundaryTable(html: string): Record<string, SSRBoundaryRecord> {
    const match = html.match(
        /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/
    );
    if (!match) return {};
    return JSON.parse(match[1]);
}

const claimStamped = (name?: string): SSRPlugin => ({
    name: 'test-pack',
    server: {
        resolveBoundary(vnode) {
            if (!(vnode.type as any).__testStamp) return undefined;
            return name !== undefined
                ? { hydrate: 'never', component: name }
                : { hydrate: 'never' };
        }
    }
});

function makeAnonymous(): any {
    // Deliberately NO name option and no __islandId — only the pack stamp.
    const Comp = component((ctx) => {
        const n = ctx.signal(1);
        return () => <i>{n.value}</i>;
    });
    (Comp as any).__testStamp = true;
    return Comp;
}

describe('ResolvedBoundary.component', () => {
    it('names the record from the resolveBoundary winner', async () => {
        const Comp = makeAnonymous();
        const html = await createSSR().use(claimStamped('PackName')).render(<Comp />);
        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.component).toBe('PackName');
    });

    it('falls back to core derivation when the winner names nothing', async () => {
        const Comp = makeAnonymous();
        (Comp as any).__name = 'CoreName';
        const html = await createSSR().use(claimStamped(undefined)).render(<Comp />);
        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.component).toBe('CoreName');
    });

    it('winner name beats core derivation', async () => {
        const Comp = makeAnonymous();
        (Comp as any).__islandId = 'IslandName';
        const html = await createSSR().use(claimStamped('PackName')).render(<Comp />);
        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.component).toBe('PackName');
    });
});

describe("modulepreload policy (#281)", () => {
    it("skips hydrate:'never' chunks and keeps schedulable ones", async () => {
        const Never = component(() => () => <i>n</i>, { name: 'NeverComp' });
        (Never as any).__testStamp = true;
        const Load = component(() => () => <b>l</b>, { name: 'LoadComp' });
        (Load as any).__loadStamp = true;

        const pack: SSRPlugin = {
            name: 'preload-pack',
            server: {
                resolveBoundary(vnode) {
                    if ((vnode.type as any).__testStamp) {
                        return { hydrate: 'never', chunk: { url: '/assets/never.js' } };
                    }
                    if ((vnode.type as any).__loadStamp) {
                        return { hydrate: 'load', chunk: { url: '/assets/load.js' } };
                    }
                    return undefined;
                }
            }
        };
        const ssr = createSSR().use(pack);
        const html = await ssr.renderDocument(<div><Never /><Load /></div>, {
            template: '<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>'
        });
        expect(html).toContain('modulepreload" href="/assets/load.js">');
        expect(html).not.toContain('modulepreload" href="/assets/never.js"');
    });
});
