/**
 * Single-flight boundary refresh — the client half (rfc-server §6.3, #313),
 * end to end in happy-dom: SSR a transform-shaped component, install its
 * table, `collect()` the inventory through the seam, re-render it with the
 * REAL `createBoundaryRefresh`, and `apply()` the entries — the resumed
 * swap, the upgraded live-write path, and the race matrix (upgrading wins,
 * buffered writes win, stale responses drop, focused text entry drops).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { component, useData } from 'sigx';
import { registerComponent, clearClientPlugins, getBoundaryRecord } from '@sigx/server-renderer/client';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import { createSSR } from '../../server-renderer/src/ssr';
import { resumePlugin } from '../src/plugin';
import { createBoundaryRefresh, type BoundaryRefreshEntry } from '../src/server/refresh';
import {
    __registerResumeQrl,
    resetResumeQrls,
    invoke,
    getScope,
    resetResumeScopes
} from '../src/client/index';

interface Seam {
    collect(): { base: number; refresh: Array<{ id: number; component: string; props?: unknown }> } | null;
    apply(entries: unknown[], seq: number): void;
}

const seam = (): Seam =>
    (globalThis as unknown as { __SIGX_SERVERFN_BOUNDARIES__: Seam }).__SIGX_SERVERFN_BOUNDARIES__;

function parseBoundaryTable(html: string): Record<string, SSRBoundaryRecord> {
    const match = html.match(
        /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/
    );
    if (!match) return {};
    return JSON.parse(match[1]);
}

/** Transform-shaped resumable counter (what sigxResume() would emit). */
function makeCounter(name = 'Counter'): any {
    const Counter = component<{ initial?: number }>((ctx) => {
        // A keyed read — deps are what the §6.3 gate admits on, and
        // collect() skips dep-less records outright.
        useData(`data:${name}`, async () => 0);
        const count = ((__sigxInit: number) => (ctx.signal as any)(__sigxInit, 'count'))(ctx.props.initial ?? 0);
        return () => (
            <button
                onClick={() => { count.value++; }}
                {...({
                    'data-sigx-on:click': `${name}_click_test0001`,
                    'data-sigx-b': (ctx as any).$sigxB
                } as any)}
            >
                {count.value}
            </button>
        );
    }, { name });
    (Counter as any).__resumeId = name;
    (Counter as any).__resumeMode = 'resume';
    return Counter;
}

const ssrWith = () => createSSR({ plugins: [resumePlugin()] });

/** SSR into the live document and install the boundary table. */
async function mount(vnode: any): Promise<{ container: HTMLElement; id: number }> {
    const html = await ssrWith().render(vnode);
    const table = parseBoundaryTable(html);
    const container = document.createElement('div');
    container.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    document.body.appendChild(container);
    (window as any).__SIGX_BOUNDARIES__ = Object.assign(
        Object.create(null),
        (window as any).__SIGX_BOUNDARIES__,
        table
    );
    const id = parseInt(Object.keys(table)[0], 10);
    return { container, id };
}

/** The full round trip: collect → filter to KEYS → re-render → entries. */
async function roundTrip(
    components: Record<string, unknown>,
    keys: string[],
    mutate?: (descriptor: { props?: unknown }) => void
): Promise<{ entries: BoundaryRefreshEntry[]; base: number }> {
    const sidecar = seam().collect();
    expect(sidecar).not.toBeNull();
    const admitted = sidecar!.refresh.filter((d) => keys.includes(d.component));
    if (mutate) admitted.forEach(mutate);
    const render = createBoundaryRefresh({ plugins: [resumePlugin()], components });
    const entries = await render(admitted as never, sidecar!.base);
    return { entries, base: sidecar!.base };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    resetResumeQrls();
    resetResumeScopes();
    clearClientPlugins();
    delete (window as any).__SIGX_BOUNDARIES__;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
});

