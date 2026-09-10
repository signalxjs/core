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
const HEX8 = /^[0-9a-f]{8}$/;

const SEARCH = `
import { component } from 'sigx';
import { serverFn } from '@sigx/server';
import { searchIndex } from './search-index';

const search = serverFn({ handler: async ({ input: q }: { input: string }) => searchIndex.query(q, { limit: 20 }) });

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
        // Extraction mechanics, not the guard gate (#489, default ON) — its
        // own behaviour is covered in its own describe below.
        requireAuthorization: false,
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
        expect(fn.key).toBe('src/Search.tsx/search');
        expect(fn.version).toMatch(HEX8);
        expect(fn.mangled).toBe('__sigxSrvFn_search');

        const client = result.clientModule!;
        expect(client).toContain(`import { __serverFnStub } from '@sigx/server/client';`);
        expect(client).toContain(
            `const search = __serverFnStub("${fn.key}", "search", "${BASE}", "${fn.version}")`
        );
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
        // The SSR wrapper carries the same stable key the stub does (#452).
        expect(ssr).toContain(`search.__sigxKey = "${result.fns[0].key}";`);
        expect(ssr).toContain(`search.__sigxKey = "src/Search.tsx/search";`);
        // Untouched otherwise — one module instance, no state split.
        expect(ssr.startsWith(SEARCH)).toBe(true);
    });

    it('the version is deterministic and content-sensitive; the key is not', () => {
        const a = extract(SEARCH);
        const b = extract(SEARCH);
        expect(a.fns[0].version).toBe(b.fns[0].version);
        const edited = SEARCH.replace('{ limit: 20 }', '{ limit: 10 }');
        expect(extract(edited).fns[0].version).not.toBe(a.fns[0].version);
        expect(extract(edited).fns[0].key).toBe(a.fns[0].key);
    });

    it('the version is seeded from the AST — a reformat with comments keeps it', () => {
        const reformatted = SEARCH.replace(
            'const search = serverFn({ handler: async ({ input: q }: { input: string }) => searchIndex.query(q, { limit: 20 }) });',
            'const search = serverFn(\n    // the index lookup\n    {\n        handler: async ({ input: q }: { input: string }) =>\n            searchIndex.query(q, {\n                limit: 20 /* page size */\n            })\n    }\n);'
        );
        expect(reformatted).not.toBe(SEARCH);
        expect(extract(reformatted).fns[0].version).toBe(extract(SEARCH).fns[0].version);
    });

    it('exported declarations and aliased serverFn imports work', () => {
        const code = `
import { serverFn as fn } from '@sigx/server';
export const ping = fn({ handler: async () => 'pong' });
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

const stamp = serverFn({ handler: async ({ rq }) => onlyServer(JSON.stringify({ ua: rq.request.headers.get('user-agent') })) });
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

const go = serverFn({ handler: async () => serverSide() });
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

const go = serverFn({ handler: async () => serverBits() });
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

