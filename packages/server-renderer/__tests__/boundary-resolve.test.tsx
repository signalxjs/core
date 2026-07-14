/**
 * The resolveBoundary seam (rfc-ssr-platform §1.3) — pre-setup consult
 * position, first-plugin-wins precedence, the flush: 'skip' path's wire
 * bytes and hook contract, and the flush axis interacting with async setup
 * work (the truth table replacing handleAsyncSetup).
 */

import { describe, it, expect, vi } from 'vitest';
import { component, useData } from 'sigx';
import { createSSR } from '../src/index';
import type { SSRPlugin } from '../src/plugin';
import type { ResolvedBoundary } from '../src/boundary';

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

function boundaryPlugin(name: string, resolve: (vnode: any) => ResolvedBoundary | undefined): SSRPlugin {
    return { name, server: { resolveBoundary: (vnode) => resolve(vnode) } };
}

function makeAsyncComponent(key: string, name = 'Async') {
    const Async = component(() => {
        const data = useData(key, async () => {
            await new Promise(r => setTimeout(r, 5));
            return { n: 42 };
        });
        return () => <div class="async">{data.value ? (data.value as any).n : 'loading'}</div>;
    }, { name });
    return Async;
}

describe('resolveBoundary — consult position and precedence', () => {
    it('runs before setup; flush:"skip" means setup never runs', async () => {
        const setupSpy = vi.fn();
        const Island = component(() => {
            setupSpy();
            return () => <div>never on the server</div>;
        }, { name: 'Island' });

        const ssr = createSSR().use(boundaryPlugin('skip-all', () => ({ flush: 'skip' })));
        const html = await ssr.render((Island as any)({}));
        expect(setupSpy).not.toHaveBeenCalled();
        expect(html).not.toContain('never on the server');
    });

    it('first plugin to return wins', async () => {
        const Comp = component(() => () => <span>x</span>, { name: 'C' });
        const second = vi.fn(() => ({ hydrate: 'idle' }) as ResolvedBoundary);
        const ssr = createSSR()
            .use(boundaryPlugin('first', () => ({ hydrate: 'visible' })))
            .use({ name: 'second', server: { resolveBoundary: second } });
        const html = await ssr.render((Comp as any)({}));
        expect(html).toContain('"hydrate":"visible"');
        expect(html).not.toContain('"hydrate":"idle"');
        // Loop breaks on first win — later plugins are not consulted
        expect(second).not.toHaveBeenCalled();
    });

    it('the hook reads its own id at the stack top', async () => {
        const seen: number[] = [];
        const Inner = component(() => () => <i>inner</i>, { name: 'Inner' });
        const Outer = component(() => () => <div>{(Inner as any)({})}</div>, { name: 'Outer' });
        const probe: SSRPlugin = {
            name: 'probe',
            server: {
                resolveBoundary(_vnode, ctx) {
                    seen.push(ctx._componentStack[ctx._componentStack.length - 1]);
                    return undefined;
                }
            }
        };
        await createSSR().use(probe).render((Outer as any)({}));
        // Outer = 1, Inner = 2 — each consult sees its own freshly-pushed id
        expect(seen).toEqual([1, 2]);
    });

    it('no plugin return → no record, no table, unchanged render', async () => {
        const Comp = component(() => () => <span>plain</span>, { name: 'C' });
        const ssr = createSSR().use(boundaryPlugin('quiet', () => undefined));
        const html = await ssr.render((Comp as any)({}));
        expect(html).toBe('<span>plain</span><!--$c:1-->');
    });
});

describe('flush: "skip" — wire bytes and hook contract', () => {
    it('emits the wrapper, no content, and the trailing marker', async () => {
        const Island = component(() => () => <div>content</div>, { name: 'Island' });
        const ssr = createSSR().use(boundaryPlugin('skip', () => ({ flush: 'skip', hydrate: 'load' })));
        const html = await ssr.render((Island as any)({}));
        expect(html).toContain('<div data-boundary="1" style="display:contents;"></div><!--$c:1-->');
        expect(html).toContain('"1":{"flush":"skip","hydrate":"load","component":"Island"}');
    });

    it('renders the fallback thunk inside the wrapper', async () => {
        const Island = component(() => () => <div>content</div>, { name: 'Island' });
        const ssr = createSSR().use(boundaryPlugin('skip', () => ({
            flush: 'skip',
            fallback: () => <p class="ph">loading widget</p>
        })));
        const html = await ssr.render((Island as any)({}));
        expect(html).toContain(
            '<div data-boundary="1" style="display:contents;"><p class="ph">loading widget</p></div><!--$c:1-->'
        );
    });

    it('a throwing fallback routes through the component error path', async () => {
        const Island = component(() => () => <div>content</div>, { name: 'Island' });
        const boom = () => { throw new Error('fallback boom'); };
        const ssr = createSSR().use(boundaryPlugin('skip', () => ({ flush: 'skip', fallback: boom as any })));
        const html = await ssr.render((Island as any)({}));
        expect(html).toContain('<!--ssr-error:1-->');
        expect(html).toContain('</div><!--$c:1-->');
    });

    it('does not call transformComponentContext or afterRenderComponent', async () => {
        const transform = vi.fn();
        const after = vi.fn();
        const Island = component(() => () => <div>x</div>, { name: 'Island' });
        const plugin: SSRPlugin = {
            name: 'spy',
            server: {
                resolveBoundary: () => ({ flush: 'skip' }),
                transformComponentContext: (_c, _v, componentCtx) => { transform(); return componentCtx; },
                afterRenderComponent: () => { after(); }
            }
        };
        await createSSR().use(plugin).render((Island as any)({}));
        expect(transform).not.toHaveBeenCalled();
        expect(after).not.toHaveBeenCalled();
    });

    it('core derives the props snapshot when the plugin omits props', async () => {
        const Island = component(() => () => <div>x</div>, { name: 'Island' });
        const ssr = createSSR().use(boundaryPlugin('skip', () => ({ flush: 'skip' })));
        const html = await ssr.render((Island as any)({ start: 5, onClick: () => {} }));
        expect(html).toContain('"props":{"start":5}');
        expect(html).not.toContain('onClick');
    });

    it('a plugin-supplied props snapshot wins over the core derivation', async () => {
        const Island = component(() => () => <div>x</div>, { name: 'Island' });
        const ssr = createSSR().use(boundaryPlugin('skip', () => ({ flush: 'skip', props: { only: 1 } })));
        const html = await ssr.render((Island as any)({ start: 5 }));
        expect(html).toContain('"props":{"only":1}');
        expect(html).not.toContain('"start":5');
    });
});