describe('collect()', () => {
    it('inventories refreshable boundaries with encoded props and a high base', async () => {
        const Counter = makeCounter();
        const { id } = await mount(<Counter initial={7} />);

        const sidecar = seam().collect()!;
        expect(sidecar.base).toBeGreaterThanOrEqual(1 << 20);
        expect(sidecar.refresh).toEqual([
            { id, component: 'Counter', deps: ['data:Counter'], props: { initial: 7 } }
        ]);

        // The base floor advances per collect — concurrent mutations get
        // disjoint id ranges.
        expect(seam().collect()!.base).toBeGreaterThan(sidecar.base);
    });

    it('excludes refreshable:false records and upgrading scopes; empty page → null', async () => {
        expect(seam().collect()).toBeNull();

        const WithChildren = component<{ children?: unknown }>((ctx) => {
            return () => <div>{ctx.props.children as any}</div>;
        }, { name: 'WithChildren' });
        (WithChildren as any).__resumeId = 'WithChildren';
        await mount(<WithChildren><em>slot</em></WithChildren>);
        expect(seam().collect()).toBeNull(); // lossy — stamped refreshable:false

        const Counter = makeCounter();
        const { id } = await mount(<Counter initial={1} />);
        (getScope(id) as any)._status = 'upgrading';
        expect(seam().collect()).toBeNull(); // in-flight upgrade excluded
    });
});

describe('apply() — resumed boundary swap', () => {
    it('swaps DOM + records + scope to the fresh id; handlers resume against fresh state', async () => {
        const Counter = makeCounter();
        const { container, id } = await mount(<Counter initial={7} />);
        expect(container.textContent).toContain('7');

        const { entries, base } = await roundTrip({ Counter }, ['Counter'], (d) => {
            (d as { props?: unknown }).props = { initial: 12 };
        });
        expect(entries).toHaveLength(1);
        seam().apply(entries as unknown[], 1);

        // Fresh DOM under the fresh id, old marker and record retired.
        const fresh = entries[0].id;
        expect(fresh).toBeGreaterThan(base);
        expect(container.textContent).toContain('12');
        expect(container.querySelector(`[data-sigx-b="${fresh}"]`)).toBeTruthy();
        expect(container.querySelector(`[data-sigx-b="${id}"]`)).toBeNull();
        expect(container.innerHTML).toContain(`$c:${fresh}`);
        expect(container.innerHTML).not.toContain(`$c:${id}-`);
        expect(getBoundaryRecord(id)).toBeUndefined();
        expect(getBoundaryRecord(fresh)?.component).toBe('Counter');
        // The re-render re-ran useData, so the FRESH record re-captured its
        // deps — the next mutation's gate keeps working after a swap.
        expect(getBoundaryRecord(fresh)?.deps).toEqual(['data:Counter']);

        // Delegation against the fresh element resumes from the FRESH state.
        const reads: unknown[] = [];
        __registerResumeQrl('Counter_read_test0002', () =>
            Promise.resolve(($scope: any) => { reads.push($scope.signals.count.value); })
        );
        const el = container.querySelector('button')!;
        await invoke('Counter_read_test0002', new Event('click'), el);
        await tick();
        expect(reads).toEqual([12]);
    });

    it('a stale overlapping response drops after retirement (record gone)', async () => {
        const Counter = makeCounter();
        const { container } = await mount(<Counter initial={7} />);

        const first = await roundTrip({ Counter }, ['Counter'], (d) => {
            (d as { props?: unknown }).props = { initial: 20 };
        });
        const second = await roundTrip({ Counter }, ['Counter'], (d) => {
            (d as { props?: unknown }).props = { initial: 30 };
        });
        // The LATER-dispatched mutation's response lands first…
        seam().apply(second.entries as unknown[], 2);
        expect(container.textContent).toContain('30');
        // …and the earlier one arrives late: its `for` id was retired.
        seam().apply(first.entries as unknown[], 1);
        expect(container.textContent).toContain('30');
    });

    it('drops when the scope is upgrading or holds buffered writes', async () => {
        const Counter = makeCounter();
        const { container, id } = await mount(<Counter initial={7} />);
        const { entries } = await roundTrip({ Counter }, ['Counter']);

        const scope = getScope(id) as any;
        scope._status = 'upgrading';
        seam().apply(entries as unknown[], 1);
        expect(container.textContent).toContain('7'); // untouched

        scope._status = 'resumed';
        scope._pendingWrites.push(['count', 8]);
        seam().apply(entries as unknown[], 2);
        expect(container.textContent).toContain('7'); // buffered intent wins
    });

    it('drops the whole entry when a text input inside the boundary has focus', async () => {
        const Field = component<{ initial?: number }>((ctx) => {
            useData('data:Field', async () => 0);
            const q = ((init: string) => (ctx.signal as any)(init, 'q'))('');
            void q;
            return () => (
                <div {...({ 'data-sigx-b': (ctx as any).$sigxB } as any)}>
                    <input type="text" />
                </div>
            );
        }, { name: 'Field' });
        (Field as any).__resumeId = 'Field';

        const { container } = await mount(<Field initial={1} />);
        const { entries } = await roundTrip({ Field }, ['Field']);
        (container.querySelector('input') as HTMLInputElement).focus();
        seam().apply(entries as unknown[], 1);
        // The old DOM (with its focused input) survived untouched.
        expect(container.querySelector('input')).toBeTruthy();
        expect(document.activeElement?.tagName).toBe('INPUT');
    });

    it('retires nested boundaries and installs the fresh nested records', async () => {
        const Child = makeCounter('Child');
        const Parent = component((ctx) => {
            void ctx;
            useData('data:Parent', async () => 0);
            return () => (
                <section {...({ 'data-sigx-b': (ctx as any).$sigxB } as any)}>
                    <Child initial={1} />
                </section>
            );
        }, { name: 'Parent' });
        (Parent as any).__resumeId = 'Parent';

        const { container } = await mount(<Parent />);
        const table = (window as any).__SIGX_BOUNDARIES__ as Record<string, SSRBoundaryRecord>;
        const childId = Number(
            Object.keys(table).find((k) => table[k].component === 'Child')
        );
        const parentId = Number(
            Object.keys(table).find((k) => table[k].component === 'Parent')
        );

        const sidecar = seam().collect()!;
        const admitted = sidecar.refresh.filter((d) => d.component === 'Parent');
        const render = createBoundaryRefresh({ plugins: [resumePlugin()], components: { Parent } });
        const entries = await render(admitted as never, sidecar.base);
        seam().apply(entries as unknown[], 1);

        // Old parent AND child retired; fresh pair installed.
        expect(getBoundaryRecord(parentId)).toBeUndefined();
        expect(getBoundaryRecord(childId)).toBeUndefined();
        const freshIds = Object.keys(entries[0].records).map(Number);
        for (const freshId of freshIds) {
            expect(getBoundaryRecord(freshId)).toBeTruthy();
        }
        expect(container.querySelectorAll('[data-sigx-b]').length).toBeGreaterThanOrEqual(1);
    });

    it('ignores malformed entries without throwing', async () => {
        const Counter = makeCounter();
        const { container, id } = await mount(<Counter initial={7} />);
        expect(() =>
            seam().apply(
                [
                    null,
                    42,
                    {},
                    { for: -1 },
                    { for: 1, id: 0.5, html: '' },
                    { for: 999999, id: 5, html: 'x' },
                    // Array-shaped state/records must never reach the table
                    // or the live signals (typeof 'object' is not enough).
                    { for: id, id: (1 << 20) + 1, html: '<b>x</b>', state: [1, 2], records: [{}] }
                ] as unknown[],
                1
            )
        ).not.toThrow();
        // The array-records entry swapped DOM (html is valid) but installed
        // nothing array-shaped; the table stays an object keyed by ids.
        expect(Array.isArray((window as any).__SIGX_BOUNDARIES__)).toBe(false);
        void container;
    });
});

