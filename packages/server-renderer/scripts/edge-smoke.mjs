// Edge smoke test (rfc-ssr-platform §2.3, rfc-deploy §6): render a streaming
// document through the WinterCG-clean primitives — the built PRODUCTION
// dist, with all Node builtin imports forbidden by edge-hooks.mjs.
// Exercises: createSSR, renderDocumentChunks (shell promise + chunk
// generator), renderDocumentToWebStream (bytes), useResponse, useHead, a
// streamed keyed useData read with its $SIGX_REPLACE replacement, the full
// Request → createFetchHandler → Response round-trip, and @sigx/server's
// handleServerFnRequest under the same no-builtin hooks.
//
// Run via:  pnpm test:edge   (after pnpm build)
import { jsx, component, useData, useHead } from 'sigx';
import { createSSR, useResponse, createFetchHandler } from '@sigx/server-renderer';
import { resumePlugin } from '@sigx/resume/server';
import { serverFn } from '@sigx/server';
import { handleServerFnRequest } from '@sigx/server/server';

const Stats = component(() => {
    const stats = useData('edge:stats', async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { visitors: 42 };
    });
    return () => jsx('p', { class: 'stats', children: [stats.value ? String(stats.value.visitors) : 'loading'] });
}, { name: 'Stats' });

const App = component(() => {
    useHead({ title: 'Edge', htmlAttrs: { lang: 'en' } });
    useResponse().status(200).header('x-edge-smoke', 'ok');
    return () => jsx('main', { children: [jsx('h1', { children: ['edge'] }), (Stats)({})] });
}, { name: 'App' });

const TEMPLATE = '<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>';

function assert(cond, message) {
    if (!cond) {
        console.error(`❌ edge-smoke: ${message}`);
        globalThis.process?.exit?.(1);
        throw new Error(message);
    }
}

// 1) The chunk primitive: shell resolves the response head; chunks stream.
{
    const ssr = createSSR();
    const { chunks, shell } = ssr.renderDocumentChunks(App({}), { template: TEMPLATE, mode: 'stream' });
    const head = await shell;
    assert(head.status === 200, `shell status 200, got ${head.status}`);
    assert(head.headers['x-edge-smoke'] === 'ok', 'useResponse header surfaced on the shell');

    let html = '';
    for await (const chunk of chunks) html += chunk;
    assert(html.includes('<title>Edge</title>'), 'useHead title injected');
    assert(html.includes('<html lang="en">'), 'htmlAttrs patched into the frame');
    assert(html.includes('data-async-placeholder'), 'streaming placeholder emitted');
    assert(html.includes('$SIGX_REPLACE(') && html.includes('42'), 'streamed replacement delivered');
    assert(html.includes('sigx:ready'), 'completion script emitted');
}

// 2) The byte stream shape edge runtimes hand to Response.
{
    const ssr = createSSR();
    const stream = ssr.renderDocumentToWebStream(App({}), { template: TEMPLATE });
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let html = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
    }
    assert(html.includes('<h1>edge</h1>'), 'web-stream document rendered');
    assert(html.includes('42'), 'web-stream carried the streamed data');
}

// 3) The resume pack's server half is WinterCG-clean too (#241): a stamped
// component renders its QRL attributes and a hydrate:'never' record.
{
    const Res = component((ctx) => {
        const n = ctx.signal(3, 'n');
        return () => jsx('button', { 'data-sigx-on:click': 'Res_click_edge0001', 'data-sigx-b': ctx.$sigxB, children: [String(n.value)] });
    }, { name: 'Res' });
    Res.__resumeId = 'Res';

    const ssr = createSSR().use(resumePlugin());
    const html = await ssr.render(Res({}));
    assert(html.includes('data-sigx-on:click="Res_click_edge0001"'), 'resume QRL attribute rendered');
    assert(/data-sigx-b="\d+"/.test(html), 'resume boundary attribute rendered');
    assert(html.includes('"hydrate":"never"') && html.includes('"n":3'), 'resume record + state in the table');
}

// 4) The fetch handler (rfc-deploy §2): full Request → Response round-trip
// through the prod dist — the shape every fetch platform consumes.
{
    const handler = createFetchHandler({ template: TEMPLATE, app: () => App({}) });

    const res = await handler(new Request('https://edge.test/'));
    assert(res.status === 200, `fetch handler status 200, got ${res.status}`);
    assert((res.headers.get('content-type') ?? '').includes('text/html'), 'fetch handler content-type set');
    assert(res.headers.get('x-edge-smoke') === 'ok', 'useResponse header merged onto the Response');
    const html = await res.text();
    assert(html.includes('data-async-placeholder') && html.includes('42'), 'fetch handler streamed the document');
    assert(html.includes('sigx:ready'), 'fetch handler emitted the completion script');

    const bot = await handler(
        new Request('https://edge.test/', { headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' } })
    );
    const botHtml = await bot.text();
    assert(botHtml.includes('42') && !botHtml.includes('data-async-placeholder'), 'bot got a blocking document');
}

// 5) @sigx/server is WinterCG-clean too (rfc-deploy §6 — closing the
// standing gap): a server-fn POST round-trip through the prod dist.
{
    const add = serverFn(async (_rq, a, b) => a + b);
    const res = await handleServerFnRequest(
        new Request('https://edge.test/_sigx/fn/add_fn_00000001', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://edge.test' },
            body: '{"args":[2,3]}'
        }),
        { resolve: () => add }
    );
    assert(res.status === 200, `server fn status 200, got ${res.status}`);
    const envelope = await res.json();
    assert(envelope.data === 5, 'server fn returned {data}');

    // timeoutMs (#350) under the same discipline: per-request AbortController
    // + AbortSignal.any + setTimeout must all be WinterCG-clean, and a fast
    // fn must be unaffected while a hung fn 504s with onError fired.
    const fast = await handleServerFnRequest(
        new Request('https://edge.test/_sigx/fn/add_fn_00000001', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://edge.test' },
            body: '{"args":[4,5]}'
        }),
        { resolve: () => add, timeoutMs: 1000 }
    );
    assert(fast.status === 200 && (await fast.json()).data === 9, 'timeoutMs leaves a fast fn unaffected');

    const never = serverFn(async () => new Promise(() => {}));
    const masked = [];
    const hung = await handleServerFnRequest(
        new Request('https://edge.test/_sigx/fn/never_fn_00000002', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: 'https://edge.test' },
            body: '{"args":[]}'
        }),
        { resolve: () => never, timeoutMs: 20, onError: (error) => masked.push(error) }
    );
    assert(hung.status === 504, `hung fn 504s under timeoutMs, got ${hung.status}`);
    assert(masked.length === 1, 'onError observed the timeout');
}

console.log('✅ edge-smoke: WinterCG-clean document streaming, fetch handler, and server-fn endpoint verified (no Node builtins imported)');
