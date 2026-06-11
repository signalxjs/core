/**
 * Layering guarantee: a client-only app importing the core primitives from
 * sigx carries ZERO bytes of the data layer (useAsync/useStream), head
 * management, or SSR machinery — they tree-shake away entirely.
 *
 * Bundles from SOURCE via esbuild (workspace aliases), with tree-shaking and
 * the packages' `sideEffects` annotations in effect — the same mechanics
 * real bundlers apply to the published packages.
 *
 * The rule being enforced (docs/rfc-use-async.md "Layering"):
 *   runs standalone in a browser → sigx · needs a server → @sigx/server-renderer
 */

import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packages = resolve(__dirname, '../..');

async function bundleClientApp(entrySource: string): Promise<string> {
    const result = await build({
        stdin: {
            contents: entrySource,
            resolveDir: __dirname,
            loader: 'ts'
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'browser',
        treeShaking: true,
        plugins: [{
            // Resolve workspace packages (incl. subpaths like
            // 'sigx/jsx-runtime', '@sigx/runtime-core/foo') to their SOURCE
            // so the test needs no dist build. sideEffects annotations are
            // still read from each package's package.json.
            name: 'sigx-workspace-source',
            setup(b) {
                b.onResolve({ filter: /^(sigx|@sigx\/[\w-]+)(\/.*)?$/ }, args => {
                    const m = /^(?:@sigx\/)?([\w-]+)(?:\/(.*))?$/.exec(args.path)!;
                    const pkg = args.path.startsWith('@sigx/') ? m[1] : 'sigx';
                    const sub = args.path.startsWith('@sigx/')
                        ? args.path.slice(`@sigx/${pkg}`.length + 1)
                        : args.path.slice('sigx'.length + 1);
                    const file = sub ? `${sub}.ts` : 'index.ts';
                    return { path: resolve(packages, pkg, 'src', file) };
                });
            }
        }],
        define: { 'process.env.NODE_ENV': '"production"' },
        logLevel: 'silent'
    });
    return result.outputFiles[0].text;
}

// Marker strings that exist ONLY in the modules they guard
const DATA_LAYER_MARKER = '__SIGX_ASYNC__';            // use-async.ts
const HEAD_MARKER = 'data-sigx-head';                  // use-head.ts
const SSR_MARKER = 'data-async-placeholder';           // @sigx/server-renderer only

describe('client-only bundle layering guarantees', () => {
    it('an app using only component/render/signal ships no data layer, head, or SSR bytes', async () => {
        const output = await bundleClientApp(`
            import { component, render, signal } from 'sigx';
            const App = component((ctx) => {
                const count = ctx.signal(0);
                return () => count.value;
            });
            render((App as any)({}), document.getElementById('app')!);
        `);

        expect(output).not.toContain(DATA_LAYER_MARKER);
        expect(output).not.toContain(HEAD_MARKER);
        expect(output).not.toContain(SSR_MARKER);
    });

    it('opting into useAsync pulls exactly the data layer (positive control)', async () => {
        const output = await bundleClientApp(`
            import { component, render, useAsync } from 'sigx';
            const App = component(() => {
                const data = useAsync('k', async () => 1);
                return () => data.value;
            });
            render((App as any)({}), document.getElementById('app')!);
        `);

        // The guard string is visible when the module is actually included —
        // proves the negative assertions above can't be false greens.
        expect(output).toContain(DATA_LAYER_MARKER);
        // ...and still no server machinery
        expect(output).not.toContain(SSR_MARKER);
    });

    it('opting into useHead pulls exactly the head layer (positive control)', async () => {
        const output = await bundleClientApp(`
            import { component, render, useHead } from 'sigx';
            const App = component(() => {
                useHead({ title: 'x' });
                return () => 'x';
            });
            render((App as any)({}), document.getElementById('app')!);
        `);

        expect(output).toContain(HEAD_MARKER);
        expect(output).not.toContain(DATA_LAYER_MARKER);
        expect(output).not.toContain(SSR_MARKER);
    });
});
