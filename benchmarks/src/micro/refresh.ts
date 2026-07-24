/**
 * Single-flight boundary refresh — `createBoundaryRefresh` from
 * `@sigx/resume/server` (rfc-server §6.3). The mutation path's most
 * expensive optional step: each admitted descriptor is a full re-render plus
 * a boundary-table encode.
 *
 * H6: descriptors are re-rendered SERIALLY (`for … await`), and each render
 * is followed by a `matchAll` scan of the whole emitted HTML to find the
 * highest component-id marker. The 1 → 8 → 32 sweep is what separates
 * "linear in descriptors because rendering is linear" from "linear plus a
 * per-descriptor tax".
 *
 * The component is stamped `__resumeId` by hand — that stamp is normally the
 * Vite transform's job, and without it resume declines to claim the boundary
 * and there is nothing to refresh.
 */
import { jsx } from 'sigx/jsx-runtime';
import { component, type JSXElement } from 'sigx';
import { resumePlugin } from '@sigx/resume';
import { createBoundaryRefresh } from '@sigx/resume/server';
import { assert, type MicroBench, type MicroSuite } from './types.ts';
import { plainListSmall } from '../fixtures/payloads.ts';

interface TrackerProps {
    label: string;
    count: number;
}

const Tracker = component<TrackerProps>((ctx) => {
    const { label, count } = ctx.props;
    return (): JSXElement => jsx('section', {
        class: 'tracker',
        children: [
            jsx('h3', { children: label }),
            jsx('ul', {
                children: plainListSmall.slice(0, count).map((row) =>
                    jsx('li', {
                        children: [
                            jsx('span', { class: 'name', children: row.name }),
                            jsx('span', { class: 'score', children: row.score.toFixed(2) })
                        ]
                    }, String(row.id)))
            })
        ]
    });
});

// The transform's stamp, applied by hand (see the module docblock).
Object.assign(Tracker, { __resumeId: 'Tracker' });

const renderBoundaries = createBoundaryRefresh({
    plugins: [resumePlugin()],
    components: { Tracker }
});

function requests(count: number): Array<{ id: number; component: string; deps: string[]; props: Record<string, unknown> }> {
    return Array.from({ length: count }, (_, i) => ({
        id: i + 1,
        component: 'Tracker',
        deps: [JSON.stringify(['tracker', i])],
        props: { label: `Tracker ${i}`, count: 20 }
    }));
}

/** Every descriptor must come back rendered — a declined one is invisible otherwise. */
function guard(count: number) {
    return async (): Promise<void> => {
        const entries = await renderBoundaries(requests(count), 1000);
        assert(
            entries.length === count,
            `refresh returned ${entries.length} of ${count} entries — descriptors are being declined, ` +
            `so this bench is measuring the decline path`
        );
        assert(entries[0].html.includes('<!--$c:'), 'refreshed HTML carries no component marker');
        assert(Object.keys(entries[0].records).length > 0, 'refresh produced an empty boundary table');
    };
}

function refreshBench(count: number, quick = false): MicroBench {
    return {
        suite: 'refresh',
        name: `boundary refresh x${count}`,
        quick,
        check: guard(count),
        run: () => renderBoundaries(requests(count), 1000)
    };
}

export const refreshSuite: MicroSuite = {
    name: 'refresh',
    benches(): MicroBench[] {
        // x32 is the quick-gated pick, not x8: at ~1.3ms it holds a stable
        // p50, where x8 (~0.3ms) swung run to run (#474).
        return [refreshBench(1), refreshBench(8), refreshBench(32, true)];
    }
};
