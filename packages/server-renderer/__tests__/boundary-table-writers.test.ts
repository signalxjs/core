/**
 * The boundary table's write accessors (rfc-server §6.3, #313):
 * `installBoundaryRecords` (a refresh envelope's `records` patch enters the
 * table exactly as a streamed assignment would) and `removeBoundaryRecord`
 * (a swapped-out boundary's id is retired). Plus the id-seeded context the
 * refresh render uses to keep fresh markers collision-free.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    getBoundaryTable,
    getBoundaryRecord,
    installBoundaryRecords,
    removeBoundaryRecord
} from '../src/client/scheduler';
import { createSSRContext } from '../src/server/context';

declare global {
    interface Window {
        __SIGX_BOUNDARIES__?: Record<string, unknown>;
    }
}

beforeEach(() => {
    delete window.__SIGX_BOUNDARIES__;
});

describe('installBoundaryRecords', () => {
    it('creates the table when absent and merges into an existing one', () => {
        installBoundaryRecords({ 5: { component: 'A' } });
        expect(getBoundaryRecord(5)).toEqual({ component: 'A' });

        installBoundaryRecords({ 7: { component: 'B' } });
        expect(getBoundaryRecord(5)).toEqual({ component: 'A' });
        expect(getBoundaryRecord(7)).toEqual({ component: 'B' });
    });

    it('overwrites an existing record wholesale', () => {
        installBoundaryRecords({ 5: { component: 'A', state: { n: 1 } } });
        installBoundaryRecords({ 5: { component: 'A', state: { n: 2 } } });
        expect(getBoundaryRecord(5)).toEqual({ component: 'A', state: { n: 2 } });
    });

    it('keeps the null-prototype discipline — __proto__ lands as plain data', () => {
        installBoundaryRecords({ ['__proto__']: { component: 'evil' } } as never);
        // No prototype write happened…
        expect(({} as Record<string, unknown>).component).toBeUndefined();
        // …and the table object itself has no prototype to pollute.
        expect(Object.getPrototypeOf(getBoundaryTable())).toBeNull();
    });
});

describe('removeBoundaryRecord', () => {
    it('retires exactly the named id', () => {
        installBoundaryRecords({ 5: { component: 'A' }, 7: { component: 'B' } });
        removeBoundaryRecord(5);
        expect(getBoundaryRecord(5)).toBeUndefined();
        expect(getBoundaryRecord(7)).toEqual({ component: 'B' });
    });

    it('is a no-op without a table', () => {
        expect(() => removeBoundaryRecord(5)).not.toThrow();
    });
});

describe('createSSRContext({ baseComponentId })', () => {
    it('seeds the id counter so fresh markers sit above the page range', () => {
        const ctx = createSSRContext({ baseComponentId: 1 << 20 });
        expect(ctx.nextId()).toBe((1 << 20) + 1);
        expect(ctx.nextId()).toBe((1 << 20) + 2);
    });

    it('defaults to the historical 1-based sequence', () => {
        const ctx = createSSRContext();
        expect(ctx.nextId()).toBe(1);
    });
});
