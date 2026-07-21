/**
 * @vitest-environment node
 *
 * extractInlineServerFns() — co-located server functions (rfc-server
 * §1.1(b)/§1.2, #305): stub swap + orphaned-import stripping (client),
 * in-place body + mangled exports (SSR), and the imports-only capture rule
 * as hard errors.
 */

import { describe, it, expect } from 'vitest';
import { extractInlineServerFns } from '../src/server-fn-inline';
import type { ServerFnExtractOptions } from '../src/server-fn-extract';

const BASE = '/_sigx/fn';

const SEARCH = `
import { component } from 'sigx';
import { serverFn } from '@sigx/server';
import { searchIndex } from './search-index';

const search = serverFn(async (rq, q: string) => searchIndex.query(q, { limit: 20 }));

export const Search = component((ctx) => {
    const q = ctx.signal('');
    return () => <input onInput={() => search(q.value)} />;
});
`;

function extract(
    code: string,
    file = '/src/Search.tsx',
    extra?: Partial<ServerFnExtractOptions>
) {
    return extractInlineServerFns(code, file, {
        stableId: file.slice(1),
        endpoint: BASE,
        ...extra
    });
}

describe('extractInlineServerFns — happy path', () => {
    it('swaps the initializer for a stub and strips the orphaned import', () => {
        const result = extract(SEARCH);
        expect(result.errors).toHaveLength(0);
        expect(result.fns).toHaveLength(1);
        const fn = result.fns[0];
        expect(fn.name).toBe('search');
        expect(fn.symbol).toMatch(/^search_fn_[0-9a-f]{8}$/);
        expect(fn.mangled).toBe('__sigxSrvFn_search');

        const client = result.clientModule!;
        expect(client).toContain(`import { __serverFnStub } from '@sigx/server/client';`);
        expect(client).toContain(`const search = __serverFnStub("${fn.symbol}", "search", "${BASE}")`);
        // The body and its server-only import are gone from the client.
        expect(client).not.toContain('searchIndex');
        // Still-used imports survive.
        expect(client).toContain(`import { component } from 'sigx';`);
        // The component itself is untouched.
        expect(client).toContain('ctx.signal');
    });

    it('keeps the body in place and appends the mangled export for SSR', () => {
        const result = extract(SEARCH);
        const ssr = result.ssrModule!;
        expect(ssr).toContain('searchIndex.query(q, { limit: 20 })');
        expect(ssr).toContain('export const __sigxSrvFn_search = search;');
        // Untouched otherwise — one module instance, no state split.
        expect(ssr.startsWith(SEARCH)).toBe(true);
    });

    it('symbols are deterministic and content-sensitive', () => {
        const a = extract(SEARCH);
        const b = extract(SEARCH);
        expect(a.fns[0].symbol).toBe(b.fns[0].symbol);
        const edited = SEARCH.replace('{ limit: 20 }', '{ limit: 10 }');
        expect(extract(edited).fns[0].symbol).not.toBe(a.fns[0].symbol);
    });

    it('exported declarations and aliased serverFn imports work', () => {
        const code = `
import { serverFn as fn } from '@sigx/server';
export const ping = fn(async (rq) => 'pong');
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns[0].name).toBe('ping');
        expect(result.clientModule).toContain('export const ping = __serverFnStub(');
        expect(result.ssrModule).toContain('export const __sigxSrvFn_ping = ping;');
    });

    it('globals and value imports are legal captures; strip is partial-aware', () => {
        const code = `
import { serverFn } from '@sigx/server';
import { used, onlyServer } from './utils';

const stamp = serverFn(async (rq) => onlyServer(JSON.stringify({ ua: rq.request.headers.get('user-agent') })));
export const alsoClient = () => used(1);
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        const client = result.clientModule!;
        // Rebuilt statements preserve the original literal verbatim.
        expect(client).toContain(`import { used } from './utils';`);
        expect(client).not.toContain('onlyServer');
    });

    it('keeps imports that are re-exported', () => {
        const code = `
import { serverFn } from '@sigx/server';
import { helper, serverSide } from './utils';

const go = serverFn(async (rq) => serverSide());
export { helper };
export { go };
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        const client = result.clientModule!;
        expect(client).toContain(`import { helper } from './utils';`);
        expect(client).not.toContain('serverSide');
    });

    it('preserves import attributes on rebuilt statements', () => {
        const code = `
import { serverFn } from '@sigx/server';
import config, { serverBits } from './config.js' with { type: 'special' };

const go = serverFn(async (rq) => serverBits());
export const show = () => config;
export { go };
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        const client = result.clientModule!;
        expect(client).toContain(`import config from './config.js' with { type: 'special' };`);
        expect(client).not.toContain('serverBits');
    });

    it('leaves type-only import statements untouched', () => {
        const code = `
import { serverFn } from '@sigx/server';
import type { Config } from './config';
import { serverOnly } from './utils';

const go = serverFn(async (rq) => serverOnly());
export const shape = (c: Config) => c;
export { go };
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        const client = result.clientModule!;
        expect(client).toContain(`import type { Config } from './config';`);
        expect(client).not.toContain('serverOnly');
    });

    it('returns nothing for files without serverFn imports', () => {
        const result = extract(`export const x = 1;`, '/src/x.ts');
        expect(result.fns).toHaveLength(0);
        expect(result.clientModule).toBeNull();
    });
});

describe('extractInlineServerFns — the imports-only rule (hard errors)', () => {
    it('rejects module-scope captures with the pass-as-argument message', () => {
        const code = `
import { serverFn } from '@sigx/server';
const TABLE = { a: 1 };
const look = serverFn(async (rq, k: string) => TABLE[k]);
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "TABLE"');
        expect(result.errors[0].message).toContain('Pass it as an argument');
        expect(result.clientModule).toBeNull();
    });

    it('rejects serverFn created inside a component', () => {
        const code = `
import { component } from 'sigx';
import { serverFn } from '@sigx/server';
export const C = component((ctx) => {
    const save = serverFn(async (rq) => 1);
    return () => <button onClick={() => save()}>x</button>;
});
`;
        const result = extract(code);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope');
        expect(result.errors[0].message).toContain('arguments');
    });

    it('rejects let/var declarations (const only)', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
let mutable = serverFn(async (rq) => 1);
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('const name = serverFn');
    });

    it('rejects JSX inside a server body', () => {
        const code = `
import { serverFn } from '@sigx/server';
const render = serverFn(async (rq) => <div>no</div>);
`;
        const result = extract(code);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('JSX');
    });

    it('rejects type-only imports captured as values', () => {
        const code = `
import { serverFn } from '@sigx/server';
import type { Helper } from './helper';
const bad = serverFn(async (rq) => (Helper as never));
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('type-only import');
    });

    it('rejects captures of enums and named default exports too', () => {
        const viaEnum = extract(`
import { serverFn } from '@sigx/server';
enum Mode { A, B }
const pick = serverFn(async (rq) => Mode.A);
`, '/src/api.ts');
        expect(viaEnum.errors).toHaveLength(1);
        expect(viaEnum.errors[0].message).toContain('module-scope binding "Mode"');

        const viaDefault = extract(`
import { serverFn } from '@sigx/server';
export default function helper() { return 1; }
const use = serverFn(async (rq) => helper());
`, '/src/api.ts');
        expect(viaDefault.errors).toHaveLength(1);
        expect(viaDefault.errors[0].message).toContain('module-scope binding "helper"');
    });

    it('rejects a source binding named __serverFnStub', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const __serverFnStub = 1;
const go = serverFn(async (rq) => 2);
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('reserved by the server-function transform');
        expect(result.errors[0].offset).toBeGreaterThan(0); // points at the binding
    });

    it('rejects mangled-name collisions from imports and exports too', () => {
        const viaImport = extract(`
import { serverFn } from '@sigx/server';
import { __sigxSrvFn_go } from './weird';
const go = serverFn(async (rq) => 1);
`, '/src/api.ts');
        expect(viaImport.errors).toHaveLength(1);
        expect(viaImport.errors[0].message).toContain('collides');

        const viaExport = extract(`
import { serverFn } from '@sigx/server';
const other = 1;
export { other as __sigxSrvFn_go };
const go = serverFn(async (rq) => 1);
`, '/src/api.ts');
        expect(viaExport.errors).toHaveLength(1);
        expect(viaExport.errors[0].message).toContain('collides');
    });

    it('block-scoped lets do not mask module-scope captures used after the block', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const db = { query: () => 1 };
const f = serverFn(async (rq) => {
    { const db = 'local'; void db; }
    return db.query();
});
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "db"');
    });

    it('block-level function declarations are block-scoped (strict mode)', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const helper = 1;
const f = serverFn(async (rq) => {
    { function helper() { return 2; } void helper; }
    return helper;
});
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "helper"');
    });

    it('body-top-level function declarations hoist across the whole body', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const f = serverFn(async (rq) => {
    const early = helper();
    function helper() { return 1; }
    return early;
});
export { f };
`, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns).toHaveLength(1);
    });

    it('var hoisting still binds across blocks', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const f = serverFn(async (rq) => {
    { var v = 1; }
    return v;
});
export { f };
`, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns).toHaveLength(1);
    });

    it('named function expressions do not mask module-scope captures', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const inner = 1;
const f = serverFn(async (rq) => {
    const g = function inner() { return 2; };
    return g() + inner;
});
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "inner"');
    });

    it('shadowed locals do not keep a server-only import alive', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
import { shadowed } from './server-stuff';

const go = serverFn(async (rq) => shadowed());
export const clientSide = () => { const shadowed = 1; return shadowed; };
export { go };
`, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        const client = result.clientModule!;
        expect(client).not.toContain(`'./server-stuff'`);
    });

    it('accepts params, locals, and nested function scopes', () => {
        const code = `
import { serverFn } from '@sigx/server';
const sum = serverFn(async (rq, items: number[]) => {
    const double = (n: number) => n * 2;
    let total = 0;
    for (const item of items) total += double(item);
    return total;
});
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns).toHaveLength(1);
    });

    it('namespace-import call sites extract too', () => {
        const code = `
import * as srv from '@sigx/server';
export const ping = srv.serverFn(async (rq) => 'pong');
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns[0].name).toBe('ping');
    });
});

