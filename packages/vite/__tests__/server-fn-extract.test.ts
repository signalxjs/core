/**
 * @vitest-environment node
 *
 * extractServerFns() — the analysis half of sigxServer() (rfc-server §3,
 * #305): stub-module generation, content-hashed symbol determinism,
 * server-only stubbing, and type-only pass-through.
 */

import { describe, it, expect } from 'vitest';
import { extractServerFns, type ServerFnExtractOptions } from '../src/server-fn-extract';

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
            `export const addToCart = __serverFnStub("${fn.symbol}", "addToCart", "${BASE}");`
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

    it('shapes the stable symbol as <stableId>#<name> (decoded form)', () => {
        const result = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts'));
        expect(result.fns[0].stableSymbol).toBe('@acme/api/src/cart.server.ts#addToCart');
    });

    it('an explicit string-literal `id` replaces the stableId in BOTH symbols', () => {
        const code = `
import { serverFn } from '@sigx/server';
export const add = serverFn({ id: 'cart/add', handler: async (rq, input) => input });
`;
        const here = extractServerFns(code, '/a/x.server.ts', opts('@acme/api/src/x.server.ts'));
        const moved = extractServerFns(code, '/b/y.server.ts', opts('@acme/api/lib/y.server.ts'));
        expect(here.fns[0].stableSymbol).toBe('cart/add#add');
        // File moves don't touch an id'd function's routes — hashed included.
        expect(moved.fns[0].symbol).toBe(here.fns[0].symbol);
        expect(moved.fns[0].stableSymbol).toBe(here.fns[0].stableSymbol);
        expect(here.warnings).toHaveLength(0);
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
        expect(result.fns[0].stableSymbol).toBe('src/x.server.ts#add');
    });

    it("stubSymbols: 'stable' bakes stable symbols and `endpoint` bakes the fetch target", () => {
        const result = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts', {
            stubSymbols: 'stable',
            endpoint: 'https://api.example.com/_sigx/fn'
        }));
        expect(result.stubModule).toContain(
            `export const addToCart = __serverFnStub("@acme/api/src/cart.server.ts#addToCart", ` +
            `"addToCart", "https://api.example.com/_sigx/fn");`
        );
        // Hashed mode (the default) keeps the hashed symbol in stubs.
        const hashed = extractServerFns(CART, '/x.ts', opts('@acme/api/src/cart.server.ts'));
        expect(hashed.stubModule).toContain(`__serverFnStub("${hashed.fns[0].symbol}"`);
    });
});
