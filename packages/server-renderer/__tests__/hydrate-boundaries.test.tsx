/**
 * The core boundary hydrator (rfc-ssr-platform §1.2) — selective hydration
 * as THE hydrator: table-driven scheduling per strategy (including the new
 * 'interaction' strategy and 'never'), walk interception in 'auto' mode,
 * the 'explicit' (islands) mode with no root walk, the hydrate-defaults DI
 * seam, and the boundary-free fast path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { hydrate } from '../src/client/hydrate-core';
import {
    scheduleTableBoundaries,
    cleanupPendingHydrations,
    invalidateMarkerIndex,
    getBoundaryTable
} from '../src/client/scheduler';
import { registerComponent } from '../src/client/registry';
import { hydrateAsyncBoundary } from '../src/client/hydration-core';
import { clearClientPlugins } from '../src/client/hydrate-context';
import {
    provideHydrateDefaults,
    getHydrateDefaults,
    HYDRATE_DEFAULTS_TOKEN
} from '../src/client/hydrate-defaults';
import type { SSRBoundaryRecord } from '../src/boundary';
import { createSSRContainer, cleanupContainer, nextTick } from './test-utils';

function setBoundaryTable(records: Record<string, SSRBoundaryRecord>): void {
    (window as any).__SIGX_BOUNDARIES__ = Object.assign(Object.create(null), records);
}

let testId = 0;
function uniqueName(base: string): string {
    return `Boundary_${base}_${++testId}`;
}

function makeAppContext(defaults?: { boundaries?: 'auto' | 'explicit' }): any {
    const provides = new Map<symbol, unknown>();
    if (defaults) provideHydrateDefaults({ provides }, defaults);
    return { provides };
}

describe('boundary hydrator', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        delete (window as any).__SIGX_BOUNDARIES__;
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.restoreAllMocks();
    });

    describe('hydrate defaults DI seam', () => {
        it('provideHydrateDefaults merges over earlier provides; getHydrateDefaults reads them', () => {
            const provides = new Map<symbol, unknown>();
            provideHydrateDefaults({ provides }, { boundaries: 'explicit' });
            expect(getHydrateDefaults({ provides })).toEqual({ boundaries: 'explicit' });
            provideHydrateDefaults({ provides }, { boundaries: 'auto' });
            expect((provides.get(HYDRATE_DEFAULTS_TOKEN) as any).boundaries).toBe('auto');
            expect(getHydrateDefaults(null)).toEqual({});
        });
    });

    describe("'interaction' strategy", () => {
        it('hydrates on first pointerdown, once, and removes the other listeners', async () => {
            let setupRuns = 0;
            const name = uniqueName('Interact');
            registerComponent(name, component(() => {
                setupRuns++;
                return () => <button class="int">wake</button>;
            }, { name }) as any);

            container = createSSRContainer('<button class="int">wake</button><!--$c:1-->');
            setBoundaryTable({ '1': { hydrate: 'interaction', component: name } });

            scheduleTableBoundaries();
            await nextTick();
            expect(setupRuns).toBe(0); // nothing until interaction

            const target = container.querySelector('.int')!;
            target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            await nextTick();
            expect(setupRuns).toBe(1);

            // once: further interactions don't double-hydrate
            target.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            target.dispatchEvent(new Event('keydown', { bubbles: true }));
            await nextTick();
            expect(setupRuns).toBe(1);
        });

        it('any of the interaction event types triggers hydration', async () => {
            for (const eventType of ['keydown', 'touchstart', 'focusin']) {
                delete (window as any).__SIGX_BOUNDARIES__;
                cleanupPendingHydrations();
                invalidateMarkerIndex();
                if (container) cleanupContainer(container);

                let hydrated = false;
                const name = uniqueName(`Int_${eventType}`);
                registerComponent(name, component(() => {
                    hydrated = true;
                    return () => <span class="t">x</span>;
                }, { name }) as any);

                container = createSSRContainer('<span class="t">x</span><!--$c:1-->');
                setBoundaryTable({ '1': { hydrate: 'interaction', component: name } });
                scheduleTableBoundaries();
                await nextTick();
                expect(hydrated).toBe(false);

                container.querySelector('.t')!.dispatchEvent(new Event(eventType, { bubbles: true }));
                await nextTick();
                expect(hydrated).toBe(true);
            }
        });

        it('cleanupPendingHydrations removes pending interaction listeners', async () => {
            let hydrated = false;
            const name = uniqueName('IntCancel');
            registerComponent(name, component(() => {
                hydrated = true;
                return () => <span class="c">x</span>;
            }, { name }) as any);

            container = createSSRContainer('<span class="c">x</span><!--$c:1-->');
            setBoundaryTable({ '1': { hydrate: 'interaction', component: name } });
            scheduleTableBoundaries();

            cleanupPendingHydrations();
            container.querySelector('.c')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            await nextTick();
            expect(hydrated).toBe(false);
        });
    });

    describe("'never' strategy", () => {
        it('schedules nothing for hydrate:"never" records and records without a strategy', async () => {
            let setupRuns = 0;
            const name = uniqueName('Never');
            registerComponent(name, component(() => {
                setupRuns++;
                return () => <span class="n">static</span>;
            }, { name }) as any);

            container = createSSRContainer('<span class="n">static</span><!--$c:1--><span>other</span><!--$c:2-->');
            setBoundaryTable({
                '1': { hydrate: 'never', component: name },
                '2': { component: name }
            });

            scheduleTableBoundaries();
            await nextTick();
            expect(setupRuns).toBe(0);
            expect(container.innerHTML).toContain('static');
        });
    });

    describe("'explicit' mode (islands app default)", () => {
        it('skips the root walk — only table entries hydrate', async () => {
            let rootSetupRuns = 0;
            let islandSetupRuns = 0;

            const islandName = uniqueName('ExplicitIsland');
            registerComponent(islandName, component(() => {
                islandSetupRuns++;
                return () => <span class="island">island</span>;
            }, { name: islandName }) as any);

            const Root = component(() => {
                rootSetupRuns++;
                return () => <div>root</div>;
            }, { name: 'Root' });

            container = createSSRContainer('<div>root<span class="island">island</span><!--$c:2--></div><!--$c:1-->');
            setBoundaryTable({ '2': { hydrate: 'load', component: islandName } });

            hydrate((Root as any)({}), container, makeAppContext({ boundaries: 'explicit' }));
            await nextTick();

            expect(rootSetupRuns).toBe(0);   // no root walk
            expect(islandSetupRuns).toBe(1); // table entry hydrated
        });

        it('explicit mode with no table hydrates nothing and does not throw', () => {
            const Root = component(() => () => <div>root</div>, { name: 'Root' });
            container = createSSRContainer('<div>root</div><!--$c:1-->');
            expect(() =>
                hydrate((Root as any)({}), container, makeAppContext({ boundaries: 'explicit' }))
            ).not.toThrow();
            expect(container.innerHTML).toBe('<div>root</div><!--$c:1-->');
        });
    });

    describe("'auto' mode walk interception", () => {
        it('defers a recorded boundary while hydrating the rest of the page', async () => {
            let asideSetupRuns = 0;
            const Aside = component(() => {
                asideSetupRuns++;
                return () => <aside class="a">aside</aside>;
            }, { name: 'Aside' });
            const Root = component(() => {
                return () => <div>{(Aside as any)({})}</div>;
            }, { name: 'Root' });

            container = createSSRContainer('<div><aside class="a">aside</aside><!--$c:2--></div><!--$c:1-->');
            // Record the aside (id 2) as interaction-deferred
            setBoundaryTable({ '2': { hydrate: 'interaction' } });

            hydrate((Root as any)({}), container, makeAppContext());
            await nextTick();
            // The walk ran (root hydrated) but the recorded boundary deferred
            expect(asideSetupRuns).toBe(0);

            container.querySelector('.a')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            await nextTick();
            expect(asideSetupRuns).toBe(1);
        });

        it('hydrate:"load" records hydrate during the walk (with the live vnode)', async () => {
            let setupRuns = 0;
            const Aside = component(() => {
                setupRuns++;
                return () => <aside class="a">aside</aside>;
            }, { name: 'Aside' });
            const Root = component(() => () => <div>{(Aside as any)({})}</div>, { name: 'Root' });

            container = createSSRContainer('<div><aside class="a">aside</aside><!--$c:2--></div><!--$c:1-->');
            setBoundaryTable({ '2': { hydrate: 'load' } });

            hydrate((Root as any)({}), container, makeAppContext());
            await nextTick();
            expect(setupRuns).toBe(1);
        });

        it('hydrate:"never" records are skipped by the walk', async () => {
            let setupRuns = 0;
            const Aside = component(() => {
                setupRuns++;
                return () => <aside class="a">aside</aside>;
            }, { name: 'Aside' });
            const Root = component(() => () => <div>{(Aside as any)({})}</div>, { name: 'Root' });

            container = createSSRContainer('<div><aside class="a">aside</aside><!--$c:2--></div><!--$c:1-->');
            setBoundaryTable({ '2': { hydrate: 'never' } });

            hydrate((Root as any)({}), container, makeAppContext());
            await nextTick();
            expect(setupRuns).toBe(0);
        });
    });

    describe('streamed boundaries × the hydrate axis', () => {
        it("explicit mode runs the leftover scan for already-replaced streamed boundaries", async () => {
            let setupRuns = 0;
            const name = uniqueName('Leftover');
            registerComponent(name, component(() => {
                setupRuns++;
                return () => <div class="s">streamed</div>;
            }, { name }) as any);

            const Root = component(() => () => <main>x</main>, { name: 'Root' });
            // $SIGX_REPLACE already ran: real content inside the placeholder, not yet hydrated
            container = createSSRContainer(
                '<div data-async-placeholder="3" style="display:contents;"><div class="s">streamed</div></div><!--$c:3-->'
            );
            setBoundaryTable({ '3': { hydrate: 'load', component: name } });

            hydrate((Root as any)({}), container, makeAppContext({ boundaries: 'explicit' }));
            await nextTick();

            expect(setupRuns).toBe(1);
            expect(container.querySelector('[data-async-placeholder]')!.hasAttribute('data-hydrated')).toBe(true);
        });

        it("a streamed boundary marked hydrate:'never' stays static", async () => {
            let setupRuns = 0;
            const name = uniqueName('NeverStream');
            registerComponent(name, component(() => {
                setupRuns++;
                return () => <div class="s">streamed</div>;
            }, { name }) as any);

            const Root = component(() => () => <main>x</main>, { name: 'Root' });
            container = createSSRContainer(
                '<div data-async-placeholder="3" style="display:contents;"><div class="s">streamed</div></div><!--$c:3-->'
            );
            setBoundaryTable({ '3': { hydrate: 'never', component: name } });

            hydrate((Root as any)({}), container, makeAppContext({ boundaries: 'explicit' }));
            await nextTick();

            expect(setupRuns).toBe(0);
            expect(container.querySelector('[data-async-placeholder]')!.hasAttribute('data-hydrated')).toBe(false);
        });

        it('table scheduling skips a boundary still showing its streaming placeholder', async () => {
            let setupRuns = 0;
            const name = uniqueName('Pending');
            registerComponent(name, component(() => {
                setupRuns++;
                return () => <div class="s">real</div>;
            }, { name }) as any);

            // Content has NOT streamed in yet — the placeholder still shows the fallback
            container = createSSRContainer(
                '<div data-async-placeholder="3" style="display:contents;">loading…</div><!--$c:3-->'
            );
            setBoundaryTable({ '3': { hydrate: 'load', component: name } });

            scheduleTableBoundaries();
            await nextTick();

            // The sigx:async-ready flow owns it; the fallback is not hydrated
            expect(setupRuns).toBe(0);
            expect(container.innerHTML).toContain('loading…');
        });
    });

    /**
     * A streamed region must stay PATCHABLE after `$SIGX_REPLACE` (#478).
     * Every hydrated component vnode needs a trailing anchor, and in the
     * streamed shape the server's `<!--$c:N-->` marker sits OUTSIDE the
     * `data-async-placeholder` wrapper — so a component hydrating inside that
     * wrapper cannot claim it, and the boundary flow used to hydrate an orphan
     * copy of the vnode against the wrapper's children. Either way the vnode
     * the parent holds was left with `dom === null`, and the next patch
     * touching it threw `Cannot read properties of null (reading 'parentNode')`.
     */
    describe('streamed regions stay patchable after the replace (#478)', () => {
        /** The replace has landed: real content inside the wrapper, marker outside. */
        const REPLACED = (inner: string) =>
            `<div data-async-placeholder="2" style="display:contents;">${inner}</div><!--$c:2-->`;

        function makeStreamed(label = 'Streamed') {
            const name = uniqueName(label);
            let setups = 0;
            const Streamed = component(() => {
                setups++;
                return () => <div class="s">streamed</div>;
            }, { name });
            registerComponent(name, Streamed as any);
            return {
                name,
                Streamed,
                record: { hydrate: 'load', component: name } as SSRBoundaryRecord,
                setups: () => setups
            };
        }

        /** The parent's vnode for the boundary child — the one a later patch touches. */
        function subTreeOf(vnode: any): any {
            return vnode._subTreeRef?.current ?? vnode._subTree;
        }

        it('anchors a component the walk hydrates INSIDE a placeholder wrapper', async () => {
            // No boundary table: the plain walk owns this region, which is the
            // shape a page component with streamed useData has — its parent's
            // content IS the wrapper, so its own marker is out of reach.
            const { Streamed, setups } = makeStreamed();
            const Shell = component(() => () => <Streamed />, { name: 'Shell' });

            container = createSSRContainer(`${REPLACED('<div class="s">streamed</div>')}<!--$c:1-->`);
            hydrate((Shell as any)({}), container, makeAppContext());
            await nextTick();

            expect(setups()).toBe(1);
            expect(container.querySelectorAll('.s').length).toBe(1);

            const child = subTreeOf((container as any)._vnode);
            expect(child.type).toBe(Streamed);
            // A synthesized trailing anchor, at the end of its range inside
            // the wrapper — never null, and never a sibling's node.
            expect(child.dom).not.toBeNull();
            expect(child.dom.nodeType).toBe(Node.COMMENT_NODE);
            expect(child.dom.parentNode).toBe(container.querySelector('[data-async-placeholder]'));
        });

        it('a parent patch replacing that component does not crash', async () => {
            const { Streamed } = makeStreamed();
            const Other = component(() => () => <p class="o">other</p>, { name: 'Other' });
            const view = signal<'streamed' | 'other'>('streamed');
            // The RouterView shape: the subtree ROOT changes component type,
            // which is patch()'s replace branch — the crash site.
            const Shell = component(
                () => () => (view.value === 'streamed' ? <Streamed /> : <Other />),
                { name: 'Shell' }
            );

            container = createSSRContainer(`${REPLACED('<div class="s">streamed</div>')}<!--$c:1-->`);
            hydrate((Shell as any)({}), container, makeAppContext());
            await nextTick();

            view.value = 'other';
            await nextTick();

            expect(container.querySelectorAll('.o').length).toBe(1);
            expect(container.querySelector('.s')).toBeNull();
        });

        it('the boundary flow hydrates the LIVE vnode, anchored on its real marker', async () => {
            // With a record, the walk SKIPS the placeholder and hands the live
            // vnode to the streamed-boundary flow (here: hydrate()'s leftover
            // scan, since the replace already landed).
            const { Streamed, record, setups } = makeStreamed();
            const Shell = component(() => () => <main>{<Streamed />}</main>, { name: 'Shell' });

            container = createSSRContainer(
                `<main>${REPLACED('<div class="s">streamed</div>')}</main><!--$c:1-->`
            );
            setBoundaryTable({ '2': record });

            hydrate((Shell as any)({}), container, makeAppContext());
            await nextTick();

            expect(setups()).toBe(1);
            expect(container.querySelectorAll('.s').length).toBe(1);

            const main = subTreeOf((container as any)._vnode);
            const child = main.children[0];
            // The vnode the PARENT holds is the one that got hydrated…
            expect(child.type).toBe(Streamed);
            expect(child._effect).toBeTruthy();
            expect(subTreeOf(child)).toBeTruthy();
            // …and it is anchored on its real `<!--$c:2-->` marker.
            expect(child.dom).not.toBeNull();
            expect(child.dom.nodeType).toBe(Node.COMMENT_NODE);
            expect(child.dom.data).toBe('$c:2');
        });

        it("a hydrate:'never' boundary keeps no handoff alive on its placeholder", async () => {
            // The walk skips and hands over; the flow then declines to hydrate.
            // The wrapper survives an unmount by design, so an unconsumed
            // handoff would keep the skipped vnode reachable with it.
            const { Streamed, record, setups } = makeStreamed('NeverStream');
            const Shell = component(() => () => <main>{<Streamed />}</main>, { name: 'Shell' });

            container = createSSRContainer(
                `<main>${REPLACED('<div class="s">streamed</div>')}</main><!--$c:1-->`
            );
            setBoundaryTable({ '2': { ...record, hydrate: 'never' } });

            hydrate((Shell as any)({}), container, makeAppContext());
            await nextTick();

            const placeholder = container.querySelector('[data-async-placeholder]')! as any;
            expect(setups()).toBe(0); // static by contract
            expect(placeholder.__sigxPendingBoundary).toBeUndefined();
        });

        it('the record-driven path (explicit mode, no walk) hydrates against the wrapper', async () => {
            const name = uniqueName('Explicit');
            let mountedEl: Element | null = null;
            registerComponent(name, component((ctx) => {
                ctx.onMounted((m: { el: Element }) => { mountedEl = m.el; });
                return () => <div class="s">streamed</div>;
            }, { name }) as any);

            const Root = component(() => () => <main>x</main>, { name: 'Root' });
            container = createSSRContainer(`${REPLACED('<div class="s">streamed</div>')}<!--$c:1-->`);
            setBoundaryTable({ '2': { hydrate: 'load', component: name } });

            hydrate((Root as any)({}), container, makeAppContext({ boundaries: 'explicit' }));
            await nextTick();

            const placeholder = container.querySelector('[data-async-placeholder]')!;
            // Content hydrated inside the wrapper, exactly once…
            expect(container.querySelectorAll('.s').length).toBe(1);
            expect(placeholder.querySelectorAll('.s').length).toBe(1);
            // …and the component's element context is the wrapper's PARENT,
            // matching what the same component sees when it is not streamed.
            expect(mountedEl).toBe(container);
        });
    });

    describe('fast path — no table', () => {
        it('hydrate() with no boundary table is the plain walk', async () => {
            let clicked = false;
            const Root = component(() => {
                const n = signal(1);
                return () => <button onClick={() => { clicked = true; n.value++; }}>b</button>;
            }, { name: 'Root' });

            container = createSSRContainer('<button>b</button><!--$c:1-->');
            hydrate((Root as any)({}), container, makeAppContext());
            await nextTick();

            (container.querySelector('button') as HTMLButtonElement).click();
            expect(clicked).toBe(true);
            expect(getBoundaryTable()).toEqual({});
        });
    });
});
