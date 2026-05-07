/**
 * Core directive system tests
 *
 * Tests defineDirective, isDirective, El type parameter,
 * and app-level directive registration.
 */

import { describe, it, expect } from 'vitest';
import { defineDirective, isDirective } from '../src/directives';
import type { DirectiveDefinition, DirectiveBinding } from '../src/directives';

describe('defineDirective', () => {
    it('should return the same definition object', () => {
        const def: DirectiveDefinition = {
            mounted(el, { value }) {}
        };
        const result = defineDirective(def);
        expect(result).toBe(def);
    });

    it('should mark the definition with __DIRECTIVE__ symbol', () => {
        const def = defineDirective({
            mounted(el, { value }) {}
        });
        expect(isDirective(def)).toBe(true);
    });

    it('should work with no hooks (empty definition)', () => {
        const def = defineDirective({});
        expect(isDirective(def)).toBe(true);
    });

    it('should preserve all lifecycle hooks', () => {
        const created = () => {};
        const mounted = () => {};
        const updated = () => {};
        const unmounted = () => {};

        const def = defineDirective({
            created,
            mounted,
            updated,
            unmounted
        });

        expect(def.created).toBe(created);
        expect(def.mounted).toBe(mounted);
        expect(def.updated).toBe(updated);
        expect(def.unmounted).toBe(unmounted);
    });

    it('should preserve extra properties added at runtime (e.g., getSSRProps)', () => {
        const def = defineDirective({
            mounted() {}
        });

        // SSR packages patch getSSRProps onto directives at runtime
        const getSSRProps = () => ({});
        (def as any).getSSRProps = getSSRProps;
        expect((def as any).getSSRProps).toBe(getSSRProps);
    });

    it('should support generic value type', () => {
        const def = defineDirective<string>({
            mounted(el, { value }) {
                // value should be string at type level
                const _v: string = value;
            }
        });
        expect(isDirective(def)).toBe(true);
    });

    it('should support generic element type', () => {
        interface MockElement {
            title: string;
        }

        const def = defineDirective<string, MockElement>({
            mounted(el, { value }) {
                // el should be MockElement at type level
                el.title = value;
            }
        });
        expect(isDirective(def)).toBe(true);
    });
});

describe('isDirective', () => {
    it('should return true for defined directives', () => {
        const def = defineDirective({ mounted() {} });
        expect(isDirective(def)).toBe(true);
    });

    it('should return false for null', () => {
        expect(isDirective(null)).toBe(false);
    });

    it('should return false for undefined', () => {
        expect(isDirective(undefined)).toBe(false);
    });

    it('should return false for plain objects', () => {
        expect(isDirective({ mounted() {} })).toBe(false);
    });

    it('should return false for primitives', () => {
        expect(isDirective(42)).toBe(false);
        expect(isDirective('string')).toBe(false);
        expect(isDirective(true)).toBe(false);
    });

    it('should return false for arrays', () => {
        expect(isDirective([1, 2, 3])).toBe(false);
    });

    it('should return false for functions', () => {
        expect(isDirective(() => {})).toBe(false);
    });
});

describe('DirectiveBinding', () => {
    it('should have value and optional oldValue', () => {
        const binding: DirectiveBinding<number> = { value: 42 };
        expect(binding.value).toBe(42);
        expect(binding.oldValue).toBeUndefined();
    });

    it('should support oldValue in update context', () => {
        const binding: DirectiveBinding<number> = { value: 42, oldValue: 10 };
        expect(binding.value).toBe(42);
        expect(binding.oldValue).toBe(10);
    });
});
