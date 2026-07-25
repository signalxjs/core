/**
 * Streamed hydration over REAL streamed output, at the shape a router app has
 * (#492, follow-up to #478).
 *
 * The #478 regression cases hand-build the post-replace DOM with streamed
 * content that contains no nested `<!--$c:M-->` markers, and a one-level
 * chain. Real `renderVNodeToString` emits a marker for every component inside
 * the streamed subtree, and a real app stacks several pass-through ancestors
 * (`App → RouterView → lazy() → Page`) whose content IS the placeholder
 * wrapper. That combination is what Pulse hit (signalxjs/pulse#59, F15), and
 * it is the one shape the hand-built tests cannot express.
 *
 * Everything here goes through `createSSR().renderStream()` and replays the
 * stream the way a browser would, so the DOM under test is the server's.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, useData } from 'sigx';
import { createSSR, stateSerializationPlugin } from '../src/index';
import { hydrate } from '../src/client/hydrate-core';
import { cleanupPendingHydrations, invalidateMarkerIndex } from '../src/client/scheduler';
import { clearClientPlugins } from '../src/client/hydrate-context';
import { createSSRContainer, cleanupContainer, nextTick } from './test-utils';

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

/** Split streamed output into the shell (before the first script) and scripts. */
function splitShell(html: string): { shell: string; scripts: string } {
    const idx = html.indexOf('\n<script>');
    const i = idx >= 0 ? idx : html.indexOf('<script>');
    return { shell: html.slice(0, i), scripts: html.slice(i) };
}

