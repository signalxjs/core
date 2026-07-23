/**
 * The SSR pack tax (H7): what `app.use(islandsPlugin())` and
 * `app.use(resumePlugin())` cost over a plain render of the SAME tree.
 *
 * Two numbers per configuration, because they answer different questions:
 *
 * - **time** — the render's p50, gated like every other timing.
 * - **bytes** — the rendered output's length. Deterministic, so it is the
 *   one metric here that is machine-independent; `check-regression` gates it
 *   far tighter and never skips it on a fingerprint mismatch. A pack that
 *   starts emitting a fatter boundary table is a real user-visible
 *   regression that a timing gate would never catch.
 *
 * The trees are the shared scenario builders (`../scenarios/build.ts`), the
 * same ones the comparative SSR suite measures — a pack's overhead only means
 * something relative to the render it wraps.
 */
import { defineApp, component, type JSXElement, type App } from 'sigx';
import { jsx } from 'sigx/jsx-runtime';
import { createSSR } from '@sigx/server-renderer';
import { islandsPlugin } from '@sigx/ssr-islands';
import { resumePlugin } from '@sigx/resume';
import { assert, type ByteMetric, type MicroBench, type MicroSuite } from './types.ts';
import { build } from '../scenarios/build.ts';
import { plainListSmall } from '../fixtures/payloads.ts';

const ssr = createSSR();

/**
 * A pack only does work on components it CLAIMS, so a bare scenario tree
 * would measure the packs doing nothing. Each configuration wraps the
 * scenario in claimable components: resume claims by `__resumeId` stamp,
 * islands by a `client:*` directive at the usage site.
 */
const Panel = component<{ title: string; rows: number }>((ctx) => {
    const { title, rows } = ctx.props;
    return (): JSXElement => jsx('div', {
        class: 'panel',
        children: [
            jsx('h4', { children: title }),
            jsx('ul', {
                children: plainListSmall.slice(0, rows).map((row) =>
                    jsx('li', { children: row.name }, String(row.id)))
            })
        ]
    });
});

Object.assign(Panel, { __resumeId: 'Panel' });

const PANELS = 8;

function tree(scenario: 'small-page' | 'large-table-1k', directive: boolean): JSXElement {
    return jsx('div', {
        id: 'root',
        children: [
            build(scenario),
            ...Array.from({ length: PANELS }, (_, i) =>
                jsx(
                    Panel,
                    directive
                        ? { title: `Panel ${i}`, rows: 10, 'client:load': true }
                        : { title: `Panel ${i}`, rows: 10 },
                    String(i)
                ))
        ]
    });
}

type Config = 'plain' | 'islands' | 'resume';

function app(scenario: 'small-page' | 'large-table-1k', config: Config): App {
    const instance = defineApp(tree(scenario, config === 'islands'));
    if (config === 'islands') instance.use(islandsPlugin());
    if (config === 'resume') instance.use(resumePlugin());
    return instance;
}

function render(scenario: 'small-page' | 'large-table-1k', config: Config): Promise<string> {
    return ssr.render(app(scenario, config));
}

/**
 * A plugin that silently failed to install renders clean HTML fast — which
 * would read as a free win forever. Each pack must leave its fingerprint.
 */
async function guard(
    scenario: 'small-page' | 'large-table-1k',
    config: Config
): Promise<void> {
    const html = await render(scenario, config);
    assert(html.length > 500, `${config} render produced almost nothing (${html.length} bytes)`);
    if (config === 'plain') {
        // The floor must really be a floor: no pack, no boundary table.
        assert(
            !html.includes('__SIGX_BOUNDARIES__'),
            'plain render emitted a boundary table — a pack leaked into the floor'
        );
        return;
    }
    assert(
        html.includes('__SIGX_BOUNDARIES__'),
        `${config} render emitted no boundary table — the pack claimed nothing`
    );
    // The two packs record the same boundaries differently, which is what
    // tells them apart: islands schedules hydration, resume records the
    // component key and never hydrates.
    if (config === 'islands') {
        assert(html.includes('"hydrate":"load"'), 'islands recorded no client:load boundary');
    } else {
        assert(html.includes('"hydrate":"never"'), 'resume recorded no zero-JS boundary');
        assert(html.includes('"component":"Panel"'), 'resume recorded no component key');
    }
}

const SCENARIOS = ['small-page', 'large-table-1k'] as const;
const CONFIGS: Config[] = ['plain', 'islands', 'resume'];

export const packsSuite: MicroSuite = {
    name: 'packs',
    benches(): MicroBench[] {
        const benches: MicroBench[] = [];
        for (const scenario of SCENARIOS) {
            for (const config of CONFIGS) {
                benches.push({
                    suite: 'packs',
                    name: `${scenario} ${config}`,
                    isFloor: config === 'plain',
                    floorOf: config === 'plain' ? undefined : `${scenario} plain`,
                    // The gated timing subset stays small — bytes below cover
                    // the rest at zero noise.
                    quick: scenario === 'small-page' && config === 'resume',
                    check: () => guard(scenario, config),
                    run: () => render(scenario, config)
                });
            }
        }
        return benches;
    },
    async bytes(): Promise<ByteMetric[]> {
        const metrics: ByteMetric[] = [];
        for (const scenario of SCENARIOS) {
            for (const config of CONFIGS) {
                const html = await render(scenario, config);
                metrics.push({ suite: 'packs', name: `${scenario} ${config}`, bytes: html.length });
            }
        }
        return metrics;
    }
};
