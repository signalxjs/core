/**
 * End-to-end island signal-state restoration on hydration (#120).
 *
 * Server captures per-island signal state into `__SIGX_ISLANDS__[id].state`; on
 * the client the islands plugin's `transformComponentContext` seam swaps
 * `ctx.signal` with a restoring variant so the island resumes from the captured
 * value instead of its literal initial. Exercised through the data-driven
 * `hydrateIslands()` entry point.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { component } from 'sigx';
import { islandsPlugin } from '../src/plugin';
import { hydrateIslands } from '../src/client/hydrate-islands';
import { invalidateIslandCache } from '../src/client/island-context';
import { registerClientPlugin, clearClientPlugins } from '@sigx/server-renderer/client';
import { registerComponent } from '../src/client/registry';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    createIslandDataScript,
    nextTick
} from './test-utils';
import type { SSRSignalFn } from '../src/server/render-component';

describe('hydrateIslands() — server-state restoration', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
        invalidateIslandCache();
        clearClientPlugins();
        registerClientPlugin(islandsPlugin());
    });

    afterEach(() => {
        if (container) cleanupContainer(container);
        cleanupScripts();
        invalidateIslandCache();
        clearClientPlugins();
    });

    function makeCounter(name: string) {
        return component((ctx) => {
            const ssrSignal = ctx.signal as unknown as SSRSignalFn;
            const count = ssrSignal(0, 'count');
            return () => (
                <div>
                    <span class="count">{count.value}</span>
                    <button onClick={() => { count.value++; }}>+</button>
                </div>
            );
        }, { name });
    }

    it('restores the captured value so the island resumes from server state', async () => {
        const name = 'RestoreCounter';
        registerComponent(name, makeCounter(name) as any);

        // Server rendered the final state (10) and captured it.
        container = createSSRContainer(
            '<div><span class="count">10</span><button>+</button></div><!--$c:1-->'
        );
        createIslandDataScript({
            '1': { strategy: 'load', componentId: name, props: {}, state: { count: 10 } }
        });

        hydrateIslands();
        await nextTick();

        container.querySelector('button')!.click();
        await nextTick();

        // 10 (restored) + 1 = 11.
        expect(container.querySelector('.count')!.textContent).toBe('11');
    });

    it('does not bleed one island\'s state into another in the same pass', async () => {
        const withState = 'BleedA';
        const noState = 'BleedB';
        registerComponent(withState, makeCounter(withState) as any);
        registerComponent(noState, makeCounter(noState) as any);

        container = createSSRContainer(
            '<div class="a"><span class="count">10</span><button>+</button></div><!--$c:1-->' +
            '<div class="b"><span class="count">0</span><button>+</button></div><!--$c:2-->'
        );
        createIslandDataScript({
            '1': { strategy: 'load', componentId: withState, props: {}, state: { count: 10 } },
            '2': { strategy: 'load', componentId: noState, props: {} }
        });

        hydrateIslands();
        await nextTick();

        (container.querySelector('.a button') as HTMLElement).click();
        (container.querySelector('.b button') as HTMLElement).click();
        await nextTick();

        // A restored 10 → 11; B had no state and must NOT inherit A's → 0 → 1.
        expect(container.querySelector('.a .count')!.textContent).toBe('11');
        expect(container.querySelector('.b .count')!.textContent).toBe('1');
    });

    it('hydrates a state-less island from its literal initial', async () => {
        const name = 'PlainCounter';
        registerComponent(name, makeCounter(name) as any);

        container = createSSRContainer(
            '<div><span class="count">0</span><button>+</button></div><!--$c:1-->'
        );
        createIslandDataScript({
            '1': { strategy: 'load', componentId: name, props: {} }
        });

        hydrateIslands();
        await nextTick();

        container.querySelector('button')!.click();
        await nextTick();

        // No captured state → starts at 0, increments to 1, still interactive.
        expect(container.querySelector('.count')!.textContent).toBe('1');
    });
});
