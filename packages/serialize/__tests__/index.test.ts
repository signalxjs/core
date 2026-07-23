import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    encodeWithHandlers,
    reviveWithHandlers,
    defineTypeHandler,
    BUILTIN_TYPE_HANDLERS,
    type TypeHandler,
} from '../src/index';

/** Encode → JSON → parse → revive: the actual wire path, not just the halves. */
function roundTrip(value: unknown, handlers: readonly TypeHandler[] = []): unknown {
    const json = JSON.stringify(encodeWithHandlers(value, handlers));
    return reviveWithHandlers(JSON.parse(json), handlers);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('built-in type vocabulary', () => {
    it('round-trips a Date as a live Date', () => {
        const d = new Date('2026-07-21T10:00:00.000Z');
        const out = roundTrip(d) as Date;
        expect(out).toBeInstanceOf(Date);
        expect(out.getTime()).toBe(d.getTime());
    });

    it('round-trips an Invalid Date', () => {
        const out = roundTrip(new Date(NaN)) as Date;
        expect(out).toBeInstanceOf(Date);
        expect(Number.isNaN(out.getTime())).toBe(true);
    });

    it('round-trips a Map, including its value types', () => {
        const m = new Map<string, unknown>([
            ['a', 1],
            ['at', new Date(5)],
        ]);
        const out = roundTrip(m) as Map<string, unknown>;
        expect(out).toBeInstanceOf(Map);
        expect(out.get('a')).toBe(1);
        expect(out.get('at')).toBeInstanceOf(Date);
        expect((out.get('at') as Date).getTime()).toBe(5);
    });

    it('round-trips a Map with non-string keys', () => {
        const out = roundTrip(new Map([[1, 'one']])) as Map<number, string>;
        expect(out.get(1)).toBe('one');
    });

    it('round-trips a Set', () => {
        const out = roundTrip(new Set(['a', 'b'])) as Set<string>;
        expect(out).toBeInstanceOf(Set);
        expect([...out]).toEqual(['a', 'b']);
    });

    it('round-trips a BigInt — the value that used to throw in stringify', () => {
        expect(() => JSON.stringify(10n)).toThrow();
        expect(roundTrip(10n)).toBe(10n);
        expect(roundTrip({ total: 9007199254740993n })).toEqual({
            total: 9007199254740993n,
        });
    });

    it('round-trips a URL', () => {
        const out = roundTrip(new URL('https://example.com/a?b=1')) as URL;
        expect(out).toBeInstanceOf(URL);
        expect(out.href).toBe('https://example.com/a?b=1');
    });

    it('round-trips a RegExp with its flags', () => {
        const out = roundTrip(/ab+c/giu) as RegExp;
        expect(out).toBeInstanceOf(RegExp);
        expect(out.source).toBe('ab+c');
        expect(out.flags).toBe('giu');
    });

    it('preserves an explicit undefined property instead of dropping it', () => {
        // The plain-JSON behaviour this replaces: the key vanishes entirely.
        expect(JSON.parse(JSON.stringify({ a: undefined, b: 1 }))).toEqual({ b: 1 });

        const out = roundTrip({ a: undefined, b: 1 }) as Record<string, unknown>;
        expect('a' in out).toBe(true);
        expect(out.a).toBeUndefined();
        expect(out.b).toBe(1);
    });

    it('preserves undefined in an array slot instead of nulling it', () => {
        expect(roundTrip([1, undefined, 3])).toEqual([1, undefined, 3]);
    });

    it('leaves JSON-native values untouched', () => {
        const value = { s: 'x', n: 1, b: true, nul: null, arr: [1, 2], o: { k: 'v' } };
        expect(roundTrip(value)).toEqual(value);
    });

    it('handles tags nested in objects and arrays', () => {
        const out = roundTrip({
            rows: [{ at: new Date(1) }, { at: new Date(2) }],
            index: new Map([['k', new Set([new Date(3)])]]),
        }) as any;
        expect(out.rows[0].at).toBeInstanceOf(Date);
        expect(out.rows[1].at.getTime()).toBe(2);
        const inner = out.index.get('k') as Set<Date>;
        expect(inner).toBeInstanceOf(Set);
        expect([...inner][0]).toBeInstanceOf(Date);
    });
});

describe('collision escaping', () => {
    it('round-trips a user object that looks like a tag', () => {
        const out = roundTrip({ $date: 'not a date' });
        expect(out).toEqual({ $date: 'not a date' });
    });

    it('escapes on the wire so the tag is not mistaken for one', () => {
        const encoded = encodeWithHandlers({ $date: 'not a date' });
        expect(encoded).toEqual({ $esc: { $date: 'not a date' } });
    });

    it('round-trips a user object whose single key really is $esc', () => {
        expect(roundTrip({ $esc: 1 })).toEqual({ $esc: 1 });
        expect(roundTrip({ $esc: { $date: 'x' } })).toEqual({ $esc: { $date: 'x' } });
    });

    it('revives values inside an escaped object without reading its own key', () => {
        // A "$date" PROPERTY whose value is a real Date — both halves must survive.
        const out = roundTrip({ $date: new Date(7) }) as { $date: Date };
        expect(out.$date).toBeInstanceOf(Date);
        expect(out.$date.getTime()).toBe(7);
    });

    it('does not escape multi-key objects — they are unambiguous', () => {
        const encoded = encodeWithHandlers({ $date: 'x', other: 1 });
        expect(encoded).toEqual({ $date: 'x', other: 1 });
        expect(roundTrip({ $date: 'x', other: 1 })).toEqual({ $date: 'x', other: 1 });
    });

    it('escapes any $-prefixed sole key, including tags that do not exist yet', () => {
        expect(roundTrip({ $futureTag: 1 })).toEqual({ $futureTag: 1 });
    });
});

describe('registry handlers', () => {
    class Money {
        constructor(readonly cents: number) {}
    }
    const money: TypeHandler = {
        name: 'money',
        tag: '$money',
        test: (v) => v instanceof Money,
        serialize: (v) => (v as Money).cents,
        revive: (c) => new Money(c as number),
    };

    it('round-trips a custom class', () => {
        const out = roundTrip(new Money(500), [money]) as Money;
        expect(out).toBeInstanceOf(Money);
        expect(out.cents).toBe(500);
    });

    it('takes precedence over a built-in for the same type', () => {
        const epochOnly: TypeHandler = {
            name: 'epoch',
            tag: '$epoch',
            test: (v) => v instanceof Date,
            serialize: (v) => (v as Date).getTime(),
            revive: (n) => `epoch:${n as number}`,
        };
        expect(roundTrip(new Date(5), [epochOnly])).toBe('epoch:5');
    });

    it('still applies built-ins to types the registry does not claim', () => {
        const out = roundTrip({ paid: new Money(1), at: new Date(2) }, [money]) as any;
        expect(out.paid).toBeInstanceOf(Money);
        expect(out.at).toBeInstanceOf(Date);
    });

    it('walks nested values inside a handler payload', () => {
        const box: TypeHandler = {
            name: 'box',
            tag: '$box',
            test: (v) => v instanceof Set && (v as Set<unknown>).has('BOXED'),
            serialize: (v) => ({ at: [...(v as Set<unknown>)][1] }),
            revive: (p) => (p as { at: unknown }).at,
        };
        const out = roundTrip(new Set(['BOXED', new Date(9)]), [box]) as Date;
        expect(out).toBeInstanceOf(Date);
        expect(out.getTime()).toBe(9);
    });
});

describe('forward and backward compatibility', () => {
    it('leaves an unknown tag in its encoded shape rather than throwing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(reviveWithHandlers({ $fromTheFuture: 1 })).toEqual({ $fromTheFuture: 1 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('$fromTheFuture'));
    });

    it('passes through a tree with no tags in it', () => {
        const value = { a: [1, { b: 'c' }], d: null };
        expect(reviveWithHandlers(value)).toEqual(value);
    });

    it('does not corrupt a non-object $esc payload it never produced', () => {
        // The encoder only ever wraps an OBJECT, so `{ $esc: 1 }` cannot have
        // come from it; unwrapping blindly would yield {} via Object.keys(1).
        expect(reviveWithHandlers({ $esc: 1 })).toEqual({ $esc: 1 });
        expect(reviveWithHandlers({ $esc: null })).toEqual({ $esc: null });
        expect(reviveWithHandlers({ $esc: [1, 2] })).toEqual({ $esc: [1, 2] });
        expect(reviveWithHandlers({ $esc: 'x' })).toEqual({ $esc: 'x' });
    });

    it('emits a tagless legacy handler payload verbatim, unescaped', () => {
        // Serialize-only handlers written before tags existed own their whole
        // encoding — wrapping their output in $esc would corrupt it.
        const legacy: TypeHandler = {
            name: 'legacy',
            test: (v) => v instanceof Date,
            serialize: (v) => ({ $legacyDate: (v as Date).getTime() }),
        };
        expect(encodeWithHandlers(new Date(5), [legacy])).toEqual({ $legacyDate: 5 });
    });
});

