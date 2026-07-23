/**
 * @vitest-environment node
 *
 * The deployment build seam (rfc-deploy §3): `ssr.adapter` config shapes,
 * the role:'client' × adapter conflict, the serve-mode virtual:sigx-app
 * error, buildApp ordering, and the adapter.dev hook.
 */

import { describe, it, expect, vi } from 'vitest';
import { isAbsolute, resolve } from 'node:path';
import { defaultServerConditions } from 'vite';
import { sigxPlugin } from '../src/index';
import { nodeAdapter, type SigxAdapter } from '../src/adapter';

const ENTRY = 'src/entry-server.tsx';

async function buildConfig(adapter?: SigxAdapter) {
    const plugin = sigxPlugin({ ssr: { entry: ENTRY, ...(adapter && { adapter }) } }) as any;
    return plugin.config({}, { command: 'build' });
}

describe('ssr.adapter — config shapes', () => {
    it('default adapter is byte-identical to the pre-adapter ssr environment', async () => {
        const config = await buildConfig();
        expect(config.environments.ssr).toEqual({
            resolve: { external: true },
            build: {
                outDir: 'dist/server',
                rollupOptions: { input: ENTRY }
            }
        });
    });

    it('nodeAdapter() explicitly configured produces the same shape', async () => {
        const config = await buildConfig(nodeAdapter());
        expect(config.environments.ssr).toEqual({
            resolve: { external: true },
            build: { outDir: 'dist/server', rollupOptions: { input: ENTRY } }
        });
    });

    it("bundled: noExternal, replacement conditions without 'node', esnext target", async () => {
        const config = await buildConfig({
            name: 'edge-test',
            serverBuild: 'bundled',
            conditions: ['workerd', 'worker'],
            runtimeExternal: [/^cloudflare:/]
        });
        const ssrEnv = config.environments.ssr;
        expect(ssrEnv.resolve.noExternal).toBe(true);
        expect(ssrEnv.resolve.external).toBeUndefined();
        expect(ssrEnv.resolve.conditions).toEqual([
            'workerd',
            'worker',
            'module',
            'development|production'
        ]);
        expect(ssrEnv.resolve.conditions).not.toContain('node');
        expect(ssrEnv.build.target).toBe('esnext');
        expect(ssrEnv.build.rollupOptions.external).toEqual([/^cloudflare:/]);
        expect(ssrEnv.build.rollupOptions.input).toBe(ENTRY);
    });

    it('bundled: adapter target and entry override the defaults', async () => {
        const config = await buildConfig({
            name: 'edge-test',
            serverBuild: 'bundled',
            target: 'es2023',
            entry: 'src/entry.worker.ts'
        });
        expect(config.environments.ssr.build.target).toBe('es2023');
        expect(config.environments.ssr.build.rollupOptions.input).toBe('src/entry.worker.ts');
    });

    it('external with adapter conditions prepends to the server defaults', async () => {
        const config = await buildConfig({ name: 'bun-ish', serverBuild: 'external', conditions: ['bun'] });
        expect(config.environments.ssr.resolve.external).toBe(true);
        expect(config.environments.ssr.resolve.conditions).toEqual(['bun', ...defaultServerConditions]);
    });
});

describe("role:'client' × ssr.adapter — config-time conflict (rfc-deploy §3.3)", () => {
    function resolvedConfig(role: string | undefined) {
        return {
            command: 'build',
            root: process.cwd(),
            base: '/',
            environments: {},
            plugins: role ? [{ name: 'sigx:server', api: { role, base: '/_sigx/fn', endpoint: '/_sigx/fn' } }] : []
        } as any;
    }

    it("throws when an explicit adapter meets role 'client'", () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY, adapter: nodeAdapter() } }) as any;
        expect(() => plugin.configResolved(resolvedConfig('client'))).toThrow(
            /role 'client'.*no server for an adapter to shape|no registry is emitted/s
        );
    });

    it("passes with role 'auto'", () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY, adapter: nodeAdapter() } }) as any;
        expect(() => plugin.configResolved(resolvedConfig('auto'))).not.toThrow();
    });

    it('passes when the adapter is only the implicit default', () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY } }) as any;
        expect(() => plugin.configResolved(resolvedConfig('client'))).not.toThrow();
    });

    it('passes without the sigx:server plugin at all', () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY, adapter: nodeAdapter() } }) as any;
        expect(() => plugin.configResolved(resolvedConfig(undefined))).not.toThrow();
    });
});

describe('virtual:sigx-app in serve mode', () => {
    it('loads as a throwing module that points at createDevRequestHandler', () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY } }) as any;
        plugin.configResolved({
            command: 'serve',
            root: process.cwd(),
            base: '/',
            environments: {},
            plugins: []
        });
        expect(plugin.resolveId('virtual:sigx-app')).toBe('\0virtual:sigx-app');
        const code = plugin.load.call({ environment: { name: 'ssr' } }, '\0virtual:sigx-app');
        expect(code).toContain('throw new Error');
        expect(code).toContain('createDevRequestHandler');
    });

    it('rejects client-environment imports at build time', () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY } }) as any;
        plugin.configResolved({
            command: 'build',
            root: process.cwd(),
            base: '/',
            environments: {},
            plugins: []
        });
        const error = vi.fn((msg: string) => {
            throw new Error(msg);
        });
        expect(() =>
            plugin.load.call({ environment: { name: 'client' }, error }, '\0virtual:sigx-app')
        ).toThrow(/server-only/);
    });
});

