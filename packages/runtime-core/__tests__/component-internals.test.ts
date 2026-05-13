import { describe, it, expect, vi } from 'vitest';
import {
    component,
    createPropsProxy,
    getComponentMeta
} from '../src/component';
import { registerComponentPlugin } from '../src/plugins';

describe('createPropsProxy', () => {
    it('passes through reads', () => {
        const proxy = createPropsProxy({ a: 1, b: 'x' });
        expect(proxy.a).toBe(1);
        expect(proxy.b).toBe('x');
    });

    it('invokes onAccess for every string property read', () => {
        const seen: string[] = [];
        const proxy = createPropsProxy({ first: 1, second: 2 }, (key) => {
            seen.push(key);
        });

        // Force two reads
        void proxy.first;
        void proxy.second;
        void proxy.first;

        expect(seen).toEqual(['first', 'second', 'first']);
    });

    it('does not invoke onAccess for symbol property access', () => {
        const onAccess = vi.fn();
        const sym = Symbol('extra');
        const target: any = { a: 1, [sym]: 'hidden' };
        const proxy = createPropsProxy(target, onAccess);

        void proxy[sym];
        expect(onAccess).not.toHaveBeenCalled();

        void proxy.a;
        expect(onAccess).toHaveBeenCalledWith('a');
    });

    it('works with no onAccess callback', () => {
        const proxy = createPropsProxy({ k: 42 });
        expect(proxy.k).toBe(42);
    });
});

describe('component() — factory behavior', () => {
    it('returns a VNode-like object when invoked as JSX', () => {
        const setup = () => () => null;
        const Cmp = component(setup, { name: 'Cmp' });

        const vnode: any = (Cmp as any)({ x: 1, key: 'k1' });
        expect(vnode.type).toBe(Cmp);
        expect(vnode.props).toEqual({ x: 1, key: 'k1' });
        expect(vnode.key).toBe('k1');
        expect(vnode.children).toEqual([]);
        expect(vnode.dom).toBeNull();
    });

    it('uses an empty object when props is falsy', () => {
        const Cmp = component(() => () => null);
        const vnode: any = (Cmp as any)(null);
        expect(vnode.props).toEqual({});
        expect(vnode.key).toBeNull();
    });

    it('uses an empty object when props is undefined', () => {
        const Cmp = component(() => () => null);
        const vnode: any = (Cmp as any)(undefined);
        expect(vnode.props).toEqual({});
        expect(vnode.key).toBeNull();
    });

    it('attaches the setup function and name onto the factory', () => {
        const setup = () => () => null;
        const Cmp: any = component(setup, { name: 'Named' });
        expect(Cmp.__setup).toBe(setup);
        expect(Cmp.__name).toBe('Named');
    });
});

describe('component registry — getComponentMeta', () => {
    it('returns the registered metadata for a component factory', () => {
        const setup = () => () => null;
        const Cmp = component(setup, { name: 'RegisteredCmp' });
        const meta = getComponentMeta(Cmp as unknown as Function);
        expect(meta).toBeDefined();
        expect(meta!.name).toBe('RegisteredCmp');
        expect(meta!.setup).toBe(setup);
    });

    it('returns undefined for unregistered functions', () => {
        expect(getComponentMeta(() => {})).toBeUndefined();
    });
});

describe('component plugin onDefine integration', () => {
    it('notifies registered plugins when a component is defined', () => {
        const onDefine = vi.fn();
        registerComponentPlugin({ onDefine });

        const setup = () => () => null;
        const Cmp = component(setup, { name: 'PluginCmp' });

        expect(onDefine).toHaveBeenCalled();
        // Find the call for our specific component (plugins are global; other tests
        // in the suite may have triggered earlier calls).
        const ourCall = onDefine.mock.calls.find(c => c[1] === Cmp);
        expect(ourCall).toBeDefined();
        expect(ourCall![0]).toBe('PluginCmp');
        expect(ourCall![1]).toBe(Cmp);
        expect(ourCall![2]).toBe(setup);
    });

    it('passes undefined name when options omits name', () => {
        const onDefine = vi.fn();
        registerComponentPlugin({ onDefine });

        const setup = () => () => null;
        const Cmp = component(setup);

        const ourCall = onDefine.mock.calls.find(c => c[1] === Cmp);
        expect(ourCall).toBeDefined();
        expect(ourCall![0]).toBeUndefined();
    });

    it('does not throw when plugin has no onDefine', () => {
        registerComponentPlugin({});
        expect(() => component(() => () => null, { name: 'NoOpPlugin' })).not.toThrow();
    });
});
