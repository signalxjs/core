/**
 * @vitest-environment node
 *
 * netlify() — the Frameworks API adapter (rfc-deploy §4.5): scaffold-iff-
 * absent setup, the generated function layout, the raw-template removal,
 * and the printed-never-written netlify.toml posture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { netlify } from '../src/index';

function logger() {
    return { info: vi.fn(), warn: vi.fn() };
}

let root: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'sigx-netlify-'));
});
afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function fakeBuild() {
    mkdirSync(join(root, 'out/client/assets'), { recursive: true });
    mkdirSync(join(root, 'out/server'), { recursive: true });
    writeFileSync(join(root, 'out/client/index.html'), '<!doctype html><!--ssr-outlet-->');
    writeFileSync(join(root, 'out/client/assets/app-abc.js'), 'console.log(1)');
    writeFileSync(
        join(root, 'out/server/entry.netlify.js'),
        'export default { fetch: () => new Response("ok") };'
    );
    return {
        root,
        clientOutDir: join(root, 'out/client'),
        serverOutDir: join(root, 'out/server'),
        ssrInput: join(root, 'src/entry.netlify.ts'),
        logger: logger()
    };
}

describe('netlify() — adapter shape', () => {
    it('is the bundled node-conditioned adapter with the default entry', () => {
        const adapter = netlify();
        expect(adapter.name).toBe('netlify');
        expect(adapter.serverBuild).toBe('bundled');
        expect(adapter.conditions).toEqual(['node']);
        expect(adapter.entry).toBe('src/entry.netlify.ts');
        expect(netlify({ entry: 'src/fn.ts' }).entry).toBe('src/fn.ts');
    });
});

describe('setup() — scaffold iff absent', () => {
    it('scaffolds the { fetch } entry with the ssr-entry import', async () => {
        await netlify().setup!({ root, ssrEntry: 'src/entry-server.tsx', logger: logger() });
        const code = readFileSync(join(root, 'src/entry.netlify.ts'), 'utf-8');
        expect(code).toContain('createFetchHandler');
        expect(code).toContain("from './entry-server'");
        expect(code).toContain('export default {');
    });

    it('never overwrites an existing entry', async () => {
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src/entry.netlify.ts'), '// sentinel');
        await netlify().setup!({ root, ssrEntry: 'src/entry-server.tsx', logger: logger() });
        expect(readFileSync(join(root, 'src/entry.netlify.ts'), 'utf-8')).toBe('// sentinel');
    });
});

describe('generate() — the Frameworks API layout', () => {
    it('emits the function dir: wrapper + full server copy + ESM package.json', async () => {
        const ctx = fakeBuild();
        writeFileSync(join(root, 'out/server/chunk-abc.js'), 'export const x = 1;');
        await netlify().generate!(ctx as never);
        const fnDir = join(root, '.netlify/v1/functions/sigx-ssr');

        const wrapper = readFileSync(join(fnDir, 'sigx-ssr.mjs'), 'utf-8');
        expect(wrapper).toContain("from './entry.netlify.js'");
        expect(wrapper).toContain('entry.fetch(request, context)');
        expect(wrapper).toContain("path: '/*'");
        expect(wrapper).toContain('preferStatic: true');
        expect(wrapper).toContain("nodeBundler: 'none'");
        expect(wrapper).toMatch(/generator: '@sigx\/netlify@/);

        expect(existsSync(join(fnDir, 'entry.netlify.js'))).toBe(true);
        expect(existsSync(join(fnDir, 'chunk-abc.js'))).toBe(true);
        expect(JSON.parse(readFileSync(join(fnDir, 'package.json'), 'utf-8'))).toEqual({
            type: 'module'
        });
    });

    it('removes the raw template from the publish dir (preferStatic would serve it for /)', async () => {
        const ctx = fakeBuild();
        await netlify().generate!(ctx as never);
        expect(existsSync(join(root, 'out/client/index.html'))).toBe(false);
        expect(existsSync(join(root, 'out/client/assets/app-abc.js'))).toBe(true);
    });

    it('prints the starter netlify.toml when absent — and never writes it', async () => {
        const ctx = fakeBuild();
        await netlify().generate!(ctx as never);
        expect(existsSync(join(root, 'netlify.toml'))).toBe(false);
        const info = (ctx.logger.info.mock.calls as string[][]).map((c) => c[0]).join('\n');
        expect(info).toContain('publish = "out/client"');
        expect(info).toContain('[build]');
    });

    it('warns when an existing netlify.toml does not mention the publish dir', async () => {
        const ctx = fakeBuild();
        writeFileSync(join(root, 'netlify.toml'), '[build]\n  publish = "somewhere/else"\n');
        await netlify().generate!(ctx as never);
        expect(readFileSync(join(root, 'netlify.toml'), 'utf-8')).toContain('somewhere/else');
        expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('out/client'));
    });

    it('regenerates the function dir from scratch', async () => {
        const ctx = fakeBuild();
        mkdirSync(join(root, '.netlify/v1/functions/sigx-ssr'), { recursive: true });
        writeFileSync(join(root, '.netlify/v1/functions/sigx-ssr/stale.js'), '');
        await netlify().generate!(ctx as never);
        expect(existsSync(join(root, '.netlify/v1/functions/sigx-ssr/stale.js'))).toBe(false);
    });

    it('throws a named error when the built entry cannot be identified', async () => {
        const ctx = fakeBuild();
        rmSync(join(root, 'out/server/entry.netlify.js'));
        writeFileSync(join(root, 'out/server/a.js'), '');
        writeFileSync(join(root, 'out/server/b.js'), '');
        await expect(async () => netlify().generate!(ctx as never)).rejects.toThrow(
            /could not identify the built function entry/
        );
    });
});
