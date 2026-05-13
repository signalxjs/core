/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
    extractComponents,
    generateDts,
    generateComponentsTs,
    matchGlob,
    shouldProcess
} from '../src/cli';

describe('extractComponents', () => {
    it('extracts a single named const component', () => {
        const code = `export const Button = component('my-button', (ctx) => { return () => null });`;
        const result = extractComponents(code, '/x/Button.tsx');
        expect(result).toEqual([
            { exportName: 'Button', tagName: 'my-button', filePath: '/x/Button.tsx' }
        ]);
    });

    it('handles multi-line generics in the regex', () => {
        const code = `
export const Card = component<
    DefineProp<"title", string>
>(
    'sigx-card',
    (ctx) => () => null
);`;
        const result = extractComponents(code, '/x/Card.tsx');
        expect(result).toEqual([
            { exportName: 'Card', tagName: 'sigx-card', filePath: '/x/Card.tsx' }
        ]);
    });

    it('extracts default exports and CamelCases the tag name', () => {
        const code = `export default component('ui-icon-button', (ctx) => () => null);`;
        const result = extractComponents(code, '/x/IconButton.tsx');
        expect(result).toEqual([
            { exportName: 'UiIconButton', tagName: 'ui-icon-button', filePath: '/x/IconButton.tsx' }
        ]);
    });

    it('returns an empty array when no component() calls are present', () => {
        expect(extractComponents('export const X = 42;', '/x/none.ts')).toEqual([]);
    });

    it('extracts multiple components from a single file', () => {
        const code = `
            export const A = component('cmp-a', () => () => null);
            const B = component('cmp-b', () => () => null);
        `;
        const result = extractComponents(code, '/x/multi.ts');
        expect(result).toHaveLength(2);
        expect(result.map(r => r.tagName).sort()).toEqual(['cmp-a', 'cmp-b']);
    });
});

describe('generateDts', () => {
    it('emits a stub when no components are found', () => {
        const out = generateDts([], '/root');
        expect(out).toContain('no components found');
        expect(out).toContain('export {};');
    });

    it('deduplicates components by tagName (first wins)', () => {
        const out = generateDts(
            [
                { tagName: 'x-card', exportName: 'CardA', filePath: '/root/a.tsx' },
                { tagName: 'x-card', exportName: 'CardB', filePath: '/root/b.tsx' }
            ],
            '/root'
        );
        expect(out).toContain('CardA');
        expect(out).not.toContain('CardB');
    });

    it('emits relative imports rooted at ../../', () => {
        const out = generateDts(
            [{ tagName: 'foo-bar', exportName: 'FooBar', filePath: '/root/src/foo.tsx' }],
            '/root'
        );
        expect(out).toContain("import type { FooBar } from '../../src/foo';");
        expect(out).toContain("'foo-bar': typeof FooBar;");
    });

    it('normalizes backslashes to forward slashes in paths', () => {
        // Simulate a Windows-style path the actual fs would emit on Win32
        const out = generateDts(
            [{ tagName: 'win-cmp', exportName: 'WinCmp', filePath: '\\root\\src\\win.tsx' }],
            '\\root'
        );
        expect(out).not.toContain('\\');
    });

    it('strips .tsx/.ts/.jsx/.js extensions from import specifiers', () => {
        const out = generateDts(
            [
                { tagName: 'ts-cmp', exportName: 'TsCmp', filePath: '/root/a.ts' },
                { tagName: 'tsx-cmp', exportName: 'TsxCmp', filePath: '/root/b.tsx' },
                { tagName: 'jsx-cmp', exportName: 'JsxCmp', filePath: '/root/c.jsx' },
                { tagName: 'js-cmp', exportName: 'JsCmp', filePath: '/root/d.js' }
            ],
            '/root'
        );
        expect(out).toContain("from '../../a'");
        expect(out).toContain("from '../../b'");
        expect(out).toContain("from '../../c'");
        expect(out).toContain("from '../../d'");
        expect(out).not.toContain('.ts\'');
        expect(out).not.toContain('.tsx\'');
    });
});

describe('generateComponentsTs', () => {
    it('returns the empty stub when no components are provided', () => {
        const out = generateComponentsTs([], '/root');
        expect(out).toContain('no components found');
    });

    it('builds nested runtime objects for hyphenated tags', () => {
        const out = generateComponentsTs(
            [
                { tagName: 'ui-button-primary', exportName: 'Button', filePath: '/root/Button.tsx' }
            ],
            '/root'
        );
        // The root prefix is 'ui'; nested under that is button.primary
        expect(out).toContain('const _ui =');
        expect(out).toContain('button:');
        expect(out).toContain('primary: Button');
        expect(out).toContain('(globalThis as any).ui = _ui;');
    });

    it('emits a global declaration block', () => {
        const out = generateComponentsTs(
            [{ tagName: 'ui-x', exportName: 'X', filePath: '/root/X.tsx' }],
            '/root'
        );
        expect(out).toContain('declare global');
        expect(out).toContain('const ui:');
    });
});

describe('matchGlob', () => {
    it('matches a globstar against nested directories', () => {
        expect(matchGlob('src/components/Button.tsx', '**/*.tsx')).toBe(true);
        expect(matchGlob('src/components/Button.ts', '**/*.tsx')).toBe(false);
    });

    it('expands single * to a non-slash segment', () => {
        // Single * matches one path segment
        expect(matchGlob('foo/bar.tsx', '*.tsx')).toBe(true);
        // The pattern is anchored at (^|/), so '*/bar.tsx' matches any '/<seg>/bar.tsx' tail
        expect(matchGlob('foo/bar.tsx', '*/bar.tsx')).toBe(true);
        // A literal directory in the pattern must be present in the path
        expect(matchGlob('foo/bar.tsx', 'baz/bar.tsx')).toBe(false);
    });

    it('escapes dots in the pattern', () => {
        expect(matchGlob('a.tsx', 'a.tsx')).toBe(true);
        // Without escaping, '.' would match any single char; verify it doesn't
        expect(matchGlob('abtsx', 'a.tsx')).toBe(false);
    });
});

describe('shouldProcess', () => {
    const opts = {
        include: ['**/*.tsx', '**/*.ts'],
        exclude: ['node_modules/**', 'dist/**', '**/*.d.ts']
    };

    it('returns true for files matching include patterns', () => {
        expect(shouldProcess('src/Button.tsx', opts)).toBe(true);
        expect(shouldProcess('lib/util.ts', opts)).toBe(true);
    });

    it('returns false for files matching exclude patterns', () => {
        expect(shouldProcess('node_modules/foo/index.ts', opts)).toBe(false);
        expect(shouldProcess('dist/bundle.tsx', opts)).toBe(false);
        expect(shouldProcess('types/components.d.ts', opts)).toBe(false);
    });

    it('returns false when path matches neither include nor exclude', () => {
        expect(shouldProcess('README.md', opts)).toBe(false);
        expect(shouldProcess('src/styles.css', opts)).toBe(false);
    });

    it('exclude takes precedence over include', () => {
        const conflicting = {
            include: ['**/*.ts'],
            exclude: ['**/secret.ts']
        };
        expect(shouldProcess('src/secret.ts', conflicting)).toBe(false);
    });

    it('normalizes backslashes before matching', () => {
        expect(shouldProcess('src\\Button.tsx', opts)).toBe(true);
    });
});