describe('virtual:sigx-manifests (#413)', () => {
    it('serves undefined manifests in dev — packs run manifest-less there', () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY } }) as any;
        plugin.configResolved({
            command: 'serve',
            root: process.cwd(),
            base: '/',
            environments: {},
            plugins: []
        });
        expect(plugin.resolveId('virtual:sigx-manifests')).toBe('\0virtual:sigx-manifests');
        const code = plugin.load.call({ environment: { name: 'ssr' } }, '\0virtual:sigx-manifests');
        expect(code).toContain('export const islandsManifest = undefined');
        expect(code).toContain('export const resumeManifest = undefined');
    });

    it('inlines the pack manifests from the client outDir at build time', async () => {
        const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = mkdtempSync(join(tmpdir(), 'sigx-manifests-'));
        try {
            mkdirSync(join(dir, '.vite'), { recursive: true });
            writeFileSync(
                join(dir, '.vite', 'sigx-islands-manifest.json'),
                JSON.stringify({ version: 2, islands: { Counter: { chunkUrl: '/c.js', exportName: 'Counter' } } })
            );
            const plugin = sigxPlugin({ ssr: { entry: ENTRY } }) as any;
            plugin.configResolved({
                command: 'build',
                root: dir,
                base: '/',
                environments: { client: { build: { outDir: '.' } } },
                plugins: []
            });
            const code = plugin.load.call({ environment: { name: 'ssr' } }, '\0virtual:sigx-manifests');
            expect(code).toContain('"Counter"');
            expect(code).toContain('export const resumeManifest = undefined');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('warns and serves undefineds for client-environment imports at build time', () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY } }) as any;
        plugin.configResolved({
            command: 'build',
            root: process.cwd(),
            base: '/',
            environments: {},
            plugins: []
        });
        const warn = vi.fn();
        const code = plugin.load.call(
            { environment: { name: 'client' }, warn },
            '\0virtual:sigx-manifests'
        );
        expect(warn).toHaveBeenCalled();
        expect(code).toContain('export const islandsManifest = undefined');
    });
});

describe('virtual:sigx-ssr-node (#425)', () => {
    /**
     * The dev handler's renderer sits behind this shim so the project's
     * external/noExternal decision applies to it exactly as it does to the
     * app's own `@sigx/*` imports. A ROOT `ssrLoadModule('@sigx/…')` is always
     * inlined by the runner, which split the graph in two whenever the family
     * was externalized — and app-carried SSR plugins (`app.use(pack())`) then
     * reached a renderer holding different `Symbol()` DI tokens.
     */
    function serveModePlugin() {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY } }) as any;
        plugin.configResolved({
            command: 'serve',
            root: process.cwd(),
            base: '/',
            environments: {},
            plugins: []
        });
        return plugin;
    }

    it('resolves to the \\0-prefixed id', () => {
        expect(serveModePlugin().resolveId('virtual:sigx-ssr-node')).toBe('\0virtual:sigx-ssr-node');
    });

    it('loads as nothing but a re-export of the renderer', () => {
        const code = serveModePlugin().load.call(
            { environment: { name: 'ssr' } },
            '\0virtual:sigx-ssr-node'
        );
        // The whole point is the bare specifier being an IMPORT here: an
        // `export const` copy, or any local work, would defeat it.
        expect(code.trim()).toBe(`export * from '@sigx/server-renderer/node';`);
    });

    it('leaves the un-prefixed id alone in load (nothing else may claim it)', () => {
        const code = serveModePlugin().load.call(
            { environment: { name: 'ssr' } },
            'virtual:sigx-ssr-node'
        );
        expect(code).toBeUndefined();
    });

    it('is server-only — a client-environment import fails loudly', () => {
        // It re-exports a Node entry; emitting the shim into a browser bundle
        // would fail later and further away.
        const error = vi.fn((msg: string) => { throw new Error(msg); });
        expect(() =>
            serveModePlugin().load.call({ environment: { name: 'client' }, error }, '\0virtual:sigx-ssr-node')
        ).toThrow(/server-only/);
    });
});

