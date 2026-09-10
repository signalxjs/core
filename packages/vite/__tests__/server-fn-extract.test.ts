/**
 * @vitest-environment node
 *
 * extractServerFns() — the analysis half of sigxServer() (rfc-server §3,
 * #305): stub-module generation, the one wire identity (key + version,
 * rfc-server-v5 §1.3/§4.2), server-only stubbing, and type-only
 * pass-through.
 */

import { describe, it, expect } from 'vitest';
import { parseAst } from 'vite';
import {
    extractServerFns,
    mintIdentity,
    normalizeServerFnCall,
    serverFnKeyStamps,
    stubCall,
    KEY_STAMP_MARKER,
    type ServerFnExtractOptions
} from '../src/server-fn-extract';

const HEX8 = /^[0-9a-f]{8}$/;

const BASE = '/_sigx/fn';
// Gate OFF by default: this file's non-gate suites use bare fixtures on
// purpose (extraction mechanics, not access policy). The access gate has its
// own describe below, with its own helper that keeps the true default.
const opts = (stableId: string, extra?: Partial<ServerFnExtractOptions>): ServerFnExtractOptions => ({
    stableId,
    endpoint: BASE,
    requireAuthorization: false,
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
        expect(fn.key).toBe('src/cart.server.ts/addToCart');
        expect(fn.version).toMatch(HEX8);
        expect(result.serverOnly).toEqual(['auditLog']);
        expect(result.warnings).toHaveLength(0);

        expect(result.stubModule).toContain(
            `import { __serverFnStub, __serverOnly } from '@sigx/server/client';`
        );
        expect(result.stubModule).toContain(
            `export const addToCart = __serverFnStub("${fn.key}", "addToCart", "${BASE}", "${fn.version}");`
        );
        expect(result.stubModule).toContain(
            `export const auditLog = __serverOnly("auditLog", "src/cart.server.ts");`
        );
        // The server body never appears in the client replacement.
        expect(result.stubModule).not.toContain('db.cart.add');
    });

    it('mints a deterministic version that changes with the implementation', () => {
        const a = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));
        const b = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(a.fns[0].version).toBe(b.fns[0].version);
        expect(a.fns[0].key).toBe(b.fns[0].key);

        // A semantic edit bumps the version — and ONLY the version: the key
        // is the route, and a body edit must not move the route.
        const edited = CART.replace('db.cart.add(id, qty)', 'db.cart.add(id, qty + 1)');
        const c = extractServerFns(edited, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(c.fns[0].version).not.toBe(a.fns[0].version);
        expect(c.fns[0].key).toBe(a.fns[0].key);

        // …and the file path changes both (two files may hold an identical fn).
        const d = extractServerFns(CART, '/src/other.server.ts', opts('src/other.server.ts'));
        expect(d.fns[0].key).not.toBe(a.fns[0].key);
        expect(d.fns[0].version).not.toBe(a.fns[0].version);
    });

    // The wire contract, pinned to LITERALS. The key is what an installed
    // client calls and the version is what it sends with every call, so any
    // change to either seed silently 409s (version) or 404s (key) every
    // deployed stub until the client is rebuilt. The version literal is the
    // proof that a plain function's seed is exactly `id\0name\0normalizedCall`
    // and nothing else leaks in (rfc-server-v5 §4.2).
    it('pins a plain function’s key and version byte-for-byte', () => {
        const result = extractServerFns(CART, '/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(result.fns[0].key).toBe('src/cart.server.ts/addToCart');
        expect(result.fns[0].version).toBe('83037bb4');
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
            `export const getProduct = __serverFnStub("${byName.getProduct.key}", "getProduct", "${BASE}", "${byName.getProduct.version}", 1);`
        );
        // Flags are omitted entirely when zero.
        expect(result.stubModule).toContain(
            `export const addToCart = __serverFnStub("${byName.addToCart.key}", "addToCart", "${BASE}", "${byName.addToCart.version}");`
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

    it('toggling cache bumps the version but keeps the key (version-skew safety)', () => {
        // A stale client must never GET a function whose server half no
        // longer accepts GET: the endpoint 409s on the version first.
        const marked = extractServerFns(READ, '/src/api.server.ts', opts('src/api.server.ts'));
        const unmarked = extractServerFns(
            READ.replace('cache: { maxAge: 60 },\n', ''),
            '/src/api.server.ts',
            opts('src/api.server.ts')
        );
        const a = marked.fns.find((f) => f.name === 'getProduct')!;
        const b = unmarked.fns.find((f) => f.name === 'getProduct')!;
        expect(a.version).not.toBe(b.version);
        expect(a.key).toBe(b.key);
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
    it('sets the invalidates bit (flags = 2) on declaring fns only', () => {
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
            `export const track = __serverFnStub("${byName.track.key}", "track", "${BASE}", "${byName.track.version}", 2);`
        );
        expect(result.stubModule).toContain(
            `export const plain = __serverFnStub("${byName.plain.key}", "plain", "${BASE}", "${byName.plain.version}");`
        );
    });

    it('ORs both bits (flags = 3) when cache and invalidates coexist (dev-warned at runtime)', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const odd = serverFn({ cache: { maxAge: 5 }, invalidates: () => ['x'], handler: async (rq) => 1 });
`;
        const result = extractServerFns(code, '/src/api.server.ts', opts('src/api.server.ts'));
        expect(result.stubModule).toContain(`"${result.fns[0].version}", 3);`);
    });

    it('toggling invalidates bumps the version but keeps the key (version-skew safety)', () => {
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
        expect(marked.fns[0].version).not.toBe(unmarked.fns[0].version);
        expect(marked.fns[0].key).toBe(unmarked.fns[0].key);
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
        expect(result.fns[1].key).toBe('src/cart.server.ts/explain');
        expect(result.fns[1].version).toMatch(HEX8);
        // Mixed module imports BOTH stub factories, each used for its kind.
        expect(result.stubModule).toContain(
            `import { __serverFnStub, __serverStreamStub } from '@sigx/server/client';`
        );
        // A stream stub carries key, name, endpoint and version — never flags.
        expect(result.stubModule).toContain(
            `export const explain = __serverStreamStub("src/cart.server.ts/explain", "explain", "${BASE}", "${result.fns[1].version}");`
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

describe('extractServerFns — rev 2 (stable ids, keys, endpoint)', () => {
    it('mints an identical key and version for the same stableId regardless of build root', () => {
        // Two app builds of one solution see the same shared module under
        // different absolute paths but the SAME package-qualified stable id.
        const a = extractServerFns(CART, '/appA/node_modules/@acme/api/src/cart.server.ts',
            opts('@acme/api/src/cart.server.ts'));
        const b = extractServerFns(CART, '/appB/packages/api/src/cart.server.ts',
            opts('@acme/api/src/cart.server.ts'));
        expect(a.fns[0].key).toBe(b.fns[0].key);
        expect(a.fns[0].version).toBe(b.fns[0].version);
        // …and a different stable id changes both.
        const c = extractServerFns(CART, '/appA/src/cart.server.ts', opts('src/cart.server.ts'));
        expect(c.fns[0].key).not.toBe(a.fns[0].key);
        expect(c.fns[0].version).not.toBe(a.fns[0].version);
    });

    it('shapes the key as <stableId>/<name> (decoded form)', () => {
        const result = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts'));
        expect(result.fns[0].key).toBe('@acme/api/src/cart.server.ts/addToCart');
    });

    it('an explicit string-literal `id` pins the key and seeds the version', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const add = serverFn({ id: 'cart/add', handler: async ({ input }) => input });
`;
        const here = extractServerFns(code, '/a/x.server.ts', opts('@acme/api/src/x.server.ts'));
        const moved = extractServerFns(code, '/b/y.server.ts', opts('@acme/api/lib/y.server.ts'));
        expect(here.fns[0].key).toBe('cart/add/add');
        // File moves don't touch an id'd function's key — nor its version,
        // since the id replaces the file-derived stable id in the seed too.
        expect(moved.fns[0].key).toBe(here.fns[0].key);
        expect(moved.fns[0].version).toBe(here.fns[0].version);
        expect(here.warnings).toHaveLength(0);

        // The id is part of the version seed: the same handler with no `id`
        // mints a different key AND a different version.
        const bare = extractServerFns(
            code.replace(`id: 'cart/add', `, ''),
            '/a/x.server.ts',
            opts('@acme/api/src/x.server.ts')
        );
        expect(bare.fns[0].key).toBe('@acme/api/src/x.server.ts/add');
        expect(bare.fns[0].version).not.toBe(here.fns[0].version);
    });

    it('normalizes a stable id into something a URL PATH can carry (#355)', () => {
        // The build-root-relative fallback emits `../` for out-of-root files.
        // Left alone, `new URL()` would resolve those away and the route
        // would silently point somewhere else.
        const up = extractServerFns(CART, '/x.ts', opts('../shared/src/cart.server.ts'));
        expect(up.fns[0].key).toBe('_up/shared/src/cart.server.ts/addToCart');

        // A scoped package name survives literally — that is the whole point.
        const scoped = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts'));
        expect(scoped.fns[0].key).not.toContain('%');

        // Anything outside `pchar` still escapes, per segment.
        const odd = extractServerFns(CART, '/x.ts', opts('a b/c?d/cart.server.ts'));
        expect(odd.fns[0].key).toBe('a%20b/c%3Fd/cart.server.ts/addToCart');

        // Empty segments collapse rather than becoming `//` in the path.
        const empty = extractServerFns(CART, '/x.ts', opts('pkg//src/cart.server.ts'));
        expect(empty.fns[0].key).toBe('pkg/src/cart.server.ts/addToCart');
    });

    it('warns when an explicit `id` is not URL-path-safe, naming the route it gets', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const add = serverFn({ id: 'cart/../add item', handler: async (rq, input) => input });
`;
        const result = extractServerFns(code, '/x.server.ts', opts('src/x.server.ts'));
        expect(result.fns[0].key).toBe('cart/_up/add%20item/add');
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
        expect(result.fns[0].key).toBe('src/x.server.ts/add');
    });

    it('`endpoint` bakes the fetch target into the stub; the key is the only route', () => {
        const result = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts', {
            endpoint: 'https://api.example.com/_sigx/fn'
        }));
        expect(result.stubModule).toContain(
            `export const addToCart = __serverFnStub("@acme/api/src/cart.server.ts/addToCart", ` +
            `"addToCart", "https://api.example.com/_sigx/fn", "${result.fns[0].version}");`
        );
    });
});

/* ------------------------------------------------------------------ */
/* The version seed (rfc-server-v5 §4.2)                              */
/* ------------------------------------------------------------------ */

describe('extractServerFns — the version is seeded from the AST, not the text', () => {
    const version = (code: string, stableId = 'src/x.server.ts'): string =>
        extractServerFns(code, '/src/x.server.ts', opts(stableId)).fns[0].version;
    /** The version of a handler that returns one literal, spelled `lit`. */
    const lit = (lit: string): string =>
        version(`import { serverFn } from '@sigx/server';\nexport const f = serverFn({ handler: async () => ${lit} });`);

    it('survives a reformat, added comments, and literal respellings', () => {
        const compact = `
import { serverFn, ServerFnError } from '@sigx/server';
import { db } from './db';
export const addToCart = serverFn(async (rq, id: string, qty: number) => { return db.cart.add(id, qty); });
`;
        const sprawling = `
import { serverFn, ServerFnError } from '@sigx/server';
import { db } from './db';

export const addToCart = serverFn(
    // the cart mutation
    async (rq, id: string, qty: number) => {
        /* one line, many spaces */
        return db.cart.add(
            id,
            qty
        );
    }
);
`;
        expect(version(sprawling)).toBe(version(compact));
        // Both are the pinned CART fixture, semantically.
        expect(version(compact, 'src/cart.server.ts')).toBe('83037bb4');

        // `1` vs `1.0` vs `0x1`, and `'a'` vs `"a"`: the same value, spelled
        // differently — `raw` is not part of the seed.
        expect(lit('1.0')).toBe(lit('1'));
        expect(lit('0x1')).toBe(lit('1'));
        expect(lit('"a"')).toBe(lit("'a'"));
    });

    it('bumps on a handler-body edit, an `input` expression edit, or an added option', () => {
        const base = `
import { serverFn } from '@sigx/server';
import { z } from 'zod';
export const add = serverFn({
    input: z.object({ id: z.string() }),
    handler: async ({ input }) => input.id
});
`;
        const v = version(base);
        expect(v).toMatch(HEX8);
        expect(version(base.replace('=> input.id', '=> input.id.trim()'))).not.toBe(v);
        expect(version(base.replace('z.string()', 'z.number()'))).not.toBe(v);
        expect(version(base.replace('    input:', '    cache: { maxAge: 60 },\n    input:'))).not.toBe(v);
        expect(version(base.replace('    input:', '    authorize: [admin],\n    input:'))).not.toBe(v);
        // Literal VALUES are semantic, whatever their spelling.
        expect(lit('1')).not.toBe(lit('2'));
        expect(lit('"a"')).not.toBe(lit('"b"'));
        expect(lit('`a`')).not.toBe(lit('`b`'));
        expect(lit('/a/g')).not.toBe(lit('/b/g'));
        // BigInt literals hash too (JSON.stringify alone would throw on
        // them), and do not collide with a string of the same digits.
        expect(lit('10n')).toMatch(HEX8);
        expect(lit('10n')).not.toBe(lit('11n'));
        expect(lit('10n')).not.toBe(lit('"10"'));
    });
});

describe('mintIdentity / normalizeServerFnCall / stubCall (the pure primitives)', () => {
    /** The `serverFn(...)` call node of a one-declaration module. */
    const callOf = (code: string): Parameters<typeof normalizeServerFnCall>[0] => {
        const program = parseAst(code, { lang: 'ts' }) as unknown as {
            body: Array<{ declaration: { declarations: Array<{ init: Parameters<typeof normalizeServerFnCall>[0] }> } }>;
        };
        return program.body[1].declaration.declarations[0].init;
    };
    const MOD = `import { serverFn } from '@sigx/server';\nexport const f = serverFn({ handler: async () => 1 });`;

    it('normalizeServerFnCall drops positions and raw spellings, keeps everything semantic', () => {
        const normalized = normalizeServerFnCall(callOf(MOD));
        expect(normalized).not.toMatch(/"(start|end|range|loc|raw)":/);
        expect(normalized).toContain('"type":"CallExpression"');
        expect(normalized).toContain('"name":"serverFn"');
        expect(normalized).toContain('"value":1');
        // Same source, shifted by leading whitespace and a comment: byte-identical.
        expect(normalizeServerFnCall(callOf(`// header\n${MOD.replace('serverFn({', 'serverFn( {')}`))).toBe(normalized);
    });

    it('mintIdentity agrees with extractServerFns, and routeSafe-normalizes the id first', () => {
        const viaExtractor = extractServerFns(MOD, '/x.server.ts', opts('src/x.server.ts')).fns[0];
        const direct = mintIdentity('f', callOf(MOD), undefined, 'src/x.server.ts');
        expect(direct).toEqual({
            name: 'f',
            key: viaExtractor.key,
            version: viaExtractor.version,
            stream: false,
            get: false,
            invalidates: false,
            form: false
        });
        // An explicit id replaces the stable id in BOTH key and seed…
        const withId = mintIdentity('f', callOf(MOD), 'cart/add', 'src/x.server.ts');
        expect(withId.key).toBe('cart/add/f');
        expect(withId.version).not.toBe(direct.version);
        // …and is made route-safe before either is minted, so `cart/../add`
        // and `cart/_up/add` are ONE identity.
        expect(mintIdentity('f', callOf(MOD), 'cart/../add', 'x')).toEqual(
            mintIdentity('f', callOf(MOD), 'cart/_up/add', 'x')
        );
    });

    it('stubCall writes the positional shape, flags only when non-zero, no flags for a stream', () => {
        const fn = mintIdentity('f', callOf(MOD), undefined, 'src/x.server.ts');
        expect(stubCall(fn, BASE)).toBe(
            `__serverFnStub("src/x.server.ts/f", "f", "${BASE}", "${fn.version}")`
        );
        expect(stubCall({ ...fn, get: true }, BASE)).toBe(
            `__serverFnStub("src/x.server.ts/f", "f", "${BASE}", "${fn.version}", 1)`
        );
        expect(stubCall({ ...fn, invalidates: true }, BASE)).toBe(
            `__serverFnStub("src/x.server.ts/f", "f", "${BASE}", "${fn.version}", 2)`
        );
        expect(stubCall({ ...fn, get: true, invalidates: true }, BASE)).toBe(
            `__serverFnStub("src/x.server.ts/f", "f", "${BASE}", "${fn.version}", 3)`
        );
        expect(stubCall({ ...fn, stream: true, get: true, invalidates: true }, BASE)).toBe(
            `__serverStreamStub("src/x.server.ts/f", "f", "${BASE}", "${fn.version}")`
        );
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
            `export const submitFeedback = __serverFnStub("${byName.submitFeedback.key}", "submitFeedback", "${BASE}", "${byName.submitFeedback.version}");`
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
    it('stamps each extracted fn LOCAL with its key, marker-guarded', () => {
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
/* serverFnPreset is GONE (rfc-server-v4 §1.5)                        */
/* ------------------------------------------------------------------ */

describe('extractServerFns — a leftover serverFnPreset module', () => {
    it('degrades to server-only stubs, never to silent extraction', () => {
        // The preset and everything derived from it are no longer server
        // functions to this extractor. The exports become `__serverOnly`
        // throwing stubs — so a client touching them fails LOUDLY — and the
        // SSR module fails at import time (`serverFnPreset` is not an
        // export of @sigx/server anymore). Neither failure is silent, which
        // is what this pin is for.
        const code = `
import { serverFn, serverFnPreset } from '@sigx/server';
const authed = serverFnPreset({ use: [requireUser] });
export const boardIssues = authed({ handler: async (rq) => 1 });
export const feed = authed.stream(async function* (rq) { yield 1; });
export const open = serverFn({ allowAnonymous: true, handler: async () => 'public' });
`;
        const result = extractServerFns(code, '/src/board.server.ts', opts('src/board.server.ts'));
        expect(result.fns.map((f) => f.name)).toEqual(['open']);
        expect(result.serverOnly.sort()).toEqual(['boardIssues', 'feed']);
        expect(result.stubModule).toContain('export const boardIssues = __serverOnly(');
        expect(result.stubModule).toContain('export const feed = __serverOnly(');
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
/* requireAuthorization (#489, rfc-server-v4 §5, renamed in #611)      */
/* ------------------------------------------------------------------ */

describe('extractServerFns — requireAuthorization', () => {
    // No requireAuthorization default here, unlike the file-wide `opts`:
    // this suite is ABOUT the gate, and "on by default" must stay honest.
    const gateOpts = (extra?: Partial<ServerFnExtractOptions>): ServerFnExtractOptions => ({
        stableId: 'src/x.server.ts',
        endpoint: BASE,
        ...extra
    });
    const BARE = `
import { serverFn, serverStream } from '@sigx/server';
export const read = serverFn(async (rq) => 1);
export const feed = serverStream(async function* (rq) { yield 1; });
`;

    it('is ON by default — a bare serverFn and a bare serverStream both fail, naming every remedy', () => {
        const result = extractServerFns(BARE, '/src/x.server.ts', gateOpts());
        expect(result.errors).toHaveLength(2);
        for (const error of result.errors) {
            // Every remedy, so the message is actionable on its own.
            expect(error.message).toContain('has no decided access policy');
            expect(error.message).toContain('authorize: [...]');
            expect(error.message).toContain('allowAnonymous: true');
            expect(error.message).toContain('serverApp');
            expect(error.message).toContain('requireAuthorization: false');
            expect(error.offset).toBeGreaterThan(0);
        }
        expect(result.errors[0].message).toContain('serverFn "read"');
        expect(result.errors[1].message).toContain('serverStream "feed"');
        // The stub module is still produced: whatever else is wrong, the
        // client must never be handed the real module.
        expect(result.stubModule).toContain('__serverFnStub(');
    });

    it('accepts the v4 declarations — authorize presence and the allowAnonymous literal, on both wrappers', () => {
        const code = `
import { serverFn, serverStream } from '@sigx/server';
export const a = serverFn({ authorize: [adminOnly], handler: async () => 1 });
export const b = serverFn({ allowAnonymous: true, handler: async () => 1 });
export const c = serverStream({ authorize: adminOnly, handler: async function* () { yield 1; } });
export const d = serverStream({ allowAnonymous: true, handler: async function* () { yield 1; } });
`;
        const result = extractServerFns(code, '/src/x.server.ts', gateOpts());
        expect(result.errors).toEqual([]);
        expect(result.fns.map((fn) => fn.name).sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('passes a bare fn when a serverApp is configured — the app default decides it (§5, third rung)', () => {
        const withApp = extractServerFns(
            BARE,
            '/src/x.server.ts',
            gateOpts({ hasServerApp: true })
        );
        expect(withApp.errors).toEqual([]);
        expect(withApp.warnings).toEqual([]);
        expect(withApp.fns.map((fn) => fn.name).sort()).toEqual(['feed', 'read']);
        // 'warn' with an app configured has nothing to warn about either.
        const warned = extractServerFns(
            BARE,
            '/src/x.server.ts',
            gateOpts({ requireAuthorization: 'warn', hasServerApp: true })
        );
        expect(warned.warnings).toEqual([]);
    });

    it('reads a string-literal allowAnonymous key, and never a computed one', () => {
        // The reader accepts both key spellings (`allowAnonymous:` and
        // `'allowAnonymous':`) like every other static option, and a
        // computed key is invisible by design — a name assembled at runtime
        // cannot satisfy a statically-read security declaration.
        const quoted = `
import { serverFn } from '@sigx/server';
export const a = serverFn({ 'allowAnonymous': true, handler: async () => 1 });
`;
        expect(extractServerFns(quoted, '/src/x.server.ts', gateOpts()).errors).toEqual([]);
        const computed = `
import { serverFn } from '@sigx/server';
const key = 'allowAnonymous';
export const a = serverFn({ [key]: true, handler: async () => 1 });
`;
        const result = extractServerFns(computed, '/src/x.server.ts', gateOpts());
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('has no decided access policy');
    });

    it('the pre-v4 spellings no longer count — `use:`/`unguarded:` fns are undecided (#611)', () => {
        // The transitional acceptance is gone with the runtime that read
        // it: these keys are unknown options now, and unknown options are
        // not access declarations.
        const code = `
import { serverFn, serverStream } from '@sigx/server';
export const c = serverFn({ use: [requireUser], handler: async () => 1 });
export const d = serverFn({ unguarded: true, handler: async () => 1 });
export const e = serverStream({ use: [requireUser], handler: async function* () { yield 1; } });
export const f = serverStream({ unguarded: true, handler: async function* () { yield 1; } });
`;
        const result = extractServerFns(code, '/src/x.server.ts', gateOpts());
        expect(result.errors).toHaveLength(4);
        for (const error of result.errors) {
            expect(error.message).toContain('has no decided access policy');
        }
    });

    it("'warn' lists them without failing, and false opts out entirely", () => {
        const warned = extractServerFns(
            BARE,
            '/src/x.server.ts',
            gateOpts({ requireAuthorization: 'warn' })
        );
        expect(warned.errors).toEqual([]);
        expect(warned.warnings).toHaveLength(2);
        expect(warned.warnings[0]).toContain('has no decided access policy');

        const off = extractServerFns(
            BARE,
            '/src/x.server.ts',
            gateOpts({ requireAuthorization: false })
        );
        expect(off.errors).toEqual([]);
        expect(off.warnings).toEqual([]);
    });

    it('demands the LITERAL true — a variable does not silence the gate', () => {
        const v4 = extractServerFns(
            `
import { serverFn } from '@sigx/server';
export const read = serverFn({ allowAnonymous: isPublic, handler: async () => 1 });
`,
            '/src/x.server.ts',
            gateOpts()
        );
        expect(v4.errors).toHaveLength(1);
    });

    it('the key-stamp block carries ONLY __sigxKey lines — the guard-checked markers are retired', () => {
        // rfc-server-v4 retired `__sigxGuardChecked`/`__SIGX_GUARDS_CHECKED__`:
        // the fail-closed runtime closed the unanalyzed-module gap they
        // mitigated, so an emission here would be dead weight in every SSR
        // module.
        const code = `
import { serverFn, serverStream } from '@sigx/server';
export const read = serverFn({ allowAnonymous: true, handler: async () => 1 });
export const feed = serverStream({ allowAnonymous: true, handler: async function* () { yield 1; } });
`;
        const result = extractServerFns(code, '/src/x.server.ts', gateOpts());
        const stamps = serverFnKeyStamps(result.fns);
        expect(stamps).toContain('read.__sigxKey =');
        // A stream is not a useData target — no key, and nothing else left
        // to stamp for it.
        expect(stamps).not.toContain('feed.');
        expect(stamps).not.toContain('__sigxGuardChecked');
        expect(stamps).not.toContain('__SIGX_GUARDS_CHECKED__');
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
