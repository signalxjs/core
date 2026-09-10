/**
 * @vitest-environment node
 *
 * sigxServer() end-to-end (real vite build, rfc-server §3, #305): the two
 * guarantees the design rests on —
 *
 * 1. CLIENT build: server-module bodies are absent from every output chunk;
 *    resume handler chunks reach server functions through the generated
 *    STUBS (the resume + serverFn composition, zero extractor changes).
 * 2. SSR build: the registry chunk (`sigx-server-fns.js`) is emitted with
 *    key → `{ version, load }` records over the REAL modules (rfc-server-v5
 *    §4.3).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sigxServer } from '../src/server-fn';
import { sigxResume } from '../src/resume';

const SECRET = 'SECRET_SERVER_BODY_dbcall';

describe('sigxServer end-to-end (real vite build)', () => {
    let root: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'sigx-server-fn-e2e-'));
        mkdirSync(join(root, 'src', 'resume'), { recursive: true });
        writeFileSync(join(root, 'index.html'),
            `<!doctype html><html><head></head><body><div id="app"></div>` +
            `<script type="module" src="/src/entry-client.ts"></script></body></html>`);
        writeFileSync(join(root, 'src', 'entry-client.ts'),
            `import 'virtual:sigx-resume/entry';\n` +
            `import { Widget, stamp } from './Widget';\n` +
            `(globalThis as never as Record<string, unknown>).__widget = { Widget, stamp };\n`);
        writeFileSync(join(root, 'src', 'api.server.ts'), `
import { serverFn } from '@sigx/server';

export const addToCart = serverFn({
    allowAnonymous: true,
    handler: async (rq, id: string) => '${SECRET}: ' + id
});
`);
        writeFileSync(join(root, 'src', 'resume', 'Buy.tsx'), `
import { component } from 'sigx';
import { addToCart } from '../api.server';

export const Buy = component<{ sku: string }>((ctx) => {
    const count = ctx.signal(0);
    return () => (
        <button onClick={async () => { count.value = (await addToCart(ctx.props.sku)).length; }}>
            {count.value}
        </button>
    );
});
`);
        // An INLINE serverFn co-located in a plain component file (§1.1(b)).
        writeFileSync(join(root, 'src', 'Widget.tsx'), `
import { component } from 'sigx';
import { serverFn } from '@sigx/server';

export const stamp = serverFn({
    allowAnonymous: true,
    handler: async (rq) => 'INLINE_${SECRET}:' + rq.url.pathname
});

export const Widget = component(() => {
    return () => <button onClick={() => stamp()}>stamp</button>;
});
`);
        writeFileSync(join(root, 'src', 'entry-server.ts'),
            `export { addToCart } from './api.server';\nexport { stamp } from './Widget';\n`);

        // Minimal stubs so the build resolves without the real workspace.
        const stub = (name: string, files: Record<string, string>) => {
            const dir = join(root, 'node_modules', ...name.split('/'));
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, 'package.json'), JSON.stringify({
                name,
                version: '0.0.0',
                type: 'module',
                main: 'index.js',
                exports: Object.fromEntries(
                    Object.keys(files).map((f) => [
                        f === 'index.js' ? '.' : './' + f.replace(/\.js$/, ''),
                        './' + f
                    ])
                )
            }));
            for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
        };
        stub('sigx', {
            'index.js':
                `export const component = (setup) => Object.assign(function C() {}, { __setup: setup });\n` +
                `export const jsx = (type, props) => ({ type, props });\n` +
                `export const jsxs = jsx;\nexport const jsxDEV = jsx;\nexport const Fragment = Symbol('f');\n`,
            'jsx-runtime.js': `export { jsx, jsxs, jsxDEV, Fragment } from './index.js';\n`,
            'jsx-dev-runtime.js': `export { jsx, jsxs, jsxDEV, Fragment } from './index.js';\n`
        });
        stub('@sigx/resume', {
            'index.js': `export {};\n`,
            'client.js':
                `export const __qrls = [];\n` +
                `export function __registerResumeQrl(sym, loader) { __qrls.push(sym); }\n` +
                `export function invoke() {}\nexport function wake() {}\n`,
            'loader.js': `export function initResume(events, r, c) { globalThis.__initArgs = { events }; }\n`
        });
        stub('@sigx/server-renderer', {
            'index.js': `export {};\n`,
            'client.js':
                `export const __chunks = [];\n` +
                `export function registerComponentChunk(name, loader) { __chunks.push(name); }\n`
        });
        // The wrapper carries the `__sigx` descriptor the endpoint reads
        // (kind/invoke/anon/form); the stub factory takes the rfc-server-v5
        // §1.4 positionals: key, name, endpoint, version, flags?.
        stub('@sigx/server', {
            'index.js':
                `export const serverFn = (opts) => Object.assign(` +
                `(...args) => opts.handler({ input: args[0], rq: {} }), ` +
                `{ __sigx: { kind: 'fn', invoke: (rq, args) => opts.handler({ input: args[0], rq }), anon: true, form: false } });\n`,
            'client.js':
                `export function __serverFnStub(key, name, endpoint, version, flags) {\n` +
                `    return async (...args) => { globalThis.__stubCalls = (globalThis.__stubCalls ?? []).concat(key + '@' + version); };\n` +
                `}\n` +
                `export function __serverStreamStub(key, name, endpoint, version) { return async function* () {}; }\n` +
                `export function __serverOnly(name, file) { return () => { throw new Error(name); }; }\n`
        });
    }, 60_000);

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('client build: server bodies absent, resume handlers reach the stub', async () => {
        const { build } = await import('vite');
        await build({
            root,
            logLevel: 'error',
            oxc: { jsx: { runtime: 'automatic', importSource: 'sigx' } },
            build: { manifest: true, outDir: 'dist/client' },
            plugins: [sigxResume(), sigxServer()]
        } as never);

        const outDir = join(root, 'dist/client');
        const chunkFiles: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js')) chunkFiles.push(full);
            }
        };
        walk(outDir);
        expect(chunkFiles.length).toBeGreaterThan(0);

        const allCode = chunkFiles.map((f) => readFileSync(f, 'utf-8'));

        // (a) No server body — file-form OR inline — reaches ANY client chunk.
        for (const code of allCode) {
            expect(code).not.toContain(SECRET);
        }

        // (b) The stubs — keyed by the stable key and carrying this build's
        //     version tag (rfc-server-v5 §1.4) — are in the bundle. Minified
        //     (the minifier picks its own string quotes — backticks today),
        //     so only the string positionals are pinned, quote-agnostically.
        const joined = allCode.join('\n');
        const q = '[`"\']';
        const stubCall = (key: string, name: string): RegExp =>
            new RegExp(
                `${q}${key.replace(/[./]/g, '\\$&')}${q},\\s*${q}${name}${q},\\s*${q}/_sigx/fn${q},\\s*${q}[0-9a-f]{8}${q}`
            );
        expect(joined).toMatch(stubCall('src/api.server.ts/addToCart', 'addToCart'));
        expect(joined).toMatch(stubCall('src/Widget.tsx/stamp', 'stamp')); // inline form
        expect(joined).not.toMatch(/_fn_[0-9a-f]{8}/); // the hashed twin is gone
        expect(joined).toContain('__stubCalls'); // the stub impl was bundled

        // (c) The resume handler chunk reaches addToCart through the stubbed
        //     module — the composition needs NO resume extractor changes.
        const manifest = JSON.parse(
            readFileSync(join(outDir, '.vite', 'sigx-resume-manifest.json'), 'utf-8')
        );
        const symbols = Object.keys(manifest.handlers);
        expect(symbols).toHaveLength(1);
        const handlerCode = readFileSync(
            join(outDir, manifest.handlers[symbols[0]].chunkUrl.slice(1)),
            'utf-8'
        );
        // Minification renames the import binding — the guarantee is the
        // EDGE: the handler chunk imports the (stubbed) api.server chunk.
        expect(handlerCode).toMatch(/api\.server-/);
        expect(handlerCode).not.toContain(SECRET);
    }, 60_000);

    it('SSR build: emits the registry chunk with key → { version, load } records', async () => {
        const { build } = await import('vite');
        await build({
            root,
            logLevel: 'error',
            oxc: { jsx: { runtime: 'automatic', importSource: 'sigx' } },
            build: { ssr: 'src/entry-server.ts', outDir: 'dist/server' },
            plugins: [sigxServer()]
        } as never);

        const registryPath = join(root, 'dist/server', 'sigx-server-fns.js');
        expect(existsSync(registryPath)).toBe(true);
        const registry = readFileSync(registryPath, 'utf-8');
        expect(registry).toContain('serverFns');
        expect(registry).toMatch(
            /\["src\/api\.server\.ts\/addToCart"\]:\s*\{\s*version:\s*"[0-9a-f]{8}",\s*load:/
        );
        // Inline fns resolve through the mangled export of the SAME module.
        expect(registry).toMatch(/\["src\/Widget\.tsx\/stamp"\]:\s*\{\s*version:\s*"[0-9a-f]{8}",\s*load:/);
        expect(registry).toContain('__sigxSrvFn_stamp');
        // One identity per function: no hashed twin registered beside the key.
        expect(registry).not.toMatch(/_fn_[0-9a-f]{8}/);
        // The registry reaches the REAL module (its body, not a stub).
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const full = join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.(js|mjs)$/.test(entry.name)) files.push(full);
            }
        };
        walk(join(root, 'dist/server'));
        const combined = files.map((f) => readFileSync(f, 'utf-8')).join('\n');
        expect(combined).toContain(SECRET);
    }, 60_000);
});

describe('sigxServer end-to-end — rev 2: role:client + shared package (#320)', () => {
    let solution: string;
    const STABLE = '@acme/shared/src/cart.server.ts/addToCart';
    const ENDPOINT = 'https://api.example.com/_sigx/fn';
    /** The stub call the native build bakes: key, name, endpoint, version
     *  (rfc-server-v5 §1.4) — group 1 is the version tag. Quote-agnostic:
     *  a minifier may respell the string literals. */
    const STUB =
        /[`"']@acme\/shared\/src\/cart\.server\.ts\/addToCart[`"'],\s*[`"']addToCart[`"'],\s*[`"']https:\/\/api\.example\.com\/_sigx\/fn[`"'],\s*[`"']([0-9a-f]{8})[`"']/;
    /** The server build's registry record for it — group 1 is the version. */
    const RECORD = /\["@acme\/shared\/src\/cart\.server\.ts\/addToCart"\]:\s*\{\s*version:\s*"([0-9a-f]{8})"/;

    const outputFiles = (dir: string): string[] => {
        const files: string[] = [];
        const walk = (d: string) => {
            for (const entry of readdirSync(d, { withFileTypes: true })) {
                const full = join(d, entry.name);
                if (entry.isDirectory()) walk(full);
                else files.push(full);
            }
        };
        walk(dir);
        return files;
    };

    beforeAll(() => {
        // One solution: a shared server package + a native (terminal-style)
        // app + a server app, both importing the SAME *.server.ts module.
        solution = mkdtempSync(join(tmpdir(), 'sigx-native-e2e-'));
        const write = (rel: string, content: string) => {
            mkdirSync(join(solution, rel, '..'), { recursive: true });
            writeFileSync(join(solution, rel), content);
        };
        write('packages/shared/package.json', JSON.stringify({ name: '@acme/shared' }));
        write('packages/shared/src/cart.server.ts', `
import { serverFn } from '@sigx/server';

export const addToCart = serverFn({
    allowAnonymous: true,
    handler: async (rq, id: string) => '${SECRET}: ' + id
});
`);
        write('apps/native/src/entry.ts',
            `import { addToCart } from '../../../packages/shared/src/cart.server';\n` +
            `export const run = () => addToCart('sku-1');\n`);
        write('apps/server/src/entry-server.ts',
            `export { addToCart } from '../../../packages/shared/src/cart.server';\n`);

        // Minimal @sigx/server at the SOLUTION root — both apps and the
        // shared package resolve it by walk-up.
        const dir = join(solution, 'node_modules', '@sigx', 'server');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({
            name: '@sigx/server',
            version: '0.0.0',
            type: 'module',
            main: 'index.js',
            exports: { '.': './index.js', './client': './client.js' }
        }));
        writeFileSync(join(dir, 'index.js'),
            `export const serverFn = (opts) => Object.assign(` +
            `(...args) => opts.handler({ input: args[0], rq: {} }), ` +
            `{ __sigx: { kind: 'fn', invoke: (rq, args) => opts.handler({ input: args[0], rq }), anon: true, form: false } });\n`);
        writeFileSync(join(dir, 'client.js'),
            `export function __serverFnStub(key, name, endpoint, version, flags) { return async () => key + '@' + version + endpoint; }\n` +
            `export function __serverOnly(name, file) { return () => { throw new Error(name); }; }\n`);
    }, 60_000);

    afterAll(() => {
        rmSync(solution, { recursive: true, force: true });
    });

    it("role:'client' build (ssr-target): stable-key stubs, baked endpoint, no bodies, no registry", async () => {
        const { build } = await import('vite');
        const root = join(solution, 'apps/native');
        await build({
            root,
            logLevel: 'error',
            build: { ssr: 'src/entry.ts', outDir: 'dist' },
            plugins: [sigxServer({
                role: 'client',
                endpoint: ENDPOINT,
                scan: ['../../packages/shared']
            })]
        } as never);

        const files = outputFiles(join(root, 'dist'));
        // No registry chunk — there is no server in this build.
        expect(files.some((f) => f.endsWith('sigx-server-fns.js'))).toBe(false);
        const combined = files
            .filter((f) => /\.(js|mjs)$/.test(f))
            .map((f) => readFileSync(f, 'utf-8'))
            .join('\n');
        // The ssr-named environment STILL got stubs (role:'client'), baked
        // with the stable key, the absolute endpoint and a version tag.
        expect(combined).toContain(STABLE);
        expect(combined).toContain(ENDPOINT);
        expect(combined).toMatch(STUB);
        expect(combined).not.toMatch(/_fn_[0-9a-f]{8}/);
        expect(combined).not.toContain(SECRET);
    }, 60_000);

    it("server app build: the registry carries the SAME key AND version the native build baked (cross-build coherence)", async () => {
        const { build } = await import('vite');
        const root = join(solution, 'apps/server');
        await build({
            root,
            logLevel: 'error',
            build: { ssr: 'src/entry-server.ts', outDir: 'dist' },
            plugins: [sigxServer({ scan: ['../../packages/shared'] })]
        } as never);

        const registryPath = join(root, 'dist', 'sigx-server-fns.js');
        expect(existsSync(registryPath)).toBe(true);
        const registry = readFileSync(registryPath, 'utf-8');
        // The exact stable key the native build baked into its stubs — an
        // installed app keeps working across this backend's redeploys.
        expect(registry).toContain(JSON.stringify(STABLE));
        const record = RECORD.exec(registry);
        if (!record) throw new Error(`no { version, load } record for ${STABLE} in:\n${registry}`);
        // …and the SAME version: two app builds of one solution (different
        // roots) hash the shared definition identically, so the native
        // client is not "skew" to this backend. The native dist is the
        // previous test's output (same describe, in order).
        const native = outputFiles(join(solution, 'apps/native/dist'))
            .filter((f) => /\.(js|mjs)$/.test(f))
            .map((f) => readFileSync(f, 'utf-8'))
            .join('\n');
        const stub = STUB.exec(native);
        if (!stub) throw new Error(`no stub call for ${STABLE} in the native build`);
        expect(record[1]).toBe(stub[1]);
        // No hashed twin registered beside the key.
        expect(registry).not.toMatch(/_fn_[0-9a-f]{8}/);
        // The real body ships in this build.
        const combined = outputFiles(join(root, 'dist'))
            .filter((f) => /\.(js|mjs)$/.test(f))
            .map((f) => readFileSync(f, 'utf-8'))
            .join('\n');
        expect(combined).toContain(SECRET);
    }, 60_000);
});
