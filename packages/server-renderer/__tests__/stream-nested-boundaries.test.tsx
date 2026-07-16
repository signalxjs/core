/**
 * Boundaries born inside a streamed render (#279): a PLAIN async component
 * (keyed useData, claimed by no plugin) whose deferred render contains
 * pack-claimed boundaries. Their records exist only after the shell table
 * flushed — the stream patch must carry them to the client, or handlers run
 * against detached scopes (the storefront's 'items counted but $0').
 */

import { describe, it, expect } from 'vitest';
import { component, useData } from 'sigx';
import type { SSRPlugin, SSRBoundaryRecord } from '@sigx/server-renderer';
import { createSSR } from '../src/ssr';

const claimStamped: SSRPlugin = {
    name: 'test-pack',
    server: {
        resolveBoundary(vnode) {
            const stamps = vnode.type as { __testStamp?: string };
            if (!stamps.__testStamp) return undefined;
            return { hydrate: 'never', component: stamps.__testStamp };
        }
    }
};

function makeCard(): any {
    const Card = component<{ id: string; price: number }>((ctx) => {
        const qty = ctx.signal(0);
        return () => <button>{ctx.props.id}:{qty.value}</button>;
    });
    (Card as any).__testStamp = 'Card';
    return Card;
}

/** Every table emission (shell + patches) merged in stream order. */
function mergedTable(html: string): Record<string, SSRBoundaryRecord> {
    const merged: Record<string, SSRBoundaryRecord> = {};
    const HEAD = 'window.__SIGX_BOUNDARIES__=Object.assign(Object.create(null),window.__SIGX_BOUNDARIES__,';
    for (let at = html.indexOf(HEAD); at >= 0; at = html.indexOf(HEAD, at + 1)) {
        const start = at + HEAD.length;
        let depth = 0;
        let inString = false;
        for (let i = start; i < html.length; i++) {
            const ch = html[i];
            if (inString) {
                if (ch === '\\') i++;
                else if (ch === '"') inString = false;
            } else if (ch === '"') inString = true;
            else if (ch === '{') depth++;
            else if (ch === '}' && --depth === 0) {
                Object.assign(merged, JSON.parse(html.slice(start, i + 1)));
                break;
            }
        }
    }
    return merged;
}

describe('streamed subtrees full of claimed boundaries', () => {
    it('patches records for boundaries created during the deferred render', async () => {
        const Card = makeCard();
        const Section = component((ctx) => {
            const data = useData('nested-section', async () => {
                await new Promise((r) => setTimeout(r, 10));
                return ['a', 'b', 'c'];
            });
            return () => (
                <section>
                    {(data.value as string[] | undefined)?.map((id) => (
                        <Card key={id} id={id} price={10} />
                    )) ?? 'loading'}
                </section>
            );
        }, { name: 'Section' });

        const ssr = createSSR().use(claimStamped);
        let html = '';
        for await (const chunk of ssr.renderChunks(<Section />)) html += chunk;

        // The replacement carried the three card boundaries...
        expect(html).toContain('$SIGX_REPLACE');
        const table = mergedTable(html);
        const cards = Object.values(table).filter((r) => r.component === 'Card');
        expect(cards).toHaveLength(3);
        // ...with their full records — props are what resumed scopes read.
        for (const record of cards) {
            expect(record.hydrate).toBe('never');
            expect(record.props).toMatchObject({ price: 10 });
        }
        // And the patch precedes its replacement (records land first).
        const patchAt = html.lastIndexOf('window.__SIGX_BOUNDARIES__=');
        const replaceAt = html.indexOf('$SIGX_REPLACE(');
        expect(patchAt).toBeGreaterThan(0);
        expect(patchAt).toBeLessThan(replaceAt);
    });

    it('does not re-send already-flushed records in later patches', async () => {
        const Card = makeCard();
        const Slow = component(() => {
            const data = useData('nested-slow', async () => {
                await new Promise((r) => setTimeout(r, 30));
                return 1;
            });
            return () => <i>{(data.value as number | undefined) ?? '…'}</i>;
        }, { name: 'Slow' });

        const ssr = createSSR().use(claimStamped);
        let html = '';
        for await (const chunk of ssr.renderChunks(<div><Card id="shell" price={1} /><Slow /></div>)) html += chunk;

        // The shell card flushed with the shell table; later PATCH
        // emissions (everything after the first assignment) must not
        // duplicate it.
        const HEAD = 'window.__SIGX_BOUNDARIES__=';
        const shellAt = html.indexOf(HEAD);
        const patches = html.slice(shellAt + HEAD.length);
        const patchAssignments = patches.includes(HEAD) ? patches.slice(patches.indexOf(HEAD)) : '';
        expect(patchAssignments).not.toContain('"component":"Card"');
    });
});
