/**
 * Structural slot shapes on the server, and slot content across streaming
 * seams (#583).
 *
 * Pins the SSR strings for shapes the #476→#534→#575 run showed escaping
 * coverage — nested slot consumers, the #575 caller shape (a conditional
 * render-function PROP), fills returning null/empty, a component child
 * carrying slot= — and drives the two provenance-sensitive ones through a
 * full hydrate → update round trip. The streaming describe covers slot
 * content inside a <Defer> boundary: the $SIGX_REPLACE payload is parsed
 * via template.innerHTML on the client, so whatever a slot renders must
 * survive that seam intact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { component, signal, Defer, lazy, type Define, type JSXElement } from 'sigx';
import { renderToString, renderToStream } from '../src/server/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick,
} from './test-utils';

async function collectStream(stream: ReadableStream<string>): Promise<string> {
    const reader = stream.getReader();
    let out = '';
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        out += value;
    }
    return out;
}

/** Decode the HTML payload of the first $SIGX_REPLACE call in the stream. */
function extractFirstReplacement(html: string): string | null {
    const m = html.match(/\$SIGX_REPLACE\(\d+, ("(?:[^"\\]|\\.)*")\)/);
    return m ? JSON.parse(m[1]) : null;
}

const Wrap = component<Define.Slot<'default'>>((ctx) => {
    return () => <div class="wrap">{ctx.slots.default?.() ?? <span class="fb">fallback</span>}</div>;
}, { name: 'Wrap' });

describe('structural slot shapes (SSR strings + round trips)', () => {
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

    it('nested slots render inside out and hydrate without duplication', async () => {
        const Inner = component<Define.Slot<'default'>>((ctx) => {
            return () => <span class="inner">{ctx.slots.default?.() ?? 'inner-fb'}</span>;
        }, { name: 'InnerSSR' });

        const App = component(() => {
            const s = signal({ v: 'deep' });
            setters.nested = (v) => { s.v = v; };
            return () => (
                <Wrap>
                    <Inner>{s.v}</Inner>
                </Wrap>
            );
        }, { name: 'App_NestedSSR' });

        const ssrHtml = await renderToString(<App />);
        expect(ssrHtml).toContain('<span class="inner">deep</span>');

        container = createSSRContainer(ssrHtml);
        const inner = container.querySelector('span.inner')!;

        hydrate(<App />, container);
        await nextTick();

        setters.nested('deeper');
        await nextTick();

        expect(container.querySelectorAll('span.inner').length).toBe(1);
        expect(container.querySelector('span.inner')).toBe(inner);
        expect(inner.textContent).toBe('deeper');
    });

    it('#575 caller shape: a conditional render-function PROP hydrates without doubling', async () => {
        const Icon = component(() => {
            return () => <i class="ic" />;
        }, { name: 'IconSSR' });

        const Placeholder = component<{ title: string; action?: () => JSXElement }>((ctx) => {
            return () => (
                <div class="ph">
                    <h3>{ctx.props.title}</h3>
                    {ctx.props.action && <div class="act">{ctx.props.action()}</div>}
                </div>
            );
        }, { name: 'PlaceholderSSR' });

        const App = component(() => {
            const s = signal({ label: 'Starta arbete' });
            setters.label = (v) => { s.label = v; };
            return () => (
                <Placeholder
                    title="empty"
                    action={() => <button class="a"><Icon /> {s.label}</button>}
                />
            );
        }, { name: 'App_Issue575' });

        const ssrHtml = await renderToString(<App />);
        // The issue's exact symptom: no <!--t--> between the space and the
        // dynamic label meant hydration appended a second copy.
        expect(ssrHtml).toMatch(/ <!--t-->Starta arbete/);

        container = createSSRContainer(ssrHtml);
        const button = container.querySelector('button.a')!;

        hydrate(<App />, container);
        await nextTick();

        setters.label('Fortsätt');
        await nextTick();

        expect(container.querySelectorAll('button.a').length).toBe(1);
        expect(button.textContent).toBe(' Fortsätt');
        expect(button.querySelectorAll('i.ic').length).toBe(1);
    });

    it('a function child returning null renders the slot empty (pinned markup)', async () => {
        const html = await renderToString(<Wrap>{() => null as any}</Wrap>);
        // The dropped result leaves a present-but-empty slot: no fallback,
        // no artifacts inside the wrapper.
        expect(html).toContain('<div class="wrap"></div>');
        expect(html).not.toContain('fallback');
    });

    it('a function child returning an empty array renders the slot empty (pinned markup)', async () => {
        const html = await renderToString(<Wrap>{() => [] as any}</Wrap>);
        expect(html).toContain('<div class="wrap"></div>');
        expect(html).not.toContain('fallback');
    });

    it('a COMPONENT child with slot= does NOT fill the named slot on the server (#588)', async () => {
        const Chip = component<{ text: string }>((ctx) => {
            return () => <span class="chip">{ctx.props.text}</span>;
        }, { name: 'ChipSSR' });

        const Card = component<Define.Slot<'badge'> & Define.Slot<'default'>>((ctx) => {
            return () => (
                <div class="card">
                    <aside>{ctx.slots.badge?.() ?? 'no badge'}</aside>
                    <main>{ctx.slots.default?.() ?? 'body'}</main>
                </div>
            );
        }, { name: 'CardBadgeSSR' });

        // slot= on a component is rejected by the JSX types AND ignored by the
        // runtime (#588) — the shared `namedSlotFor` predicate keeps this in
        // lockstep with the client extractor, so hydration cannot mismatch.
        // The cast reproduces the only way a user could ever have written it.
        const ChipAny = Chip as any;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const html = await renderToString(
                <Card>
                    <ChipAny slot="badge" text="new" />
                </Card>
            );

            // The chip renders in the DEFAULT slot; the named slot stays
            // unfilled and shows its fallback — matching the client.
            expect(html).toContain('no badge');
            expect(html).toMatch(/<main[^>]*>.*<span class="chip">new<\/span>.*<\/main>/);
            expect(warn.mock.calls.some((c) =>
                String(c[0]).includes('slot="badge" on a component child (<ChipSSR>)')
            )).toBe(true);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('slot content across the streaming seam', () => {
    it('slot content inside a <Defer> boundary survives into the $SIGX_REPLACE payload', async () => {
        let resolveLoader!: () => void;
        const gate = new Promise<void>((r) => { resolveLoader = r; });
        const LazyLeaf = lazy(async () => {
            await gate;
            return component(() => {
                return () => <em class="leaf">loaded</em>;
            }, { name: 'Leaf' });
        });
        setTimeout(resolveLoader, 5);

        const streamed = await collectStream(renderToStream(
            <div class="host">
                <Defer fallback={<span class="spin">wait</span>}>
                    <Wrap>
                        <b class="s1">static</b> count: {5}{(LazyLeaf as any)({})}
                    </Wrap>
                </Defer>
            </div>
        ));

        // The fallback streamed in the placeholder…
        expect(streamed).toContain('<span class="spin">wait</span>');
        // …and the deferred payload carries the full slot content.
        const payload = extractFirstReplacement(streamed);
        expect(payload).toBeTruthy();
        expect(payload!).toContain('<div class="wrap">');
        expect(payload!).toContain('<b class="s1">static</b>');
        expect(payload!).toContain('<em class="leaf">loaded</em>');
        // The adjacent texts inside the slot (' count: ' and '5') kept their
        // boundary marker inside the payload — template.innerHTML merges
        // adjacent text exactly like the main document parse.
        expect(payload!).toContain('count: <!--t-->5');
    });
});
