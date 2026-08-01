/**
 * all() — combine several AsyncStates into one, for all-or-nothing gating
 * (one `match` for a whole dashboard). Partial loading wants independent
 * `match` calls instead.
 *
 * A pure derived view: no fetching, no effects — every property read
 * recomputes from the members (and subscribes through their signals).
 *
 * Derived-state rules (docs/rfc-async.md rev 8):
 * - any member 'idle'      ⇒ combined 'idle' (a conditional member holds the gate)
 * - else any 'errored'     ⇒ combined 'errored' (`.error` is first-error-wins;
 *                            `.errors` collects all)
 * - else any 'pending'     ⇒ combined 'pending' (until ALL first settle)
 * - else any 'refreshing'  ⇒ combined 'refreshing' (all members have values —
 *                            keeps rendering the ready arm)
 * - else                   ⇒ 'ready'
 */

import {
    matchAsyncState,
    makeUnhandledReporter,
    isCell,
    CELL,
    type AsyncState,
    type AsyncStateImpl,
    type AsyncStateName,
    type MatchArms,
} from './async/shared.js';
import { getCurrentInstance } from './component-lifecycle.js';

/**
 * An intersection, not an interface — `AsyncState` is a union, and
 * intersecting distributes over its members so discriminant narrowing
 * (`if (x.hasValue) x.value // T`) works through the combination too.
 */
export type AllState<T, E> = AsyncState<T> & {
    /** Collect-all counterpart to first-error-wins `.error`. */
    readonly errors: E;
};

type ValuesOf<S> = { [K in keyof S]: S[K] extends AsyncState<infer V> ? V : never };
type ErrorsOf<S> = { [K in keyof S]: Error | null };

/** Object form (primary): `all({ user, posts })` — named value/errors records. */
export function all<S extends Record<string, AsyncState<unknown>>>(
    sources: S
): AllState<ValuesOf<S>, ErrorsOf<S>>;
/** Rest-tuple form for quick cases: `all(user, posts)` — positional tuples. */
export function all<S extends readonly AsyncState<unknown>[]>(
    ...sources: S
): AllState<ValuesOf<S>, ErrorsOf<S>>;
export function all(...sources: unknown[]): AllState<unknown, unknown> {
    // A single non-cell object is the record form; anything else (including
    // a single branded cell) is the tuple form.
    const record =
        sources.length === 1 && typeof sources[0] === 'object' && sources[0] !== null && !isCell(sources[0])
            ? (sources[0] as Record<string, AsyncState<unknown>>)
            : null;
    const keys = record ? Object.keys(record) : null;
    const members: AsyncState<unknown>[] = record
        ? keys!.map((k) => record[k])
        : (sources as AsyncState<unknown>[]);

    function combinedState(): AsyncStateName {
        let idle = false;
        let errored = false;
        let pending = false;
        let refreshing = false;
        // No early exit: every member's state is read so the reader
        // subscribes to all of them.
        for (const m of members) {
            const s = m.state;
            if (s === 'idle') idle = true;
            else if (s === 'errored') errored = true;
            else if (s === 'pending') pending = true;
            else if (s === 'refreshing') refreshing = true;
        }
        return idle ? 'idle' : errored ? 'errored' : pending ? 'pending' : refreshing ? 'refreshing' : 'ready';
    }

    /** Presence combines as EVERY member having a value (#485) — including
     *  members holding last-good through 'errored' (SWR-through-error), so a
     *  member that legitimately resolved null still counts as present. */
    function combinedHasValue(): boolean {
        // No early exit: every member is read so the reader subscribes to all.
        let has = true;
        for (const m of members) has = m.hasValue && has;
        return has;
    }

    function combinedValue(): unknown {
        if (!combinedHasValue()) return null;
        if (record) {
            const out: Record<string, unknown> = {};
            for (const k of keys!) out[k] = record[k].value;
            return out;
        }
        return members.map((m) => m.value);
    }

    function firstError(): Error | null {
        for (const m of members) {
            if (m.error) return m.error;
        }
        return null;
    }

    function combinedErrors(): unknown {
        if (record) {
            const out: Record<string, Error | null> = {};
            for (const k of keys!) out[k] = record[k].error;
            return out;
        }
        return members.map((m) => m.error);
    }

    function refresh(): Promise<void> {
        // Members' refresh() never rejects, so neither does the combination.
        return Promise.all(members.map((m) => m.refresh())).then(() => undefined);
    }

    const reportUnhandled = makeUnhandledReporter(getCurrentInstance(), 'all');

    // Wide impl shape, cast to the union at the return — see AsyncStateImpl.
    const impl: AsyncStateImpl<unknown> & { readonly errors: unknown } = {
        get state() {
            return combinedState();
        },
        get value() {
            return combinedValue();
        },
        get hasValue() {
            return combinedHasValue();
        },
        get error() {
            return firstError();
        },
        get errors() {
            return combinedErrors();
        },
        get loading() {
            return combinedState() === 'pending';
        },
        match<R>(arms: MatchArms<unknown, R>): R | undefined {
            return matchAsyncState<unknown, R>(
                {
                    state: combinedState(),
                    value: combinedValue(),
                    hasValue: combinedHasValue(),
                    error: firstError(),
                    retry: () => void refresh(),
                    onUnhandledError: reportUnhandled,
                },
                arms
            );
        },
        refresh,
    };
    Object.defineProperty(impl, CELL, { value: true });

    return impl as AllState<unknown, unknown>;
}
