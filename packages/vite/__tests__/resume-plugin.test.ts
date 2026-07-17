/**
 * @vitest-environment node
 *
 * sigxResume() (#241): transform wiring (QRL attributes + signal keys +
 * __resumeId/__resumeMode stamps), the virtual registry / handlers / entry
 * modules, and relative-import resolution for extracted handlers.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sigxResume } from '../src/resume';

const COUNTER = `
import { component } from 'sigx';
import { track } from '../analytics';

export const Counter = component<{ label: string }>((ctx) => {
    const count = ctx.signal(0);
    return () => (
        <button onClick={(e) => { count.value++; track('hit'); }}>
            {ctx.props.label}: {count.value}
        </button>
    );
});
`;

/** A configured plugin instance with discovery run against a tmp project. */
function makeProject(files: Record<string, string>): { plugin: any; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'sigx-resume-'));
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), content);
    }
    const plugin = sigxResume() as any;
    plugin.configResolved({ root, command: 'build' });
    return { plugin, root };
}

describe('sigxResume — transform', () => {
    let plugin: any;
    let root: string;

    beforeAll(() => {
        ({ plugin, root } = makeProject({ 'src/resume/Counter.tsx': COUNTER }));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('injects QRL attributes, signal keys, and resume stamps', () => {
        const warnings: string[] = [];
        const result = plugin.transform.call(
            { warn: (msg: string) => warnings.push(msg) },
            COUNTER,
            join(root, 'src/resume/Counter.tsx')
        );
        expect(result.code).toMatch(/data-sigx-on:click="Counter_click_[0-9a-f]{8}"/);
        expect(result.code).toContain('data-sigx-b={ctx.$sigxB}');
        expect(result.code).toContain('ctx.signal(__sigxInit, "count")');
        expect(result.code).toContain('Counter.__resumeId = "Counter"');
        expect(result.code).toContain('Counter.__resumeMode = "resume"');
        expect(warnings).toHaveLength(0);
    });

    it('stamps hydrate mode and warns when a handler is ineligible', () => {
        const code = `
import { component } from 'sigx';
const STEP = 2;
export const Stepper = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value += STEP; }}>x</button>;
});
`;
        const warnings: string[] = [];
        const result = plugin.transform.call(
            { warn: (msg: string) => warnings.push(msg) },
            code,
            join(root, 'src/resume/Stepper.tsx')
        );
        expect(result.code).toContain('Stepper.__resumeMode = "hydrate"');
        expect(result.code).not.toContain('data-sigx-on');
        expect(result.code).toContain('data-sigx-wake:click=""');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('onclick of <Stepper>');
        expect(warnings[0]).toContain('interaction hydration');
    });

    it('ignores non-matching files and files without components', () => {
        expect(plugin.transform.call({}, COUNTER, join(root, 'src/Page.tsx'))).toBeNull();
        expect(
            plugin.transform.call({}, 'export const x = 1;', join(root, 'src/resume/util.ts'))
        ).toBeNull();
    });
});

describe('sigxResume — path-separator normalization (#324)', () => {
    it('discovery (native paths) + transform (vite ids) yield ONE registration per file', () => {
        // discover() walks the fs (backslashes on Windows); transform gets
        // Vite's forward-slash id for the SAME file. Unnormalized map keys
        // register the file twice — every component then warns as its own
        // duplicate and QRL loaders double up.
        const { plugin, root } = makeProject({ 'src/resume/Counter.tsx': COUNTER });
        try {
            const posixId = join(root, 'src/resume/Counter.tsx').replace(/\\/g, '/');
            plugin.transform.call({ warn: () => {} }, COUNTER, posixId);

            const warnings: string[] = [];
            const spy = vi.spyOn(console, 'warn').mockImplementation((msg: unknown) => {
                warnings.push(String(msg));
            });
            try {
                const registry = plugin.load(plugin.resolveId('virtual:sigx-resume'));
                expect(
                    warnings.filter((w) => w.includes('duplicate resume component name'))
                ).toHaveLength(0);
                expect(registry.match(/__registerResumeQrl\("Counter_click_/g)).toHaveLength(1);
                expect(registry.match(/__registerIslandChunk\("Counter"/g)).toHaveLength(1);
            } finally {
                spy.mockRestore();
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('sigxResume — virtual modules', () => {
    let plugin: any;
    let root: string;

    beforeAll(() => {
        ({ plugin, root } = makeProject({
            'src/resume/Counter.tsx': COUNTER,
            'src/analytics.ts': `export const track = (x: string) => {};`
        }));
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it('resolves and loads the registry with QRL + upgrade-chunk loaders', () => {
        const resolved = plugin.resolveId.call({}, 'virtual:sigx-resume', undefined);
        expect(resolved).toBe('\0virtual:sigx-resume');
        const registry = plugin.load.call({}, resolved);
        expect(registry).toContain("import { __registerResumeQrl } from '@sigx/resume/client';");
        expect(registry).toContain("import { __registerIslandChunk } from '@sigx/server-renderer/client';");
        expect(registry).toMatch(
            /__registerResumeQrl\("Counter_click_[0-9a-f]{8}", \(\) => import\("virtual:sigx-resume:src\/resume\/Counter\.tsx\.handlers\.ts"\)/
        );
        expect(registry).toContain('__registerIslandChunk("Counter", () => import("/src/resume/Counter.tsx")');
    });

    it('loads the per-file handlers module with replicated imports (type-stripped)', async () => {
        const resolved = plugin.resolveId.call({}, 'virtual:sigx-resume:src/resume/Counter.tsx.handlers.ts', undefined);
        const loaded = await plugin.load.call({}, resolved);
        const handlers = typeof loaded === 'string' ? loaded : loaded.code;
        expect(handlers).toContain('import { track } from "../analytics"');
        expect(handlers).toMatch(/export const Counter_click_[0-9a-f]{8} = \(\$scope, e\) =>/);
        expect(handlers).toContain('$scope.signals.count.value++');
        expect(handlers).not.toContain('sigx');
    });

    it('resolves a handlers module relative import against the source file', async () => {
        const importer = '\0virtual:sigx-resume:src/resume/Counter.tsx.handlers.ts';
        let resolvedAgainst: string | undefined;
        const ctx = {
            resolve(source: string, from: string) {
                resolvedAgainst = from;
                return Promise.resolve({ id: join(root, 'src/analytics.ts') });
            }
        };
        await plugin.resolveId.call(ctx, '../analytics', importer);
        // Normalized (forward-slash) form — Vite's canonical importer shape
        // and the #324 map-key discipline.
        expect(resolvedAgainst).toBe(join(root, 'src/resume/Counter.tsx').replace(/\\/g, '/'));
    });

    it('emits the manifest with components and handlers sections', () => {
        const emitted: any[] = [];
        const ctx = {
            environment: { name: 'client' },
            emitFile: (asset: any) => emitted.push(asset)
        };
        const counterPath = join(root, 'src/resume/Counter.tsx').replace(/\\/g, '/');
        const bundle = {
            'assets/Counter-abc.js': {
                type: 'chunk',
                facadeModuleId: counterPath,
                fileName: 'assets/Counter-abc.js'
            },
            'assets/Counter.handlers-def.js': {
                type: 'chunk',
                facadeModuleId: '\0virtual:sigx-resume:src/resume/Counter.tsx.handlers.ts',
                fileName: 'assets/Counter.handlers-def.js'
            }
        };
        plugin.generateBundle.handler.call(ctx, {}, bundle);

        expect(emitted).toHaveLength(1);
        expect(emitted[0].fileName).toBe('.vite/sigx-resume-manifest.json');
        const manifest = JSON.parse(emitted[0].source);
        expect(manifest.components.Counter).toEqual({ chunkUrl: '/assets/Counter-abc.js', exportName: 'Counter' });
        const symbols = Object.keys(manifest.handlers);
        expect(symbols).toHaveLength(1);
        expect(symbols[0]).toMatch(/^Counter_click_[0-9a-f]{8}$/);
        expect(manifest.handlers[symbols[0]].chunkUrl).toBe('/assets/Counter.handlers-def.js');
    });

    it('emits no manifest outside the client environment', () => {
        const emitted: any[] = [];
        const ctx = { environment: { name: 'ssr' }, emitFile: (asset: any) => emitted.push(asset) };
        plugin.generateBundle.handler.call(ctx, {}, {});
        expect(emitted).toHaveLength(0);
    });

    it('loads the entry with the discovered event union', () => {
        const resolved = plugin.resolveId.call({}, 'virtual:sigx-resume/entry', undefined);
        const entry = plugin.load.call({}, resolved);
        expect(entry).toContain("import { initResume } from '@sigx/resume/loader';");
        expect(entry).toContain('initResume(["click"]');
        expect(entry).toContain("() => import(\"virtual:sigx-resume\")");
        expect(entry).toContain("() => import('@sigx/resume/client')");
    });
});

describe('sigxResume — duplicate component names', () => {
    it('keeps the first file and warns for registry and manifest', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { plugin, root } = makeProject({
            'src/resume/a.tsx': COUNTER.replace('../analytics', '../../analytics'),
            'src/resume/b/dupe.tsx': COUNTER
        });
        try {
            const registry = plugin.load.call({}, '\0virtual:sigx-resume');
            const registrations = registry.split('\n').filter((l: string) => l.includes('__registerIslandChunk("Counter"'));
            expect(registrations).toHaveLength(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate resume component name "Counter"'));
        } finally {
            warn.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('sigxResume — handlers module type-stripping (#270)', () => {
    it('serves the handlers module as plain JS even when the source handler uses TS', async () => {
        const { plugin, root } = makeProject({
            'src/resume/TsForm.tsx': `
import { component } from 'sigx';
export const TsForm = component((ctx) => {
    const done = ctx.signal(false);
    return () => <form onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.target as HTMLFormElement).get('email') as string | null;
        console.log(data);
        done.value = true;
    }}>x</form>;
});
`
        });
        try {
            const resolved = plugin.resolveId.call({}, 'virtual:sigx-resume:src/resume/TsForm.tsx.handlers.ts', undefined);
            const loaded = await plugin.load.call({}, resolved);
            const code = typeof loaded === 'string' ? loaded : loaded.code;
            expect(code).toContain('preventDefault');
            expect(code).not.toContain(' as HTMLFormElement');
            expect(code).not.toContain('string | null');
            // Still a parseable module with the export intact.
            expect(code).toMatch(/export const TsForm_submit_[0-9a-f]{8}/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
