/**
 * Setup-scope disposal on the hydration path (core#288): an effect()/watch()
 * created in a hydrated component's setup is torn down when the component
 * unmounts — mirroring runtime-core's mountComponent.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { component, signal, watch, effect } from 'sigx';
import { hydrateComponent } from '../src/client/hydrate-component';
import { createSSRContainer, cleanupContainer } from './test-utils';

describe('hydrateComponent — setup-scope disposal (core#288)', () => {
    let container: HTMLDivElement;
    afterEach(() => { if (container) cleanupContainer(container); });

    it('disposes a setup watch()/effect() when the hydrated component unmounts', () => {
        const s = signal({ n: 0 });
        const watchRuns: number[] = [];
        const effectRuns: number[] = [];

        const Cmp = component(() => {
            watch(() => s.n, (n) => { watchRuns.push(n); });
            effect(() => { effectRuns.push(s.n); });
            return () => ({ type: 'div', props: {}, key: null, children: [], dom: null } as any);
        }, { name: 'SetupScope' });

        // SSR shape: the component's <div> + its trailing marker.
        container = createSSRContainer('<div></div><!--$c:1-->');
        const vnode = (Cmp as any)({});
        hydrateComponent(vnode, container.firstChild, container);

        expect(effectRuns).toEqual([0]); // effect ran on creation during setup

        // Live while mounted.
        s.n = 1;
        expect(watchRuns).toEqual([1]);
        expect(effectRuns).toEqual([0, 1]);

        // Unmount cleanup (what the renderer's unmount() invokes) disposes the
        // setup reactions.
        expect(typeof vnode.cleanup).toBe('function');
        vnode.cleanup();

        s.n = 2;
        expect(watchRuns).toEqual([1]);       // watcher disposed
        expect(effectRuns).toEqual([0, 1]);   // effect disposed
    });
});
