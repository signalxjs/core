/**
 * Per-component error routing, end to end (rfc-ssr-platform §2.2): one
 * onError callback for shell-phase and stream-phase failures with typed
 * info; configurable renderError; the hard-coded red streamed-error div is
 * gone; document-level shell/stream failures carry phase-only info.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, useData } from 'sigx';
import { createSSR } from '../src/index';
import type { SSRPlugin } from '../src/plugin';
import type { SSRErrorInfo } from '../src/server/context';

afterEach(() => {
    vi.restoreAllMocks();
});

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

/** Renders fine pre-data; throws in the deferred (post-data) render. */
function makeStreamFailing(key: string, name = 'StreamFailing') {
    return component(() => {
        const data = useData(key, async () => {
            await new Promise(r => setTimeout(r, 5));
            return { ok: true };
        });
        return () => {
            if (data.value) {
                throw new Error('deferred boom');
            }
            return <div class="pending">loading</div>;
        };
    }, { name });
}

describe('streamed failures route through the seam', () => {
    it('onError fires with phase "stream" and componentId; renderError supplies the replacement', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const onError = vi.fn();
        const Failing = makeStreamFailing('stream-err-1');

        const ssr = createSSR();
        const out = await collectStream(ssr.renderStream((Failing as any)({}), {
            onError,
            renderError: (err, info) => `<p class="oops" data-c="${info.componentId}">${err.message}</p>`
        }) as ReadableStream<string>);

        expect(onError).toHaveBeenCalledOnce();
        const [error, info] = onError.mock.calls[0] as unknown as [Error, SSRErrorInfo];
        expect(error.message).toBe('deferred boom');
        expect(info).toMatchObject({ phase: 'stream', componentId: 1 });

        // The replacement carries renderError's HTML, not any built-in markup
        expect(out).toContain('$SIGX_REPLACE(1,');
        expect(out).toContain('oops');
        expect(out).toContain('deferred boom');
        expect(out).not.toContain('color:red');
    });

    it('the default streamed failure HTML has no hard-coded red div', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const Failing = makeStreamFailing('stream-err-default');
        const out = await collectStream(createSSR().renderStream((Failing as any)({})) as ReadableStream<string>);
        expect(out).toContain('$SIGX_REPLACE(1,');
        expect(out).not.toContain('Error loading component');
        expect(out).not.toContain('color:red');
        // Dev default: the marker plus a diagnostic box in the replacement
        expect(out).toContain('ssr-error:1');
    });

    it('boundaryId is set when the failed component is a recorded boundary', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const onError = vi.fn();
        const Failing = makeStreamFailing('stream-err-boundary');
        const recorder: SSRPlugin = {
            name: 'test:recorder',
            server: {
                resolveBoundary: () => ({ hydrate: 'load' })
            }
        };
        await collectStream(createSSR({ plugins: [recorder] }).renderStream((Failing as any)({}), { onError }) as ReadableStream<string>);
        expect(onError).toHaveBeenCalledOnce();
        const [, info] = onError.mock.calls[0] as unknown as [Error, SSRErrorInfo];
        expect(info.boundaryId).toBe(1);
    });
});

describe('shell-phase failures', () => {
    it('a sync setup throw reports phase "shell" with the component identity', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const onError = vi.fn();
        const Boom = component(() => {
            throw new Error('setup boom');
        }, { name: 'Boom' });

        const html = await createSSR().render((Boom as any)({}), { onError });
        expect(onError).toHaveBeenCalledOnce();
        const [error, info] = onError.mock.calls[0] as unknown as [Error, SSRErrorInfo];
        expect(error.message).toBe('setup boom');
        expect(info).toMatchObject({ phase: 'shell', componentId: 1, componentName: 'Boom' });
        expect(html).toContain('<!--ssr-error:1-->');
    });

    it('dev default renders a visible diagnostic box after the marker', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const Boom = component(() => {
            throw new Error('setup boom');
        }, { name: 'Boom' });

        const html = await createSSR().render((Boom as any)({}));
        expect(html).toContain('<!--ssr-error:1-->');
        expect(html).toContain('[SSR] &lt;Boom&gt; failed during shell: setup boom');
    });
});

describe('document-level failures (phase-only info)', () => {
    const TEMPLATE = `<!doctype html><html><head></head><body><!--ssr-outlet--></body></html>`;

    it('a shell-preparation failure fires onError with { phase: "shell" }', async () => {
        const onError = vi.fn();
        const ssr = createSSR();
        // Missing outlet marker → prepareDocument throws before any byte
        const { chunks, shell } = ssr.renderDocumentChunks((component(() => () => <p>x</p>, { name: 'P' }) as any)({}), {
            template: '<html><body>no outlet</body></html>',
            onError
        });
        await expect(shell).rejects.toThrow(/outlet/);
        await expect((async () => { for await (const _ of chunks) { /* drain */ } })()).rejects.toThrow();
        expect(onError).toHaveBeenCalledWith(expect.any(Error), { phase: 'shell' });
    });

    it('a plain document render reports nothing', async () => {
        const onError = vi.fn();
        const Page = component(() => () => <p>fine</p>, { name: 'Page' });
        const { chunks, shell } = createSSR().renderDocumentChunks((Page as any)({}), { template: TEMPLATE, onError });
        await shell;
        for await (const _ of chunks) { /* drain */ }
        expect(onError).not.toHaveBeenCalled();
    });
});
