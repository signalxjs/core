/**
 * SSR → hydrate → update round-trips for every slot provision form (#583).
 *
 * Slot RENDERING has SSR string coverage and slot REACTIVITY has client-only
 * coverage, but nothing hydrated a slot-rendering component before this file:
 * the walk that adopts SSR DOM runs against the callee's re-invocation of the
 * slot accessor, which is exactly where provenance bugs (#476/#534/#575) live.
 * Every test asserts node identity across hydration and no duplication after
 * a signal update — the two failure shapes slot hydration bugs produce.
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

/** Default-slot wrapper with a fallback (presence semantics, #123). */
const Wrap = component<Define.Slot<'default'>>((ctx) => {
    return () => (
        <div class="wrap">{ctx.slots.default?.() ?? <span class="fb">fallback</span>}</div>
    );
}, { name: 'Wrap' });

/** Named-slot consumer (slot= child form and slots-prop form fill it). */
const Titled = component<Define.Slot<'header'>>((ctx) => {
    return () => (
        <div class="titled">
            <header>{ctx.slots.header?.() ?? 'no title'}</header>
            <main>body</main>
        </div>
    );
}, { name: 'Titled' });

describe('hydration of slot content', () => {
    let container: HTMLDivElement;
    const setters: Record<string, (v: any) => void> = {};

    beforeEach(() => {
        cleanupScripts();
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
    });

    it('default slot with element children: content adopts and updates in place', async () => {
        const App = component(() => {
            const s = signal({ v: 'one' });
            setters.def = (v) => { s.v = v; };
            return () => <Wrap><span class="content">{s.v}</span></Wrap>;
        }, { name: 'App_DefaultSlot' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('<span class="content">one</span>');
        expect(ssrHtml).not.toContain('fallback');

        container = createSSRContainer(ssrHtml);
        const original = container.querySelector('span.content')!;

        hydrate(<App />, container);
        await nextTick();

        setters.def('two');
        await nextTick();

        const spans = container.querySelectorAll('span.content');
        expect(spans.length).toBe(1);
        expect(spans[0]).toBe(original);
        expect(original.textContent).toBe('two');
        expect(container.querySelector('span.fb')).toBeNull();
    });

    it('named slot via a slot= child: content adopts and updates in place', async () => {
        const App = component(() => {
            const s = signal({ t: 'Title' });
            setters.named = (v) => { s.t = v; };
            return () => (
                <Titled>
                    <h1 slot="header" class="h">{s.t}</h1>
                </Titled>
            );
        }, { name: 'App_NamedChild' });

        const ssrHtml = await renderToString(<App />);
        // The slot= attribute reaches the DOM on BOTH sides (client sets it
        // too) — parity holds, so hydration adopts cleanly.
        expect(ssrHtml).toContain('<h1 slot="header" class="h">Title</h1>');
        expect(ssrHtml).not.toContain('no title');

        container = createSSRContainer(ssrHtml);
        const original = container.querySelector('h1.h')!;

        hydrate(<App />, container);
        await nextTick();

        setters.named('Renamed');
        await nextTick();

        expect(container.querySelectorAll('h1.h').length).toBe(1);
        expect(container.querySelector('h1.h')).toBe(original);
        expect(original.textContent).toBe('Renamed');
        expect(container.querySelector('main')!.textContent).toBe('body');
    });

    it('named slot via the slots prop: content adopts and updates in place', async () => {
        const App = component(() => {
            const s = signal({ t: 'Prop title' });
            setters.propNamed = (v) => { s.t = v; };
            return () => <Titled slots={{ header: () => <h1 class="hp">{s.t}</h1> }} />;
        }, { name: 'App_NamedProp' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('<h1 class="hp">Prop title</h1>');

        container = createSSRContainer(ssrHtml);
        const original = container.querySelector('h1.hp')!;

        hydrate(<App />, container);
        await nextTick();

        setters.propNamed('Swapped');
        await nextTick();

        expect(container.querySelectorAll('h1.hp').length).toBe(1);
        expect(container.querySelector('h1.hp')).toBe(original);
        expect(original.textContent).toBe('Swapped');
    });

    it('render-function child with scoped props: fill re-invokes against adopted DOM', async () => {
        const Scoped = component<Define.Slot<'default', { label: string }>>((ctx) => {
            const s = signal({ label: 'first' });
            setters.scoped = (v) => { s.label = v; };
            return () => <div class="scoped">{ctx.slots.default?.({ label: s.label })}</div>;
        }, { name: 'Scoped' });

        const App = component(() => {
            return () => <Scoped>{(p) => <em class="e">{p.label}</em>}</Scoped>;
        }, { name: 'App_ScopedFn' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('<em class="e">first</em>');

        container = createSSRContainer(ssrHtml);
        const original = container.querySelector('em.e')!;

        hydrate(<App />, container);
        await nextTick();

        setters.scoped('second');
        await nextTick();

        expect(container.querySelectorAll('em.e').length).toBe(1);
        expect(container.querySelector('em.e')).toBe(original);
        expect(original.textContent).toBe('second');
    });

    it('a fill returning an ARRAY: every item adopts and updates in place (#537 shape)', async () => {
        const App = component(() => {
            const s = signal({ v: 'dyn' });
            setters.arr = (v) => { s.v = v; };
            return () => (
                <Wrap slots={{ default: () => [
                    <b class="b1">stat</b>,
                    <b class="b2">{s.v}</b>,
                ] }} />
            );
        }, { name: 'App_ArrayFill' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('<b class="b1">stat</b><b class="b2">dyn</b>');

        container = createSSRContainer(ssrHtml);
        const b1 = container.querySelector('b.b1')!;
        const b2 = container.querySelector('b.b2')!;

        hydrate(<App />, container);
        await nextTick();

        setters.arr('DYN');
        await nextTick();

        expect(container.querySelectorAll('b').length).toBe(2);
        expect(container.querySelector('b.b1')).toBe(b1);
        expect(container.querySelector('b.b2')).toBe(b2);
        expect(b2.textContent).toBe('DYN');
        expect(b1.textContent).toBe('stat');
    });

    it('a fill returning a SINGLE vnode behaves like the one-item array (server/client parity)', async () => {
        const App = component(() => {
            const s = signal({ v: 'solo' });
            setters.single = (v) => { s.v = v; };
            return () => <Wrap slots={{ default: () => <i class="solo">{s.v}</i> }} />;
        }, { name: 'App_SingleFill' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('<i class="solo">solo</i>');

        container = createSSRContainer(ssrHtml);
        const original = container.querySelector('i.solo')!;

        hydrate(<App />, container);
        await nextTick();

        setters.single('SOLO');
        await nextTick();

        expect(container.querySelectorAll('i.solo').length).toBe(1);
        expect(container.querySelector('i.solo')).toBe(original);
        expect(original.textContent).toBe('SOLO');
    });

    it('presence flip after hydration: fallback → content → fallback', async () => {
        // NOTE: the flip uses the children-present-but-null form. The fully
        // ABSENT form (`cond ? <Wrap>x</Wrap> : <Wrap />`) leaves stale slot
        // content on patch — client and hydration alike — tracked as #586.
        const App = component(() => {
            const s = signal({ show: false });
            setters.flip = (v) => { s.show = v; };
            return () => <Wrap>{s.show ? <span class="content">on</span> : null}</Wrap>;
        }, { name: 'App_PresenceFlip' });

        // SSR renders the ABSENT-slot branch: the fallback.
        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('<span class="fb">fallback</span>');
        expect(ssrHtml).not.toContain('class="content"');

        container = createSSRContainer(ssrHtml);
        const fb = container.querySelector('span.fb')!;

        hydrate(<App />, container);
        await nextTick();
        // The hydrated fallback is the SSR node.
        expect(container.querySelector('span.fb')).toBe(fb);

        setters.flip(true);
        await nextTick();
        expect(container.querySelector('span.fb')).toBeNull();
        expect(container.querySelectorAll('span.content').length).toBe(1);
        expect(container.querySelector('span.content')!.textContent).toBe('on');

        setters.flip(false);
        await nextTick();
        expect(container.querySelector('span.content')).toBeNull();
        expect(container.querySelectorAll('span.fb').length).toBe(1);
    });
});
