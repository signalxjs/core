/**
 * @vitest-environment node
 *
 * sigxResume() end-to-end (real vite build, #241): the chunk-separation
 * guarantees the whole design rests on — handler chunks split away from
 * component chunks, carry no runtime, and everything resolves through the
 * registry that the generated entry wires up.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sigxResume } from '../src/resume';

describe('sigxResume end-to-end (real vite build)', () => {
    let root: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'sigx-resume-e2e-'));
        mkdirSync(join(root, 'src', 'resume'), { recursive: true });
        writeFileSync(join(root, 'index.html'),
            `<!doctype html><html><head></head><body><div id="app"></div>` +
            `<script type="module" src="/src/entry-client.ts"></script></body></html>`);
        writeFileSync(join(root, 'src', 'entry-client.ts'),
            `import 'virtual:sigx-resume/entry';\n`);
        writeFileSync(join(root, 'src', 'resume', 'Counter.tsx'), `
import { component } from 'sigx';
import { track } from '../analytics';
export const Counter = component((ctx) => {
    const count = ctx.signal(0);
    return () => <button onClick={() => { count.value++; track('hit'); }}>{count.value}</button>;
});
`);
        writeFileSync(join(root, 'src', 'analytics.ts'),
            `export const track = (x: string) => { console.log(x); };`);

        // Minimal stubs so the build resolves without the real workspace.
        const stub = (name: string, files: Record<string, string>, extraExports: Record<string, unknown> = {}) => {
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
                ),
                ...extraExports
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
                // Side-effectful like the real registry — a no-op body would
                // let the minifier DCE the registration AND its dynamic
                // import, deleting the component chunk from the build.
                `export const __chunks = [];\n` +
                `export function registerComponentChunk(name, loader) { __chunks.push(name); }\n`
        });
    }, 60_000);

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('splits handler chunks from component chunks with no runtime edges', async () => {
        const { build } = await import('vite');
        await build({
            root,
            logLevel: 'error',
            oxc: { jsx: { runtime: 'automatic', importSource: 'sigx' } },
            build: { manifest: true, outDir: 'dist/client' },
            plugins: [sigxResume()]
        } as any);

        const outDir = join(root, 'dist/client');

        // (a) The resume manifest maps the component and the symbol.
        const manifestPath = join(outDir, '.vite', 'sigx-resume-manifest.json');
        expect(existsSync(manifestPath)).toBe(true);
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        expect(manifest.components.Counter).toBeTruthy();
        const symbols = Object.keys(manifest.handlers);
        expect(symbols).toHaveLength(1);
        const symbol = symbols[0];
        expect(symbol).toMatch(/^Counter_click_[0-9a-f]{8}$/);

        // (b) Handler chunk ≠ component chunk.
        const componentChunk = manifest.components.Counter.chunkUrl;
        const handlerChunk = manifest.handlers[symbol].chunkUrl;
        expect(handlerChunk).not.toBe(componentChunk);

        const componentCode = readFileSync(join(outDir, componentChunk.slice(1)), 'utf-8');
        const handlerCode = readFileSync(join(outDir, handlerChunk.slice(1)), 'utf-8');

        // (c) The handler chunk has no edge to the component chunk and no
        // sigx runtime — it may import shared utilities (analytics) only.
        expect(handlerCode).not.toContain(componentChunk.split('/').pop());
        expect(handlerCode).not.toMatch(/from\s*["'][^"']*sigx/);
        expect(handlerCode).toContain('.signals.count');

        // (d) The component chunk carries the QRL attribute + symbol.
        expect(componentCode).toContain('data-sigx-on:click');
        expect(componentCode).toContain(symbol);
        expect(componentCode).toContain('__resumeId');

        // (e) The registry chunk (behind the entry's dynamic import)
        // registers the symbol and the upgrade chunk.
        const assets = readdirSync(join(outDir, 'assets')).map((f) =>
            readFileSync(join(outDir, 'assets', f), 'utf-8'));
        const registryChunk = assets.find((code) => code.includes(symbol) && code.includes(handlerChunk.split('/').pop()!));
        expect(registryChunk).toBeTruthy();
        // The upgrade loader's dynamic-import edge to the component chunk
        // lives in the registry too (identifiers are minified — assert the
        // chunk reference, not the callee name).
        expect(registryChunk).toContain(componentChunk.split('/').pop()!);

        // (f) The entry wires initResume with the discovered event union.
        const clientManifest = JSON.parse(readFileSync(join(outDir, '.vite/manifest.json'), 'utf-8'));
        const entryCode = readFileSync(join(outDir, clientManifest['index.html'].file), 'utf-8');
        // Identifiers/quotes are minified — assert the wiring itself: the
        // event union literal and the lazy registry import.
        expect(entryCode).toMatch(/[`'"]click[`'"]/);
        expect(entryCode).toContain('_virtual_sigx-resume');
    }, 120_000);
});
