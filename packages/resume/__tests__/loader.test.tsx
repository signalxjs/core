/**
 * Delegation loader (#241): capture-phase document delegation, synchronous
 * preventDefault via data-sigx-pd, first-event replay through the lazily
 * loaded runtime, synthetic-bubble ordering, and lazy/cached module loading.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initResume, resetResumeDelegation, type ResumeRuntime } from '../src/loader';
import { __registerResumeQrl, resolveQrl, resetResumeQrls } from '../src/client/qrl-registry';

interface Invocation {
    symbol: string;
    event: Event;
    element: Element;
}

function makeRuntime() {
    const invocations: Invocation[] = [];
    const wakes: number[] = [];
    const runtime: ResumeRuntime = {
        invoke(symbol, event, element) {
            invocations.push({ symbol, event, element });
        },
        wake(id) {
            wakes.push(id);
        }
    };
    let loads = 0;
    const loadRuntime = vi.fn(() => {
        loads++;
        return Promise.resolve(runtime);
    });
    const loadRegistry = vi.fn(() => Promise.resolve({}));
    return { invocations, wakes, runtime, loadRuntime, loadRegistry, loads: () => loads };
}

/** Flush the loader's Promise.all chain. */
const tick = () => new Promise((r) => setTimeout(r, 0));

let container: HTMLElement;

beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
});

afterEach(() => {
    resetResumeDelegation();
    container.remove();
});

