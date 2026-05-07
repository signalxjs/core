/**
 * Type-level regression tests for lazy() and compound().
 *
 * Verifies that components with required props satisfy the generic
 * constraints used by lazy() and compound(). Before the AnyComponentFactory
 * fix, these would fail with:
 *   "Type 'ComponentFactory<{ fileUrl: string; ... }, void, {}>'
 *    does not satisfy the constraint 'ComponentFactory<any, any, any>'"
 */

import { describe, it, expect } from 'vitest';
import { component, lazy, compound } from '../src';
import type { ComponentFactory, AnyComponentFactory, LazyComponentFactory } from '../src';

describe('lazy() type constraints', () => {
    it('should accept a component with no props', () => {
        const NoProps = component(() => () => null);
        const LazyNoProps = lazy(() => Promise.resolve({ default: NoProps }));

        expect(LazyNoProps.__lazy).toBe(true);
        expect(typeof LazyNoProps.preload).toBe('function');
        expect(typeof LazyNoProps.isLoaded).toBe('function');
    });

    it('should accept a component with required props', () => {
        const WithRequired = component<{ fileUrl: string; label?: string }>(
            ({ props }) => () => null
        );
        // Before the fix this was a type error due to contravariance
        const LazyWithRequired = lazy(() => Promise.resolve({ default: WithRequired }));

        expect(LazyWithRequired.__lazy).toBe(true);
        expect(typeof LazyWithRequired.preload).toBe('function');
    });

    it('should accept a component with only required props', () => {
        const AllRequired = component<{ a: string; b: number; c: boolean }>(
            ({ props }) => () => null
        );
        const LazyAllRequired = lazy(() => Promise.resolve({ default: AllRequired }));

        expect(LazyAllRequired.__lazy).toBe(true);
    });

    it('should preserve the component type through LazyComponentFactory', () => {
        const MyComp = component<{ title: string }>(({ props }) => () => null);
        const LazyComp = lazy(() => Promise.resolve({ default: MyComp }));

        // Type-level: LazyComp should still have __props, __setup etc.
        expect(LazyComp.__setup).toBeDefined();
    });
});

describe('compound() type constraints', () => {
    it('should accept components with required props', () => {
        const Tabs = component<{ activeTab: string }>(({ props }) => () => null);
        const Panel = component<{ id: string; label: string }>(({ props }) => () => null);

        // Before the fix this was a type error due to contravariance
        const CompoundTabs = compound(Tabs, { Panel });

        expect(CompoundTabs.__setup).toBeDefined();
        expect(CompoundTabs.Panel.__setup).toBeDefined();
    });
});

describe('AnyComponentFactory constraint', () => {
    it('should be satisfied by any ComponentFactory', () => {
        const comp = component<{ x: number }>(({ props }) => () => null);

        // Type-level assertion: ComponentFactory<{x: number}, ...> extends AnyComponentFactory
        const asAny: AnyComponentFactory = comp;
        expect(asAny.__setup).toBeDefined();
    });
});
