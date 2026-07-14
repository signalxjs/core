/**
 * The __SIGX_BOUNDARIES__ table — per-request core protocol replacing the
 * islands-owned blob: shell emission, the per-id mid-stream patch (preScript
 * position, before $SIGX_REPLACE), and the fast-path guarantee that a page
 * without boundaries emits nothing.
 */

import { describe, it, expect, vi } from 'vitest';
import { component, useData } from 'sigx';
import { createSSR, renderToString } from '../src/index';
import { renderToStream } from '../src/server/index';
import type { SSRPlugin } from '../src/plugin';
import { emitBoundaryTable } from '../src/server/serialize';
import { createSSRContext } from '../src/server/context';

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

const Plain = component(() => {
    return () => <div class="plain">hello</div>;
}, { name: 'Plain' });

function makeAsyncComponent(key: string) {
    const Async = component(() => {
        const data = useData(key, async () => {
            await new Promise(r => setTimeout(r, 5));
            return { n: 42 };
        });
        return () => <div>{data.value ? (data.value as any).n : 'loading'}</div>;
    }, { name: 'Async' });
    return Async;
}

describe('fast path — no boundaries, no bytes', () => {
    it('plain string render emits no table', async () => {
        const html = await renderToString((Plain as any)({}));
        expect(html).not.toContain('__SIGX_BOUNDARIES__');
        expect(html).not.toContain('data-boundary');
    });

    it('plain streaming render (async component included) emits no table', async () => {
        const Async = makeAsyncComponent('fast-path-async');
        const out = await collectStream(renderToStream((Async as any)({})) as ReadableStream<string>);
        expect(out).toContain('$SIGX_REPLACE(');
        expect(out).not.toContain('__SIGX_BOUNDARIES__');
    });

    it('emitBoundaryTable returns the empty string for an empty table', () => {
        expect(emitBoundaryTable(createSSRContext())).toBe('');
    });
});

describe('shell emission — wire shape', () => {
    it('serializes recorded boundaries as the executable assignment', () => {
        const ctx = createSSRContext();
        ctx.recordBoundary(3, { hydrate: 'visible', component: 'Counter', props: { start: 5 } });
        ctx.recordBoundary(9, { flush: 'skip', hydrate: 'load', chunk: { url: '/c.js', export: 'C' } });
        expect(emitBoundaryTable(ctx)).toBe(
            '<script>window.__SIGX_BOUNDARIES__=Object.assign(Object.create(null),window.__SIGX_BOUNDARIES__,' +
            '{"3":{"hydrate":"visible","component":"Counter","props":{"start":5}},' +
            '"9":{"flush":"skip","hydrate":"load","chunk":{"url":"/c.js","export":"C"}}});</script>'
        );
    });

    it('escapes script-breaking payloads in props', () => {
        const ctx = createSSRContext();
        ctx.recordBoundary(1, { props: { x: '</script><script>alert(1)</script>' } });
        const script = emitBoundaryTable(ctx);
        expect(script).not.toContain('</script><script>alert');
        expect(script).toContain('\\u003c/script\\u003e');
    });

    it('ships with the shell of a string render when a plugin records a boundary', async () => {
        const recorder: SSRPlugin = {
            name: 'test:recorder',
            server: {
                transformComponentContext(ctx, _vnode, componentCtx) {
                    const id = ctx._componentStack[ctx._componentStack.length - 1];
                    ctx.recordBoundary(id, { hydrate: 'idle', component: 'Plain' });
                    return componentCtx;
                }
            }
        };
        const html = await createSSR().use(recorder).render((Plain as any)({}));
        expect(html).toContain('window.__SIGX_BOUNDARIES__=Object.assign(Object.create(null),window.__SIGX_BOUNDARIES__,');
        expect(html).toContain('"hydrate":"idle"');
    });
});

describe('mid-stream patch', () => {
    it('re-emits a mutated record as a preScript before $SIGX_REPLACE', async () => {
        // A plugin that records a boundary during the walk and mutates its
        // state when the component's async work resolves — the islands #120
        // flow, expressed through the new core seams.
        const recorder: SSRPlugin = {
            name: 'test:recorder',
            server: {
                transformComponentContext(ctx, _vnode, componentCtx) {
                    const id = ctx._componentStack[ctx._componentStack.length - 1];
                    ctx.recordBoundary(id, { hydrate: 'visible', component: 'Async' });
                    return componentCtx;
                },
                onAsyncComponentResolved(id, _html, ctx) {
                    const record = ctx.getBoundary(id);
                    if (record) record.state = { count: 7 };
                }
            }
        };
        const Async = makeAsyncComponent('patch-async');
        const ssr = createSSR().use(recorder);
        const out = await collectStream(ssr.renderStream((Async as any)({})) as ReadableStream<string>);

        // Shell table: recorded at walk time, no state yet
        const shellTable = out.indexOf('window.__SIGX_BOUNDARIES__=');
        expect(shellTable).toBeGreaterThan(-1);

        // The replacement script carries the patched record BEFORE the
        // $SIGX_REPLACE call (preScript slot) — fresh state is installed
        // before sigx:async-ready fires.
        const replaceIdx = out.indexOf('$SIGX_REPLACE(');
        expect(replaceIdx).toBeGreaterThan(-1);
        const patchIdx = out.indexOf('window.__SIGX_BOUNDARIES__=', shellTable + 1);
        expect(patchIdx).toBeGreaterThan(-1);
        expect(patchIdx).toBeLessThan(replaceIdx);
        expect(out.slice(patchIdx, replaceIdx)).toContain('"state":{"count":7}');
    });
});
