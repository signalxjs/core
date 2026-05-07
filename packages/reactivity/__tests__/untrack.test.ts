import { describe, it, expect, vi } from 'vitest';
import { signal, untrack, effect, detectAccess } from '../src/index';

describe('untrack', () => {
    it('should read values without tracking dependencies', () => {
        const state = signal({ a: 1, b: 2 });
        let effectRuns = 0;

        effect(() => {
            // Track 'a' but not 'b'
            void state.a;
            untrack(() => {
                void state.b;
            });
            effectRuns++;
        });

        expect(effectRuns).toBe(1);

        // Changing 'a' should trigger effect
        state.a = 10;
        expect(effectRuns).toBe(2);

        // Changing 'b' should NOT trigger effect (was untracked)
        state.b = 20;
        expect(effectRuns).toBe(2);
    });

    it('should return the value from the untracked function', () => {
        const state = signal({ count: 5 });
        let result: number = 0;

        effect(() => {
            result = untrack(() => state.count * 2);
        });

        expect(result).toBe(10);
    });
});

describe('detectAccess', () => {
    it('should detect property access on a signal', () => {
        const state = signal({ name: 'test', value: 42 });

        const result = detectAccess(() => state.name);

        expect(result).not.toBeNull();
        expect(result![0]).toBe(state);
        expect(result![1]).toBe('name');
    });

    it('should detect nested property access (captures last/leaf access)', () => {
        const state = signal({ user: { name: 'John' } });

        const result = detectAccess(() => state.user.name);

        expect(result).not.toBeNull();
        // detectAccess captures the LAST access — the leaf property
        // For state.user.name, this is [state.user, 'name'], enabling correct model binding
        expect(result![1]).toBe('name');
        expect((result![0] as any).name).toBe('John');
    });

    it('should return null when no access occurs', () => {
        const result = detectAccess(() => {
            // No reactive access
            const x = 5;
            return x;
        });

        expect(result).toBeNull();
    });
});
