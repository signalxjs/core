/**
 * The boundary codec end-to-end across the hydration seam (#374).
 *
 * Before this, nothing asserted that a `Date` in SSR state survived to the
 * client — the whole suite passed with the write side emitting tags and no
 * reader decoding them. These tests pair each emitter with its reader so a
 * one-sided change fails loudly.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { assignmentJs, stringifyWithHandlers, serializeBoundaryProps } from '../src/server/serialize';
import { serializeSignalState } from '../src/server/state-signals';
import { peekRestored, writeBack, reviveFromServer, type TypeHandler } from 'sigx/internals';

/** Execute an emitted assignment the way the browser would. */
function runAssignment(js: string): void {
    // eslint-disable-next-line no-new-func
    new Function('window', js)(globalThis);
}

afterEach(() => {
    delete (globalThis as any).__SIGX_ASYNC__;
    delete (globalThis as any).__SIGX_TYPE_HANDLERS__;
    vi.unstubAllGlobals();
});

describe('__SIGX_ASYNC__ — server emit → client restore', () => {
    it('round-trips a Date through the real assignment script', () => {
        runAssignment(assignmentJs('__SIGX_ASYNC__', { order: { createdAt: new Date(1_700_000_000_000) } }, []));

        const restored = peekRestored('order');
        expect(restored.hit).toBe(true);
        const value = restored.value as { createdAt: Date };
        expect(value.createdAt).toBeInstanceOf(Date);
        expect(value.createdAt.getTime()).toBe(1_700_000_000_000);
    });

    it('round-trips Map, Set, BigInt and an explicit undefined', () => {
        runAssignment(
            assignmentJs(
                '__SIGX_ASYNC__',
                { k: { index: new Map([['a', 1]]), tags: new Set(['x']), total: 42n, missing: undefined } },
                []
            )
        );

        const v = peekRestored('k').value as any;
        expect(v.index).toBeInstanceOf(Map);
        expect(v.index.get('a')).toBe(1);
        expect(v.tags).toBeInstanceOf(Set);
        expect(v.total).toBe(42n);
        expect('missing' in v).toBe(true);
        expect(v.missing).toBeUndefined();
    });

    it('leaves plain JSON data byte-identical on the wire', () => {
        expect(stringifyWithHandlers({ ok: [1, 2, { deep: true }] }, [])).toBe(
            '{"ok":[1,2,{"deep":true}]}'
        );
    });

    it('escapes a user object that looks like a tag, and restores it intact', () => {
        runAssignment(assignmentJs('__SIGX_ASYNC__', { k: { $date: 'just a string' } }, []));
        expect(peekRestored('k').value).toEqual({ $date: 'just a string' });
    });

    it('does not corrupt a live value written back after a client fetch', () => {
        // The blob is a MIXED store: this is the #369 scenario.
        runAssignment(assignmentJs('__SIGX_ASYNC__', { fromServer: new Date(1) }, []));
        const live = new Date(2);
        writeBack('fromClient', live);

        expect((peekRestored('fromServer').value as Date).getTime()).toBe(1);
        expect(peekRestored('fromClient').value).toBe(live);
    });

    it('re-reading the same key stays stable (decode is idempotent)', () => {
        runAssignment(assignmentJs('__SIGX_ASYNC__', { k: { at: new Date(5) } }, []));
        const first = peekRestored('k').value as { at: Date };
        const second = peekRestored('k').value as { at: Date };
        expect(first.at).toBeInstanceOf(Date);
        expect(second.at).toBeInstanceOf(Date);
        expect(second.at.getTime()).toBe(first.at.getTime());
    });
});

describe('registered handlers reach the client through the global seam', () => {
    class Money {
        constructor(readonly cents: number) {}
    }
    const money: TypeHandler = {
        name: 'money',
        tag: '$money',
        test: (v) => v instanceof Money,
        serialize: (v) => (v as Money).cents,
        revive: (c) => new Money(c as number)
    };

    it('revives a custom class when the handler is stamped', () => {
        runAssignment(assignmentJs('__SIGX_ASYNC__', { k: new Money(500) }, [money]));
        (globalThis as any).__SIGX_TYPE_HANDLERS__ = [money];

        const v = peekRestored('k').value as Money;
        expect(v).toBeInstanceOf(Money);
        expect(v.cents).toBe(500);
    });

    it('leaves the tag encoded — and does not throw — when no handler is stamped', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        runAssignment(assignmentJs('__SIGX_ASYNC__', { k: new Money(500) }, [money]));
        expect(peekRestored('k').value).toEqual({ $money: 500 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('$money'));
    });
});

describe('boundary payloads — props and state admit the same values', () => {
    it('accepts codec-owned values in BOTH props and signal state', () => {
        const at = new Date(5);
        const props = serializeBoundaryProps({ at, total: 42n }, []);
        const state = serializeSignalState(new Map<string, any>([['at', at], ['total', 42n]]), []);

        // Previously: props kept `at` (registered-handler bypass) and dropped
        // `total`; state dropped both, with no handlers parameter at all.
        expect(props).toEqual({ at, total: 42n });
        expect(state).toEqual({ at, total: 42n });
    });

    it('rejects prototype-polluting keys in both, even when codec-owned', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // A handler claiming the value used to skip the DANGEROUS_KEYS check.
        expect(serializeBoundaryProps({ __proto__: new Date(5) } as any, [])).toBeUndefined();
        expect(serializeSignalState(new Map([['__proto__', new Date(5)]]), [])).toBeUndefined();
        warn.mockRestore();
    });

    it('still drops functions and symbols from props', () => {
        expect(serializeBoundaryProps({ fn: () => {}, sym: Symbol('s') }, [])).toBeUndefined();
    });
});

describe('reviveFromServer', () => {
    it('is a no-op on values that carry no tags', () => {
        const v = { a: [1, { b: 'c' }], d: null };
        expect(reviveFromServer(v)).toEqual(v);
    });

    it('decodes boundary props the same way the blob path does', () => {
        const encoded = JSON.parse(stringifyWithHandlers({ at: new Date(7) }, []));
        expect((reviveFromServer(encoded) as { at: Date }).at).toBeInstanceOf(Date);
    });
});