/** Do what the browser would: install state blobs and apply $SIGX_REPLACE swaps. */
function executeStreamScripts(container: HTMLElement, scripts: string): void {
    for (const m of scripts.matchAll(/window\.__SIGX_ASYNC__=Object\.assign\(Object\.create\(null\),window\.__SIGX_ASYNC__,(\{.*?\})\);/g)) {
        const blob = JSON.parse(m[1]);
        (globalThis as any).__SIGX_ASYNC__ = Object.assign((globalThis as any).__SIGX_ASYNC__ || {}, blob);
    }
    for (const m of scripts.matchAll(/\$SIGX_REPLACE\((\d+), ("(?:[^"\\]|\\.)*")\)/g)) {
        const placeholder = container.querySelector(`[data-async-placeholder="${m[1]}"]`);
        if (placeholder) placeholder.innerHTML = JSON.parse(m[2]);
    }
}

function makeAppContext(): any {
    return { provides: new Map<symbol, unknown>() };
}

/** Every `<!--$c:N-->` in `root`, in document order, as its numeric id. */
function markerIds(root: Node): number[] {
    const out: number[] = [];
    const walk = (n: Node) => {
        for (let c = n.firstChild; c; c = c.nextSibling) {
            if (c.nodeType === Node.COMMENT_NODE && (c as Comment).data.startsWith('$c:')) {
                out.push(Number((c as Comment).data.slice(3)));
            }
            walk(c);
        }
    };
    walk(root);
    return out;
}

/**
 * The `App → RouterView → Page` chain, where `Page` is the streamed component
 * and its render puts a CHILD COMPONENT at the top level of the streamed
 * region — so the child's marker lands as a direct child of the placeholder
 * wrapper, in the sibling range every ancestor scans.
 */
function makeRouterApp(load: () => Promise<{ n: number }>) {
    const Card = component(() => () => <div class="card">card</div>, { name: 'Card' });
    const Page = component(() => {
        const data = useData('page-data', load);
        return () => (
            <>
                <Card />
                <footer class="f">{data.value ? `n: ${(data.value as any).n}` : 'loading…'}</footer>
            </>
        );
    }, { name: 'Page' });
    const RouterView = component(() => () => <Page />, { name: 'RouterView' });
    const App = component(() => () => <RouterView />, { name: 'App' });
    return { App, RouterView, Page, Card };
}

/** Walk the hydrated vnode tree, collecting each component vnode by name. */
function componentVNodes(rootVNode: any): Map<string, any> {
    const found = new Map<string, any>();
    const visit = (v: any) => {
        if (!v || typeof v !== 'object') return;
        const name = typeof v.type === 'function' ? (v.type as any).__name : null;
        if (name && !found.has(name)) found.set(name, v);
        const sub = v._subTreeRef?.current ?? v._subTree;
        if (sub) visit(sub);
        if (Array.isArray(v.children)) v.children.forEach(visit);
    };
    visit(rootVNode);
    return found;
}

describe('streamed hydration at the router shape (#492)', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        if (container) cleanupContainer(container);
        delete (globalThis as any).__SIGX_ASYNC__;
        delete (window as any).__SIGX_BOUNDARIES__;
        clearClientPlugins();
        cleanupPendingHydrations();
        invalidateMarkerIndex();
        vi.restoreAllMocks();
    });

    /**
     * Every pass-through ancestor hydrates INSIDE the wrapper, where the only
     * markers in its sibling range belong to the streamed subtree's own
     * children. Latching one of those makes a component's `dom` point into the
     * middle of its own subtree.
     */
    it('no ancestor claims a DESCENDANT marker as its anchor', async () => {
        const { App: ServerApp } = makeRouterApp(
            () => new Promise(r => setTimeout(() => r({ n: 42 }), 5))
        );
        const ssr = createSSR({ plugins: [stateSerializationPlugin()] });
        const html = await collectStream(ssr.renderStream((ServerApp as any)({})));

        const { shell, scripts } = splitShell(html);
        container = createSSRContainer(shell);
        executeStreamScripts(container, scripts);

        const wrapper = container.querySelector('[data-async-placeholder]')!;
        // The premise: the streamed region really does carry nested markers.
        expect(wrapper).not.toBeNull();
        expect(markerIds(wrapper).length).toBeGreaterThan(0);

        const clientLoad = vi.fn(async () => ({ n: 42 }));
        const { App: ClientApp } = makeRouterApp(clientLoad);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        hydrate((ClientApp as any)({}), container, makeAppContext());
        await nextTick();
        warn.mockRestore();

        const vnodes = componentVNodes((container as any)._vnode);
        const descendantMarkers = new Set(markerIds(wrapper));

        for (const name of ['App', 'RouterView', 'Page']) {
            const v = vnodes.get(name);
            expect(v, `${name} vnode`).toBeTruthy();
            expect(v.dom, `${name}.dom`).not.toBeNull();
            const isMarker =
                v.dom.nodeType === Node.COMMENT_NODE && String(v.dom.data).startsWith('$c:');
            const id = isMarker ? Number(String(v.dom.data).slice(3)) : null;
            expect(
                id !== null && descendantMarkers.has(id),
                `${name}.dom is <!--$c:${id}-->, a marker belonging to its own subtree`
            ).toBe(false);
        }

        // Every component's anchor must be distinct — two components sharing
        // one anchor means at least one of them has the wrong range.
        const doms = ['App', 'RouterView', 'Page'].map(n => vnodes.get(n)?.dom);
        expect(new Set(doms).size).toBe(doms.length);
    });

    /** Content SSR rendered after the streamed child must not be duplicated. */
    it('a sibling after the streamed region is hydrated, not re-mounted', async () => {
        const load = () => new Promise<{ n: number }>(r => setTimeout(() => r({ n: 7 }), 5));
        const makeApp = (l: () => Promise<{ n: number }>) => {
            const Streamed = component(() => {
                const data = useData('sib-data', l);
                return () => <div class="s">{data.value ? `n: ${(data.value as any).n}` : '…'}</div>;
            }, { name: 'Streamed' });
            return component(() => () => (
                <>
                    <Streamed />
                    <footer class="tail">tail</footer>
                </>
            ), { name: 'Shell' });
        };

        const ssr = createSSR({ plugins: [stateSerializationPlugin()] });
        const html = await collectStream(ssr.renderStream((makeApp(load) as any)({})));
        const { shell, scripts } = splitShell(html);
        container = createSSRContainer(shell);
        executeStreamScripts(container, scripts);
        expect(container.querySelectorAll('.tail').length).toBe(1);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        hydrate((makeApp(async () => ({ n: 7 })) as any)({}), container, makeAppContext());
        await nextTick();
        warn.mockRestore();

        expect(container.querySelectorAll('.tail').length).toBe(1);
        expect(container.querySelectorAll('.s').length).toBe(1);
    });

    /**
     * The wrapper survives an unmount by design (it is not part of the vnode
     * tree). What must NOT happen is the next route mounting INSIDE it:
     * `display: contents` hides it from layout but not from `#app > div`
     * selectors, so a page re-parented into a dead placeholder is a real
     * styling bug that no marker oracle can see.
     */
    it('a replaced route mounts in the container, not inside the dead wrapper', async () => {
        const load = () => new Promise<{ n: number }>(r => setTimeout(() => r({ n: 1 }), 5));
        const makeApp = (l: () => Promise<{ n: number }>) => {
            const Streamed = component(() => {
                const data = useData('route-data', l);
                return () => <div class="s">{data.value ? 'streamed' : '…'}</div>;
            }, { name: 'Streamed' });
            const Other = component(() => () => <p class="o">other</p>, { name: 'Other' });
            const view = signal<'streamed' | 'other'>('streamed');
            const Shell = component(
                () => () => (view.value === 'streamed' ? <Streamed /> : <Other />),
                { name: 'Shell' }
            );
            return { Shell, view };
        };

        const ssr = createSSR({ plugins: [stateSerializationPlugin()] });
        const html = await collectStream(ssr.renderStream((makeApp(load).Shell as any)({})));
        const { shell, scripts } = splitShell(html);
        container = createSSRContainer(shell);
        executeStreamScripts(container, scripts);

        const { Shell, view } = makeApp(async () => ({ n: 1 }));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        hydrate((Shell as any)({}), container, makeAppContext());
        await nextTick();
        warn.mockRestore();

        view.value = 'other';
        await nextTick();

        expect(container.querySelectorAll('.o').length).toBe(1);
        expect(container.querySelector('.s')).toBeNull();
        // The replacement is a child of the container itself.
        expect(container.querySelector('.o')!.parentNode).toBe(container);
        // …and nothing is left living inside the placeholder.
        expect(container.querySelectorAll('[data-async-placeholder] *').length).toBe(0);
    });

    /**
     * Nested streamed regions: the inner placeholder arrives INSIDE the outer
     * one's replaced HTML, so the ownership test has to hold one level down
     * too — the inner streamed component adopts the inner wrapper, and the
     * outer one does not.
     */
    it('nested streamed regions each anchor on their own wrapper', async () => {
        const makeApp = (
            outer: () => Promise<{ n: number }>,
            inner: () => Promise<{ n: number }>
        ) => {
            const Inner = component(() => {
                const data = useData('inner-data', inner);
                return () => <span class="inner">{data.value ? 'inner' : '…'}</span>;
            }, { name: 'Inner' });
            const Outer = component(() => {
                const data = useData('outer-data', outer);
                return () => (
                    <div class="outer">
                        {data.value ? 'outer' : '…'}
                        <Inner />
                    </div>
                );
            }, { name: 'Outer' });
            return component(() => () => <Outer />, { name: 'Shell' });
        };

        const slow = (n: number, ms: number) =>
            () => new Promise<{ n: number }>(r => setTimeout(() => r({ n }), ms));
        const ssr = createSSR({ plugins: [stateSerializationPlugin()] });
        const html = await collectStream(
            ssr.renderStream((makeApp(slow(1, 5), slow(2, 10)) as any)({}))
        );
        const { shell, scripts } = splitShell(html);
        container = createSSRContainer(shell);
        executeStreamScripts(container, scripts);
        expect(container.querySelectorAll('.inner').length).toBe(1);

        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        hydrate(
            (makeApp(async () => ({ n: 1 }), async () => ({ n: 2 })) as any)({}),
            container,
            makeAppContext()
        );
        await nextTick();
        warn.mockRestore();

        expect(container.querySelectorAll('.outer').length).toBe(1);
        expect(container.querySelectorAll('.inner').length).toBe(1);

        const vnodes = componentVNodes((container as any)._vnode);
        for (const name of ['Shell', 'Outer', 'Inner']) {
            expect(vnodes.get(name)?.dom, `${name}.dom`).toBeTruthy();
        }
        const doms = ['Shell', 'Outer', 'Inner'].map(n => vnodes.get(n)!.dom);
        expect(new Set(doms).size).toBe(3);
    });
});
