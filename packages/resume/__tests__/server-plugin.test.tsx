/**
 * resumePlugin() server half (#241): boundary claiming via __resumeId stamps,
 * hydrate:'never' vs 'interaction' records, named-signal state capture,
 * $sigxB exposure, and — load-bearing for the whole design — that the
 * transform-injected `data-sigx-on:*` / `data-sigx-b` props render as HTML
 * attributes through the core prop serializer.
 *
 * Fixtures hand-write what the sigxResume() transform emits (keyed signals,
 * QRL attributes, stamps) — the transform itself is tested in @sigx/vite.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import type { SSRBoundaryRecord } from '@sigx/server-renderer';
import { createSSR } from '../../server-renderer/src/ssr';
import { resumePlugin } from '../src/plugin';
import { islandsPlugin } from '../../ssr-islands/src/plugin';
import '../../ssr-islands/src/client-directives';

/** Parse the __SIGX_BOUNDARIES__ table out of rendered HTML (wire shape). */
function parseBoundaryTable(html: string): Record<string, SSRBoundaryRecord> {
    const match = html.match(
        /window\.__SIGX_BOUNDARIES__=Object\.assign\(Object\.create\(null\),window\.__SIGX_BOUNDARIES__,([\s\S]*?)\);<\/script>/
    );
    if (!match) return {};
    return JSON.parse(match[1]);
}

/** A transform-shaped resumable counter: keyed signal + QRL attributes + stamps. */
function makeCounter(): any {
    const Counter = component<{ label?: string; initial?: number }>((ctx) => {
        const count = ((__sigxInit: number) => (ctx.signal as any)(__sigxInit, 'count'))(ctx.props.initial ?? 0);
        return () => (
            <button
                onClick={() => { count.value++; }}
                {...({
                    'data-sigx-on:click': 'Counter_click_ab12cd34',
                    'data-sigx-b': (ctx as any).$sigxB
                } as any)}
            >
                {ctx.props.label ?? 'count'}: {count.value}
            </button>
        );
    }, { name: 'Counter' });
    (Counter as any).__resumeId = 'Counter';
    (Counter as any).__resumeMode = 'resume';
    return Counter;
}

describe('resumePlugin — boundary records', () => {
    it('renders QRL + boundary attributes and records hydrate:never with state', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin());
        const html = await ssr.render(<Counter label="hits" initial={7} />);

        // The attribute-smuggling path: plain string props render, on* is dropped.
        expect(html).toContain('data-sigx-on:click="Counter_click_ab12cd34"');
        expect(html).toMatch(/data-sigx-b="\d+"/);
        expect(html).not.toContain('onClick');
        // Adjacent text nodes are separated by <!--t--> markers in SSR output.
        expect(html.replace(/<!--t-->/g, '')).toContain('hits: 7');

        const records = Object.values(parseBoundaryTable(html));
        expect(records).toHaveLength(1);
        const record = records[0];
        expect(record.hydrate).toBe('never');
        expect(record.component).toBe('Counter');
        expect(record.state).toEqual({ count: 7 });
        expect(record.props).toEqual({ label: 'hits', initial: 7 });
        // The element's data-sigx-b matches the record's table id.
        const boundaryId = html.match(/data-sigx-b="(\d+)"/)![1];
        expect(parseBoundaryTable(html)[boundaryId]).toBeTruthy();
    });

    it('records hydrate:never for __resumeMode:"hydrate" components too (pack-owned waking)', async () => {
        const Counter = makeCounter();
        Counter.__resumeMode = 'hydrate';
        const ssr = createSSR().use(resumePlugin());
        const html = await ssr.render(<Counter />);

        // Core must never schedule resume boundaries — a resumable page has
        // no upfront runtime to install core interaction listeners; the
        // pack's delegation hydrates these via their wake attributes.
        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.hydrate).toBe('never');
    });

    it('attaches the upgrade chunk from the manifest', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(resumePlugin({
            manifest: {
                components: { Counter: { chunkUrl: '/assets/counter.abc.js', exportName: 'Counter' } },
                handlers: {}
            }
        }));
        const html = await ssr.render(<Counter />);

        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.chunk).toEqual({ url: '/assets/counter.abc.js', export: 'Counter' });
    });

    it('ignores unstamped components entirely', async () => {
        const Plain = component((ctx) => {
            const n = ctx.signal(1);
            return () => <span>{n.value}</span>;
        }, { name: 'Plain' });
        const ssr = createSSR().use(resumePlugin());
        const html = await ssr.render(<Plain />);

        expect(Object.values(parseBoundaryTable(html))).toHaveLength(0);
        expect(html).toContain('<span>1</span>');
    });
});

