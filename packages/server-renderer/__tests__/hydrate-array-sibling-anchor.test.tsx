/**
 * Hydration counterpart of runtime-core's fragment-array-sibling tests (#658).
 *
 * An array child among siblings normalizes to a Fragment. The hydration walk
 * traverses a Fragment transparently — SSR emits no marker for it — so it must
 * synthesize the trailing anchor comment that mount would have created. Without
 * it, the first append into a hydrated fragment falls back to a null anchor and
 * the new item lands PAST the trailing sibling.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { renderToString } from '../src/server/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick,
} from './test-utils';

describe('hydrated array-child fragments keep their sibling boundary (#658)', () => {
    let container: HTMLDivElement;
    const setters: Record<string, (items: string[]) => void> = {};

    beforeEach(() => {
        cleanupScripts();
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
    });

    function makeApp(key: string, initial: string[]) {
        const setups: string[] = [];
        const Item = component<{ label: string }>(({ props }) => {
            setups.push(props.label);
            return () => <i class="item">{props.label}</i>;
        }, { name: 'Item' });

        const App = component(() => {
            const s = signal({ items: initial });
            setters[key] = (items) => { s.items = items; };
            return () => (
                <div class="list">
                    {s.items.map((it) => <Item label={it} key={it} />)}
                    <button>Add</button>
                </div>
            );
        }, { name: `App_${key}` });

        return { App, setups };
    }

    it('growing a hydrated one-item list inserts before the trailing sibling', async () => {
        const { App, setups } = makeApp('grow1', ['a']);

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);
        const list = container.querySelector('div.list')!;
        const itemA = list.querySelector('i.item');
        expect(itemA?.textContent).toBe('a');

        hydrate(<App />, container);
        await nextTick();

        setters.grow1(['a', 'b']);
        await nextTick();

        // The new item must land before <button>, not past it…
        expect(Array.from(list.children).map((el) => el.tagName)).toEqual(['I', 'I', 'BUTTON']);
        // …and the hydrated item must survive as the same DOM node, without
        // its component being set up again.
        expect(list.querySelector('i.item')).toBe(itemA);
        expect(setups.filter((l) => l === 'a').length).toBe(2); // 1 SSR + 1 hydration

        setters.grow1(['a']);
        await nextTick();
        expect(Array.from(list.children).map((el) => el.tagName)).toEqual(['I', 'BUTTON']);
        expect(list.querySelector('i.item')).toBe(itemA);
    });

    it('growing a hydrated empty list inserts before the trailing sibling', async () => {
        const { App } = makeApp('grow0', []);

        const ssrHtml = await renderToString(<App />);
        container = createSSRContainer(ssrHtml);
        const list = container.querySelector('div.list')!;
        expect(list.querySelectorAll('i.item').length).toBe(0);

        hydrate(<App />, container);
        await nextTick();

        setters.grow0(['a', 'b']);
        await nextTick();

        expect(Array.from(list.children).map((el) => el.tagName)).toEqual(['I', 'I', 'BUTTON']);
        expect(Array.from(list.querySelectorAll('i.item')).map((el) => el.textContent)).toEqual(['a', 'b']);
    });

    it('an empty array child serializes to nothing (no comment placeholder)', async () => {
        const Empty = component(() => {
            return () => (
                <div class="empty">
                    {([] as string[]).map((s) => <span>{s}</span>)}
                    <button>Add</button>
                </div>
            );
        }, { name: 'EmptyApp' });

        const ssrHtml = await renderToString(<Empty />);
        const inner = ssrHtml.match(/<div class="empty">(.*?)<\/div>/)?.[1];
        expect(inner).toBe('<button>Add</button>');
    });
});
