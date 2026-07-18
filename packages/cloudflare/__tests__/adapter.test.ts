/**
 * @vitest-environment node
 *
 * cloudflare() — the flagship SigxAdapter (rfc-deploy §4.2): fixed bundled
 * shape, scaffold-iff-absent setup, wrangler.jsonc generation/validation,
 * and the dev platform seam.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudflare, getDevPlatform } from '../src/index';
import { attachDevPlatform, type DevPlatform } from '../src/dev';

function logger() {
    return { info: vi.fn(), warn: vi.fn() };
}

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sigx-cf-adapter-'));
    mkdirSync(join(root, 'dist-x/server'), { recursive: true });
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('cloudflare() — adapter shape', () => {
    it('is the fixed bundled workerd adapter', () => {
        const adapter = cloudflare();
        expect(adapter.name).toBe('cloudflare');
        expect(adapter.serverBuild).toBe('bundled');
        expect(adapter.conditions).toEqual(['workerd', 'worker']);
        expect(adapter.runtimeExternal).toEqual([/^cloudflare:/]);
        expect(adapter.entry).toBe('src/entry.cloudflare.ts');
    });

    it('honors the entry override and omits dev without devProxy', () => {
        expect(cloudflare({ entry: 'src/worker.ts' }).entry).toBe('src/worker.ts');
        expect(cloudflare().dev).toBeUndefined();
        expect(cloudflare({ devProxy: true }).dev).toBeTypeOf('function');
    });
});

describe('setup() — scaffold iff absent, then never touch', () => {
    it('scaffolds the entry with the ssr-entry import and the fn-mount comment', async () => {
        const adapter = cloudflare();
        const log = logger();
        await adapter.setup!({ root, ssrEntry: 'src/entry-server.tsx', logger: log });
        const file = join(root, 'src/entry.cloudflare.ts');
        expect(existsSync(file)).toBe(true);
        const code = readFileSync(file, 'utf-8');
        expect(code).toContain('createFetchHandler');
        expect(code).toContain("from './entry-server'");
        expect(code).toContain('virtual:sigx-app');
        expect(code).toContain('matchesServerFn'); // the commented fn-mount block
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('scaffolded'));
    });

    it('never overwrites an existing entry', async () => {
        const adapter = cloudflare();
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src/entry.cloudflare.ts'), '// sentinel');
        await adapter.setup!({ root, ssrEntry: 'src/entry-server.tsx', logger: logger() });
        expect(readFileSync(join(root, 'src/entry.cloudflare.ts'), 'utf-8')).toBe('// sentinel');
    });
});

describe('generate() — wrangler.jsonc iff absent', () => {
    function ctx(overrides: Partial<Record<string, unknown>> = {}) {
        const log = logger();
        writeFileSync(join(root, 'dist-x/server/entry.cloudflare.js'), 'export default {};');
        return {
            log,
            ctx: {
                root,
                clientOutDir: join(root, 'dist-x/client'),
                serverOutDir: join(root, 'dist-x/server'),
                ssrInput: join(root, 'src/entry.cloudflare.ts'),
                logger: log,
                ...overrides
            }
        };
    }

    it('writes a parseable starter config with main, assets, and html_handling none', async () => {
        writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@acme/shop' }));
        const { ctx: c } = ctx();
        await cloudflare().generate!(c as never);
        const config = JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8'));
        expect(config.name).toBe('acme-shop');
        expect(config.main).toBe('dist-x/server/entry.cloudflare.js');
        expect(config.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(config.assets).toEqual({ directory: 'dist-x/client', html_handling: 'none' });
    });

    it('honors a compatibilityDate option in the scaffold', async () => {
        const { ctx: c } = ctx();
        await cloudflare({ compatibilityDate: '2027-01-01' }).generate!(c as never);
        expect(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).compatibility_date).toBe(
            '2027-01-01'
        );
    });

    it('byte-preserves an existing config and stays silent when it matches', async () => {
        const existing =
            `{\n// user comment\n"main": "dist-x/server/entry.cloudflare.js",\n` +
            `"assets": { "directory": "dist-x/client", "html_handling": "none" }\n}\n`;
        writeFileSync(join(root, 'wrangler.jsonc'), existing);
        const { ctx: c, log } = ctx();
        await cloudflare().generate!(c as never);
        expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(existing);
        expect(log.warn).not.toHaveBeenCalled();
    });

    it('warns on main drift, assets drift, and missing html_handling — never writes', async () => {
        const existing = `{ "main": "somewhere/else.js", "assets": { "directory": "public" } }`;
        writeFileSync(join(root, 'wrangler.jsonc'), existing);
        const { ctx: c, log } = ctx();
        await cloudflare().generate!(c as never);
        expect(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).toBe(existing);
        const warnings = log.warn.mock.calls.map((call) => call[0] as string);
        expect(warnings.some((w) => w.includes('main'))).toBe(true);
        expect(warnings.some((w) => w.includes('assets.directory') || w.includes('client outDir'))).toBe(true);
        expect(warnings.some((w) => w.includes('html_handling'))).toBe(true);
    });

    it('falls back to the single built entry when the derived name is absent', async () => {
        const log = logger();
        writeFileSync(join(root, 'dist-x/server/worker.js'), 'export default {};');
        await cloudflare().generate!({
            root,
            clientOutDir: join(root, 'dist-x/client'),
            serverOutDir: join(root, 'dist-x/server'),
            ssrInput: join(root, 'src/entry.cloudflare.ts'),
            logger: log
        } as never);
        expect(JSON.parse(readFileSync(join(root, 'wrangler.jsonc'), 'utf-8')).main).toBe(
            'dist-x/server/worker.js'
        );
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('worker.js'));
    });
});

describe('dev platform seam', () => {
    function fakeServer() {
        return { close: vi.fn(async () => {}) } as never;
    }

    it('attach/get round-trip, and server.close disposes the proxy first', async () => {
        const server = fakeServer();
        const dispose = vi.fn(async () => {});
        const proxy: DevPlatform = { env: { KV: 1 }, cf: {}, ctx: {}, caches: {}, dispose };
        attachDevPlatform(server, proxy);
        expect(getDevPlatform(server)).toBe(proxy);
        await (server as { close(): Promise<void> }).close();
        expect(dispose).toHaveBeenCalled();
    });

    it('getDevPlatform throws a named error without devProxy', () => {
        expect(() => getDevPlatform(fakeServer())).toThrow(/devProxy: true/);
    });
});
