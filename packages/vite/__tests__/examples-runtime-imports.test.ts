/**
 * @vitest-environment node
 *
 * `@sigx/vite` is a build tool and a devDependency; the running production
 * server never imports it (#501). A Node `server.mjs` that did
 * `await import('@sigx/vite/ssr')` in its production branch booted only
 * while dev dependencies happened to be installed — `npm ci --omit=dev` or a
 * slim Docker layer breaks it. No deploy-smoke job installs without dev
 * deps, so this is the guard: every example server keeps `@sigx/vite`
 * inside its dev branch, and reaches manifest-derived data through the
 * build's own `dist/server/sigx-app.js` (`template`, `assets`, `assetsFor`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const EXAMPLES = fileURLToPath(new URL('../../../examples', import.meta.url));

const servers = readdirSync(EXAMPLES)
    .map((name) => join(EXAMPLES, name, 'server.mjs'))
    .filter((file) => existsSync(file));

/**
 * The file with comments blanked (`/* … *\/` blocks first, then `//` lines,
 * keeping line numbers) — prose mentions are not imports. Split on CRLF too
 * and strip without `$`: a Windows checkout ends lines in `\r`, which `.`
 * never crosses, so `.*$` left the comment in place there.
 */
function codeLines(file: string): string[] {
    const raw = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));
    return raw.split(/\r?\n/).map((l) => l.replace(/\/\/.*/, ''));
}
const IMPORTS_VITE = /(?:import\s*\(\s*|from\s*)['"]@sigx\/vite(?:\/[^'"]*)?['"]/;

describe('example servers keep @sigx/vite out of production (#501)', () => {
    it('finds the Node example servers, including the two this rule was written for', () => {
        expect(servers.length).toBeGreaterThanOrEqual(1);
        for (const dir of ['spa-ssr', 'ssr-islands']) {
            expect(servers.some((f) => f.includes(join('examples', dir, 'server.mjs'))), dir).toBe(true);
        }
    });

    for (const file of servers) {
        const name = file.split(/[\\/]/).slice(-2).join('/');

        it(`${name}: every @sigx/vite import sits inside the dev branch`, () => {
            const lines = codeLines(file);
            const devStart = lines.findIndex((l) => /if\s*\(\s*!isProd\s*\)\s*\{/.test(l));
            const devEnd = lines.findIndex((l, i) => i > devStart && /^\s*\}\s*else\s*\{/.test(l));
            expect(devStart, 'an `if (!isProd) {` dev branch').toBeGreaterThanOrEqual(0);
            expect(devEnd, 'a `} else {` production branch').toBeGreaterThan(devStart);
            lines.forEach((line, i) => {
                if (IMPORTS_VITE.test(line)) {
                    expect(i > devStart && i < devEnd, `${name}:${i + 1} imports @sigx/vite outside the dev branch: ${line.trim()}`).toBe(true);
                }
            });
        });

        it(`${name}: resolves assets through sigx-app.js, not the runtime helper`, () => {
            const code = codeLines(file).join('\n');
            expect(code).not.toMatch(/\bcollectAssets\b/);
            expect(code).not.toContain('@sigx/vite/assets');
        });
    }
});
