/**
 * Slots × resume (#583, area 4).
 *
 * resolveBoundary's lossy-snapshot verdict has three prop-shape arms
 * (`_children` / `_slots` / `_models`, plugin.ts) — the existing refresh
 * tests only exercise `_children` via an element child. This file covers:
 *
 * - the `_slots` arm: a `slots={{ default: () => … }}` usage site stamps
 *   `refreshable: false` and a smuggled `slots` descriptor prop declines,
 *   exactly like the children case;
 * - the function-child provenance: `<Comp>{() => …}</Comp>` rides
 *   `props.children` (jsx() clones component props verbatim — a render-prop
 *   fill is NOT moved onto `props.slots`), so it reduces to the `_children`
 *   arm — pinned here as a distinct case because the usage-site shape is the
 *   one the transform's slot-bail (resume-extract) actually meets;
 * - coexist-mode hydration: a server-rendered `ctx.slots` consumer (the
 *   compile-time `__resumeMode: 'hydrate'` bail shape) is walked PAST by the
 *   root hydration — slot content neither lost nor duplicated.
 *
 * Fixtures hand-write what the sigxResume() transform emits (stamps, wake
 * attributes) — the transform itself is tested in @sigx/vite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal, type Define } from 'sigx';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import { createSSR } from '../../server-renderer/src/ssr';
import { hydrate } from '../../server-renderer/src/client/hydrate-core';
import { cleanupPendingHydrations, invalidateMarkerIndex } from '../../server-renderer/src/client/scheduler';
import { clearClientPlugins } from '../../server-renderer/src/client/hydrate-context';
import { registerComponent } from '@sigx/server-renderer/client';
import { resumePlugin } from '../src/plugin';
import { createBoundaryRefresh } from '../src/server/refresh';
import { wake, resetResumeScopes } from '../src/client/index';

const BASE = 1 << 20;

/** Parse the __SIGX_BOUNDARIES__ table out of rendered HTML (wire shape). */
function parseBoundaryTable(html: string): Record<string, SSRBoundaryRecord> {
    const match = html.match(
        /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/
    );
    if (!match) return {};
    return JSON.parse(match[1]);
}

/** A transform-shaped resumable counter: keyed signal + QRL attributes + stamps. */
function makeCounter(name = 'Counter'): any {
    const Counter = component<{ label?: string; initial?: number }>((ctx) => {
        const count = ((__sigxInit: number) => (ctx.signal as any)(__sigxInit, 'count'))(ctx.props.initial ?? 0);
        return () => (
            <button
                onClick={() => { count.value++; }}
                {...({
                    'data-sigx-on:click': `${name}_click_ab12cd34`,
                    'data-sigx-b': (ctx as any).$sigxB
                } as any)}
            >
                {ctx.props.label ?? 'count'}: {count.value}
            </button>
        );
    }, { name });
    (Counter as any).__resumeId = name;
    (Counter as any).__resumeMode = 'resume';
    return Counter;
}

/** A resume-stamped slot consumer — the shape the transform bails to 'hydrate' for. */
function makeSlotHost(name: string): any {
    const Host = component<Define.Slot<'default'>>((ctx) => {
        return () => <div>{ctx.slots.default?.()}</div>;
    }, { name });
    (Host as any).__resumeId = name;
    (Host as any).__resumeMode = 'hydrate';
    return Host;
}