describe('extractInlineServerFns — cache-marked reads (rfc-server §4.1, #354)', () => {
    it('stamps the GET flag on an inline cache-marked read', () => {
        const code = `
import { component } from 'sigx';
import { serverFn } from '@sigx/server';
import { db } from './db';

const getProduct = serverFn({
    cache: { maxAge: 60 },
    handler: async (rq, input: { id: string }) => db.products.get(input.id)
});

export const Product = component((ctx) => {
    return () => <button onClick={() => getProduct({ id: 'p1' })} />;
});
`;
        const result = extract(code, '/src/Product.tsx');
        expect(result.errors).toHaveLength(0);
        expect(result.fns[0].get).toBe(true);
        expect(result.clientModule).toContain(`, "${BASE}", 1)`);
    });

    it('an unmarked inline fn stays POST (no 4th flag)', () => {
        const result = extract(SEARCH);
        expect(result.fns[0].get).toBe(false);
        expect(result.clientModule).toContain(`, "${BASE}")`);
        expect(result.clientModule).not.toContain(`, "${BASE}", 1)`);
    });
});

describe('extractInlineServerFns — refreshes-declaring mutations (rfc-server §6.3, #313)', () => {
    it('stamps the refreshes flag (5th positional) on an inline declaring fn', () => {
        const code = `
import { component } from 'sigx';
import { serverFn } from '@sigx/server';
import { db } from './db';

const track = serverFn({
    refreshes: ['Tracker'],
    handler: async (rq, input: { id: string }) => db.track(input.id)
});

export const Tracker = component((ctx) => {
    return () => <button onClick={() => track({ id: 'p1' })} />;
});
`;
        const result = extract(code, '/src/Tracker.tsx');
        expect(result.errors).toHaveLength(0);
        expect(result.fns[0].refreshes).toBe(true);
        expect(result.clientModule).toContain(`, "${BASE}", 0, 1)`);
    });
});

