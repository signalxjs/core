/**
 * App-carried SSR plugins (#413): `app.use(pack())` is the one install shape.
 * A pack's `install(app)` registers its server hooks via `provideSSRPlugin`;
 * every render path that receives the App merges them with the instance
 * plugins (instance first, name-deduped first-wins, app.use order preserved).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, defineApp, useData } from 'sigx';
import type { App, JSXElement } from 'sigx';
import {
    createSSR,
    provideSSRPlugin,
    getSSRPlugins,
    renderDocument
} from '../src/index';
import type { SSRPlugin } from '../src/index';

const TEMPLATE =
    '<!doctype html><html><head></head><body><div id="app"><!--ssr-outlet--></div></body></html>';

const Page = component(() => {
    return () => <main class="page">page</main>;
}, { name: 'Page' });

/** A plugin that records its hook firings and injects a marker. */
function recorderPlugin(name: string, log: string[]): SSRPlugin {
    return {
        name,
        server: {
            setup(ctx) {
                log.push(`${name}:setup:${ctx._appContext ? 'app' : 'noapp'}`);
            },
            resolveBoundary() {
                log.push(`${name}:resolveBoundary`);
                return undefined;
            },
            getInjectedHTML() {
                return `<!--injected:${name}-->`;
            }
        }
    };
}

/** Wrap an SSRPlugin as an app pack: install(app) provides it (#413). */
function packOf(plugin: SSRPlugin): SSRPlugin & { install(app: App): void } {
    return {
        ...plugin,
        install(app: App) {
            provideSSRPlugin(app._context, this as SSRPlugin);
        }
    };
}

function appWith(...plugins: (SSRPlugin & { install(app: App): void })[]): App {
    const app = defineApp((Page as any)({}) as JSXElement);
    for (const plugin of plugins) app.use(plugin);
    return app;
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
    let out = '';
    for await (const chunk of gen) out += chunk;
    return out;
}

async function collectStringStream(stream: ReadableStream<string>): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += value;
    }
    return out;
}

async function collectByteStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += decoder.decode(value, { stream: true });
    }
    return out;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('app-carried plugin discovery across render paths', () => {
    it('render() discovers app-carried plugins, and setup() sees the app context', async () => {
        const log: string[] = [];
        const app = appWith(packOf(recorderPlugin('rec', log)));
        const html = await createSSR().render(app);

        expect(html).toContain('<!--injected:rec-->');
        // The ordering regression (#413): setup must run AFTER _appContext
        // is assigned, so app-level provides resolve inside setup hooks.
        expect(log).toContain('rec:setup:app');
        expect(log).toContain('rec:resolveBoundary');
    });

    it('renderChunks() discovers app-carried plugins', async () => {
        const log: string[] = [];
        const app = appWith(packOf(recorderPlugin('rec', log)));
        const html = await collect(createSSR().renderChunks(app));
        expect(html).toContain('<!--injected:rec-->');
        expect(log).toContain('rec:setup:app');
    });

    it('renderStream() discovers app-carried plugins', async () => {
        const log: string[] = [];
        const app = appWith(packOf(recorderPlugin('rec', log)));
        const html = await collectStringStream(createSSR().renderStream(app));
        expect(html).toContain('<!--injected:rec-->');
    });

    it('renderStreamWithCallbacks() discovers app-carried plugins', async () => {
        const log: string[] = [];
        const app = appWith(packOf(recorderPlugin('rec', log)));
        let shell = '';
        await createSSR().renderStreamWithCallbacks(app, {
            onShellReady(html) { shell = html; },
            onAsyncChunk() {},
            onComplete() {},
            onError(e) { throw e; }
        });
        expect(shell).toContain('<!--injected:rec-->');
        expect(log).toContain('rec:setup:app');
    });

    it('renderDocument() discovers app-carried plugins', async () => {
        const log: string[] = [];
        const app = appWith(packOf(recorderPlugin('rec', log)));
        const html = await createSSR().renderDocument(app, { template: TEMPLATE });
        expect(html).toContain('<!--injected:rec-->');
        expect(log).toContain('rec:setup:app');
    });

    it('renderDocumentChunks() discovers app-carried plugins', async () => {
        const log: string[] = [];
        const app = appWith(packOf(recorderPlugin('rec', log)));
        const { chunks, shell } = createSSR().renderDocumentChunks(app, { template: TEMPLATE });
        await shell;
        const html = await collect(chunks);
        expect(html).toContain('<!--injected:rec-->');
    });

    it('renderDocumentToWebStream() discovers app-carried plugins', async () => {
        const log: string[] = [];
        const app = appWith(packOf(recorderPlugin('rec', log)));
        const html = await collectByteStream(
            createSSR().renderDocumentToWebStream(app, { template: TEMPLATE })
        );
        expect(html).toContain('<!--injected:rec-->');
    });

    it('a plain JSXElement input runs instance plugins only', async () => {
        const log: string[] = [];
        const ssr = createSSR({ plugins: [recorderPlugin('inst', log)] });
        const html = await ssr.render((Page as any)({}) as JSXElement);
        expect(html).toContain('<!--injected:inst-->');
        expect(log).toContain('inst:setup:noapp');
    });
});

