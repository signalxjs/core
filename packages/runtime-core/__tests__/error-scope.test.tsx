/**
 * Tests for errorScope() — the setup-time subtree error boundary
 * (docs/rfc-async.md §4).
 *
 * Coverage: own-render throws, descendant setup/render/re-render throws
 * (via handleComponentError's parent-chain walk), nearest-scope-wins,
 * fallback-throw bubbling, retry-as-real-remount, the onError observer,
 * app-onError interplay, unhandled-async bubbling, and the guards.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, jsx, errorScope, useData, defineApp, SigxError } from 'sigx';
import { render } from '@sigx/runtime-dom';

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

async function settle(): Promise<void> {
    await tick();
    await tick();
    await new Promise(r => setTimeout(r, 10));
}

describe('errorScope', () => {
    const containers: HTMLDivElement[] = [];

    function mount(node: any): HTMLDivElement {
        const container = document.createElement('div');
        document.body.appendChild(container);
        containers.push(container);
        render(node, container);
        return container;
    }

    afterEach(() => {
        for (const c of containers.splice(0)) c.remove();
        delete (globalThis as any).__SIGX_ASYNC__;
        vi.restoreAllMocks();
    });

    it('catches the component\'s own render throw and renders fallback(error, retry)', async () => {
        let shouldThrow = true;
        const App = component(() => {
            errorScope({
                fallback: (e, retry) => (
                    <button class="fb" onClick={() => { shouldThrow = false; retry(); }}>
                        {e.message}
                    </button>
                ),
            });
            return () => {
                if (shouldThrow) throw new Error('render boom');
                return <div class="ok">fine</div>;
            };
        });
        const container = mount(jsx(App, {}));
        await settle(); // the scope's reactive write lands out-of-frame

        const fb = container.querySelector('.fb') as HTMLButtonElement;
        expect(fb?.textContent).toBe('render boom');

        fb.click();
        await settle();
        expect(container.querySelector('.ok')?.textContent).toBe('fine');
        expect(container.querySelector('.fb')).toBeNull();
    });

    it('catches a DESCENDANT render throw (parent-chain walk), without an app context', async () => {
        const Grandchild = component(() => () => {
            throw new Error('deep failure');
        });
        const Child = component(() => () => <div class="mid">{jsx(Grandchild, {})}</div>);
        const App = component(() => {
            errorScope({ fallback: (e) => <div class="fb">{e.message}</div> });
            return () => <div class="top">{jsx(Child, {})}</div>;
        });
        const container = mount(jsx(App, {})); // bare render(): no defineApp

        await settle();
        expect(container.querySelector('.fb')?.textContent).toBe('deep failure');
    });

    it('catches a descendant SETUP throw', async () => {
        const Broken = component(() => {
            throw new Error('setup boom');
        });
        const App = component(() => {
            errorScope({ fallback: (e) => <div class="fb">{e.message}</div> });
            return () => <div>{jsx(Broken as any, {})}</div>;
        });
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.querySelector('.fb')?.textContent).toBe('setup boom');
    });

    it('catches a descendant reactive RE-render throw', async () => {
        const bomb = signal({ armed: false });
        const Child = component(() => () => {
            if (bomb.armed) throw new Error('re-render boom');
            return <div class="ok">calm</div>;
        });
        const App = component(() => {
            errorScope({ fallback: (e) => <div class="fb">{e.message}</div> });
            return () => <div>{jsx(Child, {})}</div>;
        });
        const container = mount(jsx(App, {}));
        expect(container.querySelector('.ok')).toBeTruthy();

        bomb.armed = true;
        await settle();
        expect(container.querySelector('.fb')?.textContent).toBe('re-render boom');
    });

    it('retry REMOUNTS the subtree: descendant setup re-runs, onUnmounted ran, state is fresh', async () => {
        let setups = 0;
        let unmounts = 0;
        const bomb = signal({ armed: false });

        const Child = component((ctx) => {
            setups++;
            const count = ctx.signal(100);
            ctx.onUnmounted(() => unmounts++);
            return () => {
                if (bomb.armed) throw new Error('boom');
                return <div class="count">{count.value}</div>;
            };
        });

        let retryFn!: () => void;
        const App = component(() => {
            errorScope({
                fallback: (_e, retry) => {
                    retryFn = retry;
                    return <div class="fb" />;
                },
            });
            return () => <div>{jsx(Child, {})}</div>;
        });
        const container = mount(jsx(App, {}));
        expect(setups).toBe(1);

        bomb.armed = true;
        await settle();
        expect(container.querySelector('.fb')).toBeTruthy();

        bomb.armed = false;
        retryFn();
        await settle();

        expect(container.querySelector('.count')?.textContent).toBe('100');
        expect(setups).toBe(2);   // fresh mount — not a flag flip
        expect(unmounts).toBe(1); // old subtree genuinely torn down
    });

    it('nested scopes: the NEAREST one wins; outer stays clean', async () => {
        const Inner = component(() => {
            errorScope({ fallback: (e) => <div class="inner-fb">{e.message}</div> });
            return () => {
                throw new Error('inner boom');
            };
        });
        const App = component(() => {
            errorScope({ fallback: () => <div class="outer-fb" /> });
            return () => <div class="outer-alive">{jsx(Inner, {})}</div>;
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.inner-fb')?.textContent).toBe('inner boom');
        expect(container.querySelector('.outer-fb')).toBeNull();
        expect(container.querySelector('.outer-alive')).toBeTruthy();
    });

    it('a throw from the FALLBACK render bubbles to the outer scope (no loop)', async () => {
        const Inner = component(() => {
            errorScope({
                fallback: () => {
                    throw new Error('fallback also broken');
                },
            });
            return () => {
                throw new Error('inner boom');
            };
        });
        const App = component(() => {
            errorScope({ fallback: (e) => <div class="outer-fb">{e.message}</div> });
            return () => <div>{jsx(Inner, {})}</div>;
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.outer-fb')?.textContent).toBe('fallback also broken');
    });

    it('the onError observer is called with (error, instance, info); its own throw is swallowed', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const seen: Array<{ message: string; info: string }> = [];

        const Child = component(() => () => {
            throw new Error('observed');
        }, { name: 'ChildComp' });

        const App = component(() => {
            errorScope({
                onError: (e, _instance, info) => {
                    seen.push({ message: e.message, info });
                    throw new Error('observer bug'); // must be swallowed
                },
                fallback: () => <div class="fb" />,
            });
            return () => <div>{jsx(Child, {})}</div>;
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(seen).toEqual([{ message: 'observed', info: 'render' }]);
        expect(container.querySelector('.fb')).toBeTruthy();
        expect(errorSpy.mock.calls.some(c => String(c[0]).includes('observer threw'))).toBe(true);
    });

    it('no fallback given ⇒ renders nothing while errored (still catches)', async () => {
        const App = component(() => {
            errorScope({});
            return () => {
                throw new Error('silent');
            };
        });
        const container = mount(jsx(App, {}));
        await settle();
        expect(container.textContent).toBe('');
    });

    it('a scope-handled error does NOT reach the app onError handler', async () => {
        const appHandler = vi.fn(() => true);
        const app = defineApp(jsx(component(() => {
            errorScope({ fallback: () => <div class="fb" /> });
            return () => {
                throw new Error('scoped');
            };
        }), {}));
        app.onError(appHandler);

        const container = document.createElement('div');
        document.body.appendChild(container);
        containers.push(container);
        app.mount(container as any);
        await settle();

        expect(container.querySelector('.fb')).toBeTruthy();
        expect(appHandler).not.toHaveBeenCalled();
        app.unmount();
    });

    it('an unhandled async data error (match without error arm) bubbles to the nearest scope', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => { });

        const DataChild = component(() => {
            const cell = useData('scope-bubble', () => Promise.reject(new Error('data boom')));
            return () => (
                <div class="data">
                    {cell.match({ pending: () => 'P', ready: (v) => String(v) }) ?? 'nothing'}
                </div>
            );
        });
        const App = component(() => {
            errorScope({ fallback: (e) => <div class="fb">{e.message}</div> });
            return () => <div>{jsx(DataChild, {})}</div>;
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.fb')?.textContent).toBe('data boom');
    });

    it('does NOT catch fetcher rejections handled by an error arm (value-first)', async () => {
        const scopeHit = vi.fn();
        const DataChild = component(() => {
            const cell = useData('handled-err', () => Promise.reject(new Error('handled')));
            return () => (
                <div class="data">
                    {cell.match({
                        pending: () => 'P',
                        error: (e) => `E:${e.message}`,
                        ready: (v) => String(v),
                    })}
                </div>
            );
        });
        const App = component(() => {
            errorScope({ onError: scopeHit, fallback: () => <div class="fb" /> });
            return () => <div>{jsx(DataChild, {})}</div>;
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(container.querySelector('.data')?.textContent).toBe('E:handled');
        expect(container.querySelector('.fb')).toBeNull();
        expect(scopeHit).not.toHaveBeenCalled();
    });

    it('throws SIGX103 when called outside setup', () => {
        try {
            errorScope({});
            expect.unreachable('should have thrown');
        } catch (e) {
            expect(e).toBeInstanceOf(SigxError);
            expect((e as SigxError).code).toBe('SIGX103');
        }
    });

    it('dev-warns and ignores a second call in the same setup', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const App = component(() => {
            errorScope({ fallback: (e) => <div class="first">{e.message}</div> });
            errorScope({ fallback: () => <div class="second" /> });
            return () => {
                throw new Error('which one');
            };
        });
        const container = mount(jsx(App, {}));
        await settle();

        expect(warn.mock.calls.some(c => String(c[0]).includes('called twice'))).toBe(true);
        expect(container.querySelector('.first')?.textContent).toBe('which one');
        expect(container.querySelector('.second')).toBeNull();
    });
});
