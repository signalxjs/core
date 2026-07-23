/**
 * @vitest-environment node
 *
 * The `__SIGX_ASYNC__` accessors gate on `isLiveClient()`, not `typeof
 * window` (#407): a windowless runtime that declares itself live (lynx,
 * terminal) reads and writes an embedder-installed
 * `globalThis.__SIGX_ASYNC__`; undeclared windowless runtimes (servers)
 * stay inert. Node environment — no window, so the fallback says "not
 * live" until declared. Module-level `declared` state — this file relies
 * on vitest's per-file module isolation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
    declareLiveClient,
    peekRestored,
    invalidateRestored,
    writeBack
} from '@sigx/runtime-core/internals';

afterEach(() => {
    delete (globalThis as { __SIGX_ASYNC__?: unknown }).__SIGX_ASYNC__;
    delete (globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__;
});

describe('restore accessors on a windowless runtime', () => {
    it('stays inert while undeclared, goes live after declareLiveClient(true)', () => {
        // Undeclared + no window: a server. Even a present blob must not be
        // readable — a long-lived Node process could otherwise leak one
        // request's blob into another.
        (globalThis as { __SIGX_ASYNC__?: unknown }).__SIGX_ASYNC__ = { seeded: 1 };
        expect(peekRestored('seeded')).toEqual({ hit: false, value: undefined });
        invalidateRestored('seeded');
        expect(((globalThis as any).__SIGX_ASYNC__ as any).seeded).toBe(1); // no-op
        writeBack('written', 2);
        expect('written' in ((globalThis as any).__SIGX_ASYNC__ as object)).toBe(false);

        // Declared live (what lynx/terminal do at import): the same blob is
        // now the page-lifetime data cache, decoded through the codec.
        declareLiveClient(true);
        (globalThis as { __SIGX_ASYNC__?: unknown }).__SIGX_ASYNC__ = {
            seeded: 1,
            when: { $date: 1735689600000 }
        };

        expect(peekRestored('seeded')).toEqual({ hit: true, value: 1 });
        const revived = peekRestored('when');
        expect(revived.hit).toBe(true);
        expect(revived.value).toBeInstanceOf(Date);
        expect((revived.value as Date).getTime()).toBe(1735689600000);

        invalidateRestored('seeded');
        expect(peekRestored('seeded')).toEqual({ hit: false, value: undefined });

        // writeBack lazily creates a null-prototype blob when absent
        delete (globalThis as { __SIGX_ASYNC__?: unknown }).__SIGX_ASYNC__;
        writeBack('fresh', 'v');
        const blob = (globalThis as any).__SIGX_ASYNC__;
        expect(Object.getPrototypeOf(blob)).toBe(null);
        expect(peekRestored('fresh')).toEqual({ hit: true, value: 'v' });
    });
});
