/**
 * SSRContext.registerSerializedState — the public write path into the
 * `__SIGX_ASYNC__` blob for packs that own request-scoped state (#407).
 * Emission behavior lives in async-state.test.tsx; this file pins the
 * context-method semantics (modeled on boundary-table-writers.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { createSSRContext } from '../src/index';

describe('SSRContext.registerSerializedState', () => {
    it('writes the value and marks the key unflushed', () => {
        const ctx = createSSRContext();
        ctx.registerSerializedState('store:a', { v: 1 });

        expect(ctx._asyncResults.get('store:a')).toEqual({ v: 1 });
        expect(ctx._unflushedAsyncKeys.has('store:a')).toBe(true);
    });

    it('dev-warns on an unflushed overwrite, stays silent on the post-emit patch path', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const ctx = createSSRContext();

        // Overwrite BEFORE any flush: the first value can never reach the
        // client — almost always two owners colliding on one key.
        ctx.registerSerializedState('store:a', { v: 1 });
        ctx.registerSerializedState('store:a', { v: 2 });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('store:a'));
        expect(ctx._asyncResults.get('store:a')).toEqual({ v: 2 });

        // After a flush (set drained), re-registration is the documented
        // patch path — no warning.
        ctx._unflushedAsyncKeys.clear();
        ctx.registerSerializedState('store:a', { v: 3 });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(ctx._unflushedAsyncKeys.has('store:a')).toBe(true);

        warn.mockRestore();
    });
});
