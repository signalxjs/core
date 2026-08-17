import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeWithHandlers, defineTypeHandler, type TypeHandler } from '../src/index';
import { stringifyWithHandlers } from '../src/stringify';
import { bytesHandler } from '../src/bytes';

/**
 * THE DIFFERENTIAL SUITE (#657).
 *
 * `stringifyWithHandlers` is a second, independent walk of the same value, and
 * its contract is not "produces valid JSON" — it is BYTE equality with
 * `JSON.stringify(encodeWithHandlers(v, h))`, throw for throw. Everything the
 * codec emits ends up on a wire someone's client parses back: an SSR state
 * blob inside a script tag, a boundary props table, a durable actor save. A
 * "nicer" encoding is a broken one.
 *
 * So almost nothing here asserts a literal string. `parity()` runs both walks
 * and compares them; the corpus's job is to reach every branch. When the two
 * disagree, the failure names the input rather than showing a diff of two
 * blobs neither of which anyone wrote by hand.
 *
 * A handful of cases DO pin a literal, marked "pinned": those are the shapes
 * where both walks could plausibly be wrong TOGETHER (the `$esc` wrap around a
 * dropped key, the sparse-array hole), so parity alone would prove nothing.
 */

/** Both walks, compared: the returned string AND the thrown message. */
function parity(value: unknown, handlers: readonly TypeHandler[] = [], label = ''): void {
    let expected: string | undefined;
    let expectedThrow: string | undefined;
    try {
        expected = JSON.stringify(encodeWithHandlers(value, handlers));
    } catch (error) {
        expectedThrow = (error as Error).message;
    }

    let actual: string | undefined;
    let actualThrow: string | undefined;
    try {
        actual = stringifyWithHandlers(value, handlers);
    } catch (error) {
        actualThrow = (error as Error).message;
    }

    // Throw parity FIRST: a value that throws on one side and returns
    // undefined on the other would otherwise read as agreement.
    expect(actualThrow, `threw differently: ${label}`).toBe(expectedThrow);
    expect(actual, `emitted differently: ${label}`).toBe(expected);
}

/** Silence the #565 dev probe — several corpus values deliberately trip it. */
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

describe('scalars', () => {
    const NUMBERS = [
        0, -0, 1, -1, 0.5, -0.5, 1e21, 1e-7, 5e-324, 1e-323,
        Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER,
        Number.MAX_VALUE, Number.EPSILON,
        NaN, Infinity, -Infinity
    ];

    it('every number form, alone, under a key and in an array', () => {
        for (const n of NUMBERS) {
            parity(n, [], `bare ${String(n)}`);
            parity({ n }, [], `keyed ${String(n)}`);
            parity([n], [], `element ${String(n)}`);
        }
    });

    it('-0 emits as 0, and NaN/Infinity as null (pinned)', () => {
        expect(stringifyWithHandlers([-0, NaN, Infinity, -Infinity])).toBe('[0,null,null,null]');
    });

    it('null and booleans', () => {
        for (const v of [null, true, false]) {
            parity(v, [], `bare ${String(v)}`);
            parity({ v }, [], `keyed ${String(v)}`);
            parity([v], [], `element ${String(v)}`);
        }
    });
});

// ---------------------------------------------------------------------------
// Strings — the escape boundary, as values AND as keys
// ---------------------------------------------------------------------------

describe('string escaping', () => {
    /**
     * The boundary cases. JSON.stringify escapes C0 controls, the quote, the
     * backslash and every surrogate code unit — and NOTHING else. The
     * must-NOT-escape half matters as much as the must: escaping U+2028 here
     * would change every wire byte (that is `escapeJsonForScript`'s job over in
     * @sigx/server-renderer, and only for script-tag embedding).
     */
    const STRINGS = [
        '', 'plain', 'a b c',
        'a"b', 'a\\b', 'a"\\b',
        '\n', '\t', '\r', '\b', '\f',
        '\x00', '\x01', '\x1f',
        // must NOT escape:
        '\x7f', '\u2028', '\u2029', '\ufeff', 'é', '😀',
        // must escape (lone surrogates):
        '\ud800', '\udfff', 'a\ud800b', '\udc00\ud800',
        // long enough that the fast path matters
        'x'.repeat(200), `${'x'.repeat(200)}"`
    ];

    it('as values', () => {
        for (const s of STRINGS) parity(s, [], JSON.stringify(s));
        for (const s of STRINGS) parity({ v: s }, [], `keyed ${JSON.stringify(s)}`);
        for (const s of STRINGS) parity([s], [], `element ${JSON.stringify(s)}`);
    });

    it('as KEYS — the fast path applies to keys too', () => {
        for (const s of STRINGS) {
            parity({ [s]: 1 }, [], `key ${JSON.stringify(s)}`);
            // A second key, so a "$"-leading key does not accidentally escape.
            parity({ [s]: 1, z: 2 }, [], `key+ ${JSON.stringify(s)}`);
        }
    });

    it('U+007F, U+2028 and U+2029 survive unescaped (pinned)', () => {
        expect(stringifyWithHandlers('\x7f\u2028\u2029')).toBe('"\x7f\u2028\u2029"');
    });

    it('a lone surrogate is escaped, a valid pair is not (pinned)', () => {
        expect(stringifyWithHandlers('\ud800')).toBe('"\\ud800"');
        expect(stringifyWithHandlers('😀')).toBe('"😀"');
    });
});

// ---------------------------------------------------------------------------
// The built-in vocabulary
// ---------------------------------------------------------------------------

