/**
 * @vitest-environment node
 *
 * vercel() — the Build Output API v3 adapter (rfc-deploy §4.4): runtime
 * defaults, scaffold-iff-absent setup, and the full generated layout for
 * both runtimes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vercel } from '../src/index';

function logger() {
    return { info: vi.fn(), warn: vi.fn() };
}

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sigx-vercel-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** A fake finished build: client outDir + bundled server entry. */
function fakeBuild() {
    mkdirSync(join(root, 'out/client/assets'), { recursive: true });
    mkdirSync(join(root, 'out/client/.vite'), { recursive: true });
    mkdirSync(join(root, 'out/server'), { recursive: true });
    writeFileSync(join(root, 'out/client/index.html'), '<!doctype html><!--ssr-outlet-->');
    writeFileSync(join(root, 'out/client/assets/app-abc.js'), 'console.log(1)');
    writeFileSync(join(root, 'out/client/.vite/manifest.json'), '{}');
    writeFileSync(
        join(root, 'out/server/entry.vercel.js'),
        'export default { fetch: () => new Response("ok") };'
    );
    return {
        root,
        clientOutDir: join(root, 'out/client'),
        serverOutDir: join(root, 'out/server'),
        ssrInput: join(root, 'src/entry.vercel.ts'),
        logger: logger()
    };
}

describe('vercel() — adapter shape', () => {
    it('defaults to the node runtime with node conditions', () => {
        const adapter = vercel();
        expect(adapter.name).toBe('vercel');
        expect(adapter.serverBuild).toBe('bundled');
        expect(adapter.conditions).toEqual(['node']);
        expect(adapter.entry).toBe('src/entry.vercel.ts');
    });

    it('edge runtime opts into edge-light conditions', () => {
        expect(vercel({ runtime: 'edge' }).conditions).toEqual(['edge-light', 'worker']);
    });
});

describe('setup() — scaffold iff absent', () => {
    it('scaffolds the { fetch } entry with the ssr-entry import', async () => {
        await vercel().setup!({ root, ssrEntry: 'src/entry-server.tsx', logger: logger() });
        const code = readFileSync(join(root, 'src/entry.vercel.ts'), 'utf-8');
        expect(code).toContain('createFetchHandler');
        expect(code).toContain("from './entry-server'");
        expect(code).toContain('export default {');
        expect(code).toContain('fetch(request: Request)');
    });

    it('never overwrites an existing entry', async () => {
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src/entry.vercel.ts'), '// sentinel');
        await vercel().setup!({ root, ssrEntry: 'src/entry-server.tsx', logger: logger() });
        expect(readFileSync(join(root, 'src/entry.vercel.ts'), 'utf-8')).toBe('// sentinel');
    });
});

describe('generate() — the Build Output API v3 layout', () => {
    it('node runtime: static/ (no index.html, no .vite), full server copy, vc-config, routes', async () => {
        const ctx = fakeBuild();
        // A code-split sibling chunk must ride along with the entry.
        writeFileSync(join(root, 'out/server/chunk-abc.js'), 'export const x = 1;');
        await vercel().generate!(ctx as never);
        const output = join(root, '.vercel/output');

        expect(existsSync(join(output, 'static/assets/app-abc.js'))).toBe(true);
        expect(existsSync(join(output, 'static/index.html'))).toBe(false);
        expect(existsSync(join(output, 'static/.vite'))).toBe(false);

        const vc = JSON.parse(readFileSync(join(output, 'functions/_render.func/.vc-config.json'), 'utf-8'));
        expect(vc).toEqual({
            runtime: 'nodejs22.x',
            handler: 'entry.vercel.js',
            launcherType: 'Nodejs',
            shouldAddHelpers: false,
            supportsResponseStreaming: true
        });
        expect(readFileSync(join(output, 'functions/_render.func/entry.vercel.js'), 'utf-8')).toContain(
            'fetch:'
        );
        expect(existsSync(join(output, 'functions/_render.func/chunk-abc.js'))).toBe(true);
        expect(JSON.parse(readFileSync(join(output, 'functions/_render.func/package.json'), 'utf-8'))).toEqual(
            { type: 'module' }
        );

        const config = JSON.parse(readFileSync(join(output, 'config.json'), 'utf-8'));
        expect(config.version).toBe(3);
        expect(config.routes).toEqual([
            { src: '/_sigx/fn/(.*)', dest: '/_render' },
            { handle: 'filesystem' },
            { src: '/(.*)', dest: '/_render' }
        ]);
    });

    it('node runtime honors a nodeVersion override', async () => {
        const ctx = fakeBuild();
        await vercel({ nodeVersion: 'nodejs24.x' }).generate!(ctx as never);
        const vc = JSON.parse(
            readFileSync(join(root, '.vercel/output/functions/_render.func/.vc-config.json'), 'utf-8')
        );
        expect(vc.runtime).toBe('nodejs24.x');
    });

    it('edge runtime: wrapper entrypoint bridging { fetch } to the bare-fn contract', async () => {
        const ctx = fakeBuild();
        await vercel({ runtime: 'edge' }).generate!(ctx as never);
        const funcDir = join(root, '.vercel/output/functions/_render.func');
        const vc = JSON.parse(readFileSync(join(funcDir, '.vc-config.json'), 'utf-8'));
        expect(vc).toEqual({ runtime: 'edge', entrypoint: '_sigx_edge.js' });
        const wrapper = readFileSync(join(funcDir, '_sigx_edge.js'), 'utf-8');
        expect(wrapper).toContain("from './entry.vercel.js'");
        expect(wrapper).toContain('entry.fetch(request, event)');
        expect(existsSync(join(funcDir, 'entry.vercel.js'))).toBe(true);
    });

    it('regenerates from scratch (stale files from a previous layout removed)', async () => {
        const ctx = fakeBuild();
        mkdirSync(join(root, '.vercel/output/functions/stale.func'), { recursive: true });
        writeFileSync(join(root, '.vercel/output/functions/stale.func/.vc-config.json'), '{}');
        await vercel().generate!(ctx as never);
        expect(existsSync(join(root, '.vercel/output/functions/stale.func'))).toBe(false);
    });

    it('throws a named error when the built entry cannot be identified', async () => {
        const ctx = fakeBuild();
        rmSync(join(root, 'out/server/entry.vercel.js'));
        writeFileSync(join(root, 'out/server/a.js'), '');
        writeFileSync(join(root, 'out/server/b.js'), '');
        await expect(async () => vercel().generate!(ctx as never)).rejects.toThrow(
            /could not identify the built function entry/
        );
    });
});
