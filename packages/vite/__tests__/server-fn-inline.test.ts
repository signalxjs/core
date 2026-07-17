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

function extract(code: string, file = '/src/Search.tsx') {
    return extractInlineServerFns(code, file, file.slice(1), BASE);
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
