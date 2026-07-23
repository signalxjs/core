/**
 * serverPlugin (#413) — the app-plugin face of @sigx/server: transport
 * install/dispose semantics and the one-registration types story (#411:
 * one `types` array stamps BOTH the RPC wire codec and the state/boundary
 * registry).
 *
 * Modules are loaded fresh per test (vi.resetModules + dynamic import): the
 * transport and the plugin's last-installed tracking are module-level seams,
 * and token identity must match between the plugin's own imports and the
 * test's assertions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TypeHandler } from '@sigx/serialize';

class Money {
    constructor(public cents: number) {}
}

const moneyHandler: TypeHandler = {
    name: 'money',
    tag: '$money',
    test: (v) => v instanceof Money,
    serialize: (v) => (v as Money).cents,
    revive: (c) => new Money(c as number)
};

async function load() {
    vi.resetModules();
    const sigx = await import('sigx');
    const internals = await import('sigx/internals');
    const plugin = await import('../src/plugin');
    const client = await import('../src/client/index');
    const wire = await import('../src/wire-codec');
    return { ...sigx, ...internals, ...plugin, ...client, ...wire };
}

function okFetch(): ReturnType<typeof vi.fn> {
    return vi.fn(async () => new Response(JSON.stringify({ data: 'ok' }), { status: 200 }));
}

/** app.unmount() requires a mount; run the registered disposables directly. */
function runDisposables(app: { _context: { disposables: Set<() => void> } }): void {
    for (const dispose of app._context.disposables) dispose();
    app._context.disposables.clear();
}

beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__SIGX_SERVERFN_CODEC__;
    delete (globalThis as Record<string, unknown>).__SIGX_TYPE_HANDLERS__;
});

afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).__SIGX_SERVERFN_CODEC__;
    delete (globalThis as Record<string, unknown>).__SIGX_TYPE_HANDLERS__;
});

