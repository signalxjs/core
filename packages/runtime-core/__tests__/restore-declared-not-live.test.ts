/**
 * The declaration wins in BOTH directions (#407): with a window present
 * (happy-dom), `declareLiveClient(false)` makes the `__SIGX_ASYNC__`
 * accessors inert — an embedder that says "not a live client" gets no blob
 * pickup and no writeback. Module-level `declared` state — this file relies
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

describe('restore accessors under declareLiveClient(false) with a window', () => {
    it('all three accessors are inert', () => {
        declareLiveClient(false);
        (globalThis as { __SIGX_ASYNC__?: unknown }).__SIGX_ASYNC__ = { seeded: 1 };

        expect(peekRestored('seeded')).toEqual({ hit: false, value: undefined });
        invalidateRestored('seeded');
        expect(((globalThis as any).__SIGX_ASYNC__ as any).seeded).toBe(1); // no-op
        writeBack('written', 2);
        expect('written' in ((globalThis as any).__SIGX_ASYNC__ as object)).toBe(false);
    });
});
