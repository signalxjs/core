/**
 * Structural slot shapes in the client renderer (#583).
 *
 * The shapes here are the ones the #476→#534→#575 run showed escaping
 * coverage: content that reaches a slot through one more level than the
 * simple cases — nested slot consumers, render-function props invoked
 * conditionally, several function children side by side, and a component
 * child carrying a slot= prop.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { component, signal, type Define, type JSXElement } from 'sigx';
import { render } from '../src/index';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('structural slot shapes (client)', () => {
    let container: HTMLDivElement;
    const setters: Record<string, (v: any) => void> = {};

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        container.remove();
    });

    it('nested slots: a fill that renders a component with its own slot', async () => {
        const Inner = component<Define.Slot<'default'>>((ctx) => {
            return () => <span class="inner">{ctx.slots.default?.() ?? 'inner-fb'}</span>;
        }, { name: 'Inner' });

        const Outer = component<Define.Slot<'default'>>((ctx) => {
            return () => <div class="outer">{ctx.slots.default?.() ?? 'outer-fb'}</div>;
        }, { name: 'Outer' });

        const App = component(() => {
            const s = signal({ v: 'deep' });
            setters.nested = (v) => { s.v = v; };
            return () => (
                <Outer>
                    <Inner>{s.v}</Inner>
                </Outer>
            );
        }, { name: 'App_Nested' });

        render(<App />, container);
        await tick();

        expect(container.querySelector('div.outer span.inner')!.textContent).toBe('deep');

        setters.nested('deeper');
        await tick();

        expect(container.querySelectorAll('span.inner').length).toBe(1);
        expect(container.querySelector('span.inner')!.textContent).toBe('deeper');
    });

    it('conditionally invoked render-function prop: appears, updates, disappears (#575 caller shape)', async () => {
        // The EmptyStatePlaceholder pattern from #575: an optional
        // render-function PROP (not children) invoked inside a conditional.
        const Placeholder = component<{ title: string; action?: () => JSXElement }>((ctx) => {
            return () => (
                <div class="ph">
                    <h3>{ctx.props.title}</h3>
                    {ctx.props.action && <div class="act">{ctx.props.action()}</div>}
                </div>
            );
        }, { name: 'Placeholder' });

        const App = component(() => {
            const s = signal({ label: 'go', withAction: true });
            setters.actLabel = (v) => { s.label = v; };
            setters.actOn = (v) => { s.withAction = v; };
            return () =>
                s.withAction
                    ? <Placeholder title="empty" action={() => <button class="a">{s.label}</button>} />
                    : <Placeholder title="empty" />;
        }, { name: 'App_CondAction' });

        render(<App />, container);
        await tick();
        expect(container.querySelector('div.act button.a')!.textContent).toBe('go');

        setters.actLabel('go now');
        await tick();
        expect(container.querySelectorAll('button.a').length).toBe(1);
        expect(container.querySelector('button.a')!.textContent).toBe('go now');

        setters.actOn(false);
        await tick();
        expect(container.querySelector('div.act')).toBeNull();
        expect(container.querySelector('h3')!.textContent).toBe('empty');
    });

    it('mixed static and dynamic children in one slot keep order across updates', async () => {
        const Wrap = component<Define.Slot<'default'>>((ctx) => {
            return () => <p class="w">{ctx.slots.default?.()}</p>;
        }, { name: 'Wrap' });

        const App = component(() => {
            const s = signal({ n: 1 });
            setters.mixed = (v) => { s.n = v; };
            return () => (
                <Wrap>
                    <b class="lead">lead</b>
                    mid: {s.n}
                    <i class="tail">tail</i>
                </Wrap>
            );
        }, { name: 'App_Mixed' });

        render(<App />, container);
        await tick();
        expect(container.querySelector('p.w')!.textContent).toBe('leadmid: 1tail');

        setters.mixed(2);
        await tick();
        expect(container.querySelector('p.w')!.textContent).toBe('leadmid: 2tail');
        // Order held: element, texts, element.
        const p = container.querySelector('p.w')!;
        expect(p.firstElementChild!.className).toBe('lead');
        expect(p.lastElementChild!.className).toBe('tail');
    });

    it('multiple function children in one default slot are each invoked in order', async () => {
        const Scoped = component<Define.Slot<'default', { tag: string }>>((ctx) => {
            const s = signal({ tag: 'x' });
            setters.multiTag = (v) => { s.tag = v; };
            return () => <div class="multi">{ctx.slots.default?.({ tag: s.tag })}</div>;
        }, { name: 'ScopedMulti' });

        const App = component(() => {
            return () => (
                <Scoped>
                    {(p) => <em class="f1">{`1-${p.tag}`}</em>}
                    {(p) => <em class="f2">{`2-${p.tag}`}</em>}
                </Scoped>
            );
        }, { name: 'App_MultiFn' });

        render(<App />, container);
        await tick();

        const ems = container.querySelectorAll('em');
        expect(ems.length).toBe(2);
        expect(ems[0].className).toBe('f1');
        expect(ems[0].textContent).toBe('1-x');
        expect(ems[1].className).toBe('f2');
        expect(ems[1].textContent).toBe('2-x');

        setters.multiTag('y');
        await tick();
        expect(container.querySelector('em.f1')!.textContent).toBe('1-y');
        expect(container.querySelector('em.f2')!.textContent).toBe('2-y');
        expect(container.querySelectorAll('em').length).toBe(2);
    });

    it('a COMPONENT child with a slot= prop does NOT fill the named slot (#588)', async () => {
        const Chip = component<{ text: string }>((ctx) => {
            return () => <span class="chip">{ctx.props.text}</span>;
        }, { name: 'Chip' });

        const Card = component<Define.Slot<'badge'> & Define.Slot<'default'>>((ctx) => {
            return () => (
                <div class="card">
                    <aside>{ctx.slots.badge?.() ?? 'no badge'}</aside>
                    <main>{ctx.slots.default?.() ?? 'body'}</main>
                </div>
            );
        }, { name: 'CardBadge' });

        // slot= on a component is rejected by the JSX types AND ignored by the
        // runtime (#588: routing was accidental — the extractor matched any
        // object vnode — and never typeable). The cast reproduces the only way
        // a user could ever have written it.
        const ChipAny = Chip as any;
        const App = component(() => {
            return () => (
                <Card>
                    <ChipAny slot="badge" text="new" />
                </Card>
            );
        }, { name: 'App_ComponentSlotChild' });

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            render(<App />, container);
            await tick();

            // The chip lands in the DEFAULT slot; the named slot stays
            // unfilled and shows its fallback.
            expect(container.querySelector('main span.chip')!.textContent).toBe('new');
            expect(container.querySelector('aside')!.textContent).toBe('no badge');
            // The dev warning names the slot and points at the typed form.
            expect(warn.mock.calls.some((c) =>
                String(c[0]).includes('slot="badge" on a component child (<Chip>)')
            )).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });
});
