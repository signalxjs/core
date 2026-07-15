/**
 * Scope resume + upgrade-on-write (#241), end to end in happy-dom:
 * SSR a transform-shaped component, install its boundary table, then drive
 * `invoke()` the way the delegation loader would — facades resume from
 * serialized state without running setup; the FIRST write loads the
 * component and hydrates that one boundary with the original state, then
 * replays writes; read-only handlers never upgrade; `wake()` fully hydrates
 * hydrate-mode boundaries.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { component } from 'sigx';
import { registerComponent, clearClientPlugins } from '@sigx/server-renderer/client';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import { createSSR } from '../../server-renderer/src/ssr';
import { resumePlugin } from '../src/plugin';
import { __registerResumeQrl, resetResumeQrls, invoke, wake, getScope, resetResumeScopes } from '../src/client/index';

function parseBoundaryTable(html: string): Record<string, SSRBoundaryRecord> {
    const match = html.match(
        /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/
    );
    if (!match) return {};
    return JSON.parse(match[1]);
}

/** Transform-shaped resumable counter (what sigxResume() would emit). */
function makeCounter(clicks: number[] = []): any {
    const Counter = component<{ initial?: number }>((ctx) => {
        const count = ((__sigxInit: number) => (ctx.signal as any)(__sigxInit, 'count'))(ctx.props.initial ?? 0);
        return () => (
            <button
                onClick={() => { clicks.push(count.value); count.value++; }}
                {...({
                    'data-sigx-on:click': 'Counter_click_test0001',
                    'data-sigx-b': (ctx as any).$sigxB
                } as any)}
            >
                {count.value}
            </button>
        );
    }, { name: 'Counter' });
    (Counter as any).__resumeId = 'Counter';
    (Counter as any).__resumeMode = 'resume';
    return Counter;
}

/** SSR into the live document and install the boundary table. */
async function mount(vnode: any): Promise<{ container: HTMLElement; table: Record<string, SSRBoundaryRecord>; id: number }> {
    const ssr = createSSR().use(resumePlugin());
    const html = await ssr.render(vnode);
    const table = parseBoundaryTable(html);
    const container = document.createElement('div');
    container.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/g, '');
    document.body.appendChild(container);
    (window as any).__SIGX_BOUNDARIES__ = table;
    const id = parseInt(Object.keys(table)[0], 10);
    return { container, table, id };
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

describe('scope resume', () => {
    it('rebuilds signals and props from the record without running setup', async () => {
        const { id, table } = await mount((() => {
            const Counter = makeCounter();
            return <Counter initial={7} />;
        })());

        const scope = getScope(id);
        expect(scope.signals.count.value).toBe(7);
        expect(scope.props.initial).toBe(7);
        expect(table[id].hydrate).toBe('never');
    });

    it('read-only handlers never load the component chunk', async () => {
        const Counter = makeCounter();
        const { id, container } = await mount(<Counter initial={3} />);
        // Deliberately NOT registered: any load attempt would warn + fail.

        const reads: unknown[] = [];
        __registerResumeQrl('Counter_read_test0002', () =>
            Promise.resolve(($scope: any) => { reads.push($scope.signals.count.value); })
        );
        const el = container.querySelector('button')!;
        await invoke('Counter_read_test0002', new Event('click'), el);
        await tick();

        expect(reads).toEqual([3]);
        expect((getScope(id) as any)._status).toBe('resumed');
        expect(container.querySelector('button')!.textContent).toBe('3'); // untouched DOM
    });

    it('first write upgrades: hydrates with original state, replays writes, DOM updates', async () => {
        const clicks: number[] = [];
        const Counter = makeCounter(clicks);
        const { id, container } = await mount(<Counter initial={3} />);
        registerComponent('Counter', Counter);

        __registerResumeQrl('Counter_click_test0001', () =>
            Promise.resolve(($scope: any) => { $scope.signals.count.value++; })
        );
        const el = container.querySelector('button')!;
        await invoke('Counter_click_test0001', new Event('click'), el);
        await tick();
        await tick();

        const scope = getScope(id) as any;
        expect(scope._status).toBe('upgraded');
        // Original SSR text was "3"; the buffered write replayed to 4.
        expect(container.querySelector('button')!.textContent).toBe('4');
        // Facades now route to the live signal.
        expect(scope.signals.count.value).toBe(4);

        // The upgraded boundary owns its events: delegated invoke steps aside…
        await invoke('Counter_click_test0001', new Event('click'), el);
        await tick();
        expect(container.querySelector('button')!.textContent).toBe('4');
        // …while the real hydrated listener works.
        container.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();
        expect(container.querySelector('button')!.textContent).toBe('5');
        expect(clicks).toEqual([4]); // live handler saw the replayed value
    });

    it('writes during the upgrade window buffer and replay in order', async () => {
        const Counter = makeCounter();
        const { id, container } = await mount(<Counter initial={0} />);

        registerComponent('Counter', Counter);
        const scope = getScope(id) as any;

        __registerResumeQrl('Counter_click_test0001', () =>
            Promise.resolve(($scope: any) => { $scope.signals.count.value++; })
        );
        const el = container.querySelector('button')!;

        // Two rapid interactions: the first write flips the scope to
        // 'upgrading' and the upgrade awaits the component load (async), so
        // the second handler still runs against facades and its write joins
        // the buffer — both replay in order after hydration.
        const first = invoke('Counter_click_test0001', new Event('click'), el);
        const second = invoke('Counter_click_test0001', new Event('click'), el);
        await Promise.all([first, second]);
        await tick();
        await tick();

        expect(scope._status).toBe('upgraded');
        expect(container.querySelector('button')!.textContent).toBe('2');
    });
});

describe('wake (hydrate-mode boundaries)', () => {
    it('fully hydrates the boundary; its own listeners take over (no replay)', async () => {
        const Counter = makeCounter();
        Counter.__resumeMode = 'hydrate';
        const { id, container } = await mount(<Counter initial={9} />);
        registerComponent('Counter', Counter);

        await wake(id);
        await tick();

        expect((getScope(id) as any)._status).toBe('upgraded');
        expect(container.querySelector('button')!.textContent).toBe('9'); // no writes, original state
        container.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();
        expect(container.querySelector('button')!.textContent).toBe('10');
    });

    it('is idempotent per boundary', async () => {
        const Counter = makeCounter();
        const { id } = await mount(<Counter initial={1} />);
        registerComponent('Counter', Counter);

        await Promise.all([wake(id), wake(id)]);
        await tick();
        expect((getScope(id) as any)._status).toBe('upgraded');
        expect(document.querySelectorAll('button')).toHaveLength(1);
    });
});
