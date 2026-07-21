/**
 * Component anchor selection over the enclosing region (#373).
 *
 * SSR emits a TRAILING `<!--$c:N-->` marker per component, so a parent's
 * marker comes after its children's. A component that is not handed its
 * marker has to find it, and the old rule — lowest id in a CONTIGUOUS comment
 * run, breaking on the first non-comment node after any marker — mistook
 * ordinary sibling content for the end of the component:
 *
 *     <div>A</div><!--$c:2--><span>B</span><!--$c:1-->
 *
 * Scanning for the component that owns `$c:1` stopped at `<span>` and latched
 * the CHILD's `$c:2`. Everything downstream is derived from that anchor: the
 * mismatch range, the bail cleanup, the walk's resume position, and the
 * boundary-table id.
 *
 * The fix bounds the search by the enclosing component's marker (`regionEnd`)
 * and takes the lowest id in that range, which pre-order id allocation makes
 * exact rather than heuristic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { renderToString } from '../src/server/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    findComponentBoundaries,
    parseMarkerId,
    cleanupPendingHydrations,
    invalidateMarkerIndex
} from '../src/client/scheduler';
import { registerComponent } from '../src/client/registry';
import { clearClientPlugins } from '../src/client/hydrate-context';
import type { SSRBoundaryRecord } from '../src/boundary';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick,
} from './test-utils';

/** The issue's repro shape: child content, child marker, sibling content, parent marker. */
const REPRO_HTML = '<div class="a">A</div><!--$c:2--><span class="b">B</span><!--$c:1-->';