describe('flush axis × async setup work — the truth table', () => {
    it('flush:"inline" blocks a streaming async component in place', async () => {
        const Async = makeAsyncComponent('inline-under-stream');
        const ssr = createSSR().use(boundaryPlugin('inline', () => ({ flush: 'inline' })));
        const out = await collectStream(ssr.renderStream((Async as any)({})) as ReadableStream<string>);
        expect(out).toContain('>42<');
        expect(out).not.toContain('data-async-placeholder');
        expect(out).not.toContain('$SIGX_REPLACE(');
    });

    it('flush:"stream" in string mode degrades to block', async () => {
        const Async = makeAsyncComponent('stream-under-string');
        const ssr = createSSR().use(boundaryPlugin('stream', () => ({ flush: 'stream' })));
        const html = await ssr.render((Async as any)({}));
        expect(html).toContain('>42<');
        expect(html).not.toContain('data-async-placeholder');
    });

    it('flush:"stream" with no async work renders inline (nothing to defer)', async () => {
        const Sync = component(() => () => <div class="sync">ok</div>, { name: 'Sync' });
        const ssr = createSSR().use(boundaryPlugin('stream', () => ({ flush: 'stream' })));
        const out = await collectStream(ssr.renderStream((Sync as any)({})) as ReadableStream<string>);
        expect(out).toContain('<div class="sync">ok</div>');
        expect(out).not.toContain('data-async-placeholder');
        expect(out).not.toContain('$SIGX_REPLACE(');
    });

    it('flush:"stream" streams an async component with a boundary fallback in place of the initial pass', async () => {
        const Async = makeAsyncComponent('stream-fallback');
        const ssr = createSSR().use(boundaryPlugin('stream', () => ({
            flush: 'stream',
            fallback: () => <p class="wait">waiting</p>
        })));
        const out = await collectStream(ssr.renderStream((Async as any)({})) as ReadableStream<string>);
        // Fallback inside the placeholder, not the component's pre-data render
        expect(out).toContain('style="display:contents;"><p class="wait">waiting</p></div>');
        expect(out).not.toContain('>loading<');
        // Replacement still arrives with resolved data
        expect(out).toContain('$SIGX_REPLACE(');
        expect(out).toContain('42');
    });

    it('no boundary → default streaming behavior byte-compatible with before', async () => {
        const Async = makeAsyncComponent('default-stream');
        const ssr = createSSR();
        const out = await collectStream(ssr.renderStream((Async as any)({})) as ReadableStream<string>);
        expect(out).toContain(`<div data-async-placeholder="1" style="display:contents;">`);
        expect(out).toContain('>loading<');
        expect(out).toContain('$SIGX_REPLACE(1,');
        expect(out).not.toContain('__SIGX_BOUNDARIES__');
    });

    it('a keyed useData rejection under flush:"inline" renders the settled error state in place', async () => {
        const Failing = component(() => {
            const data = useData('inline-reject', async () => {
                await new Promise(r => setTimeout(r, 5));
                throw new Error('load failed');
            });
            return () => <div class="state">{data.state}</div>;
        }, { name: 'Failing' });
        const ssr = createSSR().use(boundaryPlugin('inline', () => ({ flush: 'inline' })));
        const out = await collectStream(ssr.renderStream((Failing as any)({})) as ReadableStream<string>);
        // Value-first async: the rejection is a value (match's error arm),
        // rendered inline because the boundary blocked — no streamed replacement.
        expect(out).toContain('<div class="state">errored</div>');
        expect(out).not.toContain('$SIGX_REPLACE(');
        expect(out).not.toContain('data-async-placeholder');
    });
});
