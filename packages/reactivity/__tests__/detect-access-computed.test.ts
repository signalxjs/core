import { describe, it, expect } from 'vitest';
import { signal, computed, detectAccess } from '../src/index';

describe('detectAccess with computed', () => {
    it('should detect access to computed.value', () => {
        const state = signal({ count: 5 });
        const doubled = computed({
            get: () => state.count * 2,
            set: (v: number) => { state.count = v / 2; }
        });

        const detected = detectAccess(() => doubled.value);

        expect(detected).not.toBeNull();
        expect(detected![0]).toBe(doubled);
        expect(detected![1]).toBe('value');
        
        const [obj, key] = detected!;
        expect((obj as any)[key]).toBe(10);
    });

    it('should correctly detect when computed accesses another signal internally', () => {
        const state = signal({ count: 5 });
        const doubled = computed({
            get: () => state.count * 2,
            set: (v: number) => { state.count = v / 2; }
        });

        const detected = detectAccess(() => doubled.value);
        
        // We want it to be the computed, not the underlying state
        expect(detected![0]).toBe(doubled);
    });
});

describe('detectAccess with nested signal paths', () => {
    it('should detect leaf property on flat signal', () => {
        const state = signal({ name: 'hello' });
        const detected = detectAccess(() => state.name);

        expect(detected).not.toBeNull();
        expect(detected![0]).toBe(state);
        expect(detected![1]).toBe('name');
    });

    it('should detect leaf property on nested signal (state.form.field)', () => {
        const state = signal({
            form: { displayName: 'Admin', password: '' }
        });
        const detected = detectAccess(() => state.form.displayName);

        expect(detected).not.toBeNull();
        // Must return [state.form, "displayName"], NOT [state, "form"]
        expect(detected![1]).toBe('displayName');
        expect((detected![0] as any).displayName).toBe('Admin');
    });

    it('should detect leaf property on deeply nested signal (3+ levels)', () => {
        const state = signal({
            app: { settings: { theme: 'dark' } }
        });
        const detected = detectAccess(() => state.app.settings.theme);

        expect(detected).not.toBeNull();
        expect(detected![1]).toBe('theme');
        expect((detected![0] as any).theme).toBe('dark');
    });

    it('should allow writing back through detected tuple', () => {
        const state = signal({
            form: { displayName: 'Admin', password: '' }
        });
        const detected = detectAccess(() => state.form.displayName);

        // Simulate what model binding does: obj[key] = newValue
        const [obj, key] = detected!;
        (obj as any)[key as string] = 'Updated';

        expect(state.form.displayName).toBe('Updated');
        // Must NOT destroy sibling fields
        expect(state.form.password).toBe('');
    });

    it('should still detect computed.value when computed reads nested state', () => {
        const state = signal({
            form: { firstName: 'John', lastName: 'Doe' }
        });
        const fullName = computed({
            get: () => `${state.form.firstName} ${state.form.lastName}`,
            set: (v: string) => {
                const [first, ...rest] = v.split(' ');
                state.form.firstName = first;
                state.form.lastName = rest.join(' ');
            }
        });

        const detected = detectAccess(() => fullName.value);

        // Must return [computed, "value"], not leak to nested state internals
        expect(detected![0]).toBe(fullName);
        expect(detected![1]).toBe('value');
    });
});
