import { describe, it, expect, afterEach } from 'vitest';
import {
    getCurrentInstanceSafe,
    setCurrentInstanceSafe,
    runInRequestScope,
    hasRequestIsolation
} from '../src/async-context';

afterEach(() => {
    setCurrentInstanceSafe(null);
});

describe('getCurrentInstanceSafe / setCurrentInstanceSafe', () => {
    it('returns null initially', () => {
        expect(getCurrentInstanceSafe()).toBeNull();
    });

    it('set returns previous value (null on first call)', () => {
        const prev = setCurrentInstanceSafe({ id: 1 });
        expect(prev).toBeNull();
    });

    it('set then get returns new value', () => {
        const ctx = { id: 'comp-a' };
        setCurrentInstanceSafe(ctx);
        expect(getCurrentInstanceSafe()).toBe(ctx);
    });

    it('set twice — second returns first, get returns second', () => {
        const first = { id: 1 };
        const second = { id: 2 };
        setCurrentInstanceSafe(first);
        const prev = setCurrentInstanceSafe(second);
        expect(prev).toBe(first);
        expect(getCurrentInstanceSafe()).toBe(second);
    });

    it('set null to clear', () => {
        setCurrentInstanceSafe({ id: 'temp' });
        setCurrentInstanceSafe(null);
        expect(getCurrentInstanceSafe()).toBeNull();
    });
});

describe('runInRequestScope', () => {
    it('runs function and returns its result', () => {
        const result = runInRequestScope(() => 42);
        expect(result).toBe(42);
    });

    it('creates isolated context — instance set outside is null inside scope', () => {
        const outer = { id: 'outer' };
        setCurrentInstanceSafe(outer);

        runInRequestScope(() => {
            expect(getCurrentInstanceSafe()).toBeNull();
        });

        expect(getCurrentInstanceSafe()).toBe(outer);
    });

    it('changes inside scope do not leak outside', () => {
        setCurrentInstanceSafe(null);

        runInRequestScope(() => {
            setCurrentInstanceSafe({ id: 'inner' });
        });

        expect(getCurrentInstanceSafe()).toBeNull();
    });

    it('nested scopes are independent', () => {
        const outerCtx = { id: 'outer' };
        setCurrentInstanceSafe(outerCtx);

        runInRequestScope(() => {
            expect(getCurrentInstanceSafe()).toBeNull();
            setCurrentInstanceSafe({ id: 'scope-1' });

            runInRequestScope(() => {
                expect(getCurrentInstanceSafe()).toBeNull();
                setCurrentInstanceSafe({ id: 'scope-2' });
                expect(getCurrentInstanceSafe()).toEqual({ id: 'scope-2' });
            });

            expect(getCurrentInstanceSafe()).toEqual({ id: 'scope-1' });
        });

        expect(getCurrentInstanceSafe()).toBe(outerCtx);
    });

    it('async function within scope maintains isolation', async () => {
        setCurrentInstanceSafe({ id: 'before' });

        const result = await runInRequestScope(async () => {
            expect(getCurrentInstanceSafe()).toBeNull();
            setCurrentInstanceSafe({ id: 'async-inner' });
            await new Promise((r) => setTimeout(r, 10));
            expect(getCurrentInstanceSafe()).toEqual({ id: 'async-inner' });
            return 'done';
        });

        expect(result).toBe('done');
        expect(getCurrentInstanceSafe()).toEqual({ id: 'before' });
    });
});

describe('hasRequestIsolation', () => {
    it('returns true in Node.js environment', () => {
        expect(hasRequestIsolation()).toBe(true);
    });
});