const go = serverFn({ handler: async () => serverOnly() });
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
const look = serverFn({ handler: async ({ input: k }: { input: string }) => TABLE[k] });
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
    const save = serverFn({ handler: async () => 1 });
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
let mutable = serverFn({ handler: async () => 1 });
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('const name = serverFn');
    });

    it('rejects JSX inside a server body', () => {
        const code = `
import { serverFn } from '@sigx/server';
const render = serverFn({ handler: async () => <div>no</div> });
`;
        const result = extract(code);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('JSX');
    });

    it('rejects type-only imports captured as values', () => {
        const code = `
import { serverFn } from '@sigx/server';
import type { Helper } from './helper';
const bad = serverFn({ handler: async () => (Helper as never) });
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('type-only import');
    });

    it('rejects captures of enums and named default exports too', () => {
        const viaEnum = extract(`
import { serverFn } from '@sigx/server';
enum Mode { A, B }
const pick = serverFn({ handler: async () => Mode.A });
`, '/src/api.ts');
        expect(viaEnum.errors).toHaveLength(1);
        expect(viaEnum.errors[0].message).toContain('module-scope binding "Mode"');

        const viaDefault = extract(`
import { serverFn } from '@sigx/server';
export default function helper() { return 1; }
const use = serverFn({ handler: async () => helper() });
`, '/src/api.ts');
        expect(viaDefault.errors).toHaveLength(1);
        expect(viaDefault.errors[0].message).toContain('module-scope binding "helper"');
    });

    it('rejects a source binding named __serverFnStub', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const __serverFnStub = 1;
const go = serverFn({ handler: async () => 2 });
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('reserved by the server-function transform');
        expect(result.errors[0].offset).toBeGreaterThan(0); // points at the binding
    });

    it('rejects mangled-name collisions from imports and exports too', () => {
        const viaImport = extract(`
import { serverFn } from '@sigx/server';
import { __sigxSrvFn_go } from './weird';
const go = serverFn({ handler: async () => 1 });
`, '/src/api.ts');
        expect(viaImport.errors).toHaveLength(1);
        expect(viaImport.errors[0].message).toContain('collides');

        const viaExport = extract(`
import { serverFn } from '@sigx/server';
const other = 1;
export { other as __sigxSrvFn_go };
const go = serverFn({ handler: async () => 1 });
`, '/src/api.ts');
        expect(viaExport.errors).toHaveLength(1);
        expect(viaExport.errors[0].message).toContain('collides');
    });

    it('block-scoped lets do not mask module-scope captures used after the block', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const db = { query: () => 1 };
const f = serverFn({ handler: async () => {
    { const db = 'local'; void db; }
    return db.query();
} });
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "db"');
    });

    it('block-level function declarations are block-scoped (strict mode)', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const helper = 1;
const f = serverFn({ handler: async () => {
    { function helper() { return 2; } void helper; }
    return helper;
} });
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "helper"');
    });

    it('body-top-level function declarations hoist across the whole body', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const f = serverFn({ handler: async () => {
    const early = helper();
    function helper() { return 1; }
    return early;
} });
export { f };
`, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns).toHaveLength(1);
    });

    it('var hoisting still binds across blocks', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const f = serverFn({ handler: async () => {
    { var v = 1; }
    return v;
} });
export { f };
`, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns).toHaveLength(1);
    });

    it('named function expressions do not mask module-scope captures', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
const inner = 1;
const f = serverFn({ handler: async () => {
    const g = function inner() { return 2; };
    return g() + inner;
} });
`, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "inner"');
    });

    it('shadowed locals do not keep a server-only import alive', () => {
        const result = extract(`
import { serverFn } from '@sigx/server';
import { shadowed } from './server-stuff';

const go = serverFn({ handler: async () => shadowed() });
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
const sum = serverFn({ handler: async ({ input: items }: { input: number[] }) => {
    const double = (n: number) => n * 2;
    let total = 0;
    for (const item of items) total += double(item);
    return total;
} });
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns).toHaveLength(1);
    });

    it('namespace-import call sites extract too', () => {
        const code = `
import * as srv from '@sigx/server';
export const ping = srv.serverFn({ handler: async () => 'pong' });
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
        expect(result.clientModule).toContain(
            `const getProduct = __serverFnStub("src/Product.tsx/getProduct", "getProduct", "${BASE}", "${result.fns[0].version}", 1)`
        );
    });

    it('an unmarked inline fn stays POST (no flags argument at all)', () => {
        const result = extract(SEARCH);
        expect(result.fns[0].get).toBe(false);
        expect(result.clientModule).toContain(`, "${BASE}", "${result.fns[0].version}")`);
        expect(result.clientModule).not.toContain(`", 1)`);
    });
});

describe('extractInlineServerFns — invalidates-declaring mutations (rfc-server §6.2/§6.3, #452)', () => {
    it('sets the invalidates bit (flags = 2) on an inline declaring fn', () => {
        const code = `
import { component } from 'sigx';
import { serverFn } from '@sigx/server';
import { db } from './db';

const track = serverFn({
    handler: async (rq, input: { id: string }) => db.track(input.id),
    invalidates: () => [['tracker']]
});

export const Tracker = component((ctx) => {
    return () => <button onClick={() => track({ id: 'p1' })} />;
});
`;
        const result = extract(code, '/src/Tracker.tsx');
        expect(result.errors).toHaveLength(0);
        expect(result.fns[0].invalidates).toBe(true);
        expect(result.clientModule).toContain(
            `const track = __serverFnStub("src/Tracker.tsx/track", "track", "${BASE}", "${result.fns[0].version}", 2)`
        );
    });
});