describe('refreshable: false stamping — the _slots arm', () => {
    it('stamps a slots-prop usage site, leaves clean sites unstamped', async () => {
        const WithSlots = makeSlotHost('WithSlots');
        const Counter = makeCounter();

        const ssr = createSSR({ plugins: [resumePlugin()] });
        const html = await ssr.render(
            <main>
                <WithSlots slots={{ default: () => <em>slotted</em> }} />
                <Counter initial={1} />
            </main>
        );

        // The slot genuinely shaped the server HTML — which is exactly what
        // a refresh render from the (slot-less) snapshot could not reproduce.
        expect(html).toContain('<em>slotted</em>');

        const records = Object.values(parseBoundaryTable(html));
        const lossy = records.find((r) => r.component === 'WithSlots');
        const clean = records.find((r) => r.component === 'Counter');
        expect(lossy?.refreshable).toBe(false);
        expect(clean?.refreshable).toBeUndefined();
        // The slots value itself never reaches the serialized snapshot.
        expect(lossy?.props ?? {}).not.toHaveProperty('slots');
    });

    it('stamps a function-child usage site — a render-prop fill rides the children arm', async () => {
        const FnChild = makeSlotHost('FnChild');
        const Counter = makeCounter();

        // Provenance check first: jsx() keeps a function child on
        // `props.children` (component props are cloned verbatim); it is NOT
        // rehomed onto a `slots` prop, so resolveBoundary sees it via the
        // `_children !== undefined` arm even though the component consumes it
        // through ctx.slots.
        const vnode: any = <FnChild>{() => <span>x</span>}</FnChild>;
        expect(typeof vnode.props.children).toBe('function');
        expect(vnode.props.slots).toBeUndefined();

        const ssr = createSSR({ plugins: [resumePlugin()] });
        const html = await ssr.render(
            <main>
                <FnChild>{() => <span>fn-made</span>}</FnChild>
                <Counter initial={1} />
            </main>
        );

        expect(html).toContain('<span>fn-made</span>');

        const records = Object.values(parseBoundaryTable(html));
        const lossy = records.find((r) => r.component === 'FnChild');
        const clean = records.find((r) => r.component === 'Counter');
        expect(lossy?.refreshable).toBe(false);
        expect(clean?.refreshable).toBeUndefined();
    });
});

describe('createBoundaryRefresh — slots-prop declines (omission, never a throw)', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('declines a smuggled slots prop — the re-render is lossy', async () => {
        const Counter = makeCounter();
        const renderBoundaries = createBoundaryRefresh({ plugins: [resumePlugin()], components: { Counter } });

        // Descriptors are client-controlled: a forged `slots` value marks the
        // re-render lossy through the same verdict as `children`. The
        // re-rendered record stamps itself refreshable:false and the entry
        // is omitted.
        const entries = await renderBoundaries(
            [{ id: 3, component: 'Counter', props: { slots: { default: 'forged' } } as any }],
            BASE
        );
        expect(entries).toHaveLength(0);
    });

    it('declines the slots-carrying descriptor, keeps the clean one', async () => {
        const Counter = makeCounter();
        const renderBoundaries = createBoundaryRefresh({ plugins: [resumePlugin()], components: { Counter } });

        const entries = await renderBoundaries(
            [
                { id: 3, component: 'Counter', props: { slots: {} } as any },
                { id: 4, component: 'Counter', props: { initial: 2 } }
            ],
            BASE
        );
        expect(entries.map((e) => e.for)).toEqual([4]);
    });
});

describe('wake of a slot host — the hazard the transform now refuses (#702 phase 6)', () => {
    let el: HTMLDivElement | null = null;

    beforeEach(() => {
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
    });

    afterEach(() => {
        el?.remove();
        el = null;
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        resetResumeScopes();
        vi.restoreAllMocks();
    });

    it('cannot rebuild slot content: the upgraded render sees no slot, and dev warns', async () => {
        const sawSlot: boolean[] = [];
        const WakeSlotCard = component<Define.Slot<'default'>>((ctx) => {
            return () => {
                sawSlot.push(typeof ctx.slots.default === 'function');
                return (
                    <section
                        class="card"
                        {...({ 'data-sigx-wake:click': '', 'data-sigx-b': (ctx as any).$sigxB } as any)}
                    >
                        {ctx.slots.default ? ctx.slots.default() : <p class="empty">empty</p>}
                    </section>
                );
            };
        }, { name: 'WakeSlotCard' });
        (WakeSlotCard as any).__resumeId = 'WakeSlotCard';
        (WakeSlotCard as any).__resumeMode = 'hydrate';

        const html = await createSSR({ plugins: [resumePlugin()] }).render(
            <WakeSlotCard><em class="slotted">slotted</em></WakeSlotCard>
        );
        expect(html).toContain('slotted');
        const table = parseBoundaryTable(html);
        const id = parseInt(Object.keys(table)[0], 10);
        expect(table[id].refreshable).toBe(false); // the usage site is lossy — the record says so

        el = document.createElement('div');
        el.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/g, '');
        document.body.appendChild(el);
        (window as any).__SIGX_BOUNDARIES__ = Object.assign(Object.create(null), table);
        registerComponent('WakeSlotCard', WakeSlotCard);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        sawSlot.length = 0;

        await wake(id);
        await new Promise((r) => setTimeout(r, 0));

        // The record carries no children or slots, so the upgrade mounted the
        // component with none: what the server slotted in is gone from the
        // component's tree — the fallback renders instead.
        expect(sawSlot).toEqual([false]);
        expect(el.querySelector('p.empty')).toBeTruthy();
        expect(warn.mock.calls.some((c) => /usage-site props the snapshot cannot carry/.test(String(c[0])))).toBe(true);
    });
});

