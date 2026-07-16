/**
 * CSP nonce threading — `SSRContextOptions.nonce` must land on EVERY
 * `<script>` tag the renderer emits (boundary table, state blobs, streaming
 * protocol + replacement scripts, completion script), and its absence must
 * leave the output byte-identical to the historical bare `<script>` form.
 */

import { describe, it, expect } from 'vitest';
import { component, useData, useStream } from 'sigx';
import { createSSR } from '../src/ssr';
import { stateSerializationPlugin } from '../src/server/state-plugin';
import type { SSRPlugin } from '../src/plugin';

async function collect(chunks: AsyncGenerator<string>): Promise<string> {
    let out = '';
    for await (const chunk of chunks) out += chunk;
    return out;
}

const Plain = component(() => {
    return () => <div class="plain">hello</div>;
}, { name: 'Plain' });

function makeAsyncComponent(key: string) {
    return component(() => {
        const data = useData(key, async () => {
            await new Promise(r => setTimeout(r, 5));
            return { n: 42 };
        });
        return () => <div>{data.value ? (data.value as any).n : 'loading'}</div>;
    }, { name: 'Async' });
}

function makeStreamComponent(key: string) {
    return component(() => {
        const answer = useStream(key, async function* () {
            yield 'tok1';
            yield 'tok2';
        });
        return () => <p>{answer.value}</p>;
    }, { name: 'Streamy' });
}

/** Records every component as a boundary; mutates its state on async resolve. */
function makeRecorder(): SSRPlugin {
    return {
        name: 'test:recorder',
        server: {
            transformComponentContext(ctx, _vnode, componentCtx) {
                const id = ctx._componentStack[ctx._componentStack.length - 1];
                ctx.recordBoundary(id, { hydrate: 'idle', component: 'X' });
                return componentCtx;
            },
            onAsyncComponentResolved(id, _html, ctx) {
                const record = ctx.getBoundary(id);
                if (record) record.state = { count: 7 };
            }
        }
    };
}

describe('CSP nonce — string render', () => {
    it('puts the nonce on the boundary-table script', async () => {
        const ssr = createSSR().use(makeRecorder());
        const html = await ssr.render((Plain as any)({}), { nonce: 'abc123' });
        expect(html).toContain('<script nonce="abc123">window.__SIGX_BOUNDARIES__=');
        expect(html.match(/<script(?! nonce=)/)).toBeNull();
    });

    it('puts the nonce on the state blob script', async () => {
        const Async = makeAsyncComponent('nonce-string-state');
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Async as any)({}), { nonce: 'abc123' });
        expect(html).toContain('<script nonce="abc123">window.__SIGX_ASYNC__=');
        expect(html.match(/<script(?! nonce=)/)).toBeNull();
    });
});

describe('CSP nonce — streaming render', () => {
    it('stamps EVERY emitted script: protocol, replacement, patch, state, completion', async () => {
        const Async = makeAsyncComponent('nonce-stream-async');
        const Streamy = makeStreamComponent('nonce-stream-text');
        const App = component(() => {
            return () => (
                <main>
                    <Async />
                    <Streamy />
                </main>
            );
        }, { name: 'App' });

        const ssr = createSSR().use(makeRecorder()).use(stateSerializationPlugin());
        const out = await collect(ssr.renderChunks((App as any)({}), { nonce: 'abc123' }));

        // Everything the renderer can emit is present in this render…
        expect(out).toContain('window.$SIGX_REPLACE =');         // replace bootstrap
        expect(out).toContain('window.$SIGX_APPEND =');          // append bootstrap
        expect(out).toContain('$SIGX_APPEND(');                  // per-token scripts
        expect(out).toContain('$SIGX_REPLACE(');                 // replacement script
        expect(out).toContain('window.__SIGX_BOUNDARIES__=');    // table + mid-stream patch
        expect(out).toContain('window.__SIGX_ASYNC__=');         // state blob
        expect(out).toContain('__SIGX_STREAMING_COMPLETE__');    // completion script

        // …and not one <script> tag is missing the nonce.
        expect(out.match(/<script(?! nonce="abc123">)/)).toBeNull();

        // The mid-stream patch (mutated record) rides inside the nonce'd
        // replacement script, before the $SIGX_REPLACE call.
        expect(out).toContain('"state":{"count":7}');
    });

    it('renderDocument stamps the completion + state scripts', async () => {
        const Async = makeAsyncComponent('nonce-document-async');
        const template = '<html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>';
        const html = await createSSR().renderDocument((Async as any)({}), { template, nonce: 'abc123' });
        expect(html).toContain('window.__SIGX_ASYNC__=');
        expect(html).toContain('__SIGX_STREAMING_COMPLETE__');
        expect(html.match(/<script(?! nonce="abc123">)/)).toBeNull();
    });
});

describe('CSP nonce — absent', () => {
    it('emits plain <script> tags with no nonce attribute anywhere', async () => {
        const Async = makeAsyncComponent('no-nonce-async');
        const ssr = createSSR().use(makeRecorder()).use(stateSerializationPlugin());
        const out = await collect(ssr.renderChunks((Async as any)({})));
        expect(out).toContain('<script>');
        expect(out).toContain('$SIGX_REPLACE(');
        expect(out).toContain('__SIGX_STREAMING_COMPLETE__');
        expect(out).not.toContain('nonce=');
    });
});

describe('CSP nonce — escaping', () => {
    it('attribute-escapes a hostile nonce value', async () => {
        const ssr = createSSR().use(makeRecorder());
        const html = await ssr.render((Plain as any)({}), { nonce: 'abc"def' });
        expect(html).toContain('<script nonce="abc&quot;def">');
        expect(html).not.toContain('nonce="abc"def"');
    });
});
