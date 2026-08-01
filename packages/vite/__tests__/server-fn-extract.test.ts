/**
 * @vitest-environment node
 *
 * extractServerFns() — the analysis half of sigxServer() (rfc-server §3,
 * #305): stub-module generation, content-hashed symbol determinism,
 * server-only stubbing, and type-only pass-through.
 */

import { describe, it, expect } from 'vitest';
import {
    extractServerFns,
    serverFnKeyStamps,
    KEY_STAMP_MARKER,
    type ServerFnExtractOptions
} from '../src/server-fn-extract';

const BASE = '/_sigx/fn';
const opts = (stableId: string, extra?: Partial<ServerFnExtractOptions>): ServerFnExtractOptions => ({
    stableId,
    endpoint: BASE,
    ...extra
});

const CART = `
import { serverFn, ServerFnError } from '@sigx/server';
import { db } from './db';

export const addToCart = serverFn(async (rq, id: string, qty: number) => {
    return db.cart.add(id, qty);
});

export const auditLog = (line: string) => { console.log(line); };
`;

describe('extractServerFns — basics', () => {
    it('stubs serverFn exports and server-only exports', () => {
        const result = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));

        expect(result.fns).toHaveLength(1);
        const fn = result.fns[0];
        expect(fn.name).toBe('addToCart');
        expect(fn.symbol).toMatch(/^addToCart_fn_[0-9a-f]{8}$/);
        expect(result.serverOnly).toEqual(['auditLog']);
        expect(result.warnings).toHaveLength(0);

        expect(result.stubModule).toContain(
            `import { __serverFnStub, __serverOnly } from '@sigx/server/client';`
        );
        expect(result.stubModule).toContain(
            `export const addToCart = __serverFnStub("${fn.symbol}", "addToCart", "${BASE}", "${fn.stableSymbol}");`
        );
        expect(result.stubModule).toContain(
            `export const auditLog = __serverOnly("auditLog", "src/cart.server.ts");`
        );
        // The server body never appears in the client replacement.
        expect(result.stubModule).not.toContain('db.cart.add');
    });

    it('mints deterministic symbols that change with the implementation', () => {
        const a = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));
        const b = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(a.fns[0].symbol).toBe(b.fns[0].symbol);

        const edited = CART.replace('db.cart.add(id, qty)', 'db.cart.add(id, qty + 1)');
        const c = extractServerFns(edited, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(c.fns[0].symbol).not.toBe(a.fns[0].symbol);

        // …and with the file path (two files may hold an identical fn).
        const d = extractServerFns(CART, '/src/other.server.ts', opts('src/other.server.ts'));
        expect(d.fns[0].symbol).not.toBe(a.fns[0].symbol);
    });

    // The wire contract, pinned to a LITERAL. A hashed symbol is what an
    // installed client calls, so any change to the seed silently 404s every
    // deployed stub until the client is rebuilt. `serverFnPreset` (#398) mixes
    // the preset's source into the seed for DERIVED functions; this test is
    // the proof that a plain function's seed is untouched by that work — it
    // was written and green BEFORE the preset changes landed.
    it('pins a plain function’s hashed symbol byte-for-byte', () => {
        const result = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(result.fns[0].symbol).toBe('addToCart_fn_5b3c4824');
        expect(result.fns[0].stableSymbol).toBe('src/cart.server.ts/addToCart');
    });

    it('recognizes aliased serverFn imports and export { x } forms', () => {
        const code = `
import { serverFn as fn } from '@sigx/server';
const ping = fn(async (rq) => 'pong');
export { ping };
export { ping as alias };
`;
        const result = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
        expect(result.fns.map((f) => f.name).sort()).toEqual(['alias', 'ping']);
        expect(result.stubModule).toContain('export const ping = __serverFnStub(');
        expect(result.stubModule).toContain('export const alias = __serverFnStub(');
    });

    it('ignores look-alike serverFn from other modules', () => {
        const code = `
import { serverFn } from 'other-lib';
export const nope = serverFn(async () => 1);
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.fns).toHaveLength(0);
        expect(result.serverOnly).toEqual(['nope']);
    });

    it('passes type-only exports through untouched', () => {
        const code = `
import { serverFn } from '@sigx/server';
export interface Cart { items: string[] }
export type CartId = string;
export type { Cart as TheCart };
export const getCart = serverFn(async (rq, id: CartId) => ({ items: [] }));
`;
        const result = extractServerFns(code, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(result.fns.map((f) => f.name)).toEqual(['getCart']);
        expect(result.serverOnly).toHaveLength(0);
        // Type exports erase — none of them appear in the stub module.
        expect(result.stubModule).not.toContain('CartId');
        expect(result.stubModule).not.toContain('TheCart');
        expect(result.stubModule).not.toContain('interface');
    });

    it('warns on re-exports and default-exported serverFn', () => {
        const code = `
import { serverFn } from '@sigx/server';
export { helper } from './helpers';
export * from './more';
export default serverFn(async (rq) => 1);
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.fns).toHaveLength(0);
        expect(result.warnings).toHaveLength(3);
        expect(result.warnings[0]).toContain('re-export');
        expect(result.warnings[1]).toContain('export *');
        expect(result.warnings[2]).toContain('named export');
        expect(result.stubModule).toContain('export default __serverOnly("default"');
    });

    it('treats `export { x as default }` like an export default', () => {
        const code = `
import { serverFn } from '@sigx/server';
const ping = serverFn(async (rq) => 'pong');
export { ping as default };
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.fns).toHaveLength(0);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('named export');
        expect(result.stubModule).toContain('export default __serverOnly("default"');
    });

    it('emits an empty module for a server file with no exports', () => {
        const result = extractServerFns(
            `const secret = 'x';`,
            '/src/x.server.ts',
            opts('src/x.server.ts')
        );
        expect(result.stubModule).toBe('export {};');
    });
});

describe('extractServerFns — cache-marked reads (rfc-server §4.1, #354)', () => {
    const READ = `
import { serverFn } from '@sigx/server';
export const getProduct = serverFn({
    cache: { maxAge: 60 },
    handler: async (rq, input) => input
});
export const addToCart = serverFn(async (rq, id) => id);
`;

    it('stamps the GET flag on cache-marked fns only', () => {
        const result = extractServerFns(READ, '/src/api.server.ts', opts('src/api.server.ts'));
        const byName = Object.fromEntries(result.fns.map((f) => [f.name, f]));
        expect(byName.getProduct.get).toBe(true);
        expect(byName.addToCart.get).toBe(false);
        expect(result.stubModule).toContain(
            `export const getProduct = __serverFnStub("${byName.getProduct.symbol}", "getProduct", "${BASE}", "${byName.getProduct.stableSymbol}", 1);`
        );
        expect(result.stubModule).toContain(
            `export const addToCart = __serverFnStub("${byName.addToCart.symbol}", "addToCart", "${BASE}", "${byName.addToCart.stableSymbol}");`
        );
    });

    it('detects a computed cache VALUE (presence-only, unlike id)', () => {
        const code = `
import { serverFn } from '@sigx/server';
import { policy } from './policy';
export const read = serverFn({ cache: policy(), handler: async (rq) => 1 });
`;
        const result = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
        expect(result.fns[0].get).toBe(true);
        expect(result.warnings).toHaveLength(0);
    });

    it('toggling cache re-mints the symbol (version-skew safety)', () => {
        const marked = extractServerFns(READ, '/src/api.server.ts', opts('src/api.server.ts'));
        const unmarked = extractServerFns(
            READ.replace('cache: { maxAge: 60 },\n', ''),
            '/src/api.server.ts',
            opts('src/api.server.ts')
        );
        const a = marked.fns.find((f) => f.name === 'getProduct')!;
        const b = unmarked.fns.find((f) => f.name === 'getProduct')!;
        expect(a.symbol).not.toBe(b.symbol);
    });

    it('survives export { x } indirection', () => {
        const code = `
import { serverFn } from '@sigx/server';
const read = serverFn({ cache: { maxAge: 30 }, handler: async (rq) => 1 });
export { read };
`;
        const result = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
        expect(result.fns[0].get).toBe(true);
        expect(result.stubModule).toContain(', 1);');
    });
});

describe('extractServerFns — invalidates-declaring mutations (rfc-server §6.2/§6.3, #452)', () => {
    it('stamps the sidecar flag (6th positional) on declaring fns only', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const track = serverFn({
    handler: async (rq, input) => input,
    invalidates: () => [['tracker']]
});
export const plain = serverFn(async (rq, id) => id);
`;
        const result = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
        const byName = Object.fromEntries(result.fns.map((f) => [f.name, f]));
        expect(byName.track.invalidates).toBe(true);
        expect(byName.plain.invalidates).toBe(false);
        expect(result.stubModule).toContain(
            `export const track = __serverFnStub("${byName.track.symbol}", "track", "${BASE}", "${byName.track.stableSymbol}", 0, 1);`
        );
        expect(result.stubModule).toContain(
            `export const plain = __serverFnStub("${byName.plain.symbol}", "plain", "${BASE}", "${byName.plain.stableSymbol}");`
        );
    });

    it('emits both flags when cache and invalidates coexist (dev-warned at runtime)', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const odd = serverFn({ cache: { maxAge: 5 }, invalidates: () => ['x'], handler: async (rq) => 1 });
`;
        const result = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
        expect(result.stubModule).toContain(', 1, 1);');
    });

    it('toggling invalidates re-mints the symbol (version-skew safety)', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const track = serverFn({
    handler: async (rq, input) => input,
    invalidates: () => [['tracker']]
});
`;
        const marked = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
        const unmarked = extractServerFns(
            code.replace("    invalidates: () => [['tracker']]\n", ''),
            '/src/api.server.ts',
            opts('src/api.server.ts')
        );
        expect(marked.fns[0].symbol).not.toBe(unmarked.fns[0].symbol);
    });
});