describe('unsupported values', () => {
    it('throws on a circular structure, matching JSON.stringify', () => {
        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic.self = cyclic;
        expect(() => encodeWithHandlers(cyclic)).toThrow(/circular/i);
    });

    it('throws on a cycle reached through an array', () => {
        const arr: unknown[] = [];
        arr.push(arr);
        expect(() => encodeWithHandlers(arr)).toThrow(/circular/i);
    });

    it('allows the same object twice when it is not a cycle', () => {
        const shared = { k: 1 };
        expect(roundTrip({ a: shared, b: shared })).toEqual({ a: { k: 1 }, b: { k: 1 } });
    });

    it('honors toJSON for values no handler claims', () => {
        const custom = { toJSON: () => ({ shaped: true }) };
        expect(encodeWithHandlers(custom)).toEqual({ shaped: true });
    });

    it('lets a handler win over toJSON, seeing the raw value', () => {
        // The whole reason handlers see pre-toJSON values: Date.toJSON would
        // otherwise have flattened it to a string before any handler ran.
        const seen: unknown[] = [];
        const spy: TypeHandler = {
            name: 'spy',
            tag: '$spy',
            test: (v) => {
                if (v instanceof Date) seen.push(v);
                return v instanceof Date;
            },
            serialize: () => 'raw',
            revive: () => 'raw',
        };
        encodeWithHandlers(new Date(5), [spy]);
        expect(seen[0]).toBeInstanceOf(Date);
    });
});

