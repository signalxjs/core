/**
 * @sigx/serialize/bytes (#569) — the opt-in binary vocabulary. Round-trips
 * go through the ACTUAL wire path (encode → JSON → parse → revive), and the
 * wire SHAPES are pinned so the format cannot drift silently.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    encodeWithHandlers,
    reviveWithHandlers,
    BUILTIN_TYPE_HANDLERS,
    type TypeHandler
} from '../src/index';
import { bytesHandler } from '../src/bytes';

const HANDLERS: readonly TypeHandler[] = [bytesHandler];

/** Encode → JSON → parse → revive: the actual wire path, not just the halves. */
function roundTrip(value: unknown): unknown {
    const json = JSON.stringify(encodeWithHandlers(value, HANDLERS));
    return reviveWithHandlers(JSON.parse(json), HANDLERS);
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('wire shape', () => {
    it('a Uint8Array is the bare-string form', () => {
        expect(encodeWithHandlers(new Uint8Array([1, 2, 3]), HANDLERS)).toEqual({
            $bytes: 'AQID'
        });
    });

    it('every other kind is the [kind, base64] tuple form', () => {
        expect(encodeWithHandlers(new Int32Array([1]), HANDLERS)).toEqual({
            $bytes: ['Int32Array', 'AQAAAA==']
        });
        expect(encodeWithHandlers(new Uint8Array([1]).buffer, HANDLERS)).toEqual({
            $bytes: ['ArrayBuffer', 'AQ==']
        });
    });
});

describe('Uint8Array round-trips', () => {
    const cases: [string, Uint8Array][] = [
        ['empty', new Uint8Array(0)],
        ['one byte (padding ==)', new Uint8Array([255])],
        ['two bytes (padding =)', new Uint8Array([0, 128])],
        ['three bytes (no padding)', new Uint8Array([1, 2, 3])],
        ['all 256 byte values', new Uint8Array(Array.from({ length: 256 }, (_, i) => i))]
    ];
    for (const [label, bytes] of cases) {
        it(`round-trips ${label}`, () => {
            const out = roundTrip(bytes) as Uint8Array;
            expect(out).toBeInstanceOf(Uint8Array);
            expect(Array.from(out)).toEqual(Array.from(bytes));
        });
    }

    it('round-trips a large payload across the 0x8000 chunk boundary', () => {
        const big = new Uint8Array(100_000);
        for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
        const out = roundTrip(big) as Uint8Array;
        expect(out).toBeInstanceOf(Uint8Array);
        expect(out.length).toBe(big.length);
        expect(out).toEqual(big);
    });
});

describe('every kind round-trips to its exact constructor', () => {
    it('Int8Array with negatives', () => {
        const out = roundTrip(new Int8Array([-1, 0, 127, -128])) as Int8Array;
        expect(out).toBeInstanceOf(Int8Array);
        expect(Array.from(out)).toEqual([-1, 0, 127, -128]);
    });

    it('Uint8ClampedArray', () => {
        const out = roundTrip(new Uint8ClampedArray([0, 255])) as Uint8ClampedArray;
        expect(out).toBeInstanceOf(Uint8ClampedArray);
        expect(Array.from(out)).toEqual([0, 255]);
    });

    it('Int16Array / Uint16Array', () => {
        const i16 = roundTrip(new Int16Array([-32768, 32767])) as Int16Array;
        expect(i16).toBeInstanceOf(Int16Array);
        expect(Array.from(i16)).toEqual([-32768, 32767]);
        const u16 = roundTrip(new Uint16Array([0, 65535])) as Uint16Array;
        expect(u16).toBeInstanceOf(Uint16Array);
        expect(Array.from(u16)).toEqual([0, 65535]);
    });

    it('Int32Array / Uint32Array', () => {
        const i32 = roundTrip(new Int32Array([-2147483648, 2147483647])) as Int32Array;
        expect(i32).toBeInstanceOf(Int32Array);
        expect(Array.from(i32)).toEqual([-2147483648, 2147483647]);
        const u32 = roundTrip(new Uint32Array([0, 4294967295])) as Uint32Array;
        expect(u32).toBeInstanceOf(Uint32Array);
        expect(Array.from(u32)).toEqual([0, 4294967295]);
    });

    it('Float32Array / Float64Array with fractions and -0', () => {
        const f32 = roundTrip(new Float32Array([0.5, -1.25])) as Float32Array;
        expect(f32).toBeInstanceOf(Float32Array);
        expect(Array.from(f32)).toEqual([0.5, -1.25]);
        const f64 = roundTrip(new Float64Array([Math.PI, -0])) as Float64Array;
        expect(f64).toBeInstanceOf(Float64Array);
        expect(f64[0]).toBe(Math.PI);
        expect(Object.is(f64[1], -0)).toBe(true);
    });

    it('BigInt64Array / BigUint64Array', () => {
        const b64 = roundTrip(new BigInt64Array([-1n, 9007199254740993n])) as BigInt64Array;
        expect(b64).toBeInstanceOf(BigInt64Array);
        expect(Array.from(b64)).toEqual([-1n, 9007199254740993n]);
        const bu64 = roundTrip(new BigUint64Array([18446744073709551615n])) as BigUint64Array;
        expect(bu64).toBeInstanceOf(BigUint64Array);
        expect(Array.from(bu64)).toEqual([18446744073709551615n]);
    });

    it('DataView', () => {
        const src = new DataView(new Uint8Array([1, 2, 3, 4]).buffer);
        const out = roundTrip(src) as DataView;
        expect(out).toBeInstanceOf(DataView);
        expect(out.byteLength).toBe(4);
        expect(out.getUint8(3)).toBe(4);
    });

    it('bare ArrayBuffer', () => {
        const out = roundTrip(new Uint8Array([9, 8, 7]).buffer) as ArrayBuffer;
        expect(out).toBeInstanceOf(ArrayBuffer);
        expect(Array.from(new Uint8Array(out))).toEqual([9, 8, 7]);
    });
});

describe('view windows and subclasses', () => {
    it('a subarray view encodes ONLY its window, not the whole buffer', () => {
        const buf = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer;
        const view = new Uint8Array(buf, 2, 3);
        expect(encodeWithHandlers(view, HANDLERS)).toEqual({ $bytes: 'AgME' });
        const out = roundTrip(view) as Uint8Array;
        expect(Array.from(out)).toEqual([2, 3, 4]);
        expect(out.byteOffset).toBe(0);
    });

    it('a multi-byte view window keeps its own bytes', () => {
        const backing = new Int32Array([10, 20, 30, 40]);
        const view = backing.subarray(1, 3);
        const out = roundTrip(view) as Int32Array;
        expect(out).toBeInstanceOf(Int32Array);
        expect(Array.from(out)).toEqual([20, 30]);
    });

    it('Node Buffer is claimed and revives as a plain Uint8Array', () => {
        if (typeof Buffer === 'undefined') return;
        const buf = Buffer.from([1, 2, 3]);
        expect(bytesHandler.test(buf)).toBe(true);
        // Bare-string form — Buffer matches the Uint8Array row first.
        expect(encodeWithHandlers(buf, HANDLERS)).toEqual({ $bytes: 'AQID' });
        const out = roundTrip(buf) as Uint8Array;
        expect(out).toBeInstanceOf(Uint8Array);
        expect(Buffer.isBuffer(out)).toBe(false);
        expect(Array.from(out)).toEqual([1, 2, 3]);
    });
});

describe('composition with the built-in vocabulary', () => {
    it('bytes nested in a Map inside an object round-trip', () => {
        const value = {
            assets: new Map<string, Uint8Array>([['icon', new Uint8Array([5, 6])]]),
            at: new Date(0)
        };
        const out = roundTrip(value) as typeof value;
        expect(out.at).toBeInstanceOf(Date);
        const icon = out.assets.get('icon');
        expect(icon).toBeInstanceOf(Uint8Array);
        expect(Array.from(icon as Uint8Array)).toEqual([5, 6]);
    });

    it('a LIVE Uint8Array passes through revive untouched (idempotence)', () => {
        const live = new Uint8Array([1, 2]);
        expect(reviveWithHandlers(live, HANDLERS)).toBe(live);
    });

    it('revive(revive(x)) equals revive(x)', () => {
        const encoded = JSON.parse(
            JSON.stringify(encodeWithHandlers(new Uint8Array([1, 2, 3]), HANDLERS))
        ) as unknown;
        const once = reviveWithHandlers(encoded, HANDLERS);
        const twice = reviveWithHandlers(once, HANDLERS);
        expect(twice).toBe(once);
    });
});

describe('degradation and structure', () => {
    it('an unknown view kind degrades to Uint8Array with a dev warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const out = reviveWithHandlers({ $bytes: ['Float16Array', 'AQID'] }, HANDLERS);
        expect(out).toBeInstanceOf(Uint8Array);
        expect(Array.from(out as Uint8Array)).toEqual([1, 2, 3]);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain('unknown view kind "Float16Array"');
    });

    it('holds the structural invariants a built-in would: $-tag, revive, no collision', () => {
        expect(bytesHandler.tag).toBe('$bytes');
        expect(bytesHandler.tag.startsWith('$')).toBe(true);
        expect(typeof bytesHandler.revive).toBe('function');
        for (const h of BUILTIN_TYPE_HANDLERS) {
            expect(h.tag).not.toBe(bytesHandler.tag);
        }
    });

    it('claims nothing it cannot revive faithfully', () => {
        // SharedArrayBuffer / Float16Array (where available) keep warning —
        // the honest posture. A plain object is never claimed.
        expect(bytesHandler.test({})).toBe(false);
        expect(bytesHandler.test([1, 2])).toBe(false);
        if (typeof SharedArrayBuffer !== 'undefined') {
            expect(bytesHandler.test(new SharedArrayBuffer(4))).toBe(false);
        }
    });
});
