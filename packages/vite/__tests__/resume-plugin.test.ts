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
import { sigxServer } from '../src/server-fn';

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
function makeProject(files: Record<string, string>, command: 'build' | 'serve' = 'build'): { plugin: any; root: string } {
    const root = mkdtempSync(join(tmpdir(), 'sigx-resume-'));
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(root, rel, '..'), { recursive: true });
        writeFileSync(join(root, rel), content);
    }
    const plugin = sigxResume() as any;
    plugin.configResolved({ root, command });
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
        // The handler symbols ride the factory too — resumePlugin's assets()
        // hook maps them through the manifest to modulepreload links (#410).
        expect(result.code).toMatch(/Counter\.__resumeQrls = \["Counter_click_[0-9a-f]{8}"\]/);
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
        // Hydrate mode has no handler symbols — nothing to preload.
        expect(result.code).not.toContain('__resumeQrls');
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
                expect(registry.match(/registerComponentChunk\("Counter"/g)).toHaveLength(1);
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
        expect(registry).toContain("import { registerComponentChunk } from '@sigx/server-renderer/client';");
        expect(registry).toMatch(
            /__registerResumeQrl\("Counter_click_[0-9a-f]{8}", \(\) => import\("virtual:sigx-resume:src\/resume\/Counter\.tsx\.handlers\.ts"\)/
        );
        expect(registry).toContain('registerComponentChunk("Counter", () => import("/src/resume/Counter.tsx")');
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

/** A plugin `this` whose error() throws like Rollup's does. */
const failing = {
    warn: () => {},
    error: (m: string): never => {
        throw new Error(m);
    }
};

describe('sigxResume — serve mode (dev, #702 phase 7)', () => {
    const COUNTER_FILE = 'src/resume/Counter.tsx';

    it('keeps the original on* prop next to the QRL attributes in every environment', () => {
        const { plugin, root } = makeProject({ [COUNTER_FILE]: COUNTER }, 'serve');
        try {
            for (const name of ['client', 'ssr']) {
                const result = plugin.transform.call({ warn: () => {}, environment: { name } }, COUNTER, join(root, COUNTER_FILE));
                // `invoke` steps aside once a boundary is upgraded: the hydrated
                // component's own listener dispatches from then on. Stripping
                // on* (as #414 proposed) would leave every upgraded boundary dead.
                expect(result.code, name).toMatch(/onClick=\{\(e\) => \{ count\.value\+\+; track\('hit'\); \}\} data-sigx-on:click="/);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('warns per ineligible handler with file:line:col in serve mode', () => {
        const code = `
import { component } from 'sigx';
const STEP = 2;
export const Mixed = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value += STEP; }}>x</button>;
});
`;
        const { plugin, root } = makeProject({ 'src/resume/Mixed.tsx': code }, 'serve');
        try {
            const warnings: string[] = [];
            plugin.transform.call({ warn: (m: string) => warnings.push(m) }, code, join(root, 'src/resume/Mixed.tsx'));
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toMatch(
                /src\/resume\/Mixed\.tsx:6:\d+ onclick of <Mixed> is not resumable — handler captures module-scope binding "STEP"/
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('is idempotent over its own output: the registry lists each symbol once', () => {
        const { plugin, root } = makeProject({ [COUNTER_FILE]: COUNTER }, 'serve');
        try {
            const ctx = { warn: () => {} };
            const once = plugin.transform.call(ctx, COUNTER, join(root, COUNTER_FILE));
            plugin.transform.call(ctx, once.code, join(root, COUNTER_FILE)); // rolldown's echo pass
            const registry = plugin.load.call(failing, '\0virtual:sigx-resume');
            expect(registry.split('__registerResumeQrl(').length - 1).toBe(1);
            expect(registry.split('registerComponentChunk(').length - 1).toBe(1);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    async function hot(plugin: any, file: string, env: string, edited: string) {
        const send = vi.fn();
        const environment = {
            name: env,
            moduleGraph: { getModuleById: () => undefined, invalidateModule: vi.fn() },
            hot: { send }
        };
        const result = await plugin.hotUpdate.call({ environment }, { type: 'update', file, read: async () => edited });
        return { send, result };
    }

    it('hotUpdate sends full-reload from the client environment when a handler symbol changes', async () => {
        const { plugin, root } = makeProject({ [COUNTER_FILE]: COUNTER }, 'serve');
        try {
            const { send, result } = await hot(plugin, join(root, COUNTER_FILE), 'client', COUNTER.replace('count.value++', 'count.value += 2'));
            // The page's data-sigx-on attributes and the evaluated registry
            // hold the old content-hashed symbol — only a reload re-syncs them.
            expect(send).toHaveBeenCalledWith({ type: 'full-reload' });
            expect(result).toEqual([]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('hotUpdate leaves a markup-only edit to in-place HMR', async () => {
        const { plugin, root } = makeProject({ [COUNTER_FILE]: COUNTER }, 'serve');
        try {
            const { send, result } = await hot(plugin, join(root, COUNTER_FILE), 'client', COUNTER.replace('{ctx.props.label}: {count.value}', 'Count {count.value}'));
            expect(send).not.toHaveBeenCalled();
            expect(result).toBeUndefined();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('hotUpdate never sends from the ssr environment', async () => {
        const { plugin, root } = makeProject({ [COUNTER_FILE]: COUNTER }, 'serve');
        try {
            const { send } = await hot(plugin, join(root, COUNTER_FILE), 'ssr', COUNTER.replace('count.value++', 'count.value += 2'));
            expect(send).not.toHaveBeenCalled();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('sigxResume — duplicate component names are a build error (§4.5)', () => {
    it('transform of either file fails naming BOTH files', () => {
        const { plugin, root } = makeProject({
            'src/resume/a.tsx': COUNTER.replace('../analytics', '../../analytics'),
            'src/resume/b/dupe.tsx': COUNTER
        });
        try {
            for (const rel of ['src/resume/a.tsx', 'src/resume/b/dupe.tsx']) {
                let message = '';
                try {
                    plugin.transform.call(failing, COUNTER, join(root, rel));
                } catch (e) {
                    message = (e as Error).message;
                }
                expect(message).toContain('duplicate resume component name "Counter"');
                expect(message).toContain('src/resume/a.tsx');
                expect(message).toContain('src/resume/b/dupe.tsx');
                expect(message).toContain('must be unique');
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('the registry and the manifest refuse to build too (files nothing imported yet)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { plugin, root } = makeProject({
            'src/resume/a.tsx': COUNTER.replace('../analytics', '../../analytics'),
            'src/resume/b/dupe.tsx': COUNTER
        });
        try {
            expect(() => plugin.load.call(failing, '\0virtual:sigx-resume'))
                .toThrow(/duplicate resume component name "Counter"/);
            expect(() => plugin.generateBundle.handler.call(
                { ...failing, environment: { name: 'client' }, emitFile: () => {} }, {}, {}))
                .toThrow(/duplicate resume component name "Counter"/);
            // Never a console warning any more — it is an error or nothing.
            expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('duplicate'));
        } finally {
            warn.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a collision with an UNSTAMPABLE export (no handlers, no named signals) is not a duplicate', () => {
        // Such a component is never registered or put in the manifest, so
        // its name is not a key anything could collide with.
        const { plugin, root } = makeProject({
            'src/resume/a.tsx': COUNTER.replace('../analytics', '../../analytics'),
            'src/resume/static.tsx': `
import { component } from 'sigx';
export const Counter = component<{ label: string }>((ctx) => () => <p>{ctx.props.label}</p>);
`
        });
        try {
            expect(() => plugin.transform.call(failing, COUNTER, join(root, 'src/resume/a.tsx'))).not.toThrow();
            expect(() => plugin.load.call(failing, '\0virtual:sigx-resume')).not.toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('the same component name in two NON-resume files is nobody\'s business', () => {
        const { plugin, root } = makeProject({
            'src/resume/a.tsx': COUNTER.replace('../analytics', '../../analytics'),
            'src/Counter.tsx': COUNTER
        });
        try {
            expect(() => plugin.load.call(failing, '\0virtual:sigx-resume')).not.toThrow();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe('sigxResume — transform-contract build errors (§4.5)', () => {
    it('`export default` on a component fails the transform with file:line:col', () => {
        const code = `
import { component } from 'sigx';
const Hidden = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
export default Hidden;
`;
        const { plugin, root } = makeProject({ 'src/resume/Hidden.tsx': code });
        try {
            let message = '';
            try {
                plugin.transform.call(failing, code, join(root, 'src/resume/Hidden.tsx'));
            } catch (e) {
                message = (e as Error).message;
            }
            expect(message).toContain('resume components must be named exports');
            expect(message).toMatch(/src\/resume\/Hidden\.tsx:3:7/);
            // The registry sweep reports it too, so a discovered-but-not-yet-
            // imported module cannot slip through.
            expect(() => plugin.load.call(failing, '\0virtual:sigx-resume'))
                .toThrow(/resume components must be named exports/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a handler binding $scope / $el fails the transform', () => {
        const code = `
import { component } from 'sigx';
export const Reserved = component((ctx) => {
    const count = ctx.signal(0);
    return () => <button onClick={($el) => { count.value++; }}>x</button>;
});
`;
        const { plugin, root } = makeProject({ 'src/resume/Reserved.tsx': code });
        try {
            let message = '';
            try {
                plugin.transform.call(failing, code, join(root, 'src/resume/Reserved.tsx'));
            } catch (e) {
                message = (e as Error).message;
            }
            expect(message).toContain('onclick of <Reserved>');
            expect(message).toContain('reserved name');
            expect(message).toMatch(/src\/resume\/Reserved\.tsx:5:35/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('a default export that is not a component does not trip the check', () => {
        const code = `
import { component } from 'sigx';
export const Counter = component((ctx) => {
    const n = ctx.signal(0);
    return () => <button onClick={() => { n.value++; }}>x</button>;
});
export default { step: 1 };
`;
        const { plugin, root } = makeProject({ 'src/resume/Ok.tsx': code });
        try {
            const result = plugin.transform.call(failing, code, join(root, 'src/resume/Ok.tsx'));
            expect(result.code).toContain('Counter.__resumeId = "Counter"');
        } finally {
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

describe('sigxResume × sigxServer — form-action stamping wiring (rfc-server §6.4, #312)', () => {
    const API = `
import { serverFn } from '@sigx/server';
export const submitFeedback = serverFn({
    form: true,
    handler: async (rq, input) => input
});
`;
    const FEEDBACK = `
import { component } from 'sigx';
import { submitFeedback } from './api.server';
export const Feedback = component((ctx) => {
    const sent = ctx.signal(false);
    return () => (
        <form onSubmit={async (e) => {
            e.preventDefault();
            await submitFeedback({ message: 'x' });
            sent.value = true;
        }}>
            <input name="message" />
        </form>
    );
});
`;

    function makeWiredProject(serverOptions?: Record<string, unknown>) {
        const root = mkdtempSync(join(tmpdir(), 'sigx-resume-wired-'));
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src/api.server.ts'), API);
        writeFileSync(join(root, 'src/Feedback.resume.tsx'), FEEDBACK);
        const server = sigxServer(serverOptions) as any;
        const resume = sigxResume() as any;
        // Both plugins see the resolved config, sigx:server first — the
        // resume plugin finds it by name via config.plugins (the seam).
        const config = { root, command: 'build' as const, plugins: [server, resume] };
        server.configResolved(config);
        resume.configResolved(config);
        return { resume, root };
    }

    it('stamps the action through the live sigx:server api', () => {
        const { resume, root } = makeWiredProject();
        const file = join(root, 'src/Feedback.resume.tsx');
        const result = resume.transform.call(
            { environment: { name: 'ssr' }, warn: () => {} },
            FEEDBACK,
            file
        );
        // #355: real path segments, so the action reads as the symbol does.
        expect(result.code).toContain(
            ` action="/_sigx/fn/src/api.server.ts/submitFeedback" method="post"`
        );
        expect(result.code).toContain('data-sigx-pd:submit=""');
    });

    /**
     * A `<form>` in a file OUTSIDE `include` is never analysed — `transform()`
     * bails on the filter before the extractor runs — so nothing was stamped
     * and nothing said so (#488). The warning is deliberately hedged: this
     * file is never parsed for handler sites, so the plugin cannot know
     * whether the form's submit handler actually calls the imported fn.
     */
    it('warns about a form:true import in a file outside include', () => {
        const { resume, root } = makeWiredProject();
        const warnings: string[] = [];
        const file = join(root, 'src/Feedback.tsx');   // NOT *.resume.tsx
        const result = resume.transform.call(
            { environment: { name: 'ssr' }, warn: (m: string) => warnings.push(m) },
            FEEDBACK,
            file
        );
        expect(result).toBeNull();                     // filtered out, as before
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('[sigx:resume]');
        expect(warnings[0]).toContain('submitFeedback');
        expect(warnings[0]).toContain('without JS');

        // Once per file — dev re-transforms the same module constantly.
        resume.transform.call(
            { environment: { name: 'ssr' }, warn: (m: string) => warnings.push(m) },
            FEEDBACK,
            file
        );
        expect(warnings).toHaveLength(1);
    });

    it('stays quiet for an out-of-include file with no <form>', () => {
        const { resume, root } = makeWiredProject();
        const warnings: string[] = [];
        const result = resume.transform.call(
            { environment: { name: 'ssr' }, warn: (m: string) => warnings.push(m) },
            "import { submitFeedback } from './api.server';\nexport const x = () => submitFeedback({});\n",
            join(root, 'src/plain.tsx')
        );
        expect(result).toBeNull();
        expect(warnings).toHaveLength(0);
    });

    it('stays quiet for an out-of-include <form> importing nothing form-marked', () => {
        const { resume, root } = makeWiredProject();
        const warnings: string[] = [];
        const result = resume.transform.call(
            { environment: { name: 'ssr' }, warn: (m: string) => warnings.push(m) },
            "import { component } from 'sigx';\nexport const F = component(() => () => <form><input /></form>);\n",
            join(root, 'src/NoTarget.tsx')
        );
        expect(result).toBeNull();
        expect(warnings).toHaveLength(0);
    });

    it("role: 'client' builds never stamp", () => {
        const { resume, root } = makeWiredProject({ role: 'client' });
        const file = join(root, 'src/Feedback.resume.tsx');
        const result = resume.transform.call(
            { environment: { name: 'ssr' }, warn: () => {} },
            FEEDBACK,
            file
        );
        expect(result.code).not.toContain('action=');
    });
});