describe('extractInlineServerFns — serverStream (#310)', () => {
    it('swaps an inline serverStream for the stream stub and appends the mangled export', () => {
        const code = `
import { serverStream } from '@sigx/server';
import { ticker } from './ticker';

const ticks = serverStream({ handler: async function* ({ input: id }: { input: string }) { yield* ticker(id); } });
export const use = () => ticks('x');
`;
        const result = extract(code, '/src/Ticks.tsx');
        expect(result.errors).toHaveLength(0);
        expect(result.fns[0]).toMatchObject({ name: 'ticks', stream: true, mangled: '__sigxSrvFn_ticks' });
        expect(result.clientModule).toContain(
            `import { __serverStreamStub } from '@sigx/server/client';`
        );
        // Key, name, endpoint, version — and never a flags argument.
        expect(result.clientModule).toContain(
            `const ticks = __serverStreamStub("src/Ticks.tsx/ticks", "ticks", "${BASE}", "${result.fns[0].version}")`
        );
        expect(result.fns[0].version).toMatch(HEX8);
        expect(result.clientModule).not.toContain('ticker(');
        expect(result.ssrModule).toContain('export const __sigxSrvFn_ticks = ticks;');
    });

    it('the imports-only capture rule applies to stream bodies too', () => {
        const bad = `
import { serverStream } from '@sigx/server';
const SECRETS = ['a'];
export const leak = serverStream({ handler: async function* () { yield SECRETS[0]; } });
`;
        const result = extract(bad, '/src/Bad.tsx');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('module-scope binding "SECRETS"');
    });
});

describe('extractInlineServerFns — rev 2 (keys, id, endpoint)', () => {
    it('mints key + version off the stableId, in parity with the file form', () => {
        const a = extract(SEARCH, '/appA/Search.tsx', { stableId: '@acme/web/src/Search.tsx' });
        const b = extract(SEARCH, '/appB/Search.tsx', { stableId: '@acme/web/src/Search.tsx' });
        expect(a.fns[0].key).toBe('@acme/web/src/Search.tsx/search');
        expect(a.fns[0].version).toMatch(HEX8);
        expect(a.fns[0].key).toBe(b.fns[0].key);
        expect(a.fns[0].version).toBe(b.fns[0].version);
    });

    it('honors an explicit string-literal `id`; a non-literal one is a build error (rfc-server-v5 §1.7)', () => {
        const withId = `
import { serverFn } from '@sigx/server';
const search = serverFn({ id: 'search/query', handler: async (rq, q) => q });
export const use = () => search('x');
`;
        const result = extract(withId, '/src/api.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.warnings).toHaveLength(0);
        expect(result.fns[0].key).toBe('search/query/search');

        // A template literal is not a string literal — no fallback to the
        // file-derived id: an error at the call, and nothing extracted.
        const dynamic = withId.replace(`'search/query'`, '`search/query`');
        const failed = extract(dynamic, '/src/api.ts');
        expect(failed.warnings).toEqual([]);
        expect(failed.errors).toHaveLength(1);
        expect(failed.errors[0].message).toContain('serverFn "search": `id` must be a non-empty string literal');
        expect(failed.errors[0].offset).toBe(dynamic.indexOf('serverFn({'));
        expect(failed.fns).toEqual([]);
        expect(failed.clientModule).toBeNull();
        expect(failed.ssrModule).toBeNull();
    });

    it('an explicit `id` that routeSafeId rewrites is still only a WARNING', () => {
        const code = `
import { serverFn } from '@sigx/server';
const add = serverFn({ id: 'cart/../add item', handler: async (rq, input) => input });
export const use = () => add(1);
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toEqual([]);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('not URL-path-safe');
        expect(result.fns[0].key).toBe('cart/_up/add%20item/add');
        expect(result.clientModule).not.toBeNull();
    });

    it('`endpoint` bakes into the client splice; the key is the only route', () => {
        const result = extract(SEARCH, '/src/Search.tsx', {
            stableId: '@acme/web/src/Search.tsx',
            endpoint: 'https://api.example.com/_sigx/fn'
        });
        expect(result.clientModule).toContain(
            `__serverFnStub("@acme/web/src/Search.tsx/search", "search", ` +
            `"https://api.example.com/_sigx/fn", "${result.fns[0].version}")`
        );
    });
});

describe('extractInlineServerFns — form targets (rfc-server §6.4, #312)', () => {
    it('marks an inline literal form: true fn; stub output unchanged', () => {
        const code = `
import { serverFn } from '@sigx/server';
const submit = serverFn({ form: true, handler: async (rq, input) => input });
export const Widget = () => submit;
`;
        const result = extract(code, '/src/Widget.ts');
        expect(result.errors).toHaveLength(0);
        expect(result.fns[0].form).toBe(true);
        // No extra stub flag for form (only get/invalidates ride the stub).
        expect(result.clientModule).toContain(`"${BASE}", "${result.fns[0].version}")`);
    });

    it('an unmarked inline fn stays form: false', () => {
        const result = extract(SEARCH);
        expect(result.fns[0].form).toBe(false);
    });
});

describe('extractInlineServerFns — a leftover serverFnPreset (rfc-server-v4 §1.5)', () => {
    it('extracts nothing from a preset-only component file — the runtime import failure is the loud signal', () => {
        // `serverFnPreset` no longer exists, so the extractor no longer
        // recognizes (or errors on) it: `authed(...)` is just a call. The
        // module fails at IMPORT time instead (`serverFnPreset` is not an
        // export of @sigx/server anymore) — loud, and named after the thing
        // that was removed.
        const code = `
import { component } from 'sigx';
import { serverFnPreset } from '@sigx/server';

const authed = serverFnPreset({ use: [requireUser] });
const load = authed(async (rq) => 1);

export const Panel = component((ctx) => {
    return () => <button onClick={() => load()} />;
});
`;
        const result = extract(code, '/src/Panel.tsx');
        expect(result.errors).toEqual([]);
        expect(result.fns).toEqual([]);
        expect(result.clientModule).toBeNull();
        expect(result.ssrModule).toBeNull();
    });
});

describe('extractInlineServerFns — options spread (#398, an error since rfc-server-v5 §1.7)', () => {
    it('a spread in the options literal is a build error at the call — nothing is extracted', () => {
        const code = `
import { component } from 'sigx';
import { serverFn } from '@sigx/server';
const load = serverFn({ ...shared, handler: async () => 1 });
export const P = component((ctx) => {
    return () => <button onClick={() => load()} />;
});
`;
        const result = extract(code, '/src/P.tsx');
        expect(result.warnings).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('serverFn "load": a spread (`...`) in the options literal');
        expect(result.errors[0].message).toContain('boundary refresh');
        expect(result.errors[0].offset).toBe(code.indexOf('serverFn({'));
        // Inline errors mean no output in EITHER direction.
        expect(result.fns).toEqual([]);
        expect(result.clientModule).toBeNull();
        expect(result.ssrModule).toBeNull();
    });

    it('a literal options object stays quiet', () => {
        const code = `
import { serverFn } from '@sigx/server';
const load = serverFn({ cache: { maxAge: 1 }, handler: async () => 1 });
export const use = () => load();
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.fns).toHaveLength(1);
    });
});

