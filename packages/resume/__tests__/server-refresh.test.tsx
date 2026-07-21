/**
 * createBoundaryRefresh (rfc-server §6.3, #313) — the server half of
 * single-flight boundary refresh: re-render one boundary from its client
 * descriptor in an id-seeded context, capture fresh state through the same
 * tracking-signal machinery as the original request, encode for the
 * envelope. Plus the `refreshable: false` lossy-snapshot stamping the
 * decline path rides on.
 *
 * Fixtures hand-write what the sigxResume() transform emits (keyed signals,
 * QRL attributes, stamps) — the transform itself is tested in @sigx/vite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import { createSSR } from '../../server-renderer/src/ssr';
import { resumePlugin } from '../src/plugin';
import { createBoundaryRefresh } from '../src/server/refresh';

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

/**
 * A resumable component whose prop and named signal hold rich types. The
 * render reads the PROP (object signals are reactive objects, not `{value}`
 * boxes) — that read is what proves the descriptor props were revived; the
 * named signal is what proves rich state encodes back for the envelope.
 */
function makeCalendar(): any {
    const Calendar = component<{ start?: Date }>((ctx) => {
        const when = ((init: Date | undefined) => (ctx.signal as any)(init, 'when'))(ctx.props.start);
        void when;
        return () => (
            <time>{ctx.props.start instanceof Date ? ctx.props.start.toISOString() : 'unset'}</time>
        );
    }, { name: 'Calendar' });
    (Calendar as any).__resumeId = 'Calendar';
    (Calendar as any).__resumeMode = 'resume';
    return Calendar;
}

describe('createBoundaryRefresh — the admitted path', () => {
    it('re-renders a descriptor into fresh HTML, state, and a table patch above base', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());

        // The "page" render — its table entry is what a client would send up.
        const pageHtml = await ssr.render(<Counter label="hits" initial={7} />);
        const [pageId] = Object.keys(parseBoundaryTable(pageHtml));
        const pageRecord = parseBoundaryTable(pageHtml)[pageId];

        const renderBoundaries = createBoundaryRefresh({ ssr, components: { Counter } });
        const entries = await renderBoundaries(
            [{ id: Number(pageId), component: 'Counter', props: pageRecord.props }],
            BASE
        );

        expect(entries).toHaveLength(1);
        const entry = entries[0];
        expect(entry.for).toBe(Number(pageId));
        expect(entry.id).toBe(BASE + 1);
        // Fresh HTML self-identifies with the fresh id — marker and lexical
        // boundary attribute both — so the page swap re-wires delegation.
        expect(entry.html).toContain(`<!--$c:${BASE + 1}-->`);
        expect(entry.html).toContain(`data-sigx-b="${BASE + 1}"`);
        expect(entry.html.replace(/<!--t-->/g, '')).toContain('hits: 7');
        // State captured through the same tracking-signal machinery.
        expect(entry.state).toEqual({ count: 7 });
        // The table patch carries the root record under the fresh id.
        const patched = entry.records[BASE + 1] as SSRBoundaryRecord;
        expect(patched.component).toBe('Counter');
        expect(patched.hydrate).toBe('never');
        expect(patched.state).toEqual({ count: 7 });
    });

    it('revives encoded descriptor props and encodes rich state back', async () => {
        const Calendar = makeCalendar();
        const ssr = createSSR().use(resumePlugin());
        const start = new Date('2026-07-21T12:00:00.000Z');

        const pageHtml = await ssr.render(<Calendar start={start} />);
        const [pageId] = Object.keys(parseBoundaryTable(pageHtml));
        const pageRecord = parseBoundaryTable(pageHtml)[pageId];
        // The table ships the Date encoded — exactly what the client resends.
        expect(pageRecord.props).toEqual({ start: { $date: start.getTime() } });

        const renderBoundaries = createBoundaryRefresh({ ssr, components: { Calendar } });
        const entries = await renderBoundaries(
            [{ id: Number(pageId), component: 'Calendar', props: pageRecord.props }],
            BASE
        );

        expect(entries).toHaveLength(1);
        // The render saw a real Date (revived), and the fresh state comes
        // back in encoded wire form — table-uniform for the client.
        expect(entries[0].html).toContain('2026-07-21T12:00:00.000Z');
        expect(entries[0].state).toEqual({ when: { $date: start.getTime() } });
    });

    it('resolves lazy component loaders (module and factory shapes)', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const renderBoundaries = createBoundaryRefresh({
            ssr,
            components: {
                Counter: () => Promise.resolve({ Counter }),
                Solo: async () => makeCounter('Solo')
            }
        });

        const entries = await renderBoundaries(
            [
                { id: 3, component: 'Counter', props: { initial: 1 } },
                { id: 5, component: 'Solo', props: { initial: 2 } }
            ],
            BASE
        );
        expect(entries.map((e) => e.for)).toEqual([3, 5]);
    });

    it('keeps successive descriptors id-disjoint past the previous render', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const renderBoundaries = createBoundaryRefresh({ ssr, components: { Counter } });

        const entries = await renderBoundaries(
            [
                { id: 3, component: 'Counter' },
                { id: 4, component: 'Counter' }
            ],
            BASE
        );
        expect(entries).toHaveLength(2);
        const [first, second] = entries;
        const firstMax = Math.max(
            ...[...first.html.matchAll(/<!--\$c:(\d+)-->/g)].map((m) => Number(m[1]))
        );
        expect(second.id).toBeGreaterThan(firstMax);
        // Both ranges sit entirely above the client-chosen floor.
        expect(first.id).toBeGreaterThan(BASE);
        expect(Object.keys(second.records).every((k) => Number(k) > firstMax)).toBe(true);
    });

    it('records nested resume boundaries in the patch', async () => {
        const Child = makeCounter('Child');
        const Parent = component((ctx) => {
            void ctx;
            return () => (
                <section>
                    <Child initial={1} />
                </section>
            );
        }, { name: 'Parent' });
        (Parent as any).__resumeId = 'Parent';
        (Parent as any).__resumeMode = 'resume';

        const ssr = createSSR().use(resumePlugin());
        const renderBoundaries = createBoundaryRefresh({ ssr, components: { Parent } });
        const entries = await renderBoundaries([{ id: 2, component: 'Parent' }], BASE);

        expect(entries).toHaveLength(1);
        const ids = Object.keys(entries[0].records).map(Number);
        expect(ids).toContain(BASE + 1);
        expect(ids.length).toBeGreaterThanOrEqual(2);
        const child = Object.values(entries[0].records).find(
            (r) => (r as SSRBoundaryRecord).component === 'Child'
        );
        expect(child).toBeTruthy();
    });
});

