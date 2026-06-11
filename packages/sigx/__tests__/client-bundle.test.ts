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

async function bundleClientApp(entrySource: string, options: { minifySyntax?: boolean } = {}): Promise<string> {
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
        minifySyntax: options.minifySyntax ?? false,
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
                    // Subpaths whose dist name differs from the source file
                    const SUBPATH_SOURCES: Record<string, string> = {
                        'runtime-dom/platform': 'platform.ts'
                    };
                    const file = SUBPATH_SOURCES[`${pkg}/${sub}`] ?? (sub ? `${sub}.ts` : 'index.ts');
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
const HYDRATION_MARKER = 'client:only';                // hydration/index.ts only

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
        // Hydration utilities (client: directives) are SSR-only — a
        // client-only app must not carry them (issue #75).
        expect(output).not.toContain(HYDRATION_MARKER);
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

describe('production bundle strips dev-only warnings', () => {
    it('a production-define bundle carries no dev warning strings', async () => {
        // minifySyntax models the minify step every production build runs:
        // the define folds the gates to \`if (false)\` and minification
        // removes the dead branches with their warning strings.
        const output = await bundleClientApp(`
            import { component, defineApp, createTopic } from 'sigx';
            const topic = createTopic<number>({ namespace: 'ns', name: 'x' });
            topic.subscribe(() => {});
            const App = component((ctx) => {
                const count = ctx.signal(0);
                return () => count.value;
            });
            const app = defineApp((App as any)({}));
            app.mount(document.getElementById('app')!);
        `, { minifySyntax: true });

        // One marker per module this PR gated: component-lifecycle, app,
        // runtime-dom directives, and messaging.
        expect(output).not.toContain('called outside of component setup');
        expect(output).not.toContain('is already installed');
        expect(output).not.toContain('could not be resolved');
        expect(output).not.toContain('Error in topic subscriber');
    });
});
