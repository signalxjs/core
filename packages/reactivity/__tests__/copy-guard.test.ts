/**
 * The duplicate-copy guard (rfc-1.0 §3.4, #633 phase 1).
 *
 * `effect.ts` stamps `__SIGX_REACTIVITY__` at module init; this file proves
 * the stamp is there, hidden, and that `assertSingleCopy` implements the
 * policy: a second copy from ANOTHER file throws in dev and warns once in
 * prod, the SAME file re-evaluating (Vite restart, HMR `?t=`,
 * `vi.resetModules()`) restamps silently.
 *
 * The helper is driven directly rather than by re-importing: `__DEV__` is a
 * live getter in vitest, read at call time, and a foreign stamp planted on
 * the worker's `globalThis` would otherwise make the next test FILE's import
 * of `@sigx/reactivity` throw — hence the descriptor restore in `afterEach`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal } from '@sigx/reactivity';
import { assertSingleCopy, readCopyStamp } from '@sigx/reactivity/internals';
import type { CopyStamp } from '@sigx/reactivity/internals';

const KEY = '__SIGX_REACTIVITY__';
const descriptor = () => Object.getOwnPropertyDescriptor(globalThis, KEY);
const plant = (stamp: CopyStamp, enumerable = false) =>
    Object.defineProperty(globalThis, KEY, { value: stamp, writable: true, configurable: true, enumerable });

let real: PropertyDescriptor | undefined;

beforeEach(() => {
    real = descriptor();
});

afterEach(() => {
    // The worker's globalThis outlives this file: leave the REAL stamp behind.
    if (real) Object.defineProperty(globalThis, KEY, real);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('__SIGX_REACTIVITY__', () => {
    it('is stamped at module init, hidden, and names this copy', () => {
        void signal; // the import is what evaluated effect.ts
        const d = descriptor()!;
        expect(d.enumerable).toBe(false);
        expect(d.writable).toBe(true);
        expect(d.configurable).toBe(true);
        expect(Object.keys(globalThis)).not.toContain(KEY);

        const stamp = readCopyStamp(KEY)!;
        expect(stamp.url).toMatch(/packages\/reactivity\/src\/effect\.ts$/);
        expect(stamp.version).toBe(__SIGX_VERSION__);
        expect(stamp.warned).toBeUndefined();
    });

    it('the same file re-evaluating restamps silently — with or without an HMR query', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { url, version } = readCopyStamp(KEY)!;

        expect(() => assertSingleCopy(KEY, version, url)).not.toThrow();
        expect(() => assertSingleCopy(KEY, version, `${url}?t=1725000000000`)).not.toThrow();
        expect(() => assertSingleCopy(KEY, version, `${url}#hash`)).not.toThrow();

        expect(warn).not.toHaveBeenCalled();
        expect(descriptor()!.enumerable).toBe(false);
        expect(readCopyStamp(KEY)!.url).toBe(`${url}#hash`);
    });

    it('a copy from ANOTHER file throws in dev, naming both versions and both urls', () => {
        const foreign: CopyStamp = {
            version: '0.9.0',
            url: 'file:///app/node_modules/.pnpm/old/node_modules/@sigx/reactivity/dist/index.js'
        };
        plant(foreign);

        expect(() => assertSingleCopy(KEY, '0.15.6', 'file:///app/node_modules/@sigx/reactivity/dist/index.js'))
            .toThrow(
                /Two copies of @sigx\/reactivity are loaded: 0\.9\.0 at file:\/\/\/app\/node_modules\/\.pnpm\/old.* and 0\.15\.6 at file:\/\/\/app\/node_modules\/@sigx.*rfc-1\.0/s
            );
        // Dev does not restamp: the throw is the whole story.
        expect(readCopyStamp(KEY)).toBe(foreign);
    });

    it('a copy with no url still names the gap rather than the empty string', () => {
        plant({ version: '0.9.0', url: '' });
        expect(() => assertSingleCopy(KEY, '0.15.6', 'file:///b'))
            .toThrow(/0\.9\.0 at <unknown url> and 0\.15\.6 at file:\/\/\/b/);
    });

    it('in prod warns once, restamps with the newer copy, and stays quiet for a third', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        plant({ version: '0.9.0', url: 'file:///a' });

        assertSingleCopy(KEY, '0.15.6', 'file:///b');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/Two copies of @sigx\/reactivity.*0\.9\.0 at file:\/\/\/a and 0\.15\.6 at file:\/\/\/b/);
        expect(readCopyStamp(KEY)).toMatchObject({ version: '0.15.6', url: 'file:///b', warned: true });
        expect(descriptor()!.enumerable).toBe(false);

        // The latch rides the stamp, so a third copy does not warn again.
        assertSingleCopy(KEY, '0.16.0', 'file:///c');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(readCopyStamp(KEY)).toMatchObject({ version: '0.16.0', url: 'file:///c', warned: true });
    });

    it('HIDES a stamp an earlier plain assignment left enumerable', () => {
        // The case a partial descriptor would miss (docs/seams.md): an older
        // copy that stamped by assignment created the property enumerable.
        plant({ version: 'x', url: 'file:///same' }, true);
        expect(descriptor()!.enumerable).toBe(true);

        assertSingleCopy(KEY, 'x', 'file:///same');
        expect(descriptor()!.enumerable).toBe(false);
        expect(Object.keys(globalThis)).not.toContain(KEY);
    });
});
