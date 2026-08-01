/**
 * The dev-mode producer-invariant warn in `matchAsyncState` — the honesty
 * check behind every engine's `as AsyncState<T>` cast (§7 obligation 6).
 * No in-tree producer can trip it (they derive their fields from one state
 * machine), so it is exercised directly with lying views.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { matchAsyncState, type AsyncStateName } from '../src/async/shared';

function view(over: {
    state: AsyncStateName;
    value?: unknown;
    hasValue?: boolean;
    error?: Error | null;
    pendingKeepsValue?: boolean;
}) {
    return {
        value: null as unknown,
        hasValue: false,
        error: null as Error | null,
        retry: () => {},
        ...over,
    };
}

const ARMS = {
    idle: () => 'idle',
    pending: () => 'pending',
    error: () => 'error',
    ready: () => 'ready',
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    warn.mockRestore();
});

describe('matchAsyncState producer-invariant dev warn', () => {
    it('warns once per DISTINCT lie, not once per render', () => {
        // idle claiming a value — dispatch still proceeds normally.
        expect(matchAsyncState(view({ state: 'idle', hasValue: true }), ARMS)).toBe('idle');
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain("state 'idle' must have hasValue: false");

        // The same lie again: deduped.
        matchAsyncState(view({ state: 'idle', hasValue: true }), ARMS);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    // Runs BEFORE the branch-coverage test: the once-per-distinct-message
    // dedupe is module-level, so the pending lie must not have fired yet for
    // this silence to prove the exemption.
    it('pendingKeepsValue exempts actions (last success shown while pending) and honest views stay silent', () => {
        matchAsyncState(view({ state: 'pending', value: 'v', hasValue: true, pendingKeepsValue: true }), ARMS);
        // Honest views across the grid.
        matchAsyncState(view({ state: 'idle' }), ARMS);
        matchAsyncState(view({ state: 'ready', value: null, hasValue: true }), ARMS); // legit-null IS honest
        matchAsyncState(view({ state: 'errored', error: new Error('e'), value: 'stale', hasValue: true }), ARMS);
        expect(warn).not.toHaveBeenCalled();
    });

    it('covers every branch of the check', () => {
        // pending claiming a value (data cells never do).
        matchAsyncState(view({ state: 'pending', hasValue: true }), ARMS);
        // ready without a value.
        matchAsyncState(view({ state: 'ready', value: 1, hasValue: false }), ARMS);
        // refreshing without a value.
        matchAsyncState(view({ state: 'refreshing', value: 1, hasValue: false }), ARMS);
        // a non-errored state carrying an error.
        matchAsyncState(view({ state: 'ready', value: 1, hasValue: true, error: new Error('x') }), ARMS);
        // errored with no error to show.
        matchAsyncState(view({ state: 'errored', error: null }), ARMS);

        const messages: string[] = warn.mock.calls.map((c: unknown[]) => String(c[0]));
        expect(messages.some((m) => m.includes("state 'pending' must have hasValue: false"))).toBe(true);
        expect(messages.some((m) => m.includes("state 'ready' must have hasValue: true"))).toBe(true);
        expect(messages.some((m) => m.includes("state 'refreshing' must have hasValue: true"))).toBe(true);
        expect(messages.some((m) => m.includes("state 'ready' must have error: null"))).toBe(true);
        expect(messages.some((m) => m.includes("state 'errored' must carry a non-null error"))).toBe(true);
    });
});
