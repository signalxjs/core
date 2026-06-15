/**
 * Plugin-hook coverage for client/hydrate-core.ts
 *
 * Targets the beforeHydrate / afterHydrate / hydrateComponent client plugin
 * paths that hydrate.test.tsx doesn't cover.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { hydrate } from '../src/client/hydrate-core';
import {
    registerClientPlugin,
    clearClientPlugins
} from '../src/client/hydrate-context';
import type { SSRPlugin } from '../src/plugin';
import {
    createSSRContainer,
    cleanupContainer,
    TestCounter,
    nextTick
} from './test-utils';

beforeEach(() => {
    clearClientPlugins();
});

afterEach(() => {
    clearClientPlugins();
});

describe('hydrate() — plugin hooks', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        if (container) cleanupContainer(container);
    });

    it('skips the DOM walk when beforeHydrate returns false', () => {
        const beforeHydrate = vi.fn(() => false as const);
        const afterHydrate = vi.fn();
        const plugin: SSRPlugin = {
            name: 'opt-out',
            client: { beforeHydrate, afterHydrate }
        };
        registerClientPlugin(plugin);

        container = createSSRContainer('<div class="ssr">Never touched</div>');
        const originalHTML = container.innerHTML;

        hydrate(
            { type: 'div', props: { class: 'replaced' }, key: null, children: [], dom: null },
            container
        );

        expect(beforeHydrate).toHaveBeenCalledTimes(1);
        expect(beforeHydrate).toHaveBeenCalledWith(container);
        // afterHydrate is not called because beforeHydrate opted out
        expect(afterHydrate).not.toHaveBeenCalled();
        // DOM was not touched
        expect(container.innerHTML).toBe(originalHTML);
        // Container vnode reference is stored for resumable SSR
        expect((container as any)._vnode).toBeDefined();
    });

    it('calls afterHydrate after the DOM walk completes', () => {
        const events: string[] = [];
        const plugin: SSRPlugin = {
            name: 'observer',
            client: {
                beforeHydrate: () => { events.push('before'); return undefined; },
                afterHydrate: () => { events.push('after'); }
            }
        };
        registerClientPlugin(plugin);

        container = createSSRContainer('<div class="hello"></div>');
        hydrate(
            { type: 'div', props: { class: 'hello' }, key: null, children: [], dom: null },
            container
        );

        expect(events).toEqual(['before', 'after']);
    });

    it('lets a plugin intercept individual component hydration via hydrateComponent', () => {
        const interceptor = vi.fn((_vnode: any, _dom: any, _parent: any) => null as Node | null);
        registerClientPlugin({
            name: 'island',
            client: { hydrateComponent: interceptor }
        });

        container = createSSRContainer('<div class="counter"><span class="count">0</span><button>+</button></div><!--$c:1-->');

        hydrate((TestCounter as any)({}), container);

        expect(interceptor).toHaveBeenCalledTimes(1);
        // First arg is the component VNode
        expect(interceptor.mock.calls[0][0].type).toBe(TestCounter);
    });

    it('runs multiple plugins in registration order', () => {
        const order: string[] = [];
        registerClientPlugin({
            name: 'first',
            client: {
                beforeHydrate: () => { order.push('before:first'); return undefined; },
                afterHydrate: () => { order.push('after:first'); }
            }
        });
        registerClientPlugin({
            name: 'second',
            client: {
                beforeHydrate: () => { order.push('before:second'); return undefined; },
                afterHydrate: () => { order.push('after:second'); }
            }
        });

        container = createSSRContainer('<div></div>');
        hydrate({ type: 'div', props: {}, key: null, children: [], dom: null }, container);

        expect(order).toEqual(['before:first', 'before:second', 'after:first', 'after:second']);
    });
});

describe('hydrate() — client transformComponentContext (#120)', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        if (container) cleanupContainer(container);
    });

    it('invokes the hook with (vnode, componentCtx) before setup runs', () => {
        const seen: { signal: unknown; type: unknown } = { signal: null, type: null };
        const plugin: SSRPlugin = {
            name: 'ctx-observer',
            client: {
                transformComponentContext: (vnode, ctx) => {
                    seen.type = vnode.type;
                    seen.signal = ctx.signal;
                }
            }
        };
        registerClientPlugin(plugin);

        container = createSSRContainer('<div class="counter"><span class="count">0</span><button>+</button></div><!--$c:1-->');
        hydrate((TestCounter as any)({}), container);

        // The hook saw this component's vnode and the built context's signal fn.
        expect(seen.type).toBe(TestCounter);
        expect(typeof seen.signal).toBe('function');
    });

    it('lets a plugin swap ctx.signal and the swapped fn is what setup uses', () => {
        // A swapped factory that seeds a different value than the literal initial.
        const swapped = vi.fn((_initial: any) => signal(99));
        registerClientPlugin({
            name: 'signal-swap',
            client: {
                transformComponentContext: (_vnode, ctx) => {
                    ctx.signal = swapped as any;
                    return ctx;
                }
            }
        });

        const Comp = component((ctx) => {
            const s = ctx.signal(5);
            return () => <span class="v">{s.value}</span>;
        }, { name: 'CtxSwapComp' });

        container = createSSRContainer('<span class="v">99</span><!--$c:1-->');
        hydrate((Comp as any)({}), container);

        // setup() called the swapped factory with the component's literal initial,
        // proving the hook ran before setup.
        expect(swapped).toHaveBeenCalledWith(5);
        expect(container.querySelector('.v')!.textContent).toBe('99');
    });

    it('leaves the context unchanged when the hook returns void', async () => {
        registerClientPlugin({
            name: 'noop-transform',
            client: { transformComponentContext: () => undefined }
        });

        container = createSSRContainer('<div class="counter"><span class="count">0</span><button>+</button></div><!--$c:1-->');
        hydrate((TestCounter as any)({}), container);
        await nextTick();

        // Untouched context → component still hydrates and is interactive.
        container.querySelector('button')!.click();
        await nextTick();
        expect(container.querySelector('.count')!.textContent).toBe('1');
    });

    it('runs multiple transforms in registration order; later sees the earlier mutation', () => {
        const order: string[] = [];
        registerClientPlugin({
            name: 'first',
            client: {
                transformComponentContext: (_vnode, ctx) => {
                    order.push('first');
                    (ctx as any).__mark = 'first';
                }
            }
        });
        registerClientPlugin({
            name: 'second',
            client: {
                transformComponentContext: (_vnode, ctx) => {
                    order.push(`second:saw=${(ctx as any).__mark}`);
                }
            }
        });

        container = createSSRContainer('<div class="counter"><span class="count">0</span><button>+</button></div><!--$c:1-->');
        hydrate((TestCounter as any)({}), container);

        expect(order).toEqual(['first', 'second:saw=first']);
    });
});

describe('hydrate() — normalizeElement passthrough', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        if (container) cleanupContainer(container);
    });

    it('hydrates a string root (Text VNode normalization)', () => {
        container = createSSRContainer('hello');
        // Pass a primitive — normalizeElement should wrap it in a Text VNode
        expect(() => hydrate('hello' as any, container)).not.toThrow();
    });

    it('returns silently when given null', () => {
        container = createSSRContainer('');
        expect(() => hydrate(null as any, container)).not.toThrow();
    });
});
