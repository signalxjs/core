/**
 * @vitest-environment node
 *
 * `@sigx/vite/server-extract` — the non-Vite-bundler subpath (rfc-server
 * rev 2, N.5): export surface + `computeStableId` (the one fs-touching
 * helper; the pure extractors are covered in server-fn-extract.test.ts /
 * server-fn-inline.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    computeStableId,
    extractServerFns,
    extractInlineServerFns,
    hash8,
    offsetToLoc,
    type PackageProbe
} from '../src/server-extract';

let tmp: string;

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sigx-stable-id-'));
    const write = (rel: string, content: string): void => {
        const file = path.join(tmp, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    };
    write('solution/packages/api/package.json', JSON.stringify({ name: '@acme/api' }));
    write('solution/packages/api/src/cart.server.ts', '');
    // A nameless manifest must be SKIPPED (walk continues to @acme/api? no —
    // nested packages: nameless/sub has no name, so the walk climbs to api).
    write('solution/packages/api/nameless/package.json', '{"private": true}');
    write('solution/packages/api/nameless/util.server.ts', '');
    // Unparsable manifest — also skipped.
    write('solution/packages/api/broken/package.json', '{not json');
    write('solution/packages/api/broken/x.server.ts', '');
    // No package.json anywhere under this subtree (relative to the tmp fs
    // root there may be OS-level manifests above tmp, but tests only assert
    // the in-tree behaviors below).
    write('bare/src/thing.server.ts', '');
});

afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('computeStableId', () => {
    it('package-qualifies via the nearest named package.json', () => {
        const file = path.join(tmp, 'solution/packages/api/src/cart.server.ts');
        expect(computeStableId(file, tmp)).toBe('@acme/api/src/cart.server.ts');
    });

    it('is root-independent — the same file under two roots mints one id', () => {
        const file = path.join(tmp, 'solution/packages/api/src/cart.server.ts');
        const a = computeStableId(file, path.join(tmp, 'solution'));
        const b = computeStableId(file, path.join(tmp, 'somewhere/else'));
        expect(a).toBe(b);
        expect(a).toBe('@acme/api/src/cart.server.ts');
    });

    it('skips nameless and unparsable manifests, continuing the walk', () => {
        const nameless = path.join(tmp, 'solution/packages/api/nameless/util.server.ts');
        expect(computeStableId(nameless, tmp)).toBe('@acme/api/nameless/util.server.ts');
        const broken = path.join(tmp, 'solution/packages/api/broken/x.server.ts');
        expect(computeStableId(broken, tmp)).toBe('@acme/api/broken/x.server.ts');
    });

    it('caches probes per directory — hits AND misses', () => {
        const cache = new Map<string, PackageProbe>();
        const file = path.join(tmp, 'solution/packages/api/src/cart.server.ts');
        computeStableId(file, tmp, cache);
        const srcDir = path.join(tmp, 'solution/packages/api/src');
        const pkgDir = path.join(tmp, 'solution/packages/api');
        expect(cache.get(srcDir)).toEqual({ name: '@acme/api', dir: pkgDir });
        expect(cache.get(pkgDir)).toEqual({ name: '@acme/api', dir: pkgDir });
        // A poisoned cache entry is authoritative — proof the second call
        // never re-reads the fs.
        cache.set(srcDir, { name: '@cached/hit', dir: pkgDir });
        expect(computeStableId(file, tmp, cache)).toBe('@cached/hit/src/cart.server.ts');
    });

    it('falls back to the build-root-relative path without a named package', () => {
        // Force the no-package outcome via a pre-seeded miss for the parent
        // chain (a real fs walk above tmp could hit an OS-level manifest).
        const cache = new Map<string, PackageProbe>();
        const file = path.join(tmp, 'bare/src/thing.server.ts');
        cache.set(path.join(tmp, 'bare/src'), null);
        expect(computeStableId(file, path.join(tmp, 'bare'), cache)).toBe('src/thing.server.ts');
    });
});

describe('export surface', () => {
    it('re-exports the pure extractors and the resume helpers', () => {
        expect(typeof extractServerFns).toBe('function');
        expect(typeof extractInlineServerFns).toBe('function');
        expect(typeof hash8).toBe('function');
        expect(typeof offsetToLoc).toBe('function');
    });
});
