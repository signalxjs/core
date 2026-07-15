// Edge smoke test (rfc-ssr-platform §2.3): render a streaming document
// through the WinterCG-clean primitives — the built PRODUCTION dist, with
// all Node builtin imports forbidden by edge-hooks.mjs. Exercises:
// createSSR, renderDocumentChunks (shell promise + chunk generator),
// renderDocumentToWebStream (bytes), useResponse, useHead, and a streamed
// keyed useData read with its $SIGX_REPLACE replacement.
//
// Run via:  pnpm test:edge   (after pnpm build)
import { jsx, component, useData, useHead } from 'sigx';
import { createSSR, useResponse } from '@sigx/server-renderer';
import { resumePlugin } from '@sigx/resume/server';

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

console.log('✅ edge-smoke: WinterCG-clean document streaming verified (no Node builtins imported)');