describe('extractInlineServerFns — serverStream (#310)', () => {
    it('swaps an inline serverStream for the stream stub and appends the mangled export', () => {
        const code = `
import { serverStream } from '@sigx/server';
import { ticker } from './ticker';

const ticks = serverStream(async function* (rq, id: string) { yield* ticker(id); });
export const use = () => ticks('x');
`;
        const result = extract(code, '/src/Ticks.tsx');
        expect(result.errors).toHaveLength(0);
        expect(result.fns[0]).toMatchObject({ name: 'ticks', stream: true, mangled: '__sigxSrvFn_ticks' });
        expect(result.clientModule).toContain(
            `import { __serverStreamStub } from '@sigx/server/client';`
        );
        expect(result.clientModule).toMatch(/const ticks = __serverStreamStub\("ticks_fn_[0-9a-f]{8}"/);
        expect(result.clientModule).not.toContain('ticker(');
        expect(result.ssrModule).toContain('export const __sigxSrvFn_ticks = ticks;');
    });

    it('the imports-only capture rule applies to stream bodies too', () => {
        const bad = `
import { serverStream } from '@sigx/server';
const SECRETS = ['a'];
export const leak = serverStream(async function* () { yield SECRETS[0]; });
`;
        const result = extract(bad, '/src/Bad.tsx');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "SECRETS"');
    });
});

describe('extractInlineServerFns — rev 2 (stable symbols, id, endpoint)', () => {
    it('mints hashed + stable symbols off the stableId, in parity with the file form', () => {
        const a = extract(SEARCH, '/appA/Search.tsx', { stableId: '@acme/web/src/Search.tsx' });
        const b = extract(SEARCH, '/appB/Search.tsx', { stableId: '@acme/web/src/Search.tsx' });
        expect(a.fns[0].symbol).toBe(b.fns[0].symbol);
        expect(a.fns[0].stableSymbol).toBe('@acme/web/src/Search.tsx#search');
    });

    it('honors an explicit string-literal `id` and warns on a non-literal one', () => {
        const withId = `
import { serverFn } from '@sigx/server';
const search = serverFn({ id: 'search/query', handler: async (rq, q) => q });
export const use = () => search('x');
`;
        const result = extract(withId, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
        expect(result.fns[0].stableSymbol).toBe('search/query#search');

        const dynamic = withId.replace(`'search/query'`, '`search/query`');
        const warned = extract(dynamic, '/src/api.ts');
        expect(warned.warnings).toHaveLength(1);
        expect(warned.warnings[0]).toContain('string literal');
        expect(warned.fns[0].stableSymbol).toBe('src/api.ts#search');
    });

    it("stubSymbols: 'stable' + endpoint bake into the client splice", () => {
        const result = extract(SEARCH, '/src/Search.tsx', {
            stableId: '@acme/web/src/Search.tsx',
            stubSymbols: 'stable',
            endpoint: 'https://api.example.com/_sigx/fn'
        });
        expect(result.clientModule).toContain(
            `__serverFnStub("@acme/web/src/Search.tsx#search", "search", ` +
            `"https://api.example.com/_sigx/fn")`
        );
    });
});