describe('merge semantics', () => {
    it('instance plugins run before app-carried ones; app order is app.use order', async () => {
        const log: string[] = [];
        const ssr = createSSR({ plugins: [recorderPlugin('inst', log)] });
        const app = appWith(
            packOf(recorderPlugin('a', log)),
            packOf(recorderPlugin('b', log))
        );
        const html = await ssr.render(app);

        const setups = log.filter(l => l.includes(':setup:'));
        expect(setups).toEqual(['inst:setup:app', 'a:setup:app', 'b:setup:app']);
        // Injected HTML follows the same order
        const instAt = html.indexOf('<!--injected:inst-->');
        const aAt = html.indexOf('<!--injected:a-->');
        const bAt = html.indexOf('<!--injected:b-->');
        expect(instAt).toBeGreaterThanOrEqual(0);
        expect(instAt).toBeLessThan(aAt);
        expect(aAt).toBeLessThan(bAt);
    });

    it('an app-carried plugin colliding with an instance plugin name is dropped (first wins)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const log: string[] = [];
        const ssr = createSSR({ plugins: [recorderPlugin('dup', log)] });
        const app = appWith(packOf(recorderPlugin('dup', log)));
        await ssr.render(app);

        expect(log.filter(l => l.includes(':setup:'))).toEqual(['dup:setup:app']);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"dup"'));
    });

    it('provideSSRPlugin dedupes by name at install time (first install wins)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const log: string[] = [];
        const app = appWith(
            packOf(recorderPlugin('same', log)),
            packOf(recorderPlugin('same', log))
        );
        const carried = getSSRPlugins(app._context);
        expect(carried).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"same"'));
    });
});

describe('document default state plugin vs app-carried plugins', () => {
    const AsyncPage = component(() => {
        const data = useData('acp:data', async () => 'loaded');
        return () => <main>{data.value ?? 'loading'}</main>;
    }, { name: 'AsyncPage' });

    function asyncApp(...plugins: (SSRPlugin & { install(app: App): void })[]): App {
        const app = defineApp((AsyncPage as any)({}) as JSXElement);
        for (const plugin of plugins) app.use(plugin);
        return app;
    }

    it('appends the default state plugin when no app-carried plugin claims sigx:state', async () => {
        const html = await createSSR().renderDocument(asyncApp(), { template: TEMPLATE });
        expect(html).toContain('__SIGX_ASYNC__');
    });

    it('an app-carried plugin named sigx:state suppresses the default', async () => {
        const custom = packOf({
            name: 'sigx:state',
            server: { getInjectedHTML: () => '<!--custom-state-->' }
        });
        const html = await createSSR().renderDocument(asyncApp(custom), { template: TEMPLATE });
        expect(html).toContain('<!--custom-state-->');
        expect(html).not.toContain('__SIGX_ASYNC__');
    });

    it('serializeState: false disables the default regardless', async () => {
        const html = await createSSR().renderDocument(asyncApp(), {
            template: TEMPLATE,
            serializeState: false
        });
        expect(html).not.toContain('__SIGX_ASYNC__');
    });
});

/**
 * A duplicated module graph (#430). The whole seam is a `Symbol()` token, so
 * a second copy of this package provides under a token this copy can never
 * match — and the miss is indistinguishable from "no packs installed", which
 * is how #425 rendered pages with no boundary table and said nothing.
 */
describe('app-carried plugins — a duplicated module graph is not silent', () => {
    afterEach(() => vi.restoreAllMocks());

    /** What a second copy of @sigx/server-renderer's token looks like. */
    const foreignToken = Symbol('sigx:ssrPlugins');

    it('warns when the app provided its plugins through a SECOND copy', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp((Page as any)({}) as JSXElement);
        app._context.provides.set(foreignToken, [recorderPlugin('islands', [])]);

        await createSSR().renderDocument(app, { template: TEMPLATE });

        const message = warn.mock.calls.map(c => String(c[0])).join('\n');
        expect(message).toContain('SECOND copy');
        expect(message).toContain('no pack plugins');
    });

    it('says nothing for a healthy app-carried install', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp((Page as any)({}) as JSXElement);
        app.use(packOf(recorderPlugin('islands', [])));

        await createSSR().renderDocument(app, { template: TEMPLATE });

        expect(warn.mock.calls.map(c => String(c[0])).join('\n')).not.toContain('SECOND copy');
    });

    it('says nothing for an app that simply installed no packs', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = defineApp((Page as any)({}) as JSXElement);

        await createSSR().renderDocument(app, { template: TEMPLATE });

        expect(warn.mock.calls.map(c => String(c[0])).join('\n')).not.toContain('SECOND copy');
    });
});
