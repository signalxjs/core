/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { defineLibConfig } from '../src/lib';

describe('defineLibConfig — defaults', () => {
    it('produces a sensible default config from a single entry path', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts' });

        expect(config.build).toBeDefined();
        expect(config.build.outDir).toBe('dist');
        expect(config.build.sourcemap).toBe(true);
        expect(config.build.emptyOutDir).toBe(true);
        expect(config.build.lib.formats).toEqual(['es']);
        expect(config.build.lib.entry).toEqual({ index: 'src/index.ts' });
        expect(config.build.minify).toBe('oxc');
    });

    it('renders fileName as `${entryName}.js`', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts' });
        expect(config.build.lib.fileName('es', 'index')).toBe('index.js');
        expect(config.build.lib.fileName('es', 'utils')).toBe('utils.js');
    });

    it('uses process.cwd() as the root when none provided', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts' });
        expect(config.root).toBe(process.cwd());
    });
});

describe('defineLibConfig — entry normalization', () => {
    it('accepts a record of entry paths', () => {
        const config: any = defineLibConfig({
            entry: { index: 'src/index.ts', client: 'src/client.ts' }
        });
        expect(config.build.lib.entry).toEqual({
            index: 'src/index.ts',
            client: 'src/client.ts'
        });
    });

    it('accepts a LibEntry[] array form', () => {
        const config: any = defineLibConfig({
            entry: [
                { name: 'index', entry: 'src/index.ts' },
                { name: 'server/index', entry: 'src/server/index.ts' }
            ]
        });
        expect(config.build.lib.entry).toEqual({
            'index': 'src/index.ts',
            'server/index': 'src/server/index.ts'
        });
    });
});

describe('defineLibConfig — external merging', () => {
    function externalsAsStrings(config: any): string[] {
        return (config.build.rolldownOptions.external as Array<string | RegExp>).map(e =>
            e instanceof RegExp ? `re:${e.source}` : `str:${e}`
        );
    }

    it('always prepends SIGX runtime externals before caller externals', () => {
        const config: any = defineLibConfig({
            entry: 'src/index.ts',
            external: ['lodash']
        });
        const ext = externalsAsStrings(config);
        // Runtime externals come first
        expect(ext[0]).toBe('str:sigx');
        // Caller's external appears at the end
        expect(ext[ext.length - 1]).toBe('str:lodash');
    });

    it('deduplicates string externals already present in runtime defaults', () => {
        const config: any = defineLibConfig({
            entry: 'src/index.ts',
            external: ['sigx', '@sigx/reactivity', 'lodash']
        });
        const ext = externalsAsStrings(config);
        const sigxCount = ext.filter(e => e === 'str:sigx').length;
        const reactivityCount = ext.filter(e => e === 'str:@sigx/reactivity').length;
        expect(sigxCount).toBe(1);
        expect(reactivityCount).toBe(1);
    });

    it('deduplicates RegExp externals by source', () => {
        const config: any = defineLibConfig({
            entry: 'src/index.ts',
            external: [/^sigx\//, /^custom\//]
        });
        const ext = externalsAsStrings(config);
        const sigxRe = ext.filter(e => e === 're:^sigx\\/').length;
        expect(sigxRe).toBe(1);
        expect(ext.includes('re:^custom\\/')).toBe(true);
    });
});

describe('defineLibConfig — alias resolution', () => {
    it('resolves alias paths against the supplied root', () => {
        const root = '/tmp/lib-test-root';
        const config: any = defineLibConfig({
            entry: 'src/index.ts',
            root,
            alias: { '@sigx/reactivity': '../reactivity/src/index.ts' }
        });
        expect(config.resolve.alias['@sigx/reactivity']).toBe(
            path.resolve(root, '../reactivity/src/index.ts')
        );
    });

    it('accepts a file:// URL as the root (import.meta.url style)', () => {
        // Build the root URL from a real absolute path so this test runs on
        // both POSIX and Windows (where file URLs need drive-letter prefixes).
        const absFile = path.resolve(process.cwd(), 'vite.config.ts');
        const root = pathToFileURL(absFile).href;
        const expectedRootDir = path.dirname(fileURLToPath(root));

        const config: any = defineLibConfig({
            entry: 'src/index.ts',
            root,
            alias: { foo: 'bar.ts' }
        });
        expect(config.root).toBe(expectedRootDir);
        expect(config.resolve.alias.foo).toBe(path.resolve(expectedRootDir, 'bar.ts'));
    });

    it('returns an empty alias map when no alias option provided', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts' });
        expect(config.resolve.alias).toEqual({});
    });
});

describe('defineLibConfig — options & flags', () => {
    it('disables minification when minify=false', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts', minify: false });
        expect(config.build.minify).toBe(false);
    });

    it('disables sourcemaps when sourcemap=false', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts', sourcemap: false });
        expect(config.build.sourcemap).toBe(false);
    });

    it('emits a custom outDir', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts', outDir: 'build/out' });
        expect(config.build.outDir).toBe('build/out');
    });

    it('sets target=node18 when platform=node', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts', platform: 'node' });
        expect(config.build.target).toBe('node18');
    });

    it('omits build.target for browser platform', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts', platform: 'browser' });
        expect(config.build.target).toBeUndefined();
    });

    it('attaches sigx JSX oxc config when jsx=true', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts', jsx: true });
        expect(config.oxc).toEqual({
            jsx: { runtime: 'automatic', importSource: 'sigx' }
        });
    });

    it('omits oxc block when jsx defaults to false', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts' });
        expect(config.oxc).toBeUndefined();
    });

    it('propagates a banner into rolldownOptions.output', () => {
        const config: any = defineLibConfig({
            entry: 'src/index.ts',
            banner: '#!/usr/bin/env node'
        });
        expect(config.build.rolldownOptions.output.banner).toBe('#!/usr/bin/env node');
    });

    it('omits rolldownOptions.output when no banner provided', () => {
        const config: any = defineLibConfig({ entry: 'src/index.ts' });
        expect(config.build.rolldownOptions.output).toBeUndefined();
    });
});
