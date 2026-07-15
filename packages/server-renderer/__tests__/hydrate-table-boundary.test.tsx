/**
 * hydrateTableBoundary / findBoundaryMarker (#254): the exported one-shot
 * boundary hydration packs drive on their own schedule (resumability's
 * upgrade-on-write) — current-record read, registry resolution, in-place
 * hydration, honest false on missing record/marker/component.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import {
    hydrateTableBoundary,
    findBoundaryMarker,
    invalidateMarkerIndex,
    registerComponent
} from '../src/client/index';
import { createSSR } from '../src/ssr';
import type { SSRPlugin } from '../src/plugin';

const claimAll: SSRPlugin = {
    name: 'claim-all',
    server: {
        resolveBoundary(vnode) {
            return (vnode.type as any).__testStamp ? { hydrate: 'never' } : undefined;
        }
    }
};

function makeCounter(): any {
    const Counter = component<{ initial?: number }>((ctx) => {
        const n = ctx.signal(ctx.props.initial ?? 0);
        return () => <button onClick={() => n.value++}>{n.value}</button>;
    }, { name: 'TableCounter' });
    (Counter as any).__testStamp = true;
    return Counter;
}

let container: HTMLElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    container.remove();
    delete (window as any).__SIGX_BOUNDARIES__;
    invalidateMarkerIndex();
});

async function mount(vnode: any): Promise<number> {
    const html = await createSSR().use(claimAll).render(vnode);
    const match = html.match(/window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/)!;
    const table = JSON.parse(match[1]);
    container.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    (window as any).__SIGX_BOUNDARIES__ = table;
    invalidateMarkerIndex();
    return parseInt(Object.keys(table)[0], 10);
}

describe('hydrateTableBoundary', () => {
    it('hydrates one boundary in place; its listeners go live', async () => {
        const Counter = makeCounter();
        const id = await mount(<Counter initial={4} />);
        registerComponent('TableCounter', Counter);

        expect(findBoundaryMarker(id)).toBeTruthy();
        expect(await hydrateTableBoundary(id)).toBe(true);

        const button = container.querySelector('button')!;
        expect(button.textContent).toBe('4');
        button.dispatchEvent(new Event('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(button.textContent).toBe('5');
    });

    it('returns false for missing records, markers, or components', async () => {
        expect(await hydrateTableBoundary(999)).toBe(false); // no record

        const Unresolvable = makeCounter();
        (Unresolvable as any).__name = 'NeverRegistered';
        const id = await mount(<Unresolvable />);
        expect(await hydrateTableBoundary(id)).toBe(false); // no component

        (window as any).__SIGX_BOUNDARIES__ = { 777: { hydrate: 'never', component: 'X' } };
        expect(await hydrateTableBoundary(777)).toBe(false); // no marker
    });
});
