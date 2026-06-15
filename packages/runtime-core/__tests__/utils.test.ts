import { describe, it, expect } from 'vitest';
import { isPromise, Utils, guid } from '../src/utils/index';
import { isComponent } from '../src/utils/is-component';
import { normalizeSubTree } from '../src/utils/normalize';
import { createSlots } from '../src/utils/slots';
import { Text, Fragment } from '../src/jsx-runtime';

// ── Utils.isPromise ─────────────────────────────────────────────────────────

describe('Utils.isPromise', () => {
    it('returns true for a native Promise', () => {
        expect(Utils.isPromise(Promise.resolve(42))).toBe(true);
    });

    it('returns true for a thenable object', () => {
        expect(Utils.isPromise({ then: () => {} })).toBe(true);
    });

    it('returns true for a thenable function', () => {
        const fn = Object.assign(() => {}, { then: () => {} });
        expect(Utils.isPromise(fn)).toBe(true);
    });

    it('returns false for null', () => {
        expect(Utils.isPromise(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(Utils.isPromise(undefined)).toBe(false);
    });

    it('returns false for a number', () => {
        expect(Utils.isPromise(42)).toBe(false);
    });

    it('returns false for a string', () => {
        expect(Utils.isPromise('hello')).toBe(false);
    });

    it('returns false for a plain object', () => {
        expect(Utils.isPromise({ foo: 'bar' })).toBe(false);
    });
});

// ── guid ────────────────────────────────────────────────────────────────────

describe('guid', () => {
    const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('returns a string matching UUID v4 format', () => {
        expect(guid()).toMatch(uuidV4Regex);
    });

    it('returns a unique value on each call', () => {
        const a = guid();
        const b = guid();
        expect(a).not.toBe(b);
    });

    it('has "4" as the first character of the third segment', () => {
        const id = guid();
        const thirdSegment = id.split('-')[2];
        expect(thirdSegment[0]).toBe('4');
    });

    it('has 8, 9, a, or b as the first character of the fourth segment', () => {
        const id = guid();
        const fourthSegment = id.split('-')[3];
        expect(['8', '9', 'a', 'b']).toContain(fourthSegment[0]);
    });
});

// ── isComponent ─────────────────────────────────────────────────────────────

describe('isComponent', () => {
    it('returns true for a function with __setup property', () => {
        const comp = Object.assign(function () {}, { __setup: () => {} });
        expect(isComponent(comp)).toBe(true);
    });

    it('returns false for a function without __setup', () => {
        expect(isComponent(function () {})).toBe(false);
    });

    it('returns false for a plain object', () => {
        expect(isComponent({ __setup: () => {} })).toBe(false);
    });

    it('returns false for a string', () => {
        expect(isComponent('div')).toBe(false);
    });

    it('returns false for null', () => {
        expect(isComponent(null)).toBe(false);
    });

    it('returns false for undefined', () => {
        expect(isComponent(undefined)).toBe(false);
    });
});

// ── normalizeSubTree ────────────────────────────────────────────────────────

describe('normalizeSubTree', () => {
    it('returns a Text VNode for null', () => {
        const result = normalizeSubTree(null);
        expect(result.type).toBe(Text);
        expect(result.text).toBe('');
    });

    it('returns a Text VNode for undefined', () => {
        const result = normalizeSubTree(undefined);
        expect(result.type).toBe(Text);
        expect(result.text).toBe('');
    });

    it('returns a Text VNode for false', () => {
        const result = normalizeSubTree(false);
        expect(result.type).toBe(Text);
        expect(result.text).toBe('');
    });

    it('returns a Text VNode for true', () => {
        const result = normalizeSubTree(true);
        expect(result.type).toBe(Text);
        expect(result.text).toBe('');
    });

    it('returns a Fragment VNode for an array', () => {
        const children = [
            { type: 'div', props: {}, key: null, children: [], dom: null },
        ];
        const result = normalizeSubTree(children as any);
        expect(result.type).toBe(Fragment);
        expect(result.children).toBe(children);
    });

    it('returns a Text VNode for a string', () => {
        const result = normalizeSubTree('hello' as any);
        expect(result.type).toBe(Text);
        expect(result.text).toBe('hello');
    });

    it('returns a Text VNode for a number', () => {
        const result = normalizeSubTree(99 as any);
        expect(result.type).toBe(Text);
        expect(result.text).toBe(99);
    });

    it('passes a VNode object through unchanged', () => {
        const vnode = { type: 'div', props: { id: 'app' }, key: null, children: [], dom: null };
        const result = normalizeSubTree(vnode as any);
        expect(result).toBe(vnode);
    });
});

// ── createSlots ─────────────────────────────────────────────────────────────

describe('createSlots', () => {
    it('returns default slot children from an array', () => {
        const children = [{ type: 'span', props: {}, key: null, children: [], dom: null }];
        const slots = createSlots(children);
        const result = slots.default!();
        expect(result).toHaveLength(1);
        expect(result[0]).toBe(children[0]);
    });

    it('filters null, false, and true from default slot', () => {
        const children = ['text', null, false, true, 0];
        const slots = createSlots(children);
        const result = slots.default!();
        expect(result).toEqual(['text', 0]);
    });

    it('extracts named slots from children via slot prop', () => {
        const header = { type: 'div', props: { slot: 'header' }, key: null, children: [], dom: null };
        const body = { type: 'p', props: {}, key: null, children: [], dom: null };
        const slots = createSlots([header, body]);

        expect(slots.default!()).toEqual([body]);

        const headerSlot = (slots as any).header();
        expect(headerSlot).toEqual([header]);
    });

    it('returns named slot content from slotsFromProps function', () => {
        const slotFn = () => [{ type: 'li', props: {}, key: null, children: [], dom: null }];
        const slots = createSlots([], { items: slotFn });
        const result = (slots as any).items();
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('li');
    });

    it('passes scoped props to slotsFromProps function', () => {
        const slotFn = (props: any) => ({ type: 'span', props: { text: props.name }, key: null, children: [], dom: null });
        const slots = createSlots([], { user: slotFn });
        const result = (slots as any).user({ name: 'Alice' });
        expect(result).toHaveLength(1);
        expect(result[0].props.text).toBe('Alice');
    });

    // ── presence: a slot accessor exists only when content was provided ──

    it('reads an unprovided named slot as undefined', () => {
        const slots = createSlots([]);
        expect((slots as any).nonexistent).toBeUndefined();
    });

    it('reads the default slot as undefined when there are no children', () => {
        expect(createSlots(null).default).toBeUndefined();
        expect(createSlots([]).default).toBeUndefined();
        expect(createSlots([null, false, true]).default).toBeUndefined();
    });

    it('reads the default slot as undefined when every child is a named slot', () => {
        const only = { type: 'div', props: { slot: 'header' }, key: null, children: [], dom: null };
        const slots = createSlots([only]);
        expect(slots.default).toBeUndefined();
        // ...but the named slot is present.
        expect(typeof (slots as any).header).toBe('function');
    });

    it('makes the documented `slots.x?.() ?? fallback` pattern work for absent slots', () => {
        const slots = createSlots([]);
        expect((slots as any).header?.() ?? 'fallback').toBe('fallback');
        expect(slots.default?.() ?? 'fallback').toBe('fallback');
    });

    it('treats a slot provided via the slots prop as present even if it renders nothing', () => {
        const slots = createSlots([], { maybe: () => null });
        expect(typeof (slots as any).maybe).toBe('function');
        // Provided-but-empty still counts as present; calling normalizes null to [].
        expect((slots as any).maybe()).toEqual([]);
    });

    it('returns a stable accessor function per named slot', () => {
        const slots = createSlots([{ type: 'div', props: { slot: 'header' }, key: null, children: [], dom: null }]);
        expect((slots as any).header).toBe((slots as any).header);
        expect((slots as any).header()).toHaveLength(1);
    });

    it('repeated calls return defensive copies of the cached extraction', () => {
        const child = { type: 'span', props: {}, key: null, children: [], dom: null };
        const slots = createSlots([child]);

        const first = slots.default!();
        first.push('corruption');
        const second = slots.default!();
        expect(second).toEqual([child]);
        expect(second).not.toBe(first);
    });

    it('a slot named __proto__ is stored as a plain key without prototype pollution', () => {
        const child = { type: 'div', props: { slot: '__proto__' }, key: null, children: [], dom: null };
        const slots = createSlots([child]);

        // Only a named child means no default content — reading `default`
        // forces extraction and reads as undefined.
        expect(slots.default).toBeUndefined();

        expect(({} as any).polluted).toBeUndefined();
        expect(Object.prototype.hasOwnProperty.call(Object.prototype, '0')).toBe(false);
        // Repeated access stays clean.
        expect(slots.default).toBeUndefined();

        // The pathological name is still a WORKING named slot: the proxy
        // must not let the inherited __proto__ accessor shadow it.
        expect((slots as any)['__proto__']()).toEqual([child]);
    });

    it('re-extracts and flips slot presence after a version bump swaps the children', () => {
        const a = { type: 'span', props: {}, key: null, children: [], dom: null };
        const b = { type: 'em', props: { slot: 'side' }, key: null, children: [], dom: null };
        const slots = createSlots([a]);

        expect(slots.default!()).toEqual([a]);
        // `side` is absent → undefined.
        expect((slots as any).side).toBeUndefined();

        // The renderer's contract: _children is only reassigned together
        // with a version bump.
        slots._children = [b];
        slots._version.v++;

        // Presence flips both ways: default disappears, side appears.
        expect(slots.default).toBeUndefined();
        expect(typeof (slots as any).side).toBe('function');
        expect((slots as any).side()).toEqual([b]);
    });
});

describe('isPromise (function export)', () => {
    it('detects thenables and rejects non-thenables', () => {
        expect(isPromise(Promise.resolve(1))).toBe(true);
        expect(isPromise({ then: () => {} })).toBe(true);
        expect(isPromise(null)).toBe(false);
        expect(isPromise(42)).toBe(false);
        expect(isPromise({ then: 'no' })).toBe(false);
    });

    it('backs the deprecated Utils.isPromise', () => {
        expect(Utils.isPromise(Promise.resolve(1))).toBe(true);
        expect(Utils.isPromise('x')).toBe(false);
    });
});