describe('coexist-mode hydration around a slot-consuming hydrate-mode boundary', () => {
    let el: HTMLDivElement | null = null;

    beforeEach(() => {
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        el?.remove();
        el = null;
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.restoreAllMocks();
    });

    it('hydrates the app around it; slot content is neither lost nor duplicated', async () => {
        let cardSetups = 0;
        const SlotCard = component<Define.Slot<'default'>>((ctx) => {
            cardSetups++;
            return () => (
                <section
                    class="card"
                    {...({
                        'data-sigx-wake:click': '',
                        'data-sigx-b': (ctx as any).$sigxB
                    } as any)}
                >
                    {ctx.slots.default?.()}
                </section>
            );
        }, { name: 'SlotCard' });
        (SlotCard as any).__resumeId = 'SlotCard';
        (SlotCard as any).__resumeMode = 'hydrate';

        let liveSetups = 0;
        const Live = component(() => {
            liveSetups++;
            const n = signal(0);
            return () => <button class="live">{n.value}</button>;
        }, { name: 'Live' });

        const App = component(() => () => (
            <main>
                <Live />
                <SlotCard><em class="slotted">slotted</em></SlotCard>
            </main>
        ), { name: 'App' });

        const html = await createSSR({ plugins: [resumePlugin()] }).render(<App />);
        expect(html).toContain('slotted');
        const table = parseBoundaryTable(html);
        // The compile-bail shape SSRs as an ordinary resume record: never
        // core-scheduled, woken only by the pack's delegation.
        const card = Object.values(table).find((r) => r.component === 'SlotCard');
        expect(card?.hydrate).toBe('never');

        el = document.createElement('div');
        el.innerHTML = html.replace(/<script>[\s\S]*?<\/script>/g, '');
        document.body.appendChild(el);
        (window as any).__SIGX_BOUNDARIES__ = Object.assign(Object.create(null), table);

        const slottedBefore = el.querySelector('em.slotted');
        expect(slottedBefore).toBeTruthy();

        // Client coexist install: default root walk (no 'explicit' opt-out).
        const app = { _context: { provides: new Map<symbol, unknown>() } };
        resumePlugin().install(app as any);
        cardSetups = 0; // SSR ran the setups above — count client-side only
        liveSetups = 0;
        hydrate(<App /> as any, el, (app as any)._context);
        await Promise.resolve();

        // The app around the boundary hydrated…
        expect(liveSetups).toBe(1);
        expect((el as any)._vnode).toBeTruthy();
        // …and the boundary itself was walked PAST: no client setup ran, so
        // the slot content could not have been re-rendered (duplicated) or
        // torn down (lost).
        expect(cardSetups).toBe(0);
        const slotted = el.querySelectorAll('em.slotted');
        expect(slotted.length).toBe(1);
        expect(slotted[0]).toBe(slottedBefore);
        expect((el.textContent!.match(/slotted/g) ?? []).length).toBe(1);
    });
});