describe('serverPlugin — transport', () => {
    it('installs the transport: stubs use its fetch and endpoint at call time', async () => {
        const { defineApp, jsx, serverPlugin, __serverFnStub } = await load();
        const fetchMock = okFetch();
        const app = defineApp(jsx('div', {}));
        app.use(serverPlugin({
            transport: { endpoint: '/custom/fn', fetch: fetchMock as unknown as typeof fetch }
        }));

        const stub = __serverFnStub('sym_1', 'fnOne', '/_sigx/fn');
        await expect(stub()).resolves.toBe('ok');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/custom/fn/sym_1');
    });

    it('dispose clears the transport only if it is still the active one', async () => {
        const { defineApp, jsx, serverPlugin, __serverFnStub } = await load();
        const fetch1 = okFetch();
        const fetch2 = okFetch();
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        const app1 = defineApp(jsx('div', {}));
        app1.use(serverPlugin({ transport: { fetch: fetch1 as unknown as typeof fetch } }));
        const app2 = defineApp(jsx('div', {}));
        app2.use(serverPlugin({ transport: { fetch: fetch2 as unknown as typeof fetch } }));

        // Disposing the OLD app must not clobber the successor's transport.
        runDisposables(app1);
        const stub = __serverFnStub('sym_2', 'fnTwo', '/_sigx/fn');
        await stub();
        expect(fetch2).toHaveBeenCalledTimes(1);
        expect(fetch1).not.toHaveBeenCalled();

        // Disposing the CURRENT app clears it — stubs fall back to global fetch.
        const globalFetch = okFetch();
        vi.stubGlobal('fetch', globalFetch);
        runDisposables(app2);
        await stub();
        expect(globalFetch).toHaveBeenCalledTimes(1);
        expect(fetch2).toHaveBeenCalledTimes(1);
        vi.unstubAllGlobals();
    });

    it('a server-side install (no document, no live-client marker) skips the transport', async () => {
        const { defineApp, jsx, serverPlugin, __serverFnStub } = await load();
        const serverTransportFetch = okFetch();
        vi.stubGlobal('document', undefined);

        const app = defineApp(jsx('div', {}));
        app.use(serverPlugin({
            transport: { fetch: serverTransportFetch as unknown as typeof fetch }
        }));
        expect(app._context.disposables.size).toBe(0);
        vi.unstubAllGlobals();

        // Stubs keep using the global fetch — the process-global seam was
        // never written (no cross-request bleed).
        const globalFetch = okFetch();
        vi.stubGlobal('fetch', globalFetch);
        await __serverFnStub('sym_srv', 'fnSrv', '/_sigx/fn')();
        expect(globalFetch).toHaveBeenCalledTimes(1);
        expect(serverTransportFetch).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it('a declared live client (native, no document) DOES install the transport', async () => {
        const { defineApp, jsx, serverPlugin, __serverFnStub } = await load();
        const nativeFetch = okFetch();
        vi.stubGlobal('document', undefined);
        (globalThis as Record<string, unknown>).__SIGX_LIVE_CLIENT__ = true;
        try {
            defineApp(jsx('div', {})).use(serverPlugin({
                transport: { fetch: nativeFetch as unknown as typeof fetch }
            }));
            await __serverFnStub('sym_native', 'fnNative', '/_sigx/fn')();
            expect(nativeFetch).toHaveBeenCalledTimes(1);
        } finally {
            delete (globalThis as Record<string, unknown>).__SIGX_LIVE_CLIENT__;
            vi.unstubAllGlobals();
        }
    });

    it('warns in dev when overwriting another app\'s live transport', async () => {
        const { defineApp, jsx, serverPlugin } = await load();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        defineApp(jsx('div', {})).use(serverPlugin({ transport: { endpoint: '/a' } }));
        expect(warn).not.toHaveBeenCalled();
        defineApp(jsx('div', {})).use(serverPlugin({ transport: { endpoint: '/b' } }));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('transport'));
    });
});

describe('serverPlugin — types (the #411 one-registration story)', () => {
    it('stamps the DI token, the browser mirror, and the RPC codec from ONE registration', async () => {
        const { defineApp, jsx, serverPlugin, getProvided, TYPE_HANDLER_TOKEN, encodeWire, reviveWire } =
            await load();
        const app = defineApp(jsx('div', {}));
        app.use(serverPlugin({ types: [moneyHandler] }));

        // 1) State/boundary registry: the DI token on the app context
        // (server-side reads) …
        const provided = getProvided(app._context.provides, TYPE_HANDLER_TOKEN) as TypeHandler[];
        expect(provided).toContain(moneyHandler);
        // … and the browser mirror (client decode paths; happy-dom has window).
        expect((globalThis as Record<string, unknown>).__SIGX_TYPE_HANDLERS__).toContain(moneyHandler);

        // 2) RPC wire: the codec global, exercised through the real
        // encode/revive pair.
        const encoded = encodeWire(new Money(1250));
        expect(encoded).toEqual({ $money: 1250 });
        const revived = reviveWire(encoded) as Money;
        expect(revived).toBeInstanceOf(Money);
        expect(revived.cents).toBe(1250);
    });

    it('is idempotent across repeated installs (per-request server apps): tag-keyed replacement', async () => {
        const { defineApp, jsx, serverPlugin } = await load();
        // Fresh handler OBJECTS per install, same tag — the per-request shape.
        const makeHandler = (): TypeHandler => ({ ...moneyHandler });
        for (let request = 0; request < 3; request++) {
            defineApp(jsx('div', {})).use(serverPlugin({ types: [makeHandler()] }));
        }
        const codec = (globalThis as { __SIGX_SERVERFN_CODEC__?: TypeHandler[] })
            .__SIGX_SERVERFN_CODEC__;
        expect(codec).toHaveLength(1);
        expect(codec![0].tag).toBe('$money');
    });

    it('registerWireTypeHandlers replaces same-tag handlers and appends new tags', async () => {
        const { registerWireTypeHandlers } = await load();
        const v1: TypeHandler = { ...moneyHandler };
        const v2: TypeHandler = { ...moneyHandler, serialize: (v) => (v as Money).cents * 2 };
        const other: TypeHandler = {
            name: 'point',
            tag: '$point',
            test: () => false,
            serialize: (v) => v,
            revive: (v) => v
        };

        registerWireTypeHandlers([v1]);
        registerWireTypeHandlers([v2, other]);

        const codec = (globalThis as { __SIGX_SERVERFN_CODEC__?: TypeHandler[] })
            .__SIGX_SERVERFN_CODEC__!;
        expect(codec).toHaveLength(2);
        expect(codec[0]).toBe(v2); // same tag → replaced in place
        expect(codec[1]).toBe(other); // new tag → appended
    });

    it('tag-less handlers append once by identity (module-level constants)', async () => {
        const { registerWireTypeHandlers } = await load();
        // A serialize-only handler (no tag, no revive) — the legacy shape.
        const tagless: TypeHandler = {
            name: 'legacy',
            test: () => false,
            serialize: (v) => v
        };
        registerWireTypeHandlers([tagless]);
        registerWireTypeHandlers([tagless]); // same reference → no duplicate
        const codec = (globalThis as { __SIGX_SERVERFN_CODEC__?: TypeHandler[] })
            .__SIGX_SERVERFN_CODEC__!;
        expect(codec).toHaveLength(1);
        expect(codec[0]).toBe(tagless);
    });
});
