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
    registerComponent,
    registerComponentChunk
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

function makeCounter(name = 'TableCounter'): any {
    const Counter = component<{ initial?: number }>((ctx) => {
        const n = ctx.signal(ctx.props.initial ?? 0);
        return () => <button onClick={() => n.value++}>{n.value}</button>;
    }, { name });
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
    const html = await createSSR({ plugins: [claimAll] }).render(vnode);
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

        const Unresolvable = makeCounter('NeverRegistered');
        const id = await mount(<Unresolvable />);
        expect(await hydrateTableBoundary(id)).toBe(false); // no component

        (window as any).__SIGX_BOUNDARIES__ = { 777: { hydrate: 'never', component: 'X' } };
        expect(await hydrateTableBoundary(777)).toBe(false); // no marker
    });
});

describe('streamed boundaries still showing their placeholder', () => {
    it('returns false instead of hydrating placeholder content', async () => {
        const Counter = makeCounter('PendingStream');
        registerComponent('PendingStream', Counter);
        // Simulate a pending streamed boundary: placeholder + marker, table entry.
        container.innerHTML =
            `<div data-async-placeholder="5" style="display:contents;">loading…</div><!--$c:5-->`;
        (window as any).__SIGX_BOUNDARIES__ = { 5: { hydrate: 'never', component: 'PendingStream' } };
        invalidateMarkerIndex();

        expect(await hydrateTableBoundary(5)).toBe(false);
        expect(container.textContent).toContain('loading…'); // untouched
    });

    it("returns false for pending streams even when the record says flush:'skip'", async () => {
        const Counter = makeCounter('PendingSkip');
        registerComponent('PendingSkip', Counter);
        // data-async-placeholder ALWAYS means the stream hasn't landed —
        // skip boundaries use the data-boundary placeholder, never this one.
        container.innerHTML =
            `<div data-async-placeholder="6" style="display:contents;">loading…</div><!--$c:6-->`;
        (window as any).__SIGX_BOUNDARIES__ = { 6: { flush: 'skip', hydrate: 'never', component: 'PendingSkip' } };
        invalidateMarkerIndex();

        expect(await hydrateTableBoundary(6)).toBe(false);
        expect(container.textContent).toContain('loading…');
    });
});

describe('mid-flight table changes', () => {
    it('returns false when the record disappears while the chunk loads', async () => {
        const Counter = makeCounter('Vanishing');
        const id = await mount(<Counter initial={1} />);
        registerComponentChunk('Vanishing', async () => {
            delete (window as any).__SIGX_BOUNDARIES__[id]; // patch removes it
            return Counter;
        });

        expect(await hydrateTableBoundary(id)).toBe(false);
        expect(container.querySelector('button')!.textContent).toBe('1'); // untouched
    });

    it('re-passes once when the record is replaced while the chunk loads', async () => {
        const Counter = makeCounter('SwappedFrom');
        const Replacement = makeCounter('SwappedTo');
        registerComponent('SwappedTo', Replacement);
        const id = await mount(<Counter initial={2} />);
        registerComponentChunk('SwappedFrom', async () => {
            (window as any).__SIGX_BOUNDARIES__[id] = { hydrate: 'never', component: 'SwappedTo', props: { initial: 2 } };
            return Counter;
        });

        expect(await hydrateTableBoundary(id)).toBe(true);
        const button = container.querySelector('button')!;
        button.dispatchEvent(new Event('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
        expect(button.textContent).toBe('3'); // hydrated with the NEW record's component
    });
});
