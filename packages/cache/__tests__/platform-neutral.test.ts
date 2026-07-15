/**
 * Renderer-portability guarantee (issue #205): @sigx/cache depends on
 * @sigx/runtime-core + @sigx/reactivity only — never the `sigx` umbrella
 * (whose platform side effect drags the DOM renderer). The bundle must
 * EVALUATE with no window/document, resolve nothing from @sigx/runtime-dom,
 * and a store-backed read must work on a declared live client (lynx,
 * terminal). Harness mirrors packages/sigx/__tests__/platform-neutral.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packages = resolve(__dirname, '../..');

async function bundleIife(entrySource: string): Promise<string> {
    const result = await build({
        stdin: { contents: entrySource, resolveDir: __dirname, loader: 'ts' },
        bundle: true,
        write: false,
        format: 'iife',
        globalName: '__result',
        platform: 'neutral',
        mainFields: ['module', 'main'],
        treeShaking: true,
        plugins: [{
            name: 'sigx-workspace-source',
            setup(b) {
                // The portability assertion itself: the pack's module graph
                // must never reach the DOM renderer.
                b.onResolve({ filter: /^@sigx\/runtime-dom(\/.*)?$/ }, args => ({
                    errors: [{ text: `@sigx/cache must not depend on the DOM renderer (resolved '${args.path}' from ${args.importer})` }],
                }));
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
        define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
        logLevel: 'silent'
    });
    return result.outputFiles[0].text;
}

describe('@sigx/cache is renderer-portable', () => {
    it('evaluates with NO web globals, resolves nothing from @sigx/runtime-dom, and a cached read works on a declared live client', async () => {
        const code = await bundleIife(`
            import { cachePlugin } from '@sigx/cache';
            import { declareLiveClient, ASYNC_ENGINE_TOKEN, type AsyncEngine } from '@sigx/runtime-core/internals';

            export async function probe(): Promise<{ plugin: string; state: string; value: unknown }> {
                declareLiveClient(); // what a non-web platform module does on import

                // Install on a minimal app-context stub (what app.use provides).
                const appContext = { provides: new Map(), disposables: new Set<() => void>() };
                cachePlugin().install({ _context: appContext } as any);
                const engine = appContext.provides.get(ASYNC_ENGINE_TOKEN) as AsyncEngine;

                const handle = engine.read<number>(async () => 42, { cache: { staleTime: 60_000 } }, {} as any);
                handle.setKey('portable-key', 'portable-key');
                for (let i = 0; i < 20; i++) await Promise.resolve();
                const out = { plugin: typeof cachePlugin, state: handle.state.state, value: handle.state.value };
                handle.dispose();
                return out;
            }
        `);

        const sandbox: Record<string, unknown> = {
            console,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            queueMicrotask,
            Date,
        };
        sandbox.globalThis = sandbox;
        const context = vm.createContext(sandbox);

        expect(() => vm.runInContext(code, context)).not.toThrow();
        const out = await (vm.runInContext('__result.probe()', context) as Promise<{
            plugin: string; state: string; value: unknown;
        }>);

        expect(out.plugin).toBe('function');
        // Declared live client ⇒ the store fetched despite no window
        expect(out.state).toBe('ready');
        expect(out.value).toBe(42);
    });
});
