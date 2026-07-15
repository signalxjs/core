/**
 * Streaming × resume (#241): async resume boundaries stream a placeholder
 * first, and the replacement HTML carries the QRL/boundary attributes —
 * delegation is document-level and reads attributes at dispatch time, so
 * streamed content is interactive the moment it lands, with its state in
 * the (patched) boundary table.
 */

import { describe, it, expect } from 'vitest';
import { component, useData } from 'sigx';
import { createSSR, type SSRBoundaryRecord } from '@sigx/server-renderer';
import { resumePlugin } from '../src/plugin';

function parseAllBoundaryPatches(html: string): Record<string, SSRBoundaryRecord>[] {
    // Patch scripts inline $SIGX_REPLACE after the assignment, so anchor on
    // the JSON's own closing `});`, not on `</script>`.
    const out: Record<string, SSRBoundaryRecord>[] = [];
    const re = /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,(\{[\s\S]*?\})\);/g;
    for (const match of html.matchAll(re)) out.push(JSON.parse(match[1]));
    return out;
}

async function collectChunks(gen: AsyncGenerator<string>): Promise<string[]> {
    const chunks: string[] = [];
    for await (const chunk of gen) chunks.push(chunk);
    return chunks;
}

function makeAsyncCounter(): any {
    const AsyncCounter = component((ctx) => {
        const n = (ctx.signal as any)(5, 'n');
        const data = useData('resume-stream-test', async () => {
            await new Promise((r) => setTimeout(r, 10));
            return 'ready';
        });
        return () => (
            <button
                {...({
                    'data-sigx-on:click': 'AsyncCounter_click_test01',
                    'data-sigx-b': (ctx as any).$sigxB
                } as any)}
            >
                {data.value ?? 'loading'}:{n.value}
            </button>
        );
    }, { name: 'AsyncCounter' });
    (AsyncCounter as any).__resumeId = 'AsyncCounter';
    (AsyncCounter as any).__resumeMode = 'resume';
    return AsyncCounter;
}

describe('streaming resume boundaries', () => {
    it('streams a placeholder, then a QRL-carrying replacement with table state', async () => {
        const AsyncCounter = makeAsyncCounter();
        const ssr = createSSR().use(resumePlugin());
        const chunks = await collectChunks(ssr.renderChunks(<AsyncCounter />));
        const html = chunks.join('');

        // Placeholder first, replacement later — streamed shape intact.
        const placeholderAt = html.indexOf('data-async-placeholder=');
        const replacementAt = html.indexOf('$SIGX_REPLACE');
        expect(placeholderAt).toBeGreaterThanOrEqual(0);
        expect(replacementAt).toBeGreaterThan(placeholderAt);

        // The replacement HTML carries the QRL + boundary attributes —
        // delegation reads them at dispatch time, no rebinding needed.
        const afterPlaceholder = html.slice(placeholderAt);
        expect(afterPlaceholder).toContain('data-sigx-on:click=');
        expect(afterPlaceholder).toContain('AsyncCounter_click_test01');
        expect(afterPlaceholder).toMatch(/data-sigx-b=\\?"\d+/);
        // The replacement HTML is unicode-escaped inside $SIGX_REPLACE; the
        // resolved value must be present in it.
        expect(html.slice(replacementAt)).toContain('ready');

        // The boundary record ships hydrate:'never' with the captured state
        // (core re-emits the record as the patch before sigx:async-ready).
        const patches = parseAllBoundaryPatches(html);
        expect(patches.length).toBeGreaterThan(0);
        const records = Object.values(patches[patches.length - 1]);
        expect(records[0].hydrate).toBe('never');
        expect(records[0].state).toEqual({ n: 5 });
    });

    it('captures async-window signal writes in the patched record', async () => {
        const Late = component((ctx) => {
            const n = (ctx.signal as any)(0, 'n');
            const data = useData('resume-stream-late', async () => {
                await new Promise((r) => setTimeout(r, 10));
                return 37;
            });
            return () => {
                // Render-time derivation after the async value lands — the
                // tracking proxy records the write; onAsyncComponentResolved
                // re-serializes it into the patched record.
                if (data.value !== undefined && n.value !== data.value) n.value = data.value;
                return <i>{n.value}</i>;
            };
        }, { name: 'Late' });
        (Late as any).__resumeId = 'Late';
        (Late as any).__resumeMode = 'resume';

        const ssr = createSSR().use(resumePlugin());
        const html = (await collectChunks(ssr.renderChunks(<Late />))).join('');

        const patches = parseAllBoundaryPatches(html);
        const finalRecord = Object.values(patches[patches.length - 1])[0];
        expect(finalRecord.state).toEqual({ n: 37 });
        expect(html).toContain('37');
    });
});
