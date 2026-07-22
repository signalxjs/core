/**
 * Platform-neutrality guarantee (issue #189 / docs/rfc-async.md
 * "Renderer-agnostic by construction"): @sigx/runtime-core references no
 * web global unguarded. The bundle must EVALUATE in an environment with no
 * window/document/navigator (embedded runtimes, workers without DOM), and
 * useData must not auto-run fetchers there (the `typeof window` gate on the
 * __SIGX_ASYNC__ pickup and the auto-run).
 */

import { describe, it, expect } from 'vitest';
import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packages = resolve(__dirname, '../..');

async function bundleIife(entrySource: string, { dev = false } = {}): Promise<string> {
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
        define: dev
            ? { 'process.env.NODE_ENV': '"development"', __DEV__: 'true' }
            : { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
        logLevel: 'silent'
    });
    return result.outputFiles[0].text;
}

describe('runtime-core is platform-neutral', () => {
    it('the full runtime-core surface evaluates with NO web globals present', async () => {
        const code = await bundleIife(`
            export * from '@sigx/runtime-core';
        `);

        // A bare realm: console/timers only. No window, document, navigator,
        // AbortController, or fetch — module evaluation must still succeed.
        const sandbox: Record<string, unknown> = {
            console,
            setTimeout,
            clearTimeout,
            queueMicrotask,
        };
        sandbox.globalThis = sandbox;
        const context = vm.createContext(sandbox);

        expect(() => vm.runInContext(code, context)).not.toThrow();
        expect(vm.runInContext('typeof __result.useData', context)).toBe('function');
        expect(vm.runInContext('typeof __result.useAction', context)).toBe('function');
        expect(vm.runInContext('typeof __result.lazy', context)).toBe('function');
    });

    it('useData never auto-runs its fetcher without a window (and survives no AbortController)', async () => {
        const code = await bundleIife(`
            import { useData } from '@sigx/runtime-core';
            import { setCurrentInstance } from '@sigx/runtime-core/internals';

            export function probe(): { ran: boolean; state: string } {
                let ran = false;
                // Minimal setup-context stub: the engine only needs
                // onUnmounted registration and the provider-seam check.
                const ctx: any = { onUnmounted() { } };
                const prev = setCurrentInstance(ctx);
                try {
                    const cell = useData('neutral-key', async () => { ran = true; return 1; });
                    return { ran, state: cell.state };
                } finally {
                    setCurrentInstance(prev);
                }
            }
        `);

        const sandbox: Record<string, unknown> = { console, setTimeout, clearTimeout, queueMicrotask };
        sandbox.globalThis = sandbox;
        const context = vm.createContext(sandbox);
        vm.runInContext(code, context);
        const out = vm.runInContext('__result.probe()', context) as { ran: boolean; state: string };

        // No window ⇒ the guard holds: state parked at pending, fetcher never invoked
        expect(out.ran).toBe(false);
        expect(out.state).toBe('pending');
    });

    it('declareLiveClient() lets useData/useStream auto-run WITHOUT a window (issue #204: lynx/terminal runtimes)', async () => {
        const code = await bundleIife(`
            import { useData, useStream } from '@sigx/runtime-core';
            import { setCurrentInstance, declareLiveClient } from '@sigx/runtime-core/internals';

            export async function probe(): Promise<{ dataRan: boolean; state: string; value: unknown; streamed: string }> {
                declareLiveClient(); // what a non-web platform module does on import
                let dataRan = false;
                const ctx: any = { onUnmounted() { } };
                const prev = setCurrentInstance(ctx);
                let cell: any, stream: any;
                try {
                    cell = useData('live-key', async () => { dataRan = true; return 42; });
                    stream = useStream('live-stream', async function* () { yield 'a'; yield 'b'; });
                } finally {
                    setCurrentInstance(prev);
                }
                // Drain the microtask queue: fetch and stream resolve without timers.
                for (let i = 0; i < 20; i++) await Promise.resolve();
                return { dataRan, state: cell.state, value: cell.value, streamed: stream.value };
            }
        `);

        const sandbox: Record<string, unknown> = { console, setTimeout, clearTimeout, queueMicrotask };
        sandbox.globalThis = sandbox;
        const context = vm.createContext(sandbox);
        vm.runInContext(code, context);
        const out = await (vm.runInContext('__result.probe()', context) as Promise<{
            dataRan: boolean; state: string; value: unknown; streamed: string;
        }>);

        // Declared live client ⇒ both primitives run their sources despite no window
        expect(out.dataRan).toBe(true);
        expect(out.state).toBe('ready');
        expect(out.value).toBe(42);
        expect(out.streamed).toBe('ab');
    });

    it('a declared live client gets NO SSR-fallback warning for an unprovided injectable (issue #404)', async () => {
        // Dev bundle: the warning is __DEV__-gated, so the prod define used by
        // every other case here would strip the thing under test.
        const code = await bundleIife(`
            import { defineInjectable } from '@sigx/runtime-core';
            import { setCurrentInstance, declareLiveClient } from '@sigx/runtime-core/internals';

            const useThing = defineInjectable(() => ({ n: 1 }));
            const useOther = defineInjectable(() => ({ n: 2 }), { name: 'perRequestThing' });

            function inComponent(useFn: () => { n: number }): number {
                const ctx: any = { props: {}, provides: new Map(), parent: null };
                const prev = setCurrentInstance(ctx);
                try {
                    return useFn().n;
                } finally {
                    setCurrentInstance(prev);
                }
            }

            export function probe(): number {
                declareLiveClient(); // what a lynx/terminal platform module does on import
                return inComponent(useThing);
            }

            // Negative control: same realm, same windowless-ness, but NOT a live
            // client — proves the probe above can observe a warning at all.
            export function probeServer(): number {
                declareLiveClient(false);
                return inComponent(useOther);
            }
        `, { dev: true });

        const warnings: unknown[] = [];
        const sandbox: Record<string, unknown> = {
            console: { ...console, warn: (...args: unknown[]) => warnings.push(args[0]) },
            setTimeout, clearTimeout, queueMicrotask,
        };
        sandbox.globalThis = sandbox;
        const context = vm.createContext(sandbox);
        vm.runInContext(code, context);

        // The fallback fires (no provider) inside a component, in a realm with
        // no window — the exact shape that used to warn about SSR leakage on a
        // runtime with no server in the process.
        expect(vm.runInContext('__result.probe()', context)).toBe(1);
        expect(warnings).toEqual([]);

        // …and the warning still reaches a genuine server render, named.
        expect(vm.runInContext('__result.probeServer()', context)).toBe(2);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('perRequestThing');
    });
});
