/**
 * The __SIGX_ASYNC__ contract suite — server-side capture of keyed
 * useData/useStream values by the state serialization plugin, the
 * request-global key-indexed wire format, streaming preScript ordering,
 * XSS safety, request-level dedupe, and the consume-once client pickup
 * during hydration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, useData } from 'sigx';
import { createSSR, stateSerializationPlugin, renderToString } from '../src/index';
import { hydrateComponent } from '../src/client/hydrate-component';
import { createSSRContainer, cleanupContainer, nextTick } from './test-utils';

function makeUserComponent(key: string, loaded: any = { name: 'Ada', role: 'admin' }) {
    // Small delay so streaming-mode values resolve AFTER the shell flush —
    // forcing the per-component preScript emission path (instant fetchers
    // would already be in _asyncResults at shell time and ship with it).
    const fetcher = vi.fn(async () => {
        await new Promise(r => setTimeout(r, 5));
        return loaded;
    });
    const User = component(() => {
        const user = useData(key, fetcher);
        return () => <div class="user">{user.value ? (user.value as any).name : 'loading'}</div>;
    }, { name: 'User' });
    return { User, fetcher };
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

describe('stateSerializationPlugin — server capture', () => {
    it('emits a __SIGX_ASYNC__ blob for blocked keyed useData (string mode)', async () => {
        const { User } = makeUserComponent('blob-user');
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((User as any)({}));

        expect(html).toContain('>Ada<');
        expect(html).toContain('window.__SIGX_ASYNC__=Object.assign(Object.create(null),window.__SIGX_ASYNC__,');
        // Keyed by the explicit useData key — never by component id
        expect(html).toContain('"blob-user":{"name":"Ada","role":"admin"}');
    });

    it('does not emit a blob when the plugin is not used', async () => {
        const { User } = makeUserComponent('no-plugin-user');
        const html = await renderToString((User as any)({}));
        expect(html).toContain('>Ada<');
        expect(html).not.toContain('__SIGX_ASYNC__');
    });

    it('does not emit a blob for idle (falsy reactive-key) useData calls', async () => {
        const fetcher = vi.fn(async () => 'never-on-server');
        const Plain = component(() => {
            // A reactive key resolving falsy skips the fetch: state 'idle'.
            // (useData has no unkeyed form — every read has an identity.)
            const data = useData(() => null, fetcher);
            return () => <span>{data.value ?? data.state}</span>;
        }, { name: 'Plain' });

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Plain as any)({}));
        // Falsy key: the fetcher never runs on the server — SSR renders idle
        expect(html).toContain('<span>idle</span>');
        expect(fetcher).not.toHaveBeenCalled();
        expect(html).not.toContain('__SIGX_ASYNC__');
    });

    it('escapes </script> and friends in captured values (XSS)', async () => {
        const { User } = makeUserComponent('xss-user', { name: '</script><script>alert(1)</script>' });
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((User as any)({}));

        const stateScript = html.slice(html.indexOf('window.__SIGX_ASYNC__'));
        expect(stateScript).not.toContain('</script><script>alert');
        expect(stateScript).toContain('\\u003c/script\\u003e');
    });

    it('skips non-serializable values with a dev warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const Bad = component(() => {
            useData('callback', async () => () => 'not serializable');
            useData('good-data', async () => 'fine');
            return () => <div>x</div>;
        }, { name: 'Bad' });

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Bad as any)({}));

        expect(html).toContain('"good-data":"fine"');
        expect(html).not.toContain('"callback"');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"callback"'));
        warn.mockRestore();
    });
});

describe('non-representable values', () => {
    it('skips values JSON.stringify cannot represent (symbol) with a warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const Sym = component(() => {
            const data = useData('sym-key', async () => Symbol('nope') as any);
            return () => <div>{data.loading ? 'loading' : 'done'}</div>;
        }, { name: 'Sym' });

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Sym as any)({}));

        expect(html).not.toContain('sym-key');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"sym-key"'));
        warn.mockRestore();
    });
});

describe('prototype-pollution guards', () => {
    it('rejects dangerous keys with a dev warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const Bad = component(() => {
            const data = useData('__proto__', async () => ({ polluted: true }));
            return () => <div>{data.value ? 'loaded' : 'loading'}</div>;
        }, { name: 'Bad' });

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Bad as any)({}));

        expect(html).not.toContain('polluted');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"__proto__"'));
        warn.mockRestore();
    });

    it('emits a null-prototype assign target in the blob script', async () => {
        const Page = component(() => {
            const data = useData('safe-key', async () => 'v');
            return () => <div>{data.value ?? 'loading'}</div>;
        }, { name: 'Page' });

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Page as any)({}));

        // Object.assign onto a plain target routes "__proto__" through the
        // prototype setter — the emitted script must use a null-proto target.
        expect(html).toContain('Object.assign(Object.create(null),window.__SIGX_ASYNC__,');
    });
});

describe('stateSerializationPlugin — streaming', () => {
    it('installs state via preScript BEFORE the $SIGX_REPLACE call', async () => {
        const { User } = makeUserComponent('stream-user');
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await collectStream(ssr.renderStream((User as any)({})));

        const stateIdx = html.indexOf('window.__SIGX_ASYNC__');
        const replaceIdx = html.indexOf('$SIGX_REPLACE(1,');
        expect(stateIdx).toBeGreaterThan(-1);
        expect(replaceIdx).toBeGreaterThan(-1);
        expect(stateIdx).toBeLessThan(replaceIdx);

        // Same <script> block: state install cannot race the replace
        const scriptOpen = html.lastIndexOf('<script>', replaceIdx);
        expect(stateIdx).toBeGreaterThan(scriptOpen);
        expect(html).toContain('"stream-user":{"name":"Ada","role":"admin"}');
    });
});

describe('request-level dedupe', () => {
    it('shares one fetch between two components with the same key and emits the key once', async () => {
        const fetcher = vi.fn(async () => 'shared-value');
        const makeCard = (cls: string) => component(() => {
            const data = useData('dedupe-shared', fetcher);
            return () => <i class={cls}>{data.value}</i>;
        }, { name: 'Card' });
        const A = makeCard('a');
        const B = makeCard('b');

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render(
            <div>
                {(A as any)({})}
                {(B as any)({})}
            </div>
        );

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(html).toContain('<i class="a">shared-value</i>');
        expect(html).toContain('<i class="b">shared-value</i>');
        // The key appears exactly once in the blob
        expect(html.split('"dedupe-shared"').length - 1).toBe(1);
    });
});

describe('server → client round trip', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        delete (globalThis as any).__SIGX_ASYNC__;
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        delete (globalThis as any).__SIGX_ASYNC__;
    });

    it('renders on the server, restores on the client, never refetches', async () => {
        const { User, fetcher: serverFetch } = makeUserComponent('rt-user');
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((User as any)({}));
        expect(serverFetch).toHaveBeenCalledTimes(1);

        // Split app HTML from the state script and "execute" the script the
        // way a browser would (install the blob).
        const scriptStart = html.indexOf('<script>');
        const appHtml = html.slice(0, scriptStart);
        const marker = 'window.__SIGX_ASYNC__,';
        const stateJson = html.slice(
            html.indexOf(marker) + marker.length,
            html.lastIndexOf(');</script>')
        );
        (globalThis as any).__SIGX_ASYNC__ = JSON.parse(stateJson);

        container = createSSRContainer(appHtml);

        const clientFetch = vi.fn(async () => ({ name: 'WRONG', role: 'nope' }));
        const ClientUser = component(() => {
            const user = useData('rt-user', clientFetch);
            return () => <div class="user">{user.value ? (user.value as any).name : 'loading'}</div>;
        }, { name: 'User' });

        hydrateComponent(
            { type: ClientUser, props: {}, key: null, children: [], dom: null },
            container.firstChild, container
        );
        await nextTick();

        expect(clientFetch).not.toHaveBeenCalled();
        expect(container.querySelector('.user')!.textContent).toBe('Ada');
        // Page-lifetime cache: the entry persists (refresh() invalidates)
        expect('rt-user' in (globalThis as any).__SIGX_ASYNC__).toBe(true);
    });
});