describe('component anchor selection over the enclosing region (#373)', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
        delete (window as any).__SIGX_BOUNDARIES__;
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.restoreAllMocks();
    });

    describe('findComponentBoundaries', () => {
        it('picks the parent marker when its content continues past a child marker', () => {
            container = createSSRContainer(REPRO_HTML);

            const { trailingMarker } = findComponentBoundaries(container.firstChild);

            // The old contiguous-run rule broke at <span> and returned $c:2.
            expect(trailingMarker && parseMarkerId(trailingMarker)).toBe(1);
        });

        it("picks the child's own marker when the search is bounded by the parent's", () => {
            container = createSSRContainer(REPRO_HTML);
            const parentMarker = container.lastChild as Comment;
            expect(parseMarkerId(parentMarker)).toBe(1);

            // What the walk does for a nested component: the enclosing
            // component's marker bounds the range, so the parent's (lower) id
            // is out of reach and the child takes its own.
            const { trailingMarker } = findComponentBoundaries(container.firstChild, parentMarker);

            expect(trailingMarker && parseMarkerId(trailingMarker)).toBe(2);
        });

        it('gives each of two sibling components its own marker', () => {
            container = createSSRContainer(
                '<div class="a">A</div><!--$c:2--><div class="b">B</div><!--$c:3--><!--$c:1-->'
            );
            const parentMarker = container.lastChild as Comment;

            const first = findComponentBoundaries(container.firstChild, parentMarker);
            expect(first.trailingMarker && parseMarkerId(first.trailingMarker)).toBe(2);

            // The walk resumes after the first component's marker.
            const second = findComponentBoundaries(first.trailingMarker!.nextSibling, parentMarker);
            expect(second.trailingMarker && parseMarkerId(second.trailingMarker)).toBe(3);
        });

        it('returns no marker for a marker-free range', () => {
            container = createSSRContainer('<div class="a">A</div>');
            expect(findComponentBoundaries(container.firstChild).trailingMarker).toBeNull();
        });
    });

    describe('structural-mismatch bail', () => {
        it('discards the whole component range, not the prefix before a child marker', async () => {
            // Client renders an element-rooted subtree whose tag differs from
            // the first SSR element — the #115 bail. With the child's marker as
            // the anchor, the cleanup removed only <div class="a"> and left
            // <span class="b"> behind as a duplicated orphan.
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const Mismatched = component(() => {
                return () => (
                    <table class="t">
                        <tbody><tr><td>fresh</td></tr></tbody>
                    </table>
                );
            }, { name: 'Mismatched' });

            container = createSSRContainer(REPRO_HTML);

            hydrate(<Mismatched />, container);
            await nextTick();

            expect(container.querySelectorAll('table.t').length).toBe(1);
            expect(container.querySelectorAll('.a').length).toBe(0);
            expect(container.querySelectorAll('.b').length).toBe(0);
            expect(container.textContent).not.toContain('B');
            warn.mockRestore();
        });
    });

    describe('walk resumption', () => {
        it('resumes after the component that owns the range, not mid-range', async () => {
            // App renders [Outer, <p class="tail">]; Outer renders
            // [Inner, <span class="b">] — the repro shape one level down. A
            // short anchor made the walk resume at <span class="b">, so the
            // <p> VNode had to scan past real content to find its element.
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const Inner = component(() => {
                return () => <div class="a">A</div>;
            }, { name: 'Inner' });

            const Outer = component(() => {
                const state = signal({ n: 0 });
                (globalThis as any).__anchorRegionBump = () => { state.n++; };
                return () => (
                    <>
                        <Inner />
                        <span class="b">B{state.n}</span>
                    </>
                );
            }, { name: 'Outer' });

            const App = component(() => {
                return () => (
                    <>
                        <Outer />
                        <p class="tail">tail</p>
                    </>
                );
            }, { name: 'App' });

            try {
                container = createSSRContainer(await renderToString(<App />));
                const ssrTail = container.querySelector('p.tail')!;
                const ssrSpan = container.querySelector('span.b')!;

                hydrate(<App />, container);
                await nextTick();

                // No sibling was skipped to reach the <p> — the walk arrived
                // at it directly.
                expect(warn).not.toHaveBeenCalledWith(
                    expect.stringContaining('Skipped non-matching sibling(s)'),
                    expect.anything(),
                    expect.anything()
                );
                // Nothing was re-mounted: the SSR nodes are still the live ones.
                expect(container.querySelectorAll('p.tail').length).toBe(1);
                expect(container.querySelector('p.tail')).toBe(ssrTail);
                expect(container.querySelectorAll('span.b').length).toBe(1);
                expect(container.querySelector('span.b')).toBe(ssrSpan);

                // And the hydrated component updates that same node in place.
                (globalThis as any).__anchorRegionBump();
                await nextTick();
                expect(container.querySelectorAll('span.b').length).toBe(1);
                expect(container.querySelector('span.b')).toBe(ssrSpan);
                expect(ssrSpan.textContent).toBe('B1');
            } finally {
                delete (globalThis as any).__anchorRegionBump;
                warn.mockRestore();
            }
        });
    });

    describe('boundary-table interception', () => {
        it('resolves the record keyed on the component that owns the range', async () => {
            // The walk looks the record up by the id it parses off the anchor.
            // With the child's marker it looked up 2, missed the record for 1,
            // and hydrated inline — silently ignoring the boundary's strategy.
            let setupRuns = 0;
            const Never = component(() => {
                setupRuns++;
                return () => (
                    <>
                        <div class="a">A</div>
                        <span class="b">B</span>
                    </>
                );
            }, { name: 'AnchorRegionNever' });
            registerComponent('AnchorRegionNever', Never as any);

            container = createSSRContainer(REPRO_HTML);
            const table: Record<string, SSRBoundaryRecord> = {
                '1': { hydrate: 'never', component: 'AnchorRegionNever' }
            };
            (window as any).__SIGX_BOUNDARIES__ = Object.assign(Object.create(null), table);

            hydrate(<Never />, container);
            await nextTick();

            // hydrate: 'never' — the record was found, so setup never ran.
            expect(setupRuns).toBe(0);
            expect(container.querySelectorAll('.a').length).toBe(1);
            expect(container.querySelectorAll('.b').length).toBe(1);
        });
    });
});