describe('extractInlineServerFns — literal-true options (`form`, `allowAnonymous`; rfc-server-v5 §1.7)', () => {
    /** One inline declaration + a use, so the file is a real carrier. `flag`
     *  is a VALUE IMPORT — a legal capture, so the imports-only rule (which
     *  runs first) stays out of the way and the literal-true check is what
     *  speaks. */
    const carrier = (decl: string) => `
import { serverFn, serverStream } from '@sigx/server';
import { flag } from './flags';
${decl}
export const use = () => x;
`;

    it('`allowAnonymous: flag` on a serverFn is an error at the call — fns: [], no modules', () => {
        const code = carrier(`const x = serverFn({ allowAnonymous: flag, handler: async () => 1 });`);
        const result = extract(code, '/src/api.ts');
        expect(result.warnings).toEqual([]);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('serverFn "x": `allowAnonymous` must be the LITERAL `true`');
        expect(result.errors[0].message).toContain('not pass the access gate');
        expect(result.errors[0].offset).toBe(code.indexOf('serverFn({'));
        expect(result.fns).toEqual([]);
        expect(result.clientModule).toBeNull();
        expect(result.ssrModule).toBeNull();
    });

    it('`form: flag` on a serverFn is an error at the call', () => {
        const code = carrier(`const x = serverFn({ form: flag, handler: async () => 1 });`);
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('serverFn "x": `form` must be the LITERAL `true`');
        expect(result.errors[0].message).toContain('stamp no form action');
        expect(result.errors[0].offset).toBe(code.indexOf('serverFn({'));
        expect(result.fns).toEqual([]);
        expect(result.clientModule).toBeNull();
    });

    it("a serverStream's `allowAnonymous` is held to the same rule", () => {
        const code = carrier(`const x = serverStream({ allowAnonymous: flag, handler: async function* () { yield 1; } });`);
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('`allowAnonymous` must be the LITERAL `true`');
        expect(result.errors[0].message).toContain('"x"');
        expect(result.errors[0].offset).toBe(code.indexOf('serverStream({'));
        expect(result.fns).toEqual([]);
        expect(result.clientModule).toBeNull();
    });

    it('the literal `true` and an absent key both pass', () => {
        const ok = extract(carrier(`const x = serverFn({ allowAnonymous: true, form: true, handler: async () => 1 });`), '/src/api.ts');
        expect(ok.errors).toEqual([]);
        expect(ok.fns[0].form).toBe(true);
        const absent = extract(carrier(`const x = serverFn({ handler: async () => 1 });`), '/src/api.ts');
        expect(absent.errors).toEqual([]);
        expect(absent.fns[0].form).toBe(false);
    });
});