describe('built-in tags', () => {
    it('every built-in, bare, keyed, in an array and nested', () => {
        const values: [string, unknown][] = [
            ['date', new Date(0)],
            ['date-mid', new Date(1720000000000)],
            ['date-invalid', new Date(NaN)],
            ['map-empty', new Map()],
            ['map', new Map<unknown, unknown>([['a', 1], [2, 'b']])],
            ['map-object-keys', new Map([[{ k: 1 }, new Date(5)]])],
            ['map-nested', new Map([['d', new Map([['e', new Set([1])]])]])],
            ['set-empty', new Set()],
            ['set', new Set([1, 'a', new Date(3)])],
            ['bigint-0', 0n],
            ['bigint-neg', -1n],
            ['bigint-big', 9007199254740993n],
            ['url', new URL('https://example.com/a?b=1#c')],
            ['regexp', /ab+c/giu],
            ['regexp-quotes', /"\\/],
            ['undefined', undefined]
        ];
        for (const [label, v] of values) {
            parity(v, [], label);
            parity({ v }, [], `${label} keyed`);
            parity([v], [], `${label} element`);
            parity({ deep: { deeper: [v] } }, [], `${label} deep`);
        }
    });

    it('an explicit undefined survives every position (pinned)', () => {
        expect(stringifyWithHandlers(undefined)).toBe('{"$undef":0}');
        expect(stringifyWithHandlers([undefined])).toBe('[{"$undef":0}]');
        expect(stringifyWithHandlers({ a: undefined })).toBe('{"a":{"$undef":0}}');
    });
});

// ---------------------------------------------------------------------------
// $esc — the collision escape
// ---------------------------------------------------------------------------

describe('escaping', () => {
    it('single "$" key shapes', () => {
        parity({ $date: 'not a date' }, [], 'looks like a tag');
        parity({ $esc: 1 }, [], 'the marker itself');
        parity({ $esc: { $date: 1 } }, [], 'marker over a tag');
        parity({ $futureTag: 1 }, [], 'a tag that does not exist yet');
        parity({ $: 1 }, [], 'bare dollar');
        parity({ $a: { $b: { $c: 1 } } }, [], 'nested escapes');
        parity([{ $a: 1 }], [], 'in an array');
        parity({ outer: { $a: 1 } }, [], 'under a key');
        parity(new Map([['k', { $a: 1 }]]), [], 'inside a Map');
        parity(new Set([{ $a: 1 }]), [], 'inside a Set');
    });

    it('multi-key "$" objects are unambiguous and do NOT escape', () => {
        parity({ $date: 'x', other: 1 }, [], 'tag plus sibling');
        parity({ $a: 1, $b: 2 }, [], 'two dollar keys');
    });

    /**
     * The one case where deciding the escape from the EMITTED text rather than
     * the key set diverges: the key that earned the escape is dropped by JSON,
     * so the wrap survives around an empty object. Pinned, because both walks
     * agreeing on the wrong answer is exactly what parity cannot see.
     */
    it('a "$" key whose value JSON drops still earns the wrap (pinned)', () => {
        expect(stringifyWithHandlers({ $a: Symbol('x') })).toBe('{"$esc":{}}');
        expect(stringifyWithHandlers({ $a: () => {} })).toBe('{"$esc":{}}');
        parity({ $a: Symbol('x') }, [], 'dollar key holding a symbol');
        parity({ $a: () => {} }, [], 'dollar key holding a function');
    });
});

// ---------------------------------------------------------------------------
// __proto__ — asymmetric between the object branch and a handler tag
// ---------------------------------------------------------------------------

describe('__proto__ keys', () => {
    /** An own "__proto__" key cannot be written as a literal — that syntax sets
     *  the prototype. JSON.parse and defineProperty are the two ways in. */
    const own = (json: string): unknown => JSON.parse(json);

    it('is dropped from the output, and from the escape count', () => {
        parity(own('{"__proto__":{"x":1}}'), [], 'alone');
        parity(own('{"$a":1,"__proto__":{"x":1}}'), [], 'with a $ sibling');
        parity(own('{"$a":1,"b":2,"__proto__":{"x":1}}'), [], 'with two siblings');
        parity(own('{"__proto__":1}'), [], 'non-object payload');
        parity(own('{"__proto__":null}'), [], 'null payload');
        parity(own('[{"__proto__":{"x":1}}]'), [], 'in an array');
    });

    it('an own __proto__ leaves a $-sibling SOLE, so it escapes (pinned)', () => {
        expect(stringifyWithHandlers(own('{"$a":1,"__proto__":{"x":1}}'))).toBe('{"$esc":{"$a":1}}');
        expect(stringifyWithHandlers(own('{"__proto__":{"x":1}}'))).toBe('{}');
    });

    it('its VALUE is still walked, so a cycle under it still throws', () => {
        const cyclic: Record<string, unknown> = { self: null };
        cyclic.self = cyclic;
        const holder = {};
        Object.defineProperty(holder, '__proto__', {
            value: cyclic, enumerable: true, writable: true, configurable: true
        });
        parity(holder, [], 'cycle under __proto__');
        expect(() => stringifyWithHandlers(holder)).toThrow(/circular/);
    });

    it('its VALUE is still walked, so a depth overflow under it still throws', () => {
        let deep: unknown = 1;
        for (let i = 0; i < 300; i++) deep = { d: deep };
        const holder = {};
        Object.defineProperty(holder, '__proto__', {
            value: deep, enumerable: true, writable: true, configurable: true
        });
        parity(holder, [], 'deep under __proto__');
        expect(() => stringifyWithHandlers(holder)).toThrow(/nests deeper/);
    });

    it('a handler TAGGED "__proto__" DOES emit the key — a literal is not a setter', () => {
        const evil = defineTypeHandler({
            name: 'evil',
            tag: '__proto__',
            test: (v): v is symbol => typeof v === 'symbol',
            serialize: () => 1
        }) as TypeHandler;
        parity(Symbol('x'), [evil], 'tag __proto__');
        parity({ k: Symbol('x') }, [evil], 'tag __proto__ keyed');
        expect(stringifyWithHandlers(Symbol('x'), [evil])).toBe('{"__proto__":1}');
    });
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

describe('arrays', () => {
    it('every shape', () => {
        parity([], [], 'empty');
        parity([1, 2, 3], [], 'dense');
        parity(new Array(3), [], 'all holes');
        parity([undefined], [], 'explicit undefined');
        parity([Symbol('x')], [], 'symbol');
        parity([() => {}], [], 'function');
        parity([[[]]], [], 'nested');
    });

    it('holes become null, an explicit undefined becomes $undef (pinned)', () => {
        // The trap: reading value[i] blindly turns a hole into `undefined`,
        // which the $undef built-in claims. `encode` walks with .map(), which
        // SKIPS holes, so JSON writes null for them.
        const sparse = [1, , 3] as unknown[];
        parity(sparse, [], 'sparse');
        expect(stringifyWithHandlers(sparse)).toBe('[1,null,3]');
        expect(stringifyWithHandlers([1, undefined, 3])).toBe('[1,{"$undef":0},3]');
    });

    it('a hole made by delete, and a trailing hole', () => {
        const deleted = [1, 2, 3];
        delete deleted[1];
        parity(deleted, [], 'deleted middle');
        const grown = [1, 2, 3];
        grown.length = 5;
        parity(grown, [], 'grown length');
    });

    it('non-index own properties are ignored, as JSON ignores them', () => {
        const withExtra: unknown[] & { extra?: number } = [1, 2];
        withExtra.extra = 3;
        parity(withExtra, [], 'array with an extra prop');
    });

    it('an array carrying toJSON takes the toJSON branch', () => {
        const replaced = Object.assign([1, 2], { toJSON: () => ({ replaced: true }) });
        parity(replaced, [], 'array with toJSON');
    });
});

// ---------------------------------------------------------------------------
// toJSON
// ---------------------------------------------------------------------------

describe('toJSON', () => {
    it('every return shape', () => {
        parity({ toJSON: () => 1 }, [], 'scalar');
        parity({ toJSON: () => ({ a: 1 }) }, [], 'object');
        parity({ toJSON: () => [1, 2] }, [], 'array');
        parity({ toJSON: () => undefined }, [], 'undefined');
        parity({ toJSON: () => new Date(5) }, [], 'Date');
        parity({ toJSON: () => ({ $a: 1 }) }, [], 'escaping object');
        parity({ toJSON: () => Symbol('x') }, [], 'symbol');
        parity([{ toJSON: () => undefined }], [], 'undefined in an array');
        parity({ k: { toJSON: () => undefined } }, [], 'undefined under a key');
    });

    it('a toJSON returning undefined is $undef, NOT a dropped value (pinned)', () => {
        // The ONLY thing that returns undefined from the walk is a top-level
        // symbol or function; the $undef built-in claims everything else.
        expect(stringifyWithHandlers({ toJSON: () => undefined })).toBe('{"$undef":0}');
    });

    it('is called with NO arguments — JSON.stringify passes the key, this codec does not', () => {
        const seen: unknown[][] = [];
        const probe = { toJSON: (...args: unknown[]) => { seen.push(args); return 1; } };
        stringifyWithHandlers({ nested: probe });
        expect(seen).toEqual([[]]);
    });

    it('inherited from a prototype', () => {
        class WithToJSON {
            value = 3;
            toJSON(): unknown { return { v: this.value }; }
        }
        parity(new WithToJSON(), [], 'class toJSON');
    });

    it('a non-function toJSON is NOT called', () => {
        parity({ toJSON: 5 }, [], 'numeric toJSON');
        parity({ toJSON: null }, [], 'null toJSON');
    });

    it('a toJSON returning the receiver is circular', () => {
        const self: { toJSON: () => unknown } = { toJSON: () => self };
        parity(self, [], 'self-returning toJSON');
    });

    it('a Date with a hijacked toJSON is still claimed by the handler', () => {
        const d = new Date(5);
        (d as unknown as { toJSON: () => string }).toJSON = () => 'nope';
        parity(d, [], 'Date with hijacked toJSON');
    });
});

// ---------------------------------------------------------------------------
// Sharing, cycles, depth
// ---------------------------------------------------------------------------

describe('memo, cycles and depth', () => {
    it('a shared subtree emits identically at both positions', () => {
        const shared = { k: 1, nested: { deep: [1, 2] } };
        parity({ a: shared, b: shared }, [], 'diamond');
        const arr = [1, 2, 3];
        parity({ a: arr, b: arr }, [], 'shared array');
        parity([shared, shared, shared], [], 'thrice');
    });

    it('a shared node reached at BOTH escapeTop positions', () => {
        // Once as a tagless handler's output (escapeTop false, so no $esc
        // wrap), once as ordinary nested user data (escapeTop true).
        const shared = { $a: 1 };
        const tagless = defineTypeHandler({
            name: 'legacy',
            test: (v): v is symbol => typeof v === 'symbol',
            serialize: () => shared
        }) as TypeHandler;
        parity({ raw: shared, viaHandler: Symbol('x') }, [tagless], 'escape-dependent sharing');
        parity({ viaHandler: Symbol('x'), raw: shared }, [tagless], 'reversed order');
    });

    it('a 12-level two-way DAG is byte-correct — the spliced text is the expansion', () => {
        // 4 096 leaves: big enough that every level is reached through both
        // branches, small enough to actually emit. This is the correctness
        // half of the memo; the test below is the cost half.
        let node: Record<string, unknown> = { leaf: true };
        for (let i = 0; i < 12; i++) node = { left: node, right: node };
        parity(node, [], '12-level DAG');
    });

    it('a 40-level DAG fails FAST — the memo splices text instead of re-walking', () => {
        // The expansion is ~2^40 characters, which no JS string can hold, so
        // this cannot succeed either way. What differs is how it fails: the
        // memo doubles the TEXT per level, so the engine's string ceiling is
        // reached after ~40 concatenations and the RangeError lands in
        // milliseconds. Without it, the walk emits leaf by leaf and grinds
        // through ~2^29 of them first.
        //
        // Deliberately NOT a `parity()` case: the tree walk that
        // `JSON.stringify(encodeWithHandlers(...))` performs on the same input
        // does not return in any practical time, so there is nothing to
        // compare against. Failing fast is strictly better, and this pins it.
        let node: Record<string, unknown> = { leaf: true };
        for (let i = 0; i < 40; i++) node = { left: node, right: node };
        const started = performance.now();
        expect(() => stringifyWithHandlers(node)).toThrow(RangeError);
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    it('cycles throw JSON own message', () => {
        const selfObject: Record<string, unknown> = {};
        selfObject.self = selfObject;
        parity(selfObject, [], 'self object');

        const selfArray: unknown[] = [];
        selfArray.push(selfArray);
        parity(selfArray, [], 'self array');

        const a: Record<string, unknown> = {};
        const b: Record<string, unknown> = { a };
        a.b = b;
        parity(a, [], 'mutual');

        const inMap = new Map<string, unknown>();
        inMap.set('self', inMap);
        parity(inMap, [], 'map holding itself');
    });

    it('the depth cap fires at the same level', () => {
        const nest = (n: number): unknown => {
            let v: unknown = 1;
            for (let i = 0; i < n; i++) v = { d: v };
            return v;
        };
        for (const depth of [200, 254, 255, 256, 257, 300]) {
            parity(nest(depth), [], `depth ${depth}`);
        }
    });

    it('a cycle routed THROUGH a handler reports depth, not circularity', () => {
        // Handler-claimed values are deliberately un-memoized, so the cycle
        // guard never sees them and MAX_DEPTH is what stops the walk.
        class Box {
            inner: unknown = null;
        }
        const box = new Box();
        box.inner = box;
        const boxHandler = defineTypeHandler({
            name: 'box',
            tag: '$box',
            test: (v): v is Box => v instanceof Box,
            serialize: (b) => b.inner
        }) as TypeHandler;
        parity(box, [boxHandler], 'cycle through handler');
        expect(() => stringifyWithHandlers(box, [boxHandler])).toThrow(/nests deeper/);
    });
});

// ---------------------------------------------------------------------------
// Handler chains
// ---------------------------------------------------------------------------

class Money {
    cents: number;
    constructor(cents: number) {
        this.cents = cents;
    }
}

describe('handlers', () => {
    const money = defineTypeHandler({
        name: 'money',
        tag: '$money',
        test: (v): v is Money => v instanceof Money,
        serialize: (m) => m.cents,
        revive: (c) => new Money(c)
    }) as TypeHandler;

    /** Pre-tag handler: emits its own wire shape, must NOT be $esc-wrapped. */
    const legacy = defineTypeHandler({
        name: 'legacy',
        test: (v): v is Money => v instanceof Money,
        serialize: (m) => ({ $legacyMoney: m.cents })
    }) as TypeHandler;

    /** A registered handler wins over a built-in for the same type. */
    const epoch = defineTypeHandler({
        name: 'epoch',
        tag: '$epoch',
        test: (v): v is Date => v instanceof Date,
        serialize: (d) => d.getTime()
    }) as TypeHandler;

    /** Claims a SCALAR — bypasses the JSON-native fast path. */
    const shout = defineTypeHandler({
        name: 'shout',
        tag: '$shout',
        test: (v): v is string => typeof v === 'string' && v.startsWith('!'),
        serialize: (s) => s.slice(1)
    }) as TypeHandler;

    const payload = {
        price: new Money(1999),
        at: new Date(5),
        note: '!loud',
        list: [new Money(1), '!x', new Date(0)],
        nested: { inner: new Money(2) }
    };

    it('tagged, tagless, shadowing and scalar-claiming handlers', () => {
        parity(payload, [money], 'tagged');
        parity(payload, [legacy], 'tagless');
        parity(payload, [epoch], 'shadowing $date');
        parity(payload, [shout], 'scalar claim');
        parity(payload, [money, epoch, shout], 'all three');
        parity(payload, [], 'none');
    });

    const symTagged = defineTypeHandler({
        name: 'sym-tagged',
        tag: '$sym',
        test: (v): v is Money => v instanceof Money,
        serialize: () => Symbol('x') as unknown
    }) as TypeHandler;

    it('a handler returning a value JSON drops', () => {
        const symTagless = defineTypeHandler({
            name: 'sym-tagless',
            test: (v): v is Money => v instanceof Money,
            serialize: () => Symbol('x') as unknown
        }) as TypeHandler;
        parity(new Money(1), [symTagged], 'tagged symbol');
        parity({ m: new Money(1) }, [symTagged], 'tagged symbol keyed');
        parity([new Money(1)], [symTagged], 'tagged symbol element');
        parity(new Money(1), [symTagless], 'tagless symbol');
        parity({ m: new Money(1) }, [symTagless], 'tagless symbol keyed');
        parity([new Money(1)], [symTagless], 'tagless symbol element');
    });

    it('a tagged handler whose payload drops keeps the empty wrapper (pinned)', () => {
        expect(stringifyWithHandlers(new Money(1), [symTagged])).toBe('{}');
    });

    it('a handler returning undefined, and one returning rich types', () => {
        const undef = defineTypeHandler({
            name: 'undef',
            tag: '$u',
            test: (v): v is Money => v instanceof Money,
            serialize: () => undefined as unknown
        }) as TypeHandler;
        parity(new Money(1), [undef], 'undefined payload');

        const rich = defineTypeHandler({
            name: 'rich',
            tag: '$rich',
            test: (v): v is Money => v instanceof Money,
            serialize: (m) => new Map([['at', new Date(m.cents)]]) as unknown
        }) as TypeHandler;
        parity(new Money(7), [rich], 'Map-of-Date payload');
    });

    it('a tag needing escaping is quoted', () => {
        const odd = defineTypeHandler({
            name: 'odd',
            tag: 'a"b\\c',
            test: (v): v is Money => v instanceof Money,
            serialize: (m) => m.cents
        }) as TypeHandler;
        parity(new Money(3), [odd], 'quoted tag');
    });

    it('the opt-in bytes vocabulary', () => {
        const bytes = {
            u8: new Uint8Array([1, 2, 3]),
            view: new Float64Array([1.5, 2.5]),
            buf: new Uint8Array([9, 9]).buffer,
            nested: { deep: [new Uint8Array([0])] }
        };
        parity(bytes, [bytesHandler as TypeHandler], 'bytesHandler');
        parity(bytes, [], 'bytes without the handler');
    });
});

// ---------------------------------------------------------------------------
// Values the codec flattens, and values JSON drops
// ---------------------------------------------------------------------------

describe('flattened and dropped values', () => {
    it('a top-level symbol or function returns undefined — and nothing else does', () => {
        expect(stringifyWithHandlers(Symbol('x'))).toBeUndefined();
        expect(stringifyWithHandlers(() => {})).toBeUndefined();
        parity(Symbol('x'), [], 'bare symbol');
        parity(() => {}, [], 'bare function');
        parity({ a: Symbol('x'), b: 1 }, [], 'symbol under a key');
        parity({ a: () => {}, b: 1 }, [], 'function under a key');
        parity([Symbol('x'), 1], [], 'symbol in an array');
    });

    it('objects encode flattens — parity is with the CODEC, not raw JSON', () => {
        // Raw JSON.stringify(new String('ab')) is '"ab"'; the codec walks its
        // own keys and emits {"0":"a","1":"b"}. That divergence belongs to the
        // codec, and this walk inherits it exactly.
        parity(new String('ab'), [], 'boxed string');
        parity(new Number(5), [], 'boxed number');
        parity(new Boolean(true), [], 'boxed boolean');
        parity(new Error('x'), [], 'Error');
        parity(Promise.resolve(1), [], 'Promise');
        parity(new WeakMap(), [], 'WeakMap');
        parity(new WeakSet(), [], 'WeakSet');
        parity(Object.create(null) as object, [], 'null prototype, empty');
        parity(Object.assign(Object.create(null) as object, { a: 1 }), [], 'null prototype');
    });

    it('a boxed string flattens to an index object (pinned)', () => {
        expect(stringifyWithHandlers(new String('ab'))).toBe('{"0":"a","1":"b"}');
    });

    it('class instances, symbol keys, non-enumerables and getters', () => {
        class Point {
            x = 1;
            y = 2;
        }
        parity(new Point(), [], 'class instance');

        parity({ a: 1, [Symbol('s')]: 2 }, [], 'symbol key');

        const hidden = { visible: 1 };
        Object.defineProperty(hidden, 'invisible', { value: 2, enumerable: false });
        parity(hidden, [], 'non-enumerable');

        parity({ get when(): Date { return new Date(11); } }, [], 'getter returning a Date');
        parity({ get n(): number { return 41 + 1; } }, [], 'getter returning a scalar');
        parity({ get s(): string { return 'x'; }, get t(): number { return 1; } }, [], 'all-getter object');
    });

    /**
     * The pure-JSON fast path (#657) scans a node's values to decide whether
     * `JSON.stringify` can emit it wholesale, then hands the node to
     * `JSON.stringify`, which reads them again — so a getter is evaluated
     * TWICE where `encode` evaluates it once. Pinned rather than fixed: a
     * getter that answers differently per read is not serializable in any
     * meaningful sense, and the alternative is giving up the fast path.
     */
    it('a getter is read once more than encode reads it — the one accepted divergence', () => {
        // Counted against `encode` rather than against a bare number: in dev
        // BOTH entry points run the #565 pre-walk, which reads every value
        // once, so an absolute count measures that probe as much as the walk.
        const count = (walk: (v: unknown) => unknown, make: () => object): number => {
            let reads = 0;
            const target = make();
            Object.defineProperty(target, 'n', {
                get: () => { reads++; return 1; }, enumerable: true, configurable: true
            });
            walk(target);
            return reads;
        };
        const viaEncode = count((v) => encodeWithHandlers(v), () => ({}));
        const viaStringify = count((v) => stringifyWithHandlers(v), () => ({}));
        expect(viaStringify).toBe(viaEncode + 1);

        expect(stringifyWithHandlers({ get n(): number { return 1; } })).toBe('{"n":1}');
    });
});

// ---------------------------------------------------------------------------
// The dev probe runs on BOTH entry points
// ---------------------------------------------------------------------------

describe('the #565 dev probe', () => {
    /** The only proof `warnUnencodable` runs for the new entry point: the two
     *  call lists must be DEEP-EQUAL, not merely both non-empty. */
    function sameWarnings(value: unknown, handlers: readonly TypeHandler[] = []): void {
        warnSpy.mockClear();
        try { encodeWithHandlers(value, handlers); } catch { /* warning parity only */ }
        const fromEncode = warnSpy.mock.calls.map((call: unknown[]) => call.join(' '));

        warnSpy.mockClear();
        try { stringifyWithHandlers(value, handlers); } catch { /* as above */ }
        const fromStringify = warnSpy.mock.calls.map((call: unknown[]) => call.join(' '));

        expect(fromStringify).toEqual(fromEncode);
        expect(fromStringify.length).toBeGreaterThan(0);
    }

    it('warns identically for every unencodable shape', () => {
        sameWarnings({ n: Infinity });
        sameWarnings({ bin: new Uint8Array([1]) });
        sameWarnings({ err: new Error('x') });
        sameWarnings({ p: Promise.resolve(1) });
        sameWarnings({ w: new WeakMap() });
        sameWarnings({ deep: { deeper: { instance: new (class Thing { v = 1; })() } } });
    });

    it('says nothing when a handler claims the value', () => {
        warnSpy.mockClear();
        stringifyWithHandlers({ bin: new Uint8Array([1]) }, [bytesHandler as TypeHandler]);
        expect(warnSpy).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Run batching (#666) — a big collection of small nodes goes native in RUNS
// ---------------------------------------------------------------------------

describe('run batching (#666)', () => {
    const money = defineTypeHandler({
        name: 'money',
        tag: '$money',
        test: (v): v is Money => v instanceof Money,
        serialize: (m) => m.cents
    }) as TypeHandler;
    const epoch = defineTypeHandler({
        name: 'epoch',
        tag: '$epoch',
        test: (v): v is Date => v instanceof Date,
        serialize: (d) => d.getTime()
    }) as TypeHandler;
    const shout = defineTypeHandler({
        name: 'shout',
        tag: '$shout',
        test: (v): v is string => typeof v === 'string' && v.startsWith('!'),
        serialize: (s) => s.slice(1)
    }) as TypeHandler;
    const legacy = defineTypeHandler({
        name: 'legacy',
        test: (v): v is Money => v instanceof Money,
        serialize: (m) => ({ $legacy: m.cents })
    }) as TypeHandler;
    const SETS: readonly (readonly TypeHandler[])[] = [[], [money], [epoch], [shout], [legacy]];

    /** The issue's own shape: 500 small rows under a key. */
    const scalarRows = (n = 500): unknown[] =>
        Array.from({ length: n }, (_, i) => ({
            id: i, label: `step-${i}`, output: i % 3 === 0 ? null : `ok ${i}`, ok: i % 2 === 0, ms: i * 1.5
        }));
    const datedRows = (n = 500): unknown[] =>
        scalarRows(n).map((row, i) => ({ ...(row as object), at: new Date(1720000000000 + i) }));

    it('the issue fixtures, across handler sets', () => {
        for (let s = 0; s < SETS.length; s++) {
            parity({ steps: scalarRows() }, SETS[s]!, `scalar rows / handlers ${s}`);
            parity({ steps: datedRows() }, SETS[s]!, `dated rows / handlers ${s}`);
        }
    });

    it('substitutable leaves in rows: every built-in scalar payload', () => {
        parity({ steps: [{ id: 1, at: new Date(5) }, { id: 2 }] }, [], 'date field');
        parity([{ n: 7n }, { n: -1n }], [], 'bigint fields');
        parity([{ u: new URL('https://example.com/a?b=1') }], [], 'URL field');
        parity([{ v: undefined }, { v: 1 }], [], 'explicit undefined field');
        parity([{ at: new Date(NaN) }], [], 'invalid Date field');
        parity([{ n: NaN, m: -0, i: Infinity }], [], 'NaN/-0/Infinity fields');
    });

    it('a substituted row emits the tag wrapper in place, key order kept (pinned)', () => {
        // Both walks could get the copy's key order or the wrapper shape wrong
        // together; parity alone would prove nothing here.
        expect(stringifyWithHandlers({ steps: [{ id: 1, at: new Date(5) }, { id: 2 }] }))
            .toBe('{"steps":[{"id":1,"at":{"$date":5}},{"id":2}]}');
    });

    it('run breakers at start, middle and end — and runs of one', () => {
        const rows = scalarRows(6);
        const BREAKERS: [string, unknown][] = [
            ['map field', { m: new Map([['a', 1]]) }],
            ['set field', { s: new Set([1]) }],
            ['regexp field', { r: /x/g }],
            ['sole $ key', { $a: 1 }],
            ['own __proto__', JSON.parse('{"__proto__":{"x":1}}')],
            ['symbol value', { v: Symbol('x') }],
            ['function value', { v: () => {} }],
            ['enumerable toJSON', { toJSON: () => ({ replaced: true }) }],
            ['non-enumerable toJSON', (() => {
                const r = { id: 1 };
                Object.defineProperty(r, 'toJSON', { value: () => 'hidden', enumerable: false, configurable: true });
                return r;
            })()],
            ['class instance', new (class Row { id = 1; })()],
            ['boxed string', new String('ab')],
            ['nested object field', { child: { id: 1 } }],
            ['direct symbol', Symbol('x')]
        ];
        for (const [label, breaker] of BREAKERS) {
            parity([breaker, ...rows], [], `${label} at start`);
            parity([...rows.slice(0, 3), breaker, ...rows.slice(3)], [], `${label} in the middle`);
            parity([...rows, breaker], [], `${label} at end`);
            parity([breaker, rows[0], breaker], [], `${label} around a run of one`);
            parity([rows[0], breaker, rows[1], breaker, rows[2]], [], `${label} alternating`);
        }
    });

    it('eligible oddballs ride the batch', () => {
        parity([Object.assign(Object.create(null) as object, { a: 1 })], [], 'null-proto row');
        parity([{}, [], { a: 1 }], [], 'empty containers');
        parity([{ $a: 1, $b: 2 }], [], 'multi-$-key row');
        parity([{ get n(): number { return 41 + 1; } }], [], 'deterministic getter row');
        parity([[1, , 3], [4, 5]], [], 'nested scalar arrays with holes');
        parity([{ id: 1 }, , { id: 2 }] as unknown[], [], 'hole inside a run');
        parity([new Date(5), 7n, undefined, { id: 1 }], [], 'direct codec leaves');
    });

    it('holes and explicit undefined keep their bytes inside runs (pinned)', () => {
        expect(stringifyWithHandlers([{ id: 1 }, , { id: 2 }] as unknown[]))
            .toBe('[{"id":1},null,{"id":2}]');
        expect(stringifyWithHandlers([1, , 3] as unknown[])).toBe('[1,null,3]');
        expect(stringifyWithHandlers([undefined])).toBe('[{"$undef":0}]');
    });

    it('memo interplay: a shared row inside and outside a run, cycles after a run', () => {
        const shared = { id: 1, label: 'shared' };
        parity({ before: shared, steps: [shared, { id: 2 }, shared] }, [], 'row shared with a memoized position');
        parity([[shared, shared], new Map([['k', shared]])], [], 'shared across batch and handler');

        const cyclic: unknown[] = [{ id: 1 }, { id: 2 }];
        cyclic.push(cyclic);
        parity(cyclic, [], 'self-referential array after a run');
    });

    it('the depth cap fires at the same level through a batched shape', () => {
        const nest = (n: number, leaf: unknown): unknown => {
            let v: unknown = leaf;
            for (let i = 0; i < n; i++) v = { d: v };
            return v;
        };
        for (const depth of [248, 250, 251, 252, 253, 254, 255, 256]) {
            parity(nest(depth, [{ id: 1, at: new Date(5) }, { id: 2 }]), [], `batched at depth ${depth}`);
            parity(nest(depth, [1, 2, 3]), [], `scalar run at depth ${depth}`);
        }
    });

    it('custom handlers break runs wherever they claim', () => {
        parity([{ price: new Money(1) }, { id: 2 }], [money], 'custom claims a row value');
        const claimRow = defineTypeHandler({
            name: 'row',
            tag: '$row',
            test: (v): v is { id: number } => typeof v === 'object' && v !== null && 'id' in v,
            serialize: (r) => r.id
        }) as TypeHandler;
        parity([{ id: 1 }, { id: 2 }], [claimRow], 'custom claims the row itself');
        // A custom handler may claim a BUILT-IN's payload — the digits of a
        // bigint, the href of a URL — and encode walks payloads through the
        // full chain, so a substitution that skipped the re-check would drift.
        parity([{ n: 7n }], [shout], 'bigint payload not claimed');
        const claimDigits = defineTypeHandler({
            name: 'digits',
            tag: '$digits',
            test: (v): v is string => v === '7',
            serialize: (s) => `<${s}>`
        }) as TypeHandler;
        parity([{ n: 7n }, { id: 1 }], [claimDigits], 'custom claims the bigint payload');
        const claimHref = defineTypeHandler({
            name: 'href',
            tag: '$href',
            test: (v): v is string => typeof v === 'string' && v.startsWith('https://'),
            serialize: (s) => s.length
        }) as TypeHandler;
        parity([{ u: new URL('https://example.com/') }], [claimHref], 'custom claims the URL payload');
    });

    it('a Date with a hijacked toJSON inside a row is still $date (pinned)', () => {
        const d = new Date(5);
        (d as unknown as { toJSON: () => string }).toJSON = () => 'nope';
        parity([{ at: d }], [], 'hijacked toJSON in a row');
        expect(stringifyWithHandlers([{ at: d }])).toBe('[{"at":{"$date":5}}]');
    });

    it('a getter in a batched row is read once more than encode reads it', () => {
        // The same accepted divergence the per-node fast path pinned (#657):
        // the eligibility scan reads, then the native call reads again.
        const count = (walk: (v: unknown) => unknown, make: () => object): number => {
            let reads = 0;
            const target = make();
            Object.defineProperty(target, 'n', {
                get: () => { reads++; return 1; }, enumerable: true, configurable: true
            });
            walk([{ id: 1 }, target, { id: 2 }]);
            return reads;
        };
        const viaEncode = count((v) => encodeWithHandlers(v), () => ({ id: 3 }));
        const viaStringify = count((v) => stringifyWithHandlers(v), () => ({ id: 3 }));
        expect(viaStringify).toBe(viaEncode + 1);
    });

    it('a getter AFTER a substitution is read exactly as often as encode reads it', () => {
        // The copy path reads each remaining value once and hands the COPY to
        // the native call — fewer reads than the pass-by-ref scan, never more.
        const count = (walk: (v: unknown) => unknown): number => {
            let reads = 0;
            const target: Record<string, unknown> = { at: new Date(5) };
            Object.defineProperty(target, 'n', {
                get: () => { reads++; return 1; }, enumerable: true, configurable: true
            });
            walk([target]);
            return reads;
        };
        const viaEncode = count((v) => encodeWithHandlers(v));
        const viaStringify = count((v) => stringifyWithHandlers(v));
        expect(viaStringify).toBe(viaEncode);
    });
});

// ---------------------------------------------------------------------------
// Seeded fuzz
// ---------------------------------------------------------------------------

describe('seeded fuzz', () => {
    /**
     * mulberry32 — the same tiny seeded PRNG `benchmarks/src/scenarios/data.ts`
     * uses, inlined rather than imported: a package test must not reach across
     * the workspace into a private package, and it is six lines. Seeded so any
     * failure is reproducible from the seed printed in its assertion label.
     */
    function mulberry32(seed: number): () => number {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const LEAVES: unknown[] = [
        null, true, false, 0, -0, 1, -1, 3.5, 1e21, NaN, Infinity,
        '', 'plain', 'a"b', 'a\\b', '\x00', '\x1f', '\u2028', '\x7f',
        '\ud800', '😀',
        undefined, 7n, new Date(0), new Date(NaN),
        new URL('https://example.com/'), /x"y/g,
        Symbol('s'), () => {}
    ];

    const KEYS = ['a', 'b', '$a', '$esc', '$date', '__proto__', '', 'k"k', '\x00', 'z'];

    const HANDLER_SETS: readonly (readonly TypeHandler[])[] = [
        [],
        [bytesHandler as TypeHandler],
        // tagless legacy — its output must not be escaped
        [defineTypeHandler({
            name: 'legacy',
            test: (v): v is Money => v instanceof Money,
            serialize: (m) => ({ $legacy: m.cents })
        }) as TypeHandler],
        // shadows the built-in $date
        [defineTypeHandler({
            name: 'epoch',
            tag: '$epoch',
            test: (v): v is Date => v instanceof Date,
            serialize: (d) => d.getTime()
        }) as TypeHandler],
        // claims a scalar, bypassing the JSON-native fast path
        [defineTypeHandler({
            name: 'shout',
            tag: '$shout',
            test: (v): v is string => typeof v === 'string' && v.startsWith('a'),
            serialize: (s) => s.toUpperCase()
        }) as TypeHandler],
        // returns something JSON drops
        [defineTypeHandler({
            name: 'dropper',
            tag: '$drop',
            test: (v): v is Money => v instanceof Money,
            serialize: () => Symbol('x') as unknown
        }) as TypeHandler]
    ];

    /**
     * Builds a random tree under a node budget, re-drawing from a pool of
     * already-built nodes ~15% of the time — that is what produces the DAGs
     * and shared subtrees the memo exists for.
     */
    function build(rng: () => number): unknown {
        let budget = 40;
        const pool: object[] = [];

        const make = (depth: number): unknown => {
            const roll = rng();
            if (budget-- <= 0 || depth > 7 || roll < 0.35) {
                // A fresh Money now and then, for the sets that claim it.
                if (roll < 0.03) return new Money(Math.floor(rng() * 1000));
                return LEAVES[Math.floor(rng() * LEAVES.length)];
            }
            if (pool.length > 0 && rng() < 0.15) return pool[Math.floor(rng() * pool.length)];

            if (roll < 0.55) {
                const arr: unknown[] = [];
                const n = Math.floor(rng() * 4);
                for (let i = 0; i < n; i++) arr.push(make(depth + 1));
                // Punch a hole roughly a third of the time.
                if (arr.length > 0 && rng() < 0.3) delete arr[Math.floor(rng() * arr.length)];
                pool.push(arr);
                return arr;
            }
            if (roll < 0.58) {
                // A ROW ARRAY — the #666 shape: a run of small objects whose
                // values are scalars and codec leaves, salted with the exact
                // things that must break a run ($-keys, __proto__, getters,
                // toJSON, symbols) and with holes punched through it.
                const rows: unknown[] = [];
                const n = 2 + Math.floor(rng() * 7);
                for (let i = 0; i < n; i++) {
                    budget--;
                    const r = rng();
                    if (r < 0.1) {
                        rows.push(LEAVES[Math.floor(rng() * LEAVES.length)]);
                        continue;
                    }
                    if (r < 0.14) {
                        const replacement = LEAVES[Math.floor(rng() * LEAVES.length)];
                        rows.push({ toJSON: () => replacement });
                        continue;
                    }
                    const row: Record<string, unknown> = {};
                    const fields = 1 + Math.floor(rng() * 4);
                    for (let f = 0; f < fields; f++) {
                        const key = KEYS[Math.floor(rng() * KEYS.length)]!;
                        const value = LEAVES[Math.floor(rng() * LEAVES.length)];
                        if (key === '__proto__' || rng() >= 0.08) {
                            Object.defineProperty(row, key, {
                                value, enumerable: true, writable: true, configurable: true
                            });
                        } else {
                            Object.defineProperty(row, key, {
                                get: () => value, enumerable: true, configurable: true
                            });
                        }
                    }
                    rows.push(row);
                }
                if (rows.length > 0 && rng() < 0.25) delete rows[Math.floor(rng() * rows.length)];
                pool.push(rows);
                return rows;
            }
            if (roll < 0.62) return new Map([[KEYS[Math.floor(rng() * KEYS.length)]!, make(depth + 1)]]);
            if (roll < 0.68) return new Set([make(depth + 1)]);
            if (roll < 0.72) {
                // Built EAGERLY. A `toJSON` that generates on each call would
                // hand the two walks different values and fail parity for a
                // reason that is the fixture's, not the codec's.
                const replacement = make(depth + 1);
                return { toJSON: () => replacement };
            }

            const obj: Record<string, unknown> = {};
            const n = 1 + Math.floor(rng() * 3);
            for (let i = 0; i < n; i++) {
                const key = KEYS[Math.floor(rng() * KEYS.length)]!;
                const value = make(depth + 1);
                if (key === '__proto__') {
                    // A literal (or a plain assignment) would set the prototype.
                    Object.defineProperty(obj, key, {
                        value, enumerable: true, writable: true, configurable: true
                    });
                } else if (rng() < 0.08) {
                    // A getter now and then: the #657 fast path scans values
                    // before handing the node to JSON.stringify, so a getter
                    // is on a different code path than a data property.
                    // Deterministic, so parity still means something.
                    Object.defineProperty(obj, key, {
                        get: () => value, enumerable: true, configurable: true
                    });
                } else {
                    // defineProperty rather than assignment: the same key can
                    // be drawn twice, and assigning over a getter drawn on the
                    // previous pass throws.
                    Object.defineProperty(obj, key, {
                        value, enumerable: true, writable: true, configurable: true
                    });
                }
            }
            pool.push(obj);
            return obj;
        };

        return make(0);
    }

    it('2000 seeds x 6 handler sets agree byte for byte', () => {
        for (let seed = 1; seed <= 2000; seed++) {
            const value = build(mulberry32(seed));
            for (let h = 0; h < HANDLER_SETS.length; h++) {
                parity(value, HANDLER_SETS[h]!, `seed ${seed} / handlers ${h}`);
            }
        }
    });

    it('generated cycles throw identically', () => {
        for (let seed = 1; seed <= 200; seed++) {
            const value = build(mulberry32(seed ^ 0x5eed));
            if (value === null || typeof value !== 'object') continue;
            // Close a loop back to the root.
            if (Array.isArray(value)) value.push(value);
            else (value as Record<string, unknown>).cycle = value;
            parity(value, [], `cyclic seed ${seed}`);
        }
    });
});
