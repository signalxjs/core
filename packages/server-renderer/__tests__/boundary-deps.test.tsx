/**
 * §6.3 dep capture (#452): `serverUseAsync` records each canonical useData
 * key on the NEAREST enclosing boundary record (`record.deps`) by walking
 * the setup-context parent chain — the mutation endpoint's admission input
 * for single-flight boundary refresh. Covers: own reads, nearest-boundary
 * folding through non-boundary descendants, nested-boundary isolation,
 * dedupe, the deliberately-unrecorded reads (`server:false`, falsy keys),
 * and dep capture across a streamed (deferred) subtree.
 */

import { describe, it, expect } from 'vitest';
import { component, useData, Defer, lazy } from 'sigx';
import { createSSR } from '../src/index';
import type { SSRPlugin } from '../src/plugin';
import type { SSRBoundaryRecord } from '../src/boundary';

/** Mark every component whose vnode carries a `boundary` prop. */
const markerPlugin: SSRPlugin = {
    name: 'test-boundaries',
    server: {
        resolveBoundary(vnode) {
            if ((vnode.props as { boundary?: unknown } | null)?.boundary) {
                return { hydrate: 'never' };
            }
            return undefined;
        }
    }
};

function parseBoundaryTables(html: string): Record<string, SSRBoundaryRecord> {
    // Merge every table emission (shell + mid-stream patches), later wins —
    // exactly what Object.assign does on the client.
    const table: Record<string, SSRBoundaryRecord> = {};
    const re =
        /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/g;
    for (const match of html.matchAll(re)) {
        Object.assign(table, JSON.parse(match[1]));
    }
    return table;
}

function recordsByDeps(html: string): SSRBoundaryRecord[] {
    return Object.values(parseBoundaryTables(html)).filter((r) => r.deps);
}

async function collectStream(stream: ReadableStream<string>): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += value;
    }
    return out;
}

const ssr = () => createSSR({ plugins: [markerPlugin] });

describe('boundary dep capture (§6.3, #452)', () => {
    it("records the boundary's own reads — string and tuple canon", async () => {
        const Widget = component(() => {
            useData('w:one', async () => 1);
            useData(() => ['w', 2] as const, async () => 2);
            return () => <div>w</div>;
        }, { name: 'Widget' });

        const html = await ssr().render((Widget as any)({ boundary: true }));
        const [record] = recordsByDeps(html);
        expect(record.deps).toEqual(['w:one', '["w",2]']);
    });

    it('folds a non-boundary descendant’s reads into the nearest enclosing boundary', async () => {
        const Leaf = component(() => {
            useData('leaf:data', async () => 1);
            return () => <i>leaf</i>;
        }, { name: 'Leaf' });
        const Middle = component(() => () => <div>{(Leaf as any)({})}</div>, { name: 'Middle' });
        const Outer = component(() => {
            useData('outer:data', async () => 0);
            return () => <section>{(Middle as any)({})}</section>;
        }, { name: 'Outer' });

        const html = await ssr().render((Outer as any)({ boundary: true }));
        const [record] = recordsByDeps(html);
        expect(record.deps).toEqual(['outer:data', 'leaf:data']);
    });

    it('a nested boundary keeps its own deps — the parent does not absorb them', async () => {
        const Inner = component(() => {
            useData('inner:data', async () => 1);
            return () => <i>inner</i>;
        }, { name: 'Inner' });
        const Outer = component(() => {
            useData('outer:data', async () => 0);
            return () => <section>{(Inner as any)({ boundary: true })}</section>;
        }, { name: 'Outer' });

        const html = await ssr().render((Outer as any)({ boundary: true }));
        const withDeps = recordsByDeps(html);
        expect(withDeps).toHaveLength(2);
        const depSets = withDeps.map((r) => r.deps);
        expect(depSets).toContainEqual(['outer:data']);
        expect(depSets).toContainEqual(['inner:data']);
    });

    it('reads above any boundary record nothing; repeated keys dedupe', async () => {
        const Repeat = component(() => {
            useData('same:key', async () => 1);
            useData('same:key', async () => 1);
            return () => <b>r</b>;
        }, { name: 'Repeat' });
        const Top = component(() => {
            // No enclosing boundary — the walk exhausts the parent chain.
            useData('top:data', async () => 0);
            return () => <main>{(Repeat as any)({ boundary: true })}</main>;
        }, { name: 'Top' });

        const html = await ssr().render((Top as any)({}));
        const withDeps = recordsByDeps(html);
        expect(withDeps).toHaveLength(1);
        expect(withDeps[0].deps).toEqual(['same:key']);
    });

    it('server:false and falsy-key reads are deliberately unrecorded', async () => {
        const Quiet = component(() => {
            useData('client:only', async () => 1, { server: false });
            useData(() => false as const, async () => 2);
            return () => <div>q</div>;
        }, { name: 'Quiet' });

        const html = await ssr().render((Quiet as any)({ boundary: true }));
        expect(recordsByDeps(html)).toHaveLength(0);
    });

    it('captures deps across a streamed (deferred) subtree and re-ships the record', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const Slow = component(() => {
            return () => <span class="slow">done</span>;
        }, { name: 'Slow' });
        const LazySlow = lazy(async () => {
            await gate;
            return Slow;
        });
        const Reader = component(() => {
            useData('deferred:data', async () => 1);
            return () => <div>{(LazySlow as any)({})}</div>;
        }, { name: 'Reader' });
        const Shell = component(() => {
            return () => (
                <Defer fallback={<div class="spinner">…</div>}>
                    {(Reader as any)({})}
                </Defer>
            );
        }, { name: 'Shell' });

        setTimeout(release, 10);
        const html = await collectStream(
            ssr().renderStream((Shell as any)({ boundary: true })) as ReadableStream<string>
        );
        // The deferred subtree streamed as a $SIGX_REPLACE payload
        // (JSON-encoded), so match the marker, not raw markup.
        expect(html).toContain('$SIGX_REPLACE');
        expect(html).toContain('slow');
        const withDeps = recordsByDeps(html);
        expect(withDeps).toHaveLength(1);
        expect(withDeps[0].deps).toEqual(['deferred:data']);
    });
});