describe('BUILTIN_TYPE_HANDLERS', () => {
    it('every built-in declares both halves', () => {
        for (const h of BUILTIN_TYPE_HANDLERS) {
            expect(h.tag, h.name).toBeTruthy();
            expect(typeof h.revive, h.name).toBe('function');
        }
    });

    it('tags are unique and $-prefixed', () => {
        const tags = BUILTIN_TYPE_HANDLERS.map((h) => h.tag!);
        expect(new Set(tags).size).toBe(tags.length);
        for (const t of tags) expect(t.startsWith('$')).toBe(true);
    });
});

describe('revive is idempotent — safe on already-live values', () => {
    // The hydration blob is a MIXED store: the server writes encoded values,
    // and a client fetch writes LIVE ones back beside them
    // (runtime-core/src/async/restore.ts writeBack). A decode-on-read that
    // rebuilt live values from their enumerable keys would flatten every one
    // of them to {} — Object.keys(new Date()) is [].
    class Basket {
        items = 3;
    }

    it('returns a live Date, Map and Set untouched', () => {
        const d = new Date(5);
        const m = new Map([['a', 1]]);
        const s = new Set([1]);
        expect(reviveWithHandlers(d)).toBe(d);
        expect(reviveWithHandlers(m)).toBe(m);
        expect(reviveWithHandlers(s)).toBe(s);
    });

    it('returns live URL, RegExp and class instances untouched', () => {
        const u = new URL('https://example.com/');
        const r = /ab+c/gi;
        const b = new Basket();
        expect(reviveWithHandlers(u)).toBe(u);
        expect(reviveWithHandlers(r)).toBe(r);
        expect(reviveWithHandlers(b)).toBe(b);
    });

    it('preserves live values nested in plain objects and arrays', () => {
        const d = new Date(5);
        const out = reviveWithHandlers({ at: d, rows: [{ at: d }] }) as any;
        expect(out.at).toBe(d);
        expect(out.rows[0].at).toBe(d);
    });

    it('handles a blob mixing encoded and live entries', () => {
        // Exactly the __SIGX_ASYNC__ shape after SSR seeded one key and a
        // client fetch wrote another back.
        const live = new Date(2);
        const blob = { fromServer: { $date: 1 }, fromClient: live };
        const out = reviveWithHandlers(blob) as any;
        expect(out.fromServer).toBeInstanceOf(Date);
        expect(out.fromServer.getTime()).toBe(1);
        expect(out.fromClient).toBe(live);
    });

    it('revive(revive(x)) equals revive(x) for every built-in tag', () => {
        const encoded = encodeWithHandlers({
            at: new Date(5),
            index: new Map([['k', 1]]),
            tags: new Set(['a']),
            total: 7n,
            home: new URL('https://example.com/'),
            pattern: /ab+c/gi,
            nothing: undefined,
        });
        const once = reviveWithHandlers(JSON.parse(JSON.stringify(encoded))) as any;
        const twice = reviveWithHandlers(once) as any;
        expect(twice.at).toBeInstanceOf(Date);
        expect(twice.at.getTime()).toBe(5);
        expect(twice.index).toBeInstanceOf(Map);
        expect(twice.tags).toBeInstanceOf(Set);
        expect(twice.total).toBe(7n);
        expect(twice.home).toBeInstanceOf(URL);
        expect(twice.pattern).toBeInstanceOf(RegExp);
        expect('nothing' in twice).toBe(true);
        expect(twice.nothing).toBeUndefined();
    });

    it('still revives a null-prototype object (the blob is one)', () => {
        // assignmentJs builds __SIGX_ASYNC__ with Object.create(null).
        const blob = Object.assign(Object.create(null), { at: { $date: 5 } });
        const out = reviveWithHandlers(blob) as any;
        expect(out.at).toBeInstanceOf(Date);
    });
});

