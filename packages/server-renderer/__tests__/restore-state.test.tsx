/**
 * Tests for server state restoration during hydration
 * Tests createRestoringSignal, getIslandServerState, and signal state serialization
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import { hydrate } from '../src/client/hydrate-core';
import { hydrateComponent } from '../src/client/hydrate-component';
import {
    createSSRContainer,
    cleanupContainer,
    createIslandDataScript,
    cleanupScripts,
    ssrComponentMarkers,
    nextTick
} from './test-utils';
import type { SSRSignalFn } from './test-utils';

describe('server state restoration', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        cleanupScripts();
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
    });

    describe('createRestoringSignal (via hydration)', () => {
        it('should restore signal state by name key', async () => {
            const serverState = { myCount: 42, myLabel: 'restored' };

            let countVal: number | undefined;
            let labelVal: string | undefined;

            const NamedSignalComponent = component((ctx) => {
                const ssrSignal = ctx.signal as SSRSignalFn;
                const count = ssrSignal(0, 'myCount');
                const label = ssrSignal('default', 'myLabel');
                countVal = count.value;
                labelVal = label.value;
                return () => <div><span class="count">{count.value}</span><span class="label">{label.value}</span></div>;
            }, { name: 'NamedSignalComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<div><span class="count">42</span><span class="label">restored</span></div>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent({ type: NamedSignalComponent, props: {}, key: null, children: [], dom: null }, container.firstChild, container, serverState);
            await nextTick();

            expect(countVal).toBe(42);
            expect(labelVal).toBe('restored');
        });

        it('should restore signal state by index key when no name given', async () => {
            const serverState = { '$0': 100, '$1': 'indexed' };

            let firstVal: number | undefined;
            let secondVal: string | undefined;

            const IndexSignalComponent = component((ctx) => {
                const first = ctx.signal(0);  // key = $0
                const second = ctx.signal('');  // key = $1
                firstVal = first.value;
                secondVal = second.value;
                return () => <div><span>{first.value}</span><span>{second.value}</span></div>;
            }, { name: 'IndexSignalComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<div><span>100</span><span>indexed</span></div>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent({ type: IndexSignalComponent, props: {}, key: null, children: [], dom: null }, container.firstChild, container, serverState);
            await nextTick();

            expect(firstVal).toBe(100);
            expect(secondVal).toBe('indexed');
        });

        it('should fall back to initial value when key not in server state', async () => {
            const serverState = { count: 10 };

            let countVal: number | undefined;
            let missingVal: string | undefined;

            const PartialStateComponent = component((ctx) => {
                const ssrSignal = ctx.signal as SSRSignalFn;
                const count = ssrSignal(0, 'count');
                const missing = ssrSignal('fallback', 'noSuchKey');
                countVal = count.value;
                missingVal = missing.value;
                return () => <div><span>{count.value}</span><span>{missing.value}</span></div>;
            }, { name: 'PartialStateComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<div><span>10</span><span>fallback</span></div>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent({ type: PartialStateComponent, props: {}, key: null, children: [], dom: null }, container.firstChild, container, serverState);
            await nextTick();

            expect(countVal).toBe(10);
            expect(missingVal).toBe('fallback');
        });

        it('should restore null and false values correctly', async () => {
            const serverState = { nullVal: null, falseVal: false, zeroVal: 0, emptyVal: '' };

            let nVal: any, fVal: any, zVal: any, eVal: any;

            const FalsyComponent = component((ctx) => {
                const ssrSignal = ctx.signal as SSRSignalFn;
                const n = ssrSignal('not-null', 'nullVal');
                const f = ssrSignal(true, 'falseVal');
                const z = ssrSignal(99, 'zeroVal');
                const e = ssrSignal('filled', 'emptyVal');
                nVal = n.value;
                fVal = f.value;
                zVal = z.value;
                eVal = e.value;
                return () => <span>falsy</span>;
            }, { name: 'FalsyComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span>falsy</span>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent({ type: FalsyComponent, props: {}, key: null, children: [], dom: null }, container.firstChild, container, serverState);
            await nextTick();

            expect(nVal).toBeNull();
            expect(fVal).toBe(false);
            expect(zVal).toBe(0);
            expect(eVal).toBe('');
        });
    });

    describe('getIslandServerState', () => {
        it('should restore state via hydrateComponent with server state', async () => {
            const serverState = { count: 5 };

            // Component that reads state
            const TestComponent = component((ctx) => {
                const ssrSignal = ctx.signal as SSRSignalFn;
                const count = ssrSignal(0, 'count');
                return () => <span class="count">{count.value}</span>;
            }, { name: 'TestComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="count">5</span>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent(
                { type: TestComponent, props: {}, key: null, children: [], dom: null },
                container.firstChild,
                container,
                serverState
            );
            await nextTick();

            expect(container.querySelector('.count')?.textContent).toBe('5');
        });

        it('should handle missing server state gracefully', async () => {
            // No server state - should not error

            const SimpleComponent = component((ctx) => {
                const value = ctx.signal('default');
                return () => <span class="value">{value.value}</span>;
            }, { name: 'SimpleComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="value">default</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: SimpleComponent,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            // Should not throw
            hydrate(vnode, container);
            await nextTick();

            expect(container.querySelector('.value')?.textContent).toBe('default');
        });

        it('should handle malformed JSON in script tag', async () => {
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

            // Create a script tag with invalid JSON
            const script = document.createElement('script');
            script.id = '__SIGX_ISLANDS__';
            script.type = 'application/json';
            script.textContent = '{invalid json!!!}';
            document.body.appendChild(script);

            const SafeComponent = component((ctx) => {
                const value = ctx.signal('safe');
                return () => <span class="safe">{value.value}</span>;
            }, { name: 'SafeComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="safe">safe</span>');
            container = createSSRContainer(ssrHtml);

            // Should not throw even with malformed JSON
            expect(() => {
                hydrate({ type: SafeComponent, props: {}, key: null, children: [], dom: null }, container);
            }).not.toThrow();

            errorSpy.mockRestore();
        });
    });

    describe('SSR context extension', () => {
        it('should set isHydrating to true when server state exists', async () => {
            const serverState = { test: true };

            let isHydrating: boolean | undefined;

            const HydratingComponent = component((ctx) => {
                isHydrating = (ctx as any).ssr?.isHydrating;
                const ssrSignal = ctx.signal as SSRSignalFn;
                const test = ssrSignal(false, 'test');
                return () => <span>{test.value ? 'yes' : 'no'}</span>;
            }, { name: 'HydratingComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span>yes</span>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent(
                { type: HydratingComponent, props: {}, key: null, children: [], dom: null },
                container.firstChild,
                container,
                serverState
            );
            await nextTick();

            expect(isHydrating).toBe(true);
        });

        it('should set isServer to false during hydration', async () => {
            let isServer: boolean | undefined;

            const ClientComponent = component((ctx) => {
                isServer = (ctx as any).ssr?.isServer;
                return () => <span>Client</span>;
            }, { name: 'ClientComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span>Client</span>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: ClientComponent,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            expect(isServer).toBe(false);
        });

        it('ssr.load() should be no-op during hydration with server state', async () => {
            const serverState = { data: 'from-server' };

            const loadFn = vi.fn().mockResolvedValue(undefined);

            const LoadTestComponent = component((ctx) => {
                const ssrSignal = ctx.signal as SSRSignalFn;
                const data = ssrSignal('initial', 'data');
                
                // This should NOT be called during hydration
                (ctx as any).ssr?.load(loadFn);

                return () => <span class="data">{data.value}</span>;
            }, { name: 'LoadTestComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span class="data">from-server</span>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent(
                { type: LoadTestComponent, props: {}, key: null, children: [], dom: null },
                container.firstChild,
                container,
                serverState
            );
            await nextTick();

            // load() should be skipped during hydration
            expect(loadFn).not.toHaveBeenCalled();

            // Data should still be restored from server state
            expect(container.querySelector('.data')?.textContent).toBe('from-server');
        });
    });

    describe('complex state restoration', () => {
        it('should restore nested object state', async () => {
            const serverState = { user: { name: 'Alice', age: 30, address: { city: 'NYC' } } };

            let userName: string | undefined;
            let userAge: number | undefined;
            let userCity: string | undefined;

            const NestedComponent = component((ctx) => {
                const ssrSignal = ctx.signal as SSRSignalFn;
                const user = ssrSignal({ name: '', age: 0, address: { city: '' } }, 'user');
                // Object signals are accessed directly (not via .value)
                userName = user.name;
                userAge = user.age;
                userCity = user.address?.city;
                return () => <span>{user.name}</span>;
            }, { name: 'NestedComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span>Alice</span>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent({ type: NestedComponent, props: {}, key: null, children: [], dom: null }, container.firstChild, container, serverState);
            await nextTick();

            expect(userName).toBe('Alice');
            expect(userAge).toBe(30);
            expect(userCity).toBe('NYC');
        });

        it('should restore array state', async () => {
            const serverState = { items: ['a', 'b', 'c'] };

            let itemsLength: number | undefined;
            let firstItem: string | undefined;

            const ArrayComponent = component((ctx) => {
                const ssrSignal = ctx.signal as SSRSignalFn;
                const items = ssrSignal([] as string[], 'items');
                // Array signals are accessed directly
                itemsLength = items.length;
                firstItem = items[0];
                return () => <span>{String(items.length)}</span>;
            }, { name: 'ArrayComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<span>3</span>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent({ type: ArrayComponent, props: {}, key: null, children: [], dom: null }, container.firstChild, container, serverState);
            await nextTick();

            expect(itemsLength).toBe(3);
            expect(firstItem).toBe('a');
        });

        it('should restore multiple signals across components', async () => {
            const serverState = { title: 'Hello', count: 7, active: true };

            let vals: Record<string, any> = {};

            const MultiComponent = component((ctx) => {
                const ssrSignal = ctx.signal as SSRSignalFn;
                const title = ssrSignal('', 'title');
                const count = ssrSignal(0, 'count');
                const active = ssrSignal(false, 'active');
                vals = { title: title.value, count: count.value, active: active.value };
                return () => <div>{title.value}: {count.value}</div>;
            }, { name: 'MultiComponent' });

            const ssrHtml = ssrComponentMarkers(1, '<div>Hello: 7</div>');
            container = createSSRContainer(ssrHtml);

            hydrateComponent({ type: MultiComponent, props: {}, key: null, children: [], dom: null }, container.firstChild, container, serverState);
            await nextTick();

            expect(vals.title).toBe('Hello');
            expect(vals.count).toBe(7);
            expect(vals.active).toBe(true);
        });
    });
});