describe('extractServerFns — serverStream (#310)', () => {
    const STREAMY = `
import { serverFn, serverStream } from '@sigx/server';
import { db } from './db';

export const addToCart = serverFn(async (rq, id: string) => db.cart.add(id));
export const explain = serverStream(async function* (rq, id: string) {
    yield* db.explain(id);
});
`;

    it('extracts serverStream exports with the stream flag and stream stub', () => {
        const result = extractServerFns(STREAMY, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(result.fns.map((f) => [f.name, f.stream])).toEqual([
            ['addToCart', false],
            ['explain', true]
        ]);
        expect(result.fns[1].symbol).toMatch(/^explain_fn_[0-9a-f]{8}$/);
        expect(result.fns[1].stableSymbol).toBe('src/cart.server.ts/explain');
        // Mixed module imports BOTH stub factories, each used for its kind.
        expect(result.stubModule).toContain(
            `import { __serverFnStub, __serverStreamStub } from '@sigx/server/client';`
        );
        expect(result.stubModule).toMatch(
            /export const explain = __serverStreamStub\("explain_fn_[0-9a-f]{8}", "explain", "\/_sigx\/fn"\);/
        );
        expect(result.stubModule).not.toContain('db.explain');
    });

    it('a stream-only module imports only the stream stub', () => {
        const code = `
import { serverStream } from '@sigx/server';
export const ticks = serverStream(async function* () { yield 1; });
`;
        const result = extractServerFns(code, '/src/t.server.ts', opts('src/t.server.ts'));
        expect(result.stubModule).toContain(
            `import { __serverStreamStub } from '@sigx/server/client';`
        );
        expect(result.stubModule).not.toContain('__serverFnStub(');
    });

    it('namespace imports extract in the file form too (srv.serverFn / srv.serverStream)', () => {
        const code = `
import * as srv from '@sigx/server';
export const ping = srv.serverFn(async (rq) => 'pong');
export const ticks = srv.serverStream(async function* () { yield 1; });
`;
        const result = extractServerFns(code, '/src/ns.server.ts', opts('src/ns.server.ts'));
        expect(result.fns.map((f) => [f.name, f.stream])).toEqual([
            ['ping', false],
            ['ticks', true]
        ]);
        expect(result.serverOnly).toHaveLength(0);
    });

    it('aliased serverStream imports are recognized; look-alikes are not', () => {
        const aliased = `
import { serverStream as stream } from '@sigx/server';
export const ticks = stream(async function* () { yield 1; });
`;
        expect(
            extractServerFns(aliased, '/src/a.server.ts', opts('src/a.server.ts')).fns[0].stream
        ).toBe(true);
        const lookAlike = `
import { serverStream } from 'other-lib';
export const nope = serverStream(async function* () { yield 1; });
`;
        const result = extractServerFns(lookAlike, '/src/b.server.ts', opts('src/b.server.ts'));
        expect(result.fns).toHaveLength(0);
        expect(result.serverOnly).toEqual(['nope']);
    });
});

describe('extractServerFns — rev 2 (stable ids, stable symbols, endpoint)', () => {
    it('mints identical symbols for the same stableId regardless of build root', () => {
        // Two app builds of one solution see the same shared module under
        // different absolute paths but the SAME package-qualified stable id.
        const a = extractServerFns(CART, '/appA/node_modules/@acme/api/src/cart.server.ts',
            opts('@acme/api/src/cart.server.ts'));
        const b = extractServerFns(CART, '/appB/packages/api/src/cart.server.ts',
            opts('@acme/api/src/cart.server.ts'));
        expect(a.fns[0].symbol).toBe(b.fns[0].symbol);
        expect(a.fns[0].stableSymbol).toBe(b.fns[0].stableSymbol);
        // …and a different stable id changes both.
        const c = extractServerFns(CART, '/appA/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(c.fns[0].symbol).not.toBe(a.fns[0].symbol);
    });

    it('shapes the stable symbol as <stableId>/<name> (decoded form)', () => {
        const result = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts'));
        expect(result.fns[0].stableSymbol).toBe('@acme/api/src/cart.server.ts/addToCart');
    });

    it('an explicit string-literal `id` replaces the stableId in BOTH symbols', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const add = serverFn({ id: 'cart/add', handler: async (rq, input) => input });
`;
        const here = extractServerFns(code, '/a/x.server.ts', opts('@acme/api/src/x.server.ts'));
        const moved = extractServerFns(code, '/b/y.server.ts', opts('@acme/api/lib/y.server.ts'));
        expect(here.fns[0].stableSymbol).toBe('cart/add/add');
        // File moves don't touch an id'd function's routes — hashed included.
        expect(moved.fns[0].symbol).toBe(here.fns[0].symbol);
        expect(moved.fns[0].stableSymbol).toBe(here.fns[0].stableSymbol);
        expect(here.warnings).toHaveLength(0);
    });

    it('normalizes a stable id into something a URL PATH can carry (#355)', () => {
        // The build-root-relative fallback emits `../` for out-of-root files.
        // Left alone, `new URL()` would resolve those away and the route
        // would silently point somewhere else.
        const up = extractServerFns(CART, '/x.ts', opts('../shared/src/cart.server.ts'));
        expect(up.fns[0].stableSymbol).toBe('_up/shared/src/cart.server.ts/addToCart');

        // A scoped package name survives literally — that is the whole point.
        const scoped = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts'));
        expect(scoped.fns[0].stableSymbol).not.toContain('%');

        // Anything outside `pchar` still escapes, per segment.
        const odd = extractServerFns(CART, '/x.ts', opts('a b/c?d/cart.server.ts'));
        expect(odd.fns[0].stableSymbol).toBe('a%20b/c%3Fd/cart.server.ts/addToCart');

        // Empty segments collapse rather than becoming `//` in the path.
        const empty = extractServerFns(CART, '/x.ts', opts('pkg//src/cart.server.ts'));
        expect(empty.fns[0].stableSymbol).toBe('pkg/src/cart.server.ts/addToCart');
    });

    it('warns when an explicit `id` is not URL-path-safe, naming the route it gets', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const add = serverFn({ id: 'cart/../add item', handler: async (rq, input) => input });
`;
        const result = extractServerFns(code, '/x.server.ts', opts('src/x.server.ts'));
        expect(result.fns[0].stableSymbol).toBe('cart/_up/add%20item/add');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('not URL-path-safe');
        expect(result.warnings[0]).toContain('cart/_up/add%20item');
    });

    it('warns on a non-literal `id` and falls back to the file-derived stable id', () => {
        const code = `
import { serverFn } from '@sigx/server';
const routeId = 'cart/add';
export const add = serverFn({ id: routeId, handler: async (rq, input) => input });
`;
        const result = extractServerFns(code, '/x.server.ts', opts('src/x.server.ts'));
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('string literal');
        expect(result.fns[0].stableSymbol).toBe('src/x.server.ts/add');
    });

    it("stubSymbols: 'stable' bakes stable symbols and `endpoint` bakes the fetch target", () => {
        const result = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts', {
            stubSymbols: 'stable',
            endpoint: 'https://api.example.com/_sigx/fn'
        }));
        expect(result.stubModule).toContain(
            `export const addToCart = __serverFnStub("@acme/api/src/cart.server.ts/addToCart", ` +
            `"addToCart", "https://api.example.com/_sigx/fn", ` +
            `"@acme/api/src/cart.server.ts/addToCart");`
        );
        // Hashed mode (the default) keeps the hashed symbol in stubs.
        const hashed = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts'));
        expect(hashed.stubModule).toContain(`__serverFnStub("${hashed.fns[0].symbol}"`);
    });
});

describe('extractServerFns — form targets (rfc-server §6.4, #312)', () => {
    const FORMS = `
import { serverFn } from '@sigx/server';
export const submitFeedback = serverFn({
    form: true,
    handler: async (rq, input) => input
});
export const addToCart = serverFn(async (rq, id) => id);
`;

    it('marks literal form: true fns only; stub output carries NO extra flag', () => {
        const result = extractServerFns(FORMS, '/src/api.server.ts', opts('src/api.server.ts'));
        const byName = Object.fromEntries(result.fns.map((f) => [f.name, f]));
        expect(byName.submitFeedback.form).toBe(true);
        expect(byName.addToCart.form).toBe(false);
        // The form bit is build/runtime-side only — stubs are plain RPC.
        expect(result.stubModule).toContain(
            `export const submitFeedback = __serverFnStub("${byName.submitFeedback.symbol}", "submitFeedback", "${BASE}", "${byName.submitFeedback.stableSymbol}");`
        );
    });

    it('requires the LITERAL true — false, computed, and truthy strings do not mark', () => {
        for (const value of ['false', 'FORM_ON', '"true"', '1']) {
            const code = `
import { serverFn } from '@sigx/server';
const FORM_ON = true;
export const f = serverFn({ form: ${value}, handler: async (rq) => 1 });
`;
            const result = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
            expect(result.fns[0].form).toBe(false);
        }
    });

    it('survives export { x } indirection', () => {
        const code = `
import { serverFn } from '@sigx/server';
const submit = serverFn({ form: true, handler: async (rq) => 1 });
export { submit };
`;
        const result = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
        expect(result.fns[0].form).toBe(true);
    });
});

describe('serverFnKeyStamps — SSR-side __sigxKey stamps (#452)', () => {
    it('stamps each extracted fn LOCAL with its stable symbol, marker-guarded', () => {
        const result = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));
        const stamps = serverFnKeyStamps(result.fns);
        expect(stamps).toContain(KEY_STAMP_MARKER);
        expect(stamps).toContain('addToCart.__sigxKey = "src/cart.server.ts/addToCart";');
    });

    it('aliased exports stamp the LOCAL binding; first export wins per local', () => {
        const code = `
import { serverFn } from '@sigx/server';
const impl = serverFn(async (rq) => 1);
export { impl as ping, impl as alias };
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        const stamps = serverFnKeyStamps(result.fns);
        expect(stamps).toContain('impl.__sigxKey = "src/x.server.ts/ping";');
        expect(stamps).not.toContain('#alias');
    });

    it('an explicit id flows into the stamp, matching the stub key', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const add = serverFn({ id: 'cart/add', handler: async (rq, input) => input });
`;
        const result = extractServerFns(code, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(serverFnKeyStamps(result.fns)).toContain('add.__sigxKey = "cart/add/add";');
        expect(result.stubModule).toContain('"cart/add/add"');
    });

    it('streams are skipped — no stamp block for a stream-only module', () => {
        const code = `
import { serverStream } from '@sigx/server';
export const ticks = serverStream(async function* (rq) { yield 1; });
`;
        const result = extractServerFns(code, '/src/t.server.ts', opts('src/t.server.ts'));
        expect(serverFnKeyStamps(result.fns)).toBe('');
    });
});

/* ------------------------------------------------------------------ */
/* serverFnPreset (#398)                                              */
/* ------------------------------------------------------------------ */

const PRESET = `
import { serverFn, serverFnPreset } from '@sigx/server';
import { requireUser } from './guards';

const authed = serverFnPreset({ use: [requireUser] });

export const boardIssues = authed({ input: BoardKey, handler: async (rq, k) => k });
export const addTwo = authed(async (rq, sku: string, qty: number) => sku + qty);
export const feed = authed.stream(async function* (rq) { yield 1; });
export const open = serverFn(async () => 'public');
`;

describe('extractServerFns — serverFnPreset', () => {
    it('extracts preset-derived functions exactly like plain ones', () => {
        const result = extractServerFns(PRESET, '/src/board.server.ts', opts('src/board.server.ts'));

        expect(result.fns.map((f) => f.name).sort()).toEqual([
            'addTwo',
            'boardIssues',
            'feed',
            'open'
        ]);
        // The preset local itself is not a server function — it becomes a
        // server-only stub, so the client can never call it.
        expect(result.serverOnly).toEqual([]);
        expect(result.warnings).toEqual([]);

        const feed = result.fns.find((f) => f.name === 'feed');
        expect(feed?.stream).toBe(true);
        expect(result.stubModule).toContain('export const feed = __serverStreamStub(');
        expect(result.stubModule).toContain('export const addTwo = __serverFnStub(');
        // A stream is not a useData target — no stable-key argument.
        expect(serverFnKeyStamps(result.fns)).not.toContain('feed.__sigxKey');
    });

    it('mixes the preset source into the derived seed — and ONLY the derived one', () => {
        const before = extractServerFns(PRESET, '/src/board.server.ts', opts('src/board.server.ts'));
        const edited = PRESET.replace('use: [requireUser]', 'use: [requireUser, rateLimit]');
        const after = extractServerFns(edited, '/src/board.server.ts', opts('src/board.server.ts'));

        const symbolOf = (r: typeof before, name: string): string | undefined =>
            r.fns.find((f) => f.name === name)?.symbol;

        // Editing the shared chain re-mints every function derived from it…
        for (const name of ['boardIssues', 'addTwo', 'feed']) {
            expect(symbolOf(after, name)).not.toBe(symbolOf(before, name));
        }
        // …and nothing else. A plain fn in the same file is untouched.
        expect(symbolOf(after, 'open')).toBe(symbolOf(before, 'open'));
        // Stable symbols never move — an installed client keeps its route.
        for (const fn of before.fns) {
            const twin = after.fns.find((f) => f.name === fn.name);
            expect(twin?.stableSymbol).toBe(fn.stableSymbol);
        }
    });

    it('reads the statically-read options off a derived call site', () => {
        const code = `
import { serverFnPreset } from '@sigx/server';
const authed = serverFnPreset({ use: [] });
export const read = authed({ id: 'board/read', cache: { maxAge: 60 }, handler: async () => 1 });
export const write = authed({ handler: async () => 1, invalidates: () => ['b'] });
export const action = authed({ form: true, input: S, handler: async () => 1 });
`;
        const result = extractServerFns(code, '/src/board.server.ts', opts('src/board.server.ts'));
        const byName = Object.fromEntries(result.fns.map((f) => [f.name, f]));
        expect(byName.read.get).toBe(true);
        expect(byName.read.stableSymbol).toBe('board/read/read');
        expect(byName.write.invalidates).toBe(true);
        expect(byName.action.form).toBe(true);
    });

    it('classifies a preset declared AFTER its uses (the pre-pass)', () => {
        const code = `
import { serverFnPreset } from '@sigx/server';
export const first = authed(async () => 1);
const authed = serverFnPreset({ use: [] });
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.fns.map((f) => f.name)).toEqual(['first']);
    });

    it('recognizes namespace and aliased preset imports', () => {
        const namespaced = `
import * as srv from '@sigx/server';
const authed = srv.serverFnPreset({ use: [] });
export const a = authed(async () => 1);
export const b = authed.stream(async function* () { yield 1; });
`;
        const one = extractServerFns(namespaced, '/src/n.server.ts', opts('src/n.server.ts'));
        expect(one.fns.map((f) => f.name).sort()).toEqual(['a', 'b']);
        expect(one.fns.find((f) => f.name === 'b')?.stream).toBe(true);

        const aliased = `
import { serverFnPreset as guarded } from '@sigx/server';
const authed = guarded({ use: [] });
export const a = authed(async () => 1);
`;
        const two = extractServerFns(aliased, '/src/a.server.ts', opts('src/a.server.ts'));
        expect(two.fns.map((f) => f.name)).toEqual(['a']);
    });

    it('does not treat an arbitrary member call on a preset as a server function', () => {
        const code = `
import { serverFnPreset } from '@sigx/server';
const authed = serverFnPreset({ use: [] });
export const nope = authed.somethingElse(async () => 1);
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.fns).toHaveLength(0);
        expect(result.serverOnly).toEqual(['nope']);
    });

    it('warns when a preset is exported, and stubs it server-only', () => {
        const declaration = `
import { serverFnPreset } from '@sigx/server';
export const authed = serverFnPreset({ use: [] });
`;
        const one = extractServerFns(declaration, '/src/g.server.ts', opts('src/g.server.ts'));
        expect(one.serverOnly).toEqual(['authed']);
        expect(one.warnings).toHaveLength(1);
        expect(one.warnings[0]).toContain('per-MODULE construct');
        expect(one.stubModule).toContain('export const authed = __serverOnly("authed"');

        const specifier = `
import { serverFnPreset } from '@sigx/server';
const authed = serverFnPreset({ use: [] });
export { authed };
`;
        const two = extractServerFns(specifier, '/src/g.server.ts', opts('src/g.server.ts'));
        expect(two.warnings[0]).toContain('per-MODULE construct');

        const asDefault = `
import { serverFnPreset } from '@sigx/server';
export default serverFnPreset({ use: [] });
`;
        const three = extractServerFns(asDefault, '/src/g.server.ts', opts('src/g.server.ts'));
        expect(three.warnings[0]).toContain('per-MODULE construct');
    });
});

describe('extractServerFns — options spread (#398)', () => {
    it('warns that a spread hides the statically-read options, and still extracts', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const read = serverFn({ ...shared, handler: async () => 1 });
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.fns.map((f) => f.name)).toEqual(['read']);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('spread');
        expect(result.warnings[0]).toContain('boundary refresh');
    });

    it('stays quiet on a literal options object and on the direct form', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const a = serverFn({ cache: { maxAge: 1 }, handler: async () => 1 });
export const b = serverFn(async () => 1);
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.warnings).toEqual([]);
    });
});

/* ------------------------------------------------------------------ */
/* requireGuards (#489, rfc-server-v3 §1.4)                            */
/* ------------------------------------------------------------------ */

describe('extractServerFns — requireGuards', () => {
    const BARE = `
import { serverFn, serverStream } from '@sigx/server';
export const read = serverFn(async (rq) => 1);
export const feed = serverStream(async function* (rq) { yield 1; });
`;

    it('is ON by default — a bare serverFn and a bare serverStream both fail', () => {
        const result = extractServerFns(BARE, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.errors).toHaveLength(2);
        for (const error of result.errors) {
            // All three remedies, so the message is actionable on its own.
            expect(error.message).toContain('serverFnPreset');
            expect(error.message).toContain('use: [...]');
            expect(error.message).toContain('unguarded: true');
            expect(error.offset).toBeGreaterThan(0);
        }
        expect(result.errors[0].message).toContain('serverFn "read"');
        expect(result.errors[1].message).toContain('serverStream "feed"');
        // The stub module is still produced: whatever else is wrong, the
        // client must never be handed the real module.
        expect(result.stubModule).toContain('__serverFnStub(');
    });

    it('accepts all three remedies, on both wrappers', () => {
        const code = `
import { serverFn, serverStream, serverFnPreset } from '@sigx/server';
const authed = serverFnPreset({ use: [requireUser] });
export const a = authed(async (rq) => 1);
export const b = authed.stream(async function* (rq) { yield 1; });
export const c = serverFn({ use: [requireUser], handler: async () => 1 });
export const d = serverFn({ unguarded: true, handler: async () => 1 });
export const e = serverStream({ use: [requireUser], handler: async function* () { yield 1; } });
export const f = serverStream({ unguarded: true, handler: async function* () { yield 1; } });
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.errors).toEqual([]);
        expect(result.fns.map((fn) => fn.name).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });

    it("'warn' lists them without failing, and false opts out entirely", () => {
        const warned = extractServerFns(
            BARE,
            '/src/x.server.ts',
            opts('src/x.server.ts', { requireGuards: 'warn' })
        );
        expect(warned.errors).toEqual([]);
        expect(warned.warnings).toHaveLength(2);
        expect(warned.warnings[0]).toContain('declares no guard chain');

        const off = extractServerFns(
            BARE,
            '/src/x.server.ts',
            opts('src/x.server.ts', { requireGuards: false })
        );
        expect(off.errors).toEqual([]);
        expect(off.warnings).toEqual([]);
    });

    it('demands the LITERAL true — a variable does not silence the gate', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const read = serverFn({ unguarded: isPublic, handler: async () => 1 });
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        expect(result.errors).toHaveLength(1);
    });

    it('stamps __sigxGuardChecked on what it checked, streams included', () => {
        const code = `
import { serverFn, serverStream } from '@sigx/server';
export const read = serverFn({ unguarded: true, handler: async () => 1 });
export const feed = serverStream({ unguarded: true, handler: async function* () { yield 1; } });
`;
        const result = extractServerFns(code, '/src/x.server.ts', opts('src/x.server.ts'));
        const stamps = serverFnKeyStamps(result.fns, true);
        expect(stamps).toContain('globalThis.__SIGX_GUARDS_CHECKED__ = true;');
        expect(stamps).toContain('read.__sigxGuardChecked = true;');
        // A stream gets the marker but never a data key.
        expect(stamps).toContain('feed.__sigxGuardChecked = true;');
        expect(stamps).not.toContain('feed.__sigxKey');

        // With the gate off, nothing claims to have been checked — absence is
        // the alarm, so a false "checked" would be the worst outcome.
        expect(serverFnKeyStamps(result.fns)).not.toContain('__sigxGuardChecked');
        expect(serverFnKeyStamps(result.fns)).not.toContain('__SIGX_GUARDS_CHECKED__');
    });
});

