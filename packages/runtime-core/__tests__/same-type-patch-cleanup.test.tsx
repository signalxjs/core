import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';

/**
 * Regression test for the wizard reconciler bug where a child component's
 * `onUnmounted` hooks silently stopped firing after a parent component
 * re-rendered.
 *
 * Root cause: the renderer's same-type patch path copied `_effect`,
 * `_subTree`, `_subTreeRef`, and `_slots` from the old VNode to the new
 * VNode, but not `cleanup`. After any parent re-render that kept the same
 * child component type at the same position, the live VNode no longer
 * had the cleanup closure created at mount time, so when it was later
 * unmounted, its onUnmounted hooks never ran.
 *
 * Symptom in the CLI: the previous step's keyboard handler kept firing
 * on the Done screen, the focus state never cleared, and pressing Enter
 * re-triggered scaffolding ("folder already exists").
 */
describe('same-type patch preserves cleanup', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('still runs onUnmounted on a child component after the parent re-renders', () => {
        const unmountSpy = vi.fn();
        const parentTick = signal(0);

        // Child registers an onUnmounted hook at mount time.
        const Child = component((ctx) => {
            ctx.onUnmounted(() => unmountSpy());
            return () => jsx('div', { children: 'child' });
        });

        // Parent owns a reactive signal and reads it during render.
        // Bumping `parentTick` triggers a re-render of Parent, which
        // produces a fresh VNode tree containing a new Child VNode.
        // The reconciler hits the same-type patch path for Child.
        const Parent = component(() => {
            return () => jsx('div', {
                'data-tick': String(parentTick.value),
                children: jsx(Child, {}),
            });
        });

        render(jsx(Parent, {}), container);
        expect(unmountSpy).not.toHaveBeenCalled();

        // Force the parent to re-render. Child's VNode is replaced with a
        // fresh one via the same-type patch path. Without the fix, the
        // new VNode does not carry `cleanup`, so the eventual unmount
        // becomes silent.
        parentTick.value = 1;
        parentTick.value = 2;
        parentTick.value = 3;

        // Now unmount everything. The Child's onUnmounted hook must fire
        // exactly once, even though the live VNode is the post-patch one.
        render(null, container);
        expect(unmountSpy).toHaveBeenCalledTimes(1);
    });

    it('preserves cleanup through multiple parent re-renders before unmount', () => {
        const unmountSpy = vi.fn();
        const a = signal(0);
        const b = signal('x');

        const Leaf = component((ctx) => {
            ctx.onUnmounted(() => unmountSpy());
            return () => jsx('span', { children: 'leaf' });
        });

        // Intermediate component re-renders on its own signal, exercising
        // the same-type patch path repeatedly.
        const Middle = component(() => {
            return () => jsx('div', {
                'data-b': b.value,
                children: jsx(Leaf, {}),
            });
        });

        const Outer = component(() => {
            return () => jsx('section', {
                'data-a': String(a.value),
                children: jsx(Middle, {}),
            });
        });

        render(jsx(Outer, {}), container);

        // Interleave updates so both Outer and Middle re-render multiple
        // times, each going through the same-type patch path for their
        // child components.
        a.value = 1;
        b.value = 'y';
        a.value = 2;
        b.value = 'z';
        a.value = 3;

        render(null, container);
        expect(unmountSpy).toHaveBeenCalledTimes(1);
    });

    it('cleanup runs when the child is later swapped out by a sibling-type change', () => {
        // This mirrors the wizard pattern: parent re-renders many times
        // while one child stays mounted, then eventually the child is
        // replaced by a different component type.
        const aUnmount = vi.fn();
        const bUnmount = vi.fn();
        const which = signal<'a' | 'b'>('a');
        const tick = signal(0);

        const ChildA = component((ctx) => {
            ctx.onUnmounted(() => aUnmount());
            return () => jsx('div', { children: 'A' });
        });
        const ChildB = component((ctx) => {
            ctx.onUnmounted(() => bUnmount());
            return () => jsx('div', { children: 'B' });
        });

        const Parent = component(() => {
            return () => jsx('div', {
                'data-tick': String(tick.value),
                children: which.value === 'a' ? jsx(ChildA, {}) : jsx(ChildB, {}),
            });
        });

        render(jsx(Parent, {}), container);

        // Parent re-renders while ChildA stays mounted at the same position.
        tick.value = 1;
        tick.value = 2;
        tick.value = 3;

        // Now swap to ChildB. ChildA should unmount once and run its hook.
        which.value = 'b';
        expect(aUnmount).toHaveBeenCalledTimes(1);
        expect(bUnmount).not.toHaveBeenCalled();

        // Same drill for ChildB.
        tick.value = 4;
        tick.value = 5;
        render(null, container);
        expect(bUnmount).toHaveBeenCalledTimes(1);
    });
});