describe('defineTypeHandler + generic TypeHandler', () => {
    class Money {
        constructor(public cents: number) {}
    }

    const moneyHandler = defineTypeHandler({
        name: 'money',
        tag: '$money',
        test: (v): v is Money => v instanceof Money,
        serialize: (m) => m.cents,
        revive: (cents) => new Money(cents),
    });

    it('round-trips through the inferred handler', () => {
        const out = roundTrip({ price: new Money(1250) }, [moneyHandler]) as {
            price: Money;
        };
        expect(out.price).toBeInstanceOf(Money);
        expect(out.price.cents).toBe(1250);
    });

    it('reviveWithHandlers<T> types the result (assertion, not validation)', () => {
        const encoded = encodeWithHandlers(new Date(5));
        const revived = reviveWithHandlers<Date>(JSON.parse(JSON.stringify(encoded)));
        expect(revived.getTime()).toBe(5);
    });

    // ---- compile-time contract (checked by root `pnpm typecheck`) ----------

    it('typed, legacy, and heterogeneous handlers all satisfy the chain type', () => {
        // A typed handler flows into the unparameterized chains every
        // consumer takes (method-syntax bivariance).
        const asBase: TypeHandler = moneyHandler;

        // A pre-generic hand-cast handler compiles unchanged.
        const legacy: TypeHandler = {
            name: 'legacy-money',
            tag: '$legacy',
            test: (v) => v instanceof Money,
            serialize: (v) => (v as Money).cents,
            revive: (c) => new Money(c as number),
        };

        // Heterogeneous arrays need no cast or alias.
        const chain: readonly TypeHandler[] = [
            moneyHandler,
            legacy,
            ...BUILTIN_TYPE_HANDLERS,
        ];

        // The guard is what drives inference. Simple tests infer a predicate
        // on their own (TS 5.5 rules) — but a compound test with an
        // environment check (the url builtin's exact shape) infers plain
        // boolean, and the helper rejects it until annotated `(v): v is URL`.
        defineTypeHandler<URL>({
            name: 'bad',
            // @ts-expect-error compound test infers boolean, not a type guard —
            // annotate `(v): v is URL =>` (see the defineTypeHandler JSDoc)
            test: (v) => typeof URL !== 'undefined' && v instanceof URL,
            serialize: () => 0,
        });

        // Pairing is checked: revive must accept what serialize produced.
        defineTypeHandler<Money, number>({
            name: 'mismatched',
            test: (v): v is Money => v instanceof Money,
            serialize: (m) => m.cents,
            // @ts-expect-error string is not the number `serialize` produced
            revive: (s: string) => new Money(Number(s)),
        });

        expect(asBase.name).toBe('money');
        expect(chain.length).toBeGreaterThan(2);
    });
});