describe('createBoundaryRefresh — declines (omission, never a throw)', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('declines inherited object keys — only own registry entries are callable', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const renderBoundaries = createBoundaryRefresh({ ssr, components: { Counter } });

        // `constructor`/`toString` resolve through the prototype chain of a
        // plain-object registry; the own-property guard must keep them from
        // ever reaching the lazy-loader call path.
        const entries = await renderBoundaries(
            [
                { id: 3, component: 'constructor' },
                { id: 5, component: 'toString' },
                { id: 7, component: 'Counter' }
            ],
            BASE
        );
        expect(entries.map((e) => e.for)).toEqual([7]);
    });

    it('declines unknown registry keys, keeps the rest', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const renderBoundaries = createBoundaryRefresh({ ssr, components: { Counter } });

        const entries = await renderBoundaries(
            [
                { id: 3, component: 'Ghost' },
                { id: 4, component: 'Counter' }
            ],
            BASE
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].for).toBe(4);
    });

    it('declines when the re-render throws, keeps the rest', async () => {
        const Counter = makeCounter();
        const Bomb = component(() => {
            throw new Error('boom');
        }, { name: 'Bomb' });
        (Bomb as any).__resumeId = 'Bomb';

        const ssr = createSSR().use(resumePlugin());
        const renderBoundaries = createBoundaryRefresh({ ssr, components: { Counter, Bomb } });

        const entries = await renderBoundaries(
            [
                { id: 3, component: 'Bomb' },
                { id: 4, component: 'Counter' }
            ],
            BASE
        );
        expect(entries.map((e) => e.for)).toEqual([4]);
    });

    it('declines a smuggled children prop — the re-render is lossy', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const renderBoundaries = createBoundaryRefresh({ ssr, components: { Counter } });

        // Descriptors are client-controlled: a forged `children` value would
        // render markup the snapshot cannot vouch for. The re-rendered record
        // stamps itself refreshable:false and the entry is omitted.
        const entries = await renderBoundaries(
            [{ id: 3, component: 'Counter', props: { children: 'forged' } as any }],
            BASE
        );
        expect(entries).toHaveLength(0);
    });

    it('declines everything when the app factory throws', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const renderBoundaries = createBoundaryRefresh({
            ssr,
            components: { Counter },
            app: () => {
                throw new Error('no app for you');
            }
        });
        const entries = await renderBoundaries([{ id: 3, component: 'Counter' }], BASE);
        expect(entries).toHaveLength(0);
    });
});

describe('refreshable: false stamping (lossy snapshots)', () => {
    it('stamps a children-carrying usage site, leaves clean sites unstamped', async () => {
        const WithChildren = component<{ children?: unknown }>((ctx) => {
            return () => <div>{ctx.props.children as any}</div>;
        }, { name: 'WithChildren' });
        (WithChildren as any).__resumeId = 'WithChildren';
        const Counter = makeCounter();

        const ssr = createSSR().use(resumePlugin());
        const html = await ssr.render(
            <main>
                <WithChildren>
                    <em>slotted</em>
                </WithChildren>
                <Counter initial={1} />
            </main>
        );

        const records = Object.values(parseBoundaryTable(html));
        const lossy = records.find((r) => r.component === 'WithChildren');
        const clean = records.find((r) => r.component === 'Counter');
        expect(lossy?.refreshable).toBe(false);
        expect(clean?.refreshable).toBeUndefined();
    });

    it('does not stamp for dropped on* handler props', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const html = await ssr.render(<Counter initial={1} {...({ onSelect: () => {} } as any)} />);
        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.refreshable).toBeUndefined();
    });

    it('stamps for a dropped non-handler function prop (render prop)', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const html = await ssr.render(<Counter initial={1} {...({ format: (n: number) => `${n}` } as any)} />);
        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.refreshable).toBe(false);
    });
});
