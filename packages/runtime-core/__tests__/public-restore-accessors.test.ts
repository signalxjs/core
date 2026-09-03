/**
 * `peekRestored` / `invalidateRestored` are public from the root entry (#449).
 *
 * `@sigx/store` seeds every store instance from the `__SIGX_ASYNC__` blob
 * through these two, and reached them via `/internals` — a subpath the 1.0
 * contract does not cover. The root entry now exports THE SAME functions:
 * not wrappers, not copies (a second copy meant a second place to apply the
 * codec, and that decode was already missed once, #369). Identity is the
 * assertion; the behaviour checks below just prove the public names read
 * and drop the same blob the engine writes.
 *
 * happy-dom environment: a window exists, so the accessors are live without
 * a declaration.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { peekRestored, invalidateRestored } from '../src';
import * as internals from '../src/internals';
import * as umbrella from 'sigx';

afterEach(() => {
    delete (globalThis as { __SIGX_ASYNC__?: unknown }).__SIGX_ASYNC__;
});

describe('public restore accessors (#449)', () => {
    it('are the /internals functions themselves, not re-implementations', () => {
        expect(peekRestored).toBe(internals.peekRestored);
        expect(invalidateRestored).toBe(internals.invalidateRestored);
    });

    it('reach `sigx` consumers through the umbrella re-export', () => {
        expect(umbrella.peekRestored).toBe(peekRestored);
        expect(umbrella.invalidateRestored).toBe(invalidateRestored);
    });

    it('read the blob through the codec, do not consume, and drop on invalidate', () => {
        (globalThis as { __SIGX_ASYNC__?: unknown }).__SIGX_ASYNC__ = Object.assign(
            Object.create(null),
            { seeded: { n: 1 }, when: { $date: 1735689600000 }, nothing: null }
        );

        // Own-key presence, not truthiness: a transferred `null` is a hit.
        expect(peekRestored('nothing')).toEqual({ hit: true, value: null });
        expect(peekRestored('absent')).toEqual({ hit: false, value: undefined });

        // Decoded at the read — THE decode point for the seam.
        const when = peekRestored('when');
        expect(when.value).toBeInstanceOf(Date);

        // Reading does not consume: the second instance seeds too.
        expect(peekRestored('seeded')).toEqual({ hit: true, value: { n: 1 } });
        expect(peekRestored('seeded')).toEqual({ hit: true, value: { n: 1 } });

        // The opt-in instance scope: peek, then invalidate.
        invalidateRestored('seeded');
        expect(peekRestored('seeded')).toEqual({ hit: false, value: undefined });
        // A missing key is a no-op, and the rest of the blob is untouched.
        invalidateRestored('seeded');
        expect(peekRestored('nothing')).toEqual({ hit: true, value: null });
    });

    it('hands back a live written-back value by reference — the copy-first rule', () => {
        // What the contract explicitly does NOT promise: a private copy. A
        // Map the engine wrote back after a client fetch is the blob's own
        // object; a pack that proxies it writes into the blob.
        const live = new Map([['a', 1]]);
        internals.writeBack('live', live);
        expect(peekRestored('live').value).toBe(live);
    });
});
