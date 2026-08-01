/**
 * @vitest-environment node
 *
 * The RPC transport binding of the boundary codec (#568).
 *
 * `wire-codec.ts` is small and entirely about ONE decision: where the per-app
 * type handlers come from on this boundary. They arrive through the
 * `__SIGX_SERVERFN_CODEC__` global — no import in either direction, so both the
 * client stub entry and the endpoint stay dependency-free — and a malformed
 * registry is documented to be IGNORED rather than allowed to break the call.
 * That branch had no test of its own; it was only ever reached incidentally.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { encodeWire, reviveWire, type TypeHandler } from '../src/wire-codec';

type CodecGlobal = { __SIGX_SERVERFN_CODEC__?: unknown };

afterEach(() => {
    delete (globalThis as CodecGlobal).__SIGX_SERVERFN_CODEC__;
});

class Money {
    constructor(readonly cents: number) {}
}

const moneyHandler: TypeHandler = {
    name: 'money',
    tag: '$money',
    test: (v): v is Money => v instanceof Money,
    serialize: (v) => (v as Money).cents,
    revive: (raw) => new Money(raw as number)
};

describe('wire-codec — the built-in vocabulary with no registry', () => {
    it('carries the built-ins in both directions', () => {
        expect(encodeWire(new Date(0))).toEqual({ $date: 0 });
        expect(reviveWire({ $date: 0 })).toEqual(new Date(0));
        expect(reviveWire(encodeWire(new Set(['a'])))).toEqual(new Set(['a']));
        expect(reviveWire(encodeWire(new Map([['k', 1]])))).toEqual(new Map([['k', 1]]));
        expect(reviveWire(encodeWire(42n))).toBe(42n);
    });
});

describe('wire-codec — a malformed __SIGX_SERVERFN_CODEC__ is ignored', () => {
    // Documented behavior: "A malformed registry is ignored rather than
    // allowed to break the call." Every shape below is something a
    // mis-implemented pack could stamp; none may throw, and none may change
    // what the built-ins do.
    const malformed: Array<[string, unknown]> = [
        ['undefined', undefined],
        ['null', null],
        ['an object', {}],
        ['a string', 'nope'],
        ['a number', 42],
        ['a function', () => {}],
        ['an array-LIKE', { length: 2, 0: moneyHandler, 1: moneyHandler }]
    ];

    for (const [label, value] of malformed) {
        it(`ignores ${label}`, () => {
            (globalThis as CodecGlobal).__SIGX_SERVERFN_CODEC__ = value;
            expect(() => encodeWire({ at: new Date(0) })).not.toThrow();
            expect(encodeWire({ at: new Date(0) })).toEqual({ at: { $date: 0 } });
            expect(() => reviveWire({ at: { $date: 0 } })).not.toThrow();
            expect(reviveWire({ at: { $date: 0 } })).toEqual({ at: new Date(0) });
        });
    }
});

describe('wire-codec — a valid registry', () => {
    it('is consulted on both halves, ahead of the built-ins', () => {
        (globalThis as CodecGlobal).__SIGX_SERVERFN_CODEC__ = [moneyHandler];
        const encoded = encodeWire({ price: new Money(1999) });
        expect(encoded).toEqual({ price: { $money: 1999 } });
        const revived = reviveWire(encoded) as { price: Money };
        expect(revived.price).toBeInstanceOf(Money);
        expect(revived.price.cents).toBe(1999);
    });

    it('is read PER CALL, so a late install still applies', () => {
        // `configureServerFn` / `registerWireTypeHandlers` can stamp the seam
        // after the module has been evaluated — memoizing the lookup would
        // silently drop every handler installed after the first encode.
        // No handler yet: the class instance flattens to its own enumerable
        // fields and the prototype is gone — a lossy success, and the reason
        // the codec dev-warns about this shape (#565).
        expect(encodeWire({ price: new Money(1999) })).toEqual({ price: { cents: 1999 } });

        (globalThis as CodecGlobal).__SIGX_SERVERFN_CODEC__ = [moneyHandler];
        const revived = reviveWire({ price: { $money: 1999 } }) as { price: Money };
        expect(revived.price).toBeInstanceOf(Money);
    });
});
