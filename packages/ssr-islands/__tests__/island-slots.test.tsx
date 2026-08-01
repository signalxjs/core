/**
 * #583 area 3 — slots × islands coverage.
 *
 * `islandsPlugin`'s `resolveBoundary` strips `children`/`slots` (and
 * `$models`) from the serialized boundary props before recording them for the
 * client hydrator (src/plugin.ts). These tests pin what islands with slot
 * children actually do across that seam:
 *
 * 1. A `client:load` island rendering `ctx.slots.default?.()` — the slot
 *    content is server-rendered into the HTML, but never ships in the
 *    `__SIGX_BOUNDARIES__` record; vnode-driven hydration keeps the
 *    server-rendered slot content (no loss, no duplication).
 * 2. Slot content that itself contains an island — the inner island still
 *    gets its boundary record and trailing marker.
 * 3. `client:only` + slot children — the slot content is skipped with the
 *    rest of the server render and, since slots are stripped from the
 *    record, cannot be reconstructed client-side. Pinned as intended.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { component, signal, type Define } from 'sigx';
import { createSSR } from '@sigx/server-renderer';
import { hydrate } from '../../server-renderer/src/client/hydrate-core';
import {
    registerClientPlugin,
    clearClientPlugins,
    cleanupPendingHydrations,
    invalidateMarkerIndex
} from '@sigx/server-renderer/client';
import { islandsPlugin } from '../src/plugin';
import '../src/client-directives';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    parseBoundaryTable,
    nextTick
} from './test-utils';

/** A slot-rendering island: real prop + default slot + interactive state. */
const SlotIsland = component<{ label?: string } & Define.Slot<'default'>>((ctx) => {
    const n = signal(0);
    return () => (
        <div class="slot-island">
            <button class="bump" onClick={() => n.value++}>{n.value}</button>
            <section class="slot-out">{ctx.slots.default?.()}</section>
        </div>
    );
}, { name: 'SlotIsland' });

/** Plain (non-island) slot-rendering wrapper. */
const SlotWrapper = component<Define.Slot<'default'>>((ctx) => {
    return () => <div class="wrapper">{ctx.slots.default?.()}</div>;
}, { name: 'SlotWrapper' });

/** A small island to nest inside the wrapper's slot content. */
const InnerIsland = component<{ start?: number }>((ctx) => {
    const count = signal(ctx.props.start ?? 0);
    return () => <span class="inner-count">{count.value}</span>;
}, { name: 'InnerIsland' });