describe('extractServerFns — non-callable server-only exports (#565)', () => {
    /** Every export here is provably NOT callable — the stub lies about each. */
    const VALUES = `
import { serverFn } from '@sigx/server';

export const MAX = 10;
export const NAME = 'cart';
export const CONFIG = { retries: 3 };
export const ORDER = ['a', 'b'];
export const GREETING = \`hi\`;
export class Db {}
export const Boxed = class {};

export const addToCart = serverFn(async (rq, id: string) => id);
`;

    /** …and every export here MIGHT be callable, so none may warn. */
    const CALLABLE = `
import { serverFn } from '@sigx/server';
import { imported } from './elsewhere';

export const helper = makeThing();          // a call — could return a function
export const alias = imported;              // an identifier — unknowable here
export const method = obj.thing;            // a member expression — ditto
export const arrow = (x) => x;
export function fn() {}
export const lazy = await getIt();
export let later;
export { imported };

export const addToCart = serverFn(async (rq, id: string) => id);
`;

    it('records literals, object/array literals, templates and classes', () => {
        const result = extractServerFns(VALUES, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(result.serverOnlyValues).toEqual([
            { name: 'MAX', kind: 'value' },
            { name: 'NAME', kind: 'value' },
            { name: 'CONFIG', kind: 'value' },
            { name: 'ORDER', kind: 'value' },
            { name: 'GREETING', kind: 'value' },
            { name: 'Db', kind: 'class' },
            { name: 'Boxed', kind: 'class' }
        ]);
        // The stub still exports them all — the warning is diagnosis, not a
        // behavior change.
        expect(result.serverOnly).toContain('MAX');
        expect(result.serverOnly).toContain('Db');
    });

    it('records NOTHING it cannot prove — a false alarm costs more than a miss', () => {
        const result = extractServerFns(CALLABLE, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(result.serverOnlyValues).toEqual([]);
    });

    it('says nothing about a module whose only exports are server functions', () => {
        const result = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));
        // `auditLog` is an arrow function: honestly stubbed, so no warning.
        expect(result.serverOnlyValues).toEqual([]);
    });
});
