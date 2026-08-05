/**
 * Seam visibility (#634) — the split this repo now maintains on `globalThis`:
 *
 * - **Pack-internal seams are NON-ENUMERABLE.** Nobody reads them off the
 *   global by hand, so they have no business in `Object.keys(globalThis)` or
 *   a devtools completion list.
 * - **Wire seams stay ENUMERABLE.** `__SIGX_ASYNC__` and `__SIGX_BOUNDARIES__`
 *   are written by the emitted inline script (`assignmentJs`), so hiding them
 *   would change wire bytes — and they are the page's debuggable data cache,
 *   the same posture as `__NEXT_DATA__` / `__NUXT__`.
 *
 * Both halves rot silently without an assertion: a plain assignment anywhere
 * re-creates a deleted property as enumerable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { declareLiveClient, provideTypeHandlers, writeBack } from '@sigx/runtime-core/internals';
import { defineTypeHandler } from '@sigx/serialize';

type Seams = {
    __SIGX_LIVE_CLIENT__?: unknown;
    __SIGX_TYPE_HANDLERS__?: unknown;
    __SIGX_ASYNC__?: Record<string, unknown>;
};

function descriptor(name: keyof Seams): PropertyDescriptor | undefined {
    return Object.getOwnPropertyDescriptor(globalThis, name);
}

afterEach(() => {
    // `declareLiveClient` also sets module-local state that no API resets, so
    // a `false` declaration would make every later test's `writeBack` inert
    // (the accessors gate on `isLiveClient()`). Re-declare live, THEN drop the
    // marker — happy-dom's window makes `true` the honest value here anyway.
    declareLiveClient(true);
    const g = globalThis as Seams;
    delete g.__SIGX_LIVE_CLIENT__;
    delete g.__SIGX_TYPE_HANDLERS__;
    delete g.__SIGX_ASYNC__;
});

describe('pack-internal seams are hidden', () => {
    it('__SIGX_LIVE_CLIENT__ is non-enumerable but reads back', () => {
        declareLiveClient(true);
        expect(descriptor('__SIGX_LIVE_CLIENT__')?.enumerable).toBe(false);
        expect(Object.keys(globalThis)).not.toContain('__SIGX_LIVE_CLIENT__');
        // Hidden, not unreadable — `@sigx/server` reads this by name.
        expect((globalThis as Seams).__SIGX_LIVE_CLIENT__).toBe(true);
        // An explicit not-live override still lands (the contract is `boolean`).
        declareLiveClient(false);
        expect((globalThis as Seams).__SIGX_LIVE_CLIENT__).toBe(false);
        expect(descriptor('__SIGX_LIVE_CLIENT__')?.enumerable).toBe(false);
    });

    it('__SIGX_TYPE_HANDLERS__ is non-enumerable and still accumulates', () => {
        const handler = defineTypeHandler({
            name: 'x',
            tag: '$x',
            test: (v): v is string => typeof v === 'string' && v === 'x',
            serialize: () => 1,
            revive: () => 'x' as const
        });
        const appContext = { provides: new Map<symbol, unknown>() };
        provideTypeHandlers(appContext, [handler]);
        expect(descriptor('__SIGX_TYPE_HANDLERS__')?.enumerable).toBe(false);
        expect(Object.keys(globalThis)).not.toContain('__SIGX_TYPE_HANDLERS__');
        expect((globalThis as Seams).__SIGX_TYPE_HANDLERS__).toEqual([handler]);

        // A second install appends rather than replacing, and the property
        // must not become enumerable on the way.
        provideTypeHandlers(appContext, [handler]);
        expect((globalThis as Seams).__SIGX_TYPE_HANDLERS__).toHaveLength(2);
        expect(descriptor('__SIGX_TYPE_HANDLERS__')?.enumerable).toBe(false);
    });
});

describe('wire seams stay visible', () => {
    it('__SIGX_ASYNC__ is a plain enumerable property', () => {
        // The blob is the page's data cache and a documented debugging
        // surface; it is also written by the emitted script as a plain
        // assignment, so a non-enumerable descriptor here would be a lie
        // about what the server produces.
        writeBack('user', { name: 'Ada' });
        expect(descriptor('__SIGX_ASYNC__')?.enumerable).toBe(true);
        expect(Object.keys(globalThis)).toContain('__SIGX_ASYNC__');
    });

    it('a foreign producer can still create the blob by plain assignment', () => {
        // @sigx/store (separate repo) seeds its own slices this way — the
        // interop contract behind async-coexistence.test.tsx.
        (globalThis as Seams).__SIGX_ASYNC__ = Object.assign(Object.create(null), {
            'store:cart': { items: 3 }
        });
        writeBack('user', { name: 'Ada' });
        expect((globalThis as Seams).__SIGX_ASYNC__).toEqual({
            'store:cart': { items: 3 },
            user: { name: 'Ada' }
        });
    });
});