describe('resumePlugin — coexistence with islands', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('lets islands claim directive-carrying resume components (islands registered first)', async () => {
        const Counter = makeCounter();
        const ssr = createSSR().use(islandsPlugin()).use(resumePlugin());
        const html = await ssr.render(<Counter client:visible initial={3} />);

        const record = Object.values(parseBoundaryTable(html))[0];
        // Islands' record: hydrate strategy from the directive, not 'never'.
        // resolveBoundary is winner-take-all, islands is consulted first —
        // resume is never asked, so no warning fires.
        expect(record.hydrate).toBe('visible');
        // And islands' tracking signal owns the state capture — resume's
        // transform hook (which runs for every plugin) must step aside on
        // client:* usage sites rather than overwrite it.
        expect(record.state).toEqual({ count: 3 });
    });

    it('declines directive-carrying components even when consulted first', async () => {
        const Counter = makeCounter();
        // Wrong registration order — resume's decline is the safety net that
        // keeps ownership with islands regardless.
        const ssr = createSSR().use(resumePlugin()).use(islandsPlugin());
        const html = await ssr.render(<Counter client:visible initial={3} />);

        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.hydrate).toBe('visible');
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('client:'));
    });

    it('claims stamped components while islands claims directive-carrying ones', async () => {
        const Counter = makeCounter();
        const Island = component((ctx) => {
            const n = (ctx.signal as any)(0, 'n');
            return () => <div>{n.value}</div>;
        }, { name: 'Island' });

        const ssr = createSSR().use(islandsPlugin()).use(resumePlugin());
        const html = await ssr.render(
            <div>
                <Counter initial={1} />
                <Island client:idle />
            </div>
        );

        const records = Object.values(parseBoundaryTable(html));
        const byComponent = Object.fromEntries(records.map((r) => [r.component, r]));
        expect(byComponent.Counter.hydrate).toBe('never');
        expect(byComponent.Island.hydrate).toBe('idle');
    });
});

describe('resumePlugin — state capture', () => {
    it('captures writes during setup, not just initials', async () => {
        const Warmup = component((ctx) => {
            const n = ((__sigxInit: number) => (ctx.signal as any)(__sigxInit, 'n'))(0);
            n.value = 42; // setup-time write must reach the record
            return () => <i>{n.value}</i>;
        }, { name: 'Warmup' });
        (Warmup as any).__resumeId = 'Warmup';
        (Warmup as any).__resumeMode = 'resume';

        const ssr = createSSR().use(resumePlugin());
        const html = await ssr.render(<Warmup />);

        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.state).toEqual({ n: 42 });
        expect(html).toContain('<i>42</i>');
    });

    it('keeps unnamed signals local-only (named = transferred)', async () => {
        const Mixed = component((ctx) => {
            const kept = ((__sigxInit: number) => (ctx.signal as any)(__sigxInit, 'kept'))(1);
            const local = ctx.signal(2);
            return () => <i>{kept.value + local.value}</i>;
        }, { name: 'Mixed' });
        (Mixed as any).__resumeId = 'Mixed';
        (Mixed as any).__resumeMode = 'resume';

        const ssr = createSSR().use(resumePlugin());
        const html = await ssr.render(<Mixed />);

        const record = Object.values(parseBoundaryTable(html))[0];
        expect(record.state).toEqual({ kept: 1 });
    });
});