describe('islands × slots (#583 area 3)', () => {
    let container: HTMLDivElement | undefined;

    beforeEach(() => {
        cleanupScripts();
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        registerClientPlugin(islandsPlugin());
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        container = undefined;
        cleanupScripts();
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
    });

    describe('client:load island with slot children', () => {
        it('server-renders the slot content into the HTML', async () => {
            const html = await createSSR({ plugins: [islandsPlugin()] }).render(
                <SlotIsland client:load label="greeting">
                    <span class="slotted">from server</span>
                </SlotIsland>
            );

            expect(html).toContain('<span class="slotted">from server</span>');
            // The slot content renders inside the island's slot outlet,
            // before the island's trailing marker.
            expect(html).toContain(
                '<section class="slot-out"><span class="slotted">from server</span></section></div><!--$c:1-->'
            );
        });

        it('records boundary props WITHOUT the children/slots (only real props ship)', async () => {
            const html = await createSSR({ plugins: [islandsPlugin()] }).render(
                <SlotIsland client:load label="greeting">
                    <span class="slotted">from server</span>
                </SlotIsland>
            );

            const records = parseBoundaryTable(html);
            expect(records['1']).toMatchObject({ hydrate: 'load', component: 'SlotIsland' });
            // The serialized props keep the real prop and nothing structural:
            // children and slots are stripped before serialization.
            expect(records['1'].props).toEqual({ label: 'greeting' });
            expect(records['1'].props).not.toHaveProperty('children');
            expect(records['1'].props).not.toHaveProperty('slots');
            // The slot content's text must not leak into the record either.
            expect(JSON.stringify(records['1'])).not.toContain('from server');
        });

        it('strips a slots-prop fill from the record too', async () => {
            const S = SlotIsland as any;
            const html = await createSSR({ plugins: [islandsPlugin()] }).render(
                <S client:load slots={{ default: () => <b class="sp">slot-prop fill</b> }} />
            );

            // The fill renders on the server…
            expect(html).toContain('<b class="sp">slot-prop fill</b>');
            // …but nothing of it survives into the record: `slots` is stripped
            // and no other serializable prop remains.
            const records = parseBoundaryTable(html);
            expect(records['1'].props).toBeUndefined();
            expect(JSON.stringify(records['1'])).not.toContain('slot-prop fill');
        });

        it('hydration keeps the server-rendered slot content — no loss, no duplication', async () => {
            const html = await createSSR({ plugins: [islandsPlugin()] }).render(
                <SlotIsland client:load label="greeting">
                    <span class="slotted">from server</span>
                </SlotIsland>
            );

            // Mount the body markup (without the boundary-table script — jsdom
            // wouldn't execute it, and the vnode-driven hydrate below carries
            // the live children itself).
            container = createSSRContainer(html.slice(0, html.indexOf('<script>')));
            expect(container.querySelectorAll('.slotted')).toHaveLength(1);

            hydrate(
                (
                    <SlotIsland client:load label="greeting">
                        <span class="slotted">from server</span>
                    </SlotIsland>
                ) as any,
                container
            );
            await nextTick();

            // Slot content survived hydration exactly once.
            expect(container.querySelectorAll('.slotted')).toHaveLength(1);
            expect(container.querySelector('.slotted')!.textContent).toBe('from server');

            // The island is interactive, and a re-render does not drop or
            // duplicate the slot content.
            (container.querySelector('.bump') as HTMLElement).click();
            await nextTick();
            expect(container.querySelector('.bump')!.textContent).toBe('1');
            expect(container.querySelectorAll('.slotted')).toHaveLength(1);
            expect(container.querySelector('.slotted')!.textContent).toBe('from server');
        });
    });

    describe('island inside a plain wrapper\'s slot content', () => {
        it('the inner island still gets its boundary record and trailing marker', async () => {
            const html = await createSSR({ plugins: [islandsPlugin()] }).render(
                <SlotWrapper>
                    <InnerIsland client:load start={7} />
                </SlotWrapper>
            );

            // The island rendered inside the wrapper's slot outlet, with its
            // own trailing marker (wrapper = id 1, inner island = id 2).
            expect(html).toContain(
                '<div class="wrapper"><span class="inner-count">7</span><!--$c:2--></div><!--$c:1-->'
            );

            // Only the island is recorded — the plain wrapper claims no boundary.
            const records = parseBoundaryTable(html);
            expect(Object.keys(records)).toEqual(['2']);
            expect(records['2']).toMatchObject({ hydrate: 'load', component: 'InnerIsland' });
            expect(records['2'].props).toEqual({ start: 7 });
        });
    });

    describe('client:only island with slot children', () => {
        // Pins INTENDED behavior: client:only skips the server render
        // entirely (setup never runs, so the slot outlet never renders), and
        // since `resolveBoundary` strips children/slots from the record, the
        // slot content cannot be reconstructed client-side from the boundary
        // table either. Authors must not expect server-provided slot content
        // to survive `client:only`.
        it('emits only the placeholder — slot content is neither rendered nor recorded', async () => {
            const html = await createSSR({ plugins: [islandsPlugin()] }).render(
                <SlotIsland client:only label="greeting">
                    <span class="co-slot">never rendered</span>
                </SlotIsland>
            );

            // The empty client-mount placeholder plus the trailing marker —
            // and nothing of the island's own markup.
            expect(html).toContain('<div data-boundary="1" style="display:contents;"></div><!--$c:1-->');
            expect(html).not.toContain('slot-island');
            // The slot content appears nowhere: not in the HTML…
            expect(html).not.toContain('co-slot');
            expect(html).not.toContain('never rendered');

            // …and not in the boundary record: flush is 'skip', the real prop
            // ships, children/slots do not.
            const records = parseBoundaryTable(html);
            expect(records['1']).toMatchObject({
                flush: 'skip',
                hydrate: 'load',
                component: 'SlotIsland'
            });
            expect(records['1'].props).toEqual({ label: 'greeting' });
            expect(records['1'].props).not.toHaveProperty('children');
            expect(records['1'].props).not.toHaveProperty('slots');
        });
    });
});