describe('initResume — delegation', () => {
    it('loads nothing at init; first interaction loads once and replays the event', async () => {
        const rt = makeRuntime();
        initResume(['click'], rt.loadRegistry, rt.loadRuntime);
        expect(rt.loadRuntime).not.toHaveBeenCalled();

        container.innerHTML = `<button data-sigx-on:click="Sym_click_1">go</button>`;
        const button = container.querySelector('button')!;
        button.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();

        expect(rt.invocations).toHaveLength(1);
        expect(rt.invocations[0].symbol).toBe('Sym_click_1');
        expect(rt.invocations[0].element).toBe(button);
        expect(rt.invocations[0].event.type).toBe('click');

        // Repeat events reuse the settled promise — no second load.
        button.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();
        expect(rt.invocations).toHaveLength(2);
        expect(rt.loads()).toBe(1);
        expect(rt.loadRegistry).toHaveBeenCalledTimes(1);
    });

    it('applies preventDefault synchronously when data-sigx-pd is present', () => {
        const rt = makeRuntime();
        // Runtime never resolves within this test — pd must not wait for it.
        initResume(['click'], rt.loadRegistry, () => new Promise(() => {}));

        container.innerHTML =
            `<a href="#" data-sigx-on:click="Sym_click_pd" data-sigx-pd:click="">x</a>` +
            `<a href="#" data-sigx-on:click="Sym_click_nopd">y</a>`;
        const [withPd, withoutPd] = Array.from(container.querySelectorAll('a'));

        const evPd = new Event('click', { bubbles: true, cancelable: true });
        withPd.dispatchEvent(evPd);
        expect(evPd.defaultPrevented).toBe(true);

        const evPlain = new Event('click', { bubbles: true, cancelable: true });
        withoutPd.dispatchEvent(evPlain);
        expect(evPlain.defaultPrevented).toBe(false);
    });

    it('bubbles synthetically target → root and stops on cancelBubble', async () => {
        const rt = makeRuntime();
        initResume(['click'], rt.loadRegistry, rt.loadRuntime);

        container.innerHTML =
            `<div data-sigx-on:click="Outer">` +
            `<div data-sigx-on:click="Middle"><button data-sigx-on:click="Inner">x</button></div>` +
            `</div>`;
        container.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();
        expect(rt.invocations.map((i) => i.symbol)).toEqual(['Inner', 'Middle', 'Outer']);

        // stopPropagation inside a handler ends the synthetic bubble.
        rt.invocations.length = 0;
        rt.runtime.invoke = (symbol, event) => {
            rt.invocations.push({ symbol, event, element: null as any });
            if (symbol === 'Middle') event.stopPropagation();
        };
        container.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();
        expect(rt.invocations.map((i) => i.symbol)).toEqual(['Inner', 'Middle']);
    });

    it('ignores events with no QRL carrier in the ancestor chain', async () => {
        const rt = makeRuntime();
        initResume(['click'], rt.loadRegistry, rt.loadRuntime);
        container.innerHTML = `<button>plain</button>`;
        container.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();
        expect(rt.loadRuntime).not.toHaveBeenCalled();
        expect(rt.invocations).toHaveLength(0);
    });

    it('is idempotent and only listens for registered event types', async () => {
        const rt = makeRuntime();
        initResume(['click'], rt.loadRegistry, rt.loadRuntime);
        initResume(['click', 'input'], rt.loadRegistry, rt.loadRuntime);

        container.innerHTML = `<input data-sigx-on:input="Sym_input" data-sigx-on:keydown="Sym_key" />`;
        const input = container.querySelector('input')!;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('keydown', { bubbles: true })); // not delegated
        await tick();
        expect(rt.invocations.map((i) => i.symbol)).toEqual(['Sym_input']);

        // A duplicated 'click' registration must not double-invoke.
        container.innerHTML = `<button data-sigx-on:click="Sym_once">x</button>`;
        container.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();
        expect(rt.invocations.filter((i) => i.symbol === 'Sym_once')).toHaveLength(1);
    });

    it('wakes hydrate-mode boundaries via data-sigx-wake (no replay), deduped per boundary', async () => {
        const rt = makeRuntime();
        initResume(['click'], rt.loadRegistry, rt.loadRuntime);

        container.innerHTML =
            `<div data-sigx-wake:click="" data-sigx-b="7">` +
            `<button data-sigx-wake:click="" data-sigx-pd:click="" data-sigx-b="7">x</button>` +
            `</div>`;
        const ev = new Event('click', { bubbles: true, cancelable: true });
        container.querySelector('button')!.dispatchEvent(ev);
        expect(ev.defaultPrevented).toBe(true); // pd applies to wake carriers too
        await tick();

        expect(rt.wakes).toEqual([7]); // one wake per boundary, not per element
        expect(rt.invocations).toHaveLength(0); // no QRL replay for wake carriers
    });

    it('resetResumeDelegation removes listeners', async () => {
        const rt = makeRuntime();
        initResume(['click'], rt.loadRegistry, rt.loadRuntime);
        resetResumeDelegation();

        container.innerHTML = `<button data-sigx-on:click="Sym">x</button>`;
        container.querySelector('button')!.dispatchEvent(new Event('click', { bubbles: true }));
        await tick();
        expect(rt.invocations).toHaveLength(0);
    });
});

describe('QRL registry', () => {
    afterEach(() => resetResumeQrls());

    it('resolves through the lazy loader once and caches', async () => {
        const handler = vi.fn();
        const loader = vi.fn(() => Promise.resolve(handler));
        __registerResumeQrl('Sym_a', loader);

        expect(await resolveQrl('Sym_a')).toBe(handler);
        expect(await resolveQrl('Sym_a')).toBe(handler);
        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('first registration wins', async () => {
        const first = vi.fn();
        __registerResumeQrl('Sym_b', () => Promise.resolve(first));
        __registerResumeQrl('Sym_b', () => Promise.resolve(vi.fn()));
        expect(await resolveQrl('Sym_b')).toBe(first);
    });

    it('warns and returns null for unknown symbols and non-function resolutions', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await resolveQrl('Sym_missing')).toBeNull();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Sym_missing'));

        __registerResumeQrl('Sym_bad', () => Promise.resolve(42 as any));
        expect(await resolveQrl('Sym_bad')).toBeNull();
        warn.mockRestore();
    });
});
