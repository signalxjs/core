/**
 * Tests for the island component registry — focuses on the paths not already
 * exercised by lazy-islands.test.tsx:
 * - registerComponents (filters non-components via isComponent)
 * - unwrapComponentModule edge cases (first-component fallback, none-found → warn)
 * - HydrationRegistry class (register / registerLazy / registerAll / get / has / resolve)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal } from 'sigx';
import {
    registerComponents,
    getComponent,
    hasComponent,
    resolveComponent,
    __registerIslandChunk,
    HydrationRegistry,
    type ComponentFactory
} from '../src/client/registry';

// Unique names so module-level registry Maps don't leak between tests.
let testId = 0;
function uniqueName(base: string): string {
    return `Reg_${base}_${++testId}`;
}

const Comp = component(() => () => <span>x</span>, { name: 'RegComp' });
const Comp2 = component(() => () => <span>y</span>, { name: 'RegComp2' });

afterEach(() => {
    vi.restoreAllMocks();
});

describe('registerComponents', () => {
    it('registers only real components and skips non-components', () => {
        const a = uniqueName('A');
        const b = uniqueName('B');
        const c = uniqueName('C');

        registerComponents({
            [a]: Comp,
            [b]: Comp2,
            // Not a SignalX component — should be filtered out by isComponent
            [c]: (() => {}) as unknown as ComponentFactory,
        });

        expect(getComponent(a)).toBe(Comp);
        expect(getComponent(b)).toBe(Comp2);
        expect(getComponent(c)).toBeUndefined();
        expect(hasComponent(c)).toBe(false);
    });

    it('tolerates an empty record', () => {
        expect(() => registerComponents({})).not.toThrow();
    });
});

describe('resolveComponent unwrap edge cases', () => {
    it('unwraps a module whose component is under an unrelated export name (first-component fallback)', async () => {
        const name = uniqueName('FirstFallback');
        // Module exports the component under a key that is neither `default`
        // nor the component name — forces the Object.values() fallback scan.
        const mod = { somethingElse: Comp } as any;
        __registerIslandChunk(name, () => Promise.resolve(mod));

        const result = await resolveComponent(name);
        expect(result).toBe(Comp);
        // Cached into the eager registry afterwards.
        expect(getComponent(name)).toBe(Comp);
    });

    it('returns undefined and warns when the module contains no component', async () => {
        const name = uniqueName('NoComp');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // A module object with only plain values — nothing has __setup.
        __registerIslandChunk(name, () => Promise.resolve({ foo: 1, bar: 'baz' } as any));

        const result = await resolveComponent(name);
        expect(result).toBeUndefined();
        expect(warnSpy).toHaveBeenCalled();
        expect(warnSpy.mock.calls.flat().join(' ')).toContain(name);
        // Nothing cached on failure.
        expect(getComponent(name)).toBeUndefined();
    });
});

describe('HydrationRegistry class', () => {
    it('register / get / has work and chain', () => {
        const reg = new HydrationRegistry();
        const name = uniqueName('HRReg');

        const ret = reg.register(name, Comp);
        expect(ret).toBe(reg); // chainable
        expect(reg.get(name)).toBe(Comp);
        expect(reg.has(name)).toBe(true);
        expect(reg.get('missing')).toBeUndefined();
        expect(reg.has('missing')).toBe(false);
    });

    it('registerLazy makes has() true without eager get()', () => {
        const reg = new HydrationRegistry();
        const name = uniqueName('HRLazy');

        reg.registerLazy(name, () => Promise.resolve(Comp));
        expect(reg.has(name)).toBe(true);
        // Not yet eagerly resolved.
        expect(reg.get(name)).toBeUndefined();
    });

    it('registerAll filters non-components', () => {
        const reg = new HydrationRegistry();
        const a = uniqueName('HRAllA');
        const b = uniqueName('HRAllB');

        const ret = reg.registerAll({
            [a]: Comp,
            [b]: (() => {}) as unknown as ComponentFactory,
        });
        expect(ret).toBe(reg);
        expect(reg.get(a)).toBe(Comp);
        expect(reg.get(b)).toBeUndefined();
    });

    it('resolve returns the eager component instantly when registered', async () => {
        const reg = new HydrationRegistry();
        const name = uniqueName('HRResolveEager');
        reg.register(name, Comp);

        await expect(reg.resolve(name)).resolves.toBe(Comp);
    });

    it('resolve runs the lazy loader, unwraps { default }, and caches', async () => {
        const reg = new HydrationRegistry();
        const name = uniqueName('HRResolveLazy');
        const loader = vi.fn(() => Promise.resolve({ default: Comp2 } as any));
        reg.registerLazy(name, loader);

        const first = await reg.resolve(name);
        expect(first).toBe(Comp2);
        // Cached: second resolve hits the eager map, loader not called again.
        const second = await reg.resolve(name);
        expect(second).toBe(Comp2);
        expect(loader).toHaveBeenCalledOnce();
        expect(reg.get(name)).toBe(Comp2);
    });

    it('resolve returns undefined for a wholly unknown name', async () => {
        const reg = new HydrationRegistry();
        await expect(reg.resolve('nope_unknown')).resolves.toBeUndefined();
    });

    it('resolve returns undefined when the loaded module has no component', async () => {
        const reg = new HydrationRegistry();
        const name = uniqueName('HRResolveNoComp');
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        reg.registerLazy(name, () => Promise.resolve({ nothing: true } as any));

        await expect(reg.resolve(name)).resolves.toBeUndefined();
        expect(reg.get(name)).toBeUndefined();
    });
});
