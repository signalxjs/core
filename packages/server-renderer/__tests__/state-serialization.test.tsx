/**
 * Tests for the built-in state serialization plugin: server-side capture of
 * ssr.load() signal state, the __SIGX_STATE__ wire format, streaming
 * preScript ordering, XSS safety, and the automatic client-side pickup
 * during hydration.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import { createSSR, stateSerializationPlugin, renderToString } from '../src/index';
import { hydrateComponent } from '../src/client/hydrate-component';
import {
    createSSRContainer,
    cleanupContainer,
    ssrComponentMarkers,
    nextTick
} from './test-utils';
import type { SSRSignalFn } from './test-utils';

function makeUserComponent(loaded: any = { name: 'Ada', role: 'admin' }) {
    const loadSpy = vi.fn(async () => {
        user.value = loaded;
    });
    let user: any;
    const User = component((ctx) => {
        const ssrSignal = ctx.signal as SSRSignalFn;
        user = ssrSignal(null, 'user');
        (ctx as any).ssr.load(loadSpy);
        return () => <div class="user">{user.value ? user.value.name : 'loading'}</div>;
    }, { name: 'User' });
    return { User, loadSpy };
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
    it('emits a __SIGX_STATE__ blob for blocked ssr.load components (string mode)', async () => {
        const { User } = makeUserComponent();
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((User as any)({}));

        expect(html).toContain('>Ada<');
        expect(html).toContain('window.__SIGX_STATE__=Object.assign(window.__SIGX_STATE__||{},');
        // Root component gets id 1; named signal key 'user'
        expect(html).toContain('"1":{"user":{"name":"Ada","role":"admin"}}');
    });

    it('does not change output when the plugin is not used', async () => {
        const { User } = makeUserComponent();
        const html = await renderToString((User as any)({}));
        expect(html).toContain('>Ada<');
        expect(html).not.toContain('__SIGX_STATE__');
    });

    it('does not emit a blob for components without ssr.load()', async () => {
        const Plain = component((ctx) => {
            const ssrSignal = ctx.signal as SSRSignalFn;
            const count = ssrSignal(7, 'count');
            return () => <span>{count.value}</span>;
        }, { name: 'Plain' });

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Plain as any)({}));
        expect(html).toContain('<span>7</span>');
        expect(html).not.toContain('__SIGX_STATE__');
    });

    it('uses positional keys for unnamed signals', async () => {
        const Anon = component((ctx) => {
            const value = ctx.signal('initial');
            (ctx as any).ssr.load(async () => {
                value.value = 'loaded';
            });
            return () => <p>{value.value}</p>;
        }, { name: 'Anon' });

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Anon as any)({}));
        expect(html).toContain('"1":{"$0":"loaded"}');
    });

    it('escapes </script> and friends in captured values (XSS)', async () => {
        const { User } = makeUserComponent({ name: '</script><script>alert(1)</script>' });
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((User as any)({}));

        const stateScript = html.slice(html.indexOf('window.__SIGX_STATE__'));
        expect(stateScript).not.toContain('</script><script>alert');
        expect(stateScript).toContain('\\u003c/script\\u003e');
    });

    it('skips non-serializable values with a dev warning', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const Bad = component((ctx) => {
            const ssrSignal = ctx.signal as SSRSignalFn;
            const fn = ssrSignal(null as any, 'callback');
            const ok = ssrSignal(null as any, 'data');
            (ctx as any).ssr.load(async () => {
                fn.value = () => 'not serializable';
                ok.value = 'fine';
            });
            return () => <div>x</div>;
        }, { name: 'Bad' });

        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((Bad as any)({}));

        expect(html).toContain('"data":"fine"');
        expect(html).not.toContain('callback');
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('"callback"'));
        warn.mockRestore();
    });
});

describe('stateSerializationPlugin — streaming', () => {
    it('installs state via preScript BEFORE the $SIGX_REPLACE call', async () => {
        const { User } = makeUserComponent();
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await collectStream(ssr.renderStream((User as any)({})));

        const stateIdx = html.indexOf('window.__SIGX_STATE__');
        const replaceIdx = html.indexOf('$SIGX_REPLACE(1,');
        expect(stateIdx).toBeGreaterThan(-1);
        expect(replaceIdx).toBeGreaterThan(-1);
        expect(stateIdx).toBeLessThan(replaceIdx);

        // Same <script> block: state install cannot race the replace
        const scriptOpen = html.lastIndexOf('<script>', replaceIdx);
        expect(stateIdx).toBeGreaterThan(scriptOpen);
        expect(html).toContain('"1":{"user":{"name":"Ada","role":"admin"}}');
    });
});

describe('automatic client pickup during hydration', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        delete (globalThis as any).__SIGX_STATE__;
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        delete (globalThis as any).__SIGX_STATE__;
    });

    it('restores state from window.__SIGX_STATE__ without an explicit serverState arg', async () => {
        const loadSpy = vi.fn(async () => {});
        let restored: any;

        const User = component((ctx) => {
            const ssrSignal = ctx.signal as SSRSignalFn;
            const user = ssrSignal(null as any, 'user');
            (ctx as any).ssr.load(loadSpy);
            restored = user.value;
            return () => <div class="user">{user.value ? (user.value as any).name : 'loading'}</div>;
        }, { name: 'User' });

        // Simulate the server-emitted blob (component id 1)
        (globalThis as any).__SIGX_STATE__ = { 1: { user: { name: 'Ada', role: 'admin' } } };

        const ssrHtml = ssrComponentMarkers(1, '<div class="user">Ada</div>');
        container = createSSRContainer(ssrHtml);

        hydrateComponent(
            { type: User, props: {}, key: null, children: [], dom: null },
            container.firstChild, container
        );
        await nextTick();

        // Signal restored from the blob; ssr.load() was a no-op
        expect(restored).toEqual({ name: 'Ada', role: 'admin' });
        expect(loadSpy).not.toHaveBeenCalled();
        expect(container.querySelector('.user')!.textContent).toBe('Ada');
    });

    it('falls back to normal client behavior when no blob entry exists', async () => {
        const loadSpy = vi.fn(async () => {});

        const User = component((ctx) => {
            const ssrSignal = ctx.signal as SSRSignalFn;
            const user = ssrSignal(null as any, 'user');
            (ctx as any).ssr.load(loadSpy);
            return () => <div class="user">{user.value ? (user.value as any).name : 'loading'}</div>;
        }, { name: 'User' });

        const ssrHtml = ssrComponentMarkers(1, '<div class="user">loading</div>');
        container = createSSRContainer(ssrHtml);

        hydrateComponent(
            { type: User, props: {}, key: null, children: [], dom: null },
            container.firstChild, container
        );
        await nextTick();

        // No server state → hydration ssr.load stays a no-op walk-side but
        // signal keeps its initial value
        expect(container.querySelector('.user')!.textContent).toBe('loading');
    });
});

describe('server → client round trip', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        if (container) cleanupContainer(container);
        delete (globalThis as any).__SIGX_STATE__;
    });

    it('renders on the server, restores on the client, never refetches', async () => {
        const { User, loadSpy: serverLoad } = makeUserComponent();
        const ssr = createSSR().use(stateSerializationPlugin());
        const html = await ssr.render((User as any)({}));
        expect(serverLoad).toHaveBeenCalledTimes(1);

        // Split app HTML from the state script and "execute" the script the
        // way a browser would (install the blob).
        const scriptStart = html.indexOf('<script>');
        const appHtml = html.slice(0, scriptStart);
        const stateJson = html.slice(
            html.indexOf('||{},') + 5,
            html.lastIndexOf(');</script>')
        );
        (globalThis as any).__SIGX_STATE__ = JSON.parse(
            stateJson.replace(/\\u003c/g, '<').replace(/\\u003e/g, '>')
        );

        container = createSSRContainer(appHtml);

        const clientLoad = vi.fn(async () => {});
        let clientValue: any;
        const ClientUser = component((ctx) => {
            const ssrSignal = ctx.signal as SSRSignalFn;
            const user = ssrSignal(null as any, 'user');
            (ctx as any).ssr.load(clientLoad);
            clientValue = user.value;
            return () => <div class="user">{user.value ? (user.value as any).name : 'loading'}</div>;
        }, { name: 'User' });

        hydrateComponent(
            { type: ClientUser, props: {}, key: null, children: [], dom: null },
            container.firstChild, container
        );
        await nextTick();

        expect(clientValue).toEqual({ name: 'Ada', role: 'admin' });
        expect(clientLoad).not.toHaveBeenCalled();
        expect(container.querySelector('.user')!.textContent).toBe('Ada');
    });
});
