/**
 * @vitest-environment node
 *
 * The URL grammar both entries share (rfc-server §4/§4.1, #355): the
 * symbol↔path codec and the GET read's named-argument query. Unit-level
 * because the two halves must be exact mirrors — the endpoint tests cover
 * how a mismatch surfaces (404s and 400s), this file covers that there
 * isn't one.
 */

import { describe, it, expect } from 'vitest';
import { encodeFnPath, encodeReadQuery } from '../src/fn-url';
import { decodeFnPath, decodeReadQuery } from '../src/fn-url-decode';

const blob = (args: unknown[]): string => JSON.stringify(args);

describe('encodeFnPath / decodeFnPath', () => {
    it('leaves a hashed symbol completely alone', () => {
        expect(encodeFnPath('addToCart_fn_9f3a01cc')).toBe('addToCart_fn_9f3a01cc');
    });

    it('spends a stable symbol as real path segments — no % at all', () => {
        const symbol = '@acme/api/src/cart.server.ts/addToCart';
        expect(encodeFnPath(symbol)).toBe(symbol);
        expect(encodeFnPath(symbol)).not.toContain('%');
    });

    it('escapes only what a path segment cannot carry', () => {
        expect(encodeFnPath('@acme/a b/c?d/e#f/fn')).toBe('@acme/a%20b/c%3Fd/e%23f/fn');
    });

    it('round-trips everything it encodes', () => {
        for (const symbol of [
            'addToCart_fn_9f3a01cc',
            '@acme/api/src/cart.server.ts/addToCart',
            'cart/add/add',
            '@acme/a b/c?d/e#f/fn',
            'weird/%/fn',
            'unicode/påse/fn'
        ]) {
            expect(decodeFnPath(encodeFnPath(symbol))).toBe(symbol);
        }
    });

    it('throws on a malformed escape so the endpoint can 400 it', () => {
        expect(() => decodeFnPath('%FF')).toThrow(URIError);
    });
});

describe('encodeReadQuery / decodeReadQuery', () => {
    const roundTrip = (args: unknown[]): unknown[] | string | null => {
        const query = encodeReadQuery(args, blob);
        return decodeReadQuery(new URLSearchParams(query));
    };

    it('spends all-scalar args as readable named params', () => {
        expect(encodeReadQuery(['shoes', 42, true, null], blob)).toBe(
            'a0=shoes&a1=42&a2=true&a3=null'
        );
    });

    it('emits nothing at all for a no-argument read', () => {
        expect(encodeReadQuery([], blob)).toBe('');
        expect(decodeReadQuery(new URLSearchParams(''))).toBeNull();
    });

    it('round-trips scalars with their types intact', () => {
        for (const args of [
            ['shoes'],
            [42],
            [-1.5e3],
            [0],
            [true, false],
            [null],
            [''],
            ['hello world'],
            ['a&b=c'],
            // Strings that would otherwise read back as something else.
            ['42'],
            ['true'],
            ['null'],
            ['-0.5'],
            ['"quoted"'],
            // Strings that look numeric but are not, by the strict grammar.
            ['007'],
            ['+1'],
            ['1_000'],
            ['shoes', 2, false, null]
        ]) {
            expect(roundTrip(args), JSON.stringify(args)).toEqual(args);
        }
    });

    it('falls back to the blob as soon as one argument is not a scalar', () => {
        for (const args of [
            [{ id: 'p1' }],
            [['a']],
            ['shoes', { page: 2 }],
            [undefined],
            [Number.NaN],
            [Number.POSITIVE_INFINITY]
        ]) {
            const query = encodeReadQuery(args, blob);
            expect(query.startsWith('args='), JSON.stringify(args)).toBe(true);
            // The blob is the caller's business, so the named decoder declines it.
            expect(decodeReadQuery(new URLSearchParams(query))).toBeNull();
        }
    });

    it('decodes several named params positionally', () => {
        expect(decodeReadQuery(new URLSearchParams('a0=1&a1=two&a2=false'))).toEqual([
            1,
            'two',
            false
        ]);
    });

    it('rejects both encodings on one call', () => {
        expect(decodeReadQuery(new URLSearchParams('a0=1&args=%5B1%5D'))).toBe('both');
        expect(decodeReadQuery(new URLSearchParams('a1=1&args=%5B1%5D'))).toBe('both');
    });

    it('rejects a gap rather than shifting the arguments down', () => {
        expect(decodeReadQuery(new URLSearchParams('a1=2'))).toBe('sparse');
        expect(decodeReadQuery(new URLSearchParams('a0=1&a2=3'))).toBe('sparse');
        expect(decodeReadQuery(new URLSearchParams('a0=1&a1=2&a4=5'))).toBe('sparse');
    });

    it('rejects a malformed quoted value', () => {
        expect(decodeReadQuery(new URLSearchParams('a0="unterminated'))).toBe('malformed');
    });

    it('ignores query params that are not arguments', () => {
        expect(decodeReadQuery(new URLSearchParams('a0=1&utm_source=x'))).toEqual([1]);
        expect(decodeReadQuery(new URLSearchParams('utm_source=x'))).toBeNull();
    });
});