describe('apply() — upgraded boundary live writes', () => {
    async function upgraded(): Promise<{ container: HTMLElement; id: number }> {
        const Counter = makeCounter();
        registerComponent('Counter', Counter);
        const { container, id } = await mount(<Counter initial={7} />);
        __registerResumeQrl('Counter_click_test0001', () =>
            Promise.resolve(($scope: any) => { $scope.signals.count.value++; })
        );
        await invoke('Counter_click_test0001', new Event('click'), container.querySelector('button')!);
        await tick();
        expect((getScope(id) as any)._status).toBe('upgraded');
        expect(container.textContent).toContain('8');
        return { container, id };
    }

    it('writes fresh state through live signals — no DOM swap', async () => {
        const { container, id } = await upgraded();
        const button = container.querySelector('button');

        seam().apply([{ for: id, id: (1 << 20) + 1, html: '<b>ignored</b>', state: { count: 41 } }], 3);
        await tick();
        expect(container.textContent).toContain('41');
        // Same element — the HTML was skipped, reactivity patched in place.
        expect(container.querySelector('button')).toBe(button);
        expect((getBoundaryRecord(id) as { state?: unknown }).state).toEqual({ count: 41 });
    });

    it('drops a stale (earlier-dispatched) response after a newer one applied', async () => {
        const { container, id } = await upgraded();
        seam().apply([{ for: id, id: (1 << 20) + 1, html: '', state: { count: 50 } }], 5);
        await tick();
        expect(container.textContent).toContain('50');
        seam().apply([{ for: id, id: (1 << 20) + 1, html: '', state: { count: 40 } }], 4);
        await tick();
        expect(container.textContent).toContain('50'); // stale write dropped
    });
});