describe('extractInlineServerFns — the options literal is the only authoring form (rfc-server-v5 §1.1)', () => {
    /** One inline declaration + a use. `opts` and `extra` are VALUE IMPORTS
     *  — legal captures, so the imports-only rule (which runs first) stays
     *  out of the way and the options-literal check is what speaks. */
    const carrier = (decl: string) => `
import { serverFn, serverStream } from '@sigx/server';
import { opts, extra } from './options';
${decl}
export const use = () => x;
`;
    /** The message's fixed head, for the wrapper the call names. */
    const head = (wrapper: string) =>
        `${wrapper} "x": the only authoring form is ${wrapper}({ input?, handler, … })`;
    const cases: Array<[string, 'serverFn' | 'serverStream', string]> = [
        ['the removed direct fn form', 'serverFn', `const x = serverFn(async (rq, id: string) => id);`],
        ['the removed direct stream form', 'serverStream', `const x = serverStream(async function* (rq, n: number) { yield n; });`],
        ['a variable options object', 'serverFn', `const x = serverFn(opts);`],
        ['no argument at all', 'serverFn', `const x = serverFn();`],
        ['a second argument beside the literal', 'serverFn', `const x = serverFn({ handler: async () => 1 }, extra);`]
    ];

    it.each(cases)('%s is ONE error at the call — fns: [], no modules', (_shape, wrapper, decl) => {
        const code = carrier(decl);
        const result = extract(code, '/src/api.ts');
        expect(result.warnings).toEqual([]);
        // Exactly one error — not also the misplaced-call or option-reader
        // errors for the same call site.
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].offset).toBe(code.indexOf(`${wrapper}(`));
        expect(result.errors[0].message).toContain(head(wrapper));
        expect(result.errors[0].message).toContain('ONE object-literal argument');
        expect(result.errors[0].message).toContain('rfc-server-v5 §1.1');
        // Inline errors mean no output in EITHER direction.
        expect(result.fns).toEqual([]);
        expect(result.clientModule).toBeNull();
        expect(result.ssrModule).toBeNull();
    });

    it('stays ONE error with the access gate on — the gate has no literal to read', () => {
        const code = carrier(`const x = serverFn(async () => 1);`);
        const result = extract(code, '/src/api.ts', { requireAuthorization: true });
        expect(result.errors.map((e) => e.message)).toEqual([expect.stringContaining(head('serverFn'))]);
        expect(result.warnings).toEqual([]);
    });

    it('a module-scope options object trips the imports-only rule first — still one error, at the capture', () => {
        // The capture check runs over the whole call before the shape check,
        // so `serverFn(opts)` with a module-scope `opts` is reported as the
        // capture it is. Either way the author is told to write the literal
        // at the call site.
        const code = `
import { serverFn } from '@sigx/server';
const opts = { handler: async () => 1 };
const x = serverFn(opts);
export const use = () => x;
`;
        const result = extract(code, '/src/api.ts');
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].message).toContain('captures module-scope binding "opts"');
        expect(result.errors[0].offset).toBe(code.indexOf('(opts)') + 1);
        expect(result.fns).toEqual([]);
        expect(result.clientModule).toBeNull();
    });
});