describe('virtual:sigx-app codegen error surfaces', () => {
    it('treats a CORRUPT optional manifest as a loud, named error — not as absent', async () => {
        const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { generateAppModuleCode } = await import('../src/app-module');
        const dir = mkdtempSync(join(tmpdir(), 'sigx-app-corrupt-'));
        try {
            mkdirSync(join(dir, '.vite'), { recursive: true });
            writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="app"><!--ssr-outlet--></div>');
            writeFileSync(join(dir, '.vite', 'manifest.json'), '{}');
            writeFileSync(join(dir, '.vite', 'sigx-islands-manifest.json'), '{ not json');
            expect(() => generateAppModuleCode(dir, '/')).toThrow(/invalid JSON.*sigx-islands-manifest\.json/s);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('names the ordering contract when index.html or the client manifest is absent', async () => {
        const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { generateAppModuleCode } = await import('../src/app-module');
        const dir = mkdtempSync(join(tmpdir(), 'sigx-app-absent-'));
        try {
            expect(() => generateAppModuleCode(dir, '/')).toThrow(/no index\.html.*build --app/s);
            mkdirSync(join(dir, '.vite'), { recursive: true });
            writeFileSync(join(dir, 'index.html'), '<!doctype html>');
            expect(() => generateAppModuleCode(dir, '/')).toThrow(/no \.vite\/manifest\.json/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('buildApp ordering (rfc-deploy §3.1)', () => {
    function fakeBuilder(generateSpy?: SigxAdapter['generate']) {
        const order: string[] = [];
        const env = (name: string, isBuilt = false) => ({ name, isBuilt });
        const environments: Record<string, { name: string; isBuilt: boolean }> = {
            // Deliberately declared ssr-first: the hook must impose client → ssr.
            ssr: env('ssr'),
            client: env('client'),
            extra: env('extra')
        };
        const builder = {
            environments,
            config: {
                root: process.cwd(),
                logger: { info: vi.fn(), warn: vi.fn() },
                environments: {
                    client: { build: { outDir: 'dist/client' } },
                    ssr: { build: { outDir: 'dist/server' } }
                }
            },
            build: vi.fn(async (e: { name: string; isBuilt: boolean }) => {
                order.push(e.name);
                e.isBuilt = true;
            })
        };
        return { builder, order };
    }

    it('builds client → ssr → remaining environments, then runs adapter.generate with absolute paths', async () => {
        const generate = vi.fn();
        const plugin = sigxPlugin({
            ssr: { entry: ENTRY, adapter: { name: 't', serverBuild: 'external', generate } }
        }) as any;
        const { builder, order } = fakeBuilder();
        await plugin.buildApp(builder);
        expect(order).toEqual(['client', 'ssr', 'extra']);
        expect(generate).toHaveBeenCalledTimes(1);
        const ctx = generate.mock.calls[0][0];
        expect(isAbsolute(ctx.clientOutDir)).toBe(true);
        expect(isAbsolute(ctx.serverOutDir)).toBe(true);
        expect(ctx.clientOutDir).toBe(resolve(process.cwd(), 'dist/client'));
        expect(ctx.serverOutDir).toBe(resolve(process.cwd(), 'dist/server'));
        expect(ctx.ssrInput).toBe(resolve(process.cwd(), ENTRY));
        expect(typeof ctx.logger.info).toBe('function');
    });

    it('runs adapter.setup BEFORE any environment builds (scaffold-iff-absent inputs)', async () => {
        const events: string[] = [];
        const plugin = sigxPlugin({
            ssr: {
                entry: ENTRY,
                adapter: {
                    name: 't',
                    serverBuild: 'external',
                    setup(ctx) {
                        events.push('setup');
                        expect(ctx.ssrEntry).toBe(ENTRY);
                        expect(typeof ctx.root).toBe('string');
                    }
                }
            }
        }) as any;
        const { builder, order } = fakeBuilder();
        const build = builder.build;
        builder.build = vi.fn(async (e: { name: string; isBuilt: boolean }) => {
            events.push('build:' + e.name);
            return build(e);
        });
        await plugin.buildApp(builder);
        expect(events[0]).toBe('setup');
        expect(order).toEqual(['client', 'ssr', 'extra']);
    });

    it('fails with the scaffold contract named when the platform entry is missing', async () => {
        const plugin = sigxPlugin({
            ssr: {
                entry: ENTRY,
                adapter: { name: 't', serverBuild: 'external', entry: 'src/definitely-missing.worker.ts' }
            }
        }) as any;
        const { builder } = fakeBuilder();
        await expect(plugin.buildApp(builder)).rejects.toThrow(/platform entry.*does not exist.*scaffold/s);
    });

    it('skips environments that are already built', async () => {
        const plugin = sigxPlugin({ ssr: { entry: ENTRY } }) as any;
        const { builder, order } = fakeBuilder();
        builder.environments.client.isBuilt = true;
        await plugin.buildApp(builder);
        expect(order).toEqual(['ssr', 'extra']);
    });

    it('is absent without the ssr option', () => {
        const plugin = sigxPlugin() as any;
        expect(plugin.buildApp).toBeUndefined();
    });
});

describe('adapter.dev (rfc-deploy §4.6)', () => {
    it('runs the dev hook against the dev server', async () => {
        const dev = vi.fn();
        const plugin = sigxPlugin({
            ssr: { entry: ENTRY, adapter: { name: 't', serverBuild: 'external', dev } }
        }) as any;
        const server = { middlewares: { use: vi.fn() } };
        await plugin.configureServer(server);
        expect(dev).toHaveBeenCalledWith(server);
    });
});
