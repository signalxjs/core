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
} from '../src/client/boundary-hydrator';
import { registerComponent } from '../src/client/registry';
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
