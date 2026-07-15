import { describe, it, expect } from 'vitest';
import { createToken, getProvided, setProvided, type InjectionToken } from '../src/di/token';

describe('typed DI tokens', () => {
    it('createToken returns a plain symbol carrying the description', () => {
        const token = createToken<{ n: number }>('sigx:test');
        expect(typeof token).toBe('symbol');
        expect(token.description).toBe('sigx:test');
    });

    it('tokens are unique per createToken call (no Symbol.for registry)', () => {
        const a = createToken<string>('sigx:same');
        const b = createToken<string>('sigx:same');
        expect(a).not.toBe(b);
    });

    it('setProvided/getProvided round-trip a value with its type', () => {
        const token = createToken<{ hits: number }>('sigx:roundtrip');
        const provides = new Map<symbol, unknown>();

        setProvided(provides, token, { hits: 3 });
        const value = getProvided(provides, token);

        expect(value).toEqual({ hits: 3 });
        // Type-level: value is { hits: number } | undefined — no cast needed.
        expect(value!.hits + 1).toBe(4);
    });

    it('getProvided tolerates a missing map and a missing entry', () => {
        const token = createToken<string>('sigx:absent');
        expect(getProvided(undefined, token)).toBeUndefined();
        expect(getProvided(null, token)).toBeUndefined();
        expect(getProvided(new Map<symbol, unknown>(), token)).toBeUndefined();
    });

    it('an InjectionToken is assignable wherever a symbol is expected', () => {
        const token: InjectionToken<number> = createToken<number>('sigx:assignable');
        const asSymbol: symbol = token;
        const provides = new Map<symbol, unknown>([[asSymbol, 42]]);
        expect(getProvided(provides, token)).toBe(42);
    });
});
