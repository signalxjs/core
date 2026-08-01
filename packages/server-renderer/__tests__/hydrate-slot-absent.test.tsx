/**
 * Post-hydration presence flip with a fully ABSENT children prop (#586).
 *
 * `cond ? <Wrap>content</Wrap> : <Wrap />` — unlike the children-present-
 * but-null form — used to skip the slot update on patch entirely, so a
 * hydrated page flipping content off kept the stale fill in the DOM.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { component, signal, type Define } from 'sigx';
import { renderToString } from '../src/server/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick,
} from './test-utils';

const Wrap = component<Define.Slot<'default'>>((ctx) => {
    return () => (
        <div class="wrap">{ctx.slots.default?.() ?? <span class="fb">fallback</span>}</div>
    );
}, { name: 'Wrap' });

describe('post-hydration presence flip with an absent children prop (#586)', () => {
    let container: HTMLDivElement;
    let setShow: (v: boolean) => void;

    beforeEach(() => {
        cleanupScripts();
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
    });

    it('content → absent → content round-trips after hydration', async () => {
        const App = component(() => {
            const s = signal({ show: true });
            setShow = (v) => { s.show = v; };
            return () =>
                s.show
                    ? <Wrap><span class="content">on</span></Wrap>
                    : <Wrap />;
        }, { name: 'App_AbsentFlip' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('<span class="content">on</span>');

        container = createSSRContainer(ssrHtml);
        const original = container.querySelector('span.content')!;

        hydrate(<App />, container);
        await nextTick();
        expect(container.querySelector('span.content')).toBe(original);

        setShow(false);
        await nextTick();
        // The stale-fill bug left the content mounted here.
        expect(container.querySelector('span.content')).toBeNull();
        expect(container.querySelectorAll('span.fb').length).toBe(1);

        setShow(true);
        await nextTick();
        expect(container.querySelector('span.fb')).toBeNull();
        expect(container.querySelectorAll('span.content').length).toBe(1);
        expect(container.querySelector('span.content')!.textContent).toBe('on');
    });
});
