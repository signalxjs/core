import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';

/**
 * Regression tests for the "fragment array sibling boundary" bug.
 *
 * When JSX produces a mapped array of elements followed by a sibling
 * element, normalizeChild wraps the array as an anonymous Fragment VNode.
 * Appending a new item to the mapped array must place the new DOM node
 * at the end of the fragment, NOT past the trailing sibling.
 */
describe('fragment-wrapped array children — sibling boundary', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    function view(items: string[]) {
        // Matches the reported repro: `{items.map(...)}<button>Add</button>`
        return jsx('div', {
            children: [
                items.map((s) => jsx('span', { key: s, children: s })),
                jsx('button', { children: 'Add' }),
            ],
        });
    }

    function tagsOf(parent: Element): string[] {
        return Array.from(parent.children).map((el) => el.outerHTML);
    }

    it('appends a new mapped entry before the trailing sibling', () => {
        render(view(['a', 'b', 'c']), container);

        const outer = container.firstElementChild as HTMLElement;
        expect(tagsOf(outer)).toEqual([
            '<span>a</span>',
            '<span>b</span>',
            '<span>c</span>',
            '<button>Add</button>',
        ]);

        render(view(['a', 'b', 'c', 'd']), container);
        expect(tagsOf(outer)).toEqual([
            '<span>a</span>',
            '<span>b</span>',
            '<span>c</span>',
            '<span>d</span>',
            '<button>Add</button>',
        ]);
    });

    it('keeps the trailing sibling last across repeated appends', () => {
        render(view(['a', 'b', 'c']), container);
        render(view(['a', 'b', 'c', 'd']), container);
        render(view(['a', 'b', 'c', 'd', 'e']), container);

        const outer = container.firstElementChild as HTMLElement;
        expect(tagsOf(outer)).toEqual([
            '<span>a</span>',
            '<span>b</span>',
            '<span>c</span>',
            '<span>d</span>',
            '<span>e</span>',
            '<button>Add</button>',
        ]);
    });

    it('handles empty-to-filled transitions without displacing the sibling', () => {
        render(view([]), container);
        const outer = container.firstElementChild as HTMLElement;
        // Empty-list still places sibling last.
        expect(outer.lastElementChild?.tagName).toBe('BUTTON');

        render(view(['a', 'b']), container);
        expect(tagsOf(outer)).toEqual([
            '<span>a</span>',
            '<span>b</span>',
            '<button>Add</button>',
        ]);
    });

    // #658: normalizeChild used to give an array child a different vnode
    // shape per length (0 → Comment, 1 → bare item, 2+ → Fragment), so a
    // list crossing the 1↔2 boundary changed type at its position and the
    // reconciler remounted every item — setups re-ran, DOM nodes were
    // recreated — while the final DOM *order* still looked correct.
    it('crossing the 1↔2 boundary patches items instead of remounting them (#658)', () => {
        const setups: string[] = [];
        const Item = component<{ label: string }>(({ props }) => {
            setups.push(props.label);
            return () => jsx('i', { children: props.label });
        }, { name: 'Item' });

        function appView(items: string[]) {
            return jsx('div', {
                children: [
                    jsx('span', { children: 'head' }),
                    items.map((s) => jsx(Item, { label: s }, s)),
                ],
            });
        }

        render(appView(['a']), container);
        expect(setups).toEqual(['a']);
        const outer = container.firstElementChild as HTMLElement;
        const first = outer.querySelector('i');

        render(appView(['a', 'b']), container);
        expect(setups).toEqual(['a', 'b']);
        expect(outer.querySelector('i')).toBe(first);

        render(appView(['a']), container);
        expect(setups).toEqual(['a', 'b']);
        expect(outer.querySelector('i')).toBe(first);
    });

    it('growing 1→2 keeps the existing item DOM node and the sibling last (#658)', () => {
        render(view(['a']), container);
        const outer = container.firstElementChild as HTMLElement;
        const a = outer.querySelector('span');

        render(view(['a', 'b']), container);
        expect(outer.querySelector('span')).toBe(a);
        expect(tagsOf(outer)).toEqual([
            '<span>a</span>',
            '<span>b</span>',
            '<button>Add</button>',
        ]);

        render(view(['a']), container);
        expect(outer.querySelector('span')).toBe(a);
        expect(tagsOf(outer)).toEqual([
            '<span>a</span>',
            '<button>Add</button>',
        ]);
    });

    it('crossing 0↔1 keeps the sibling in place', () => {
        render(view([]), container);
        const outer = container.firstElementChild as HTMLElement;
        expect(outer.lastElementChild?.tagName).toBe('BUTTON');

        render(view(['a']), container);
        expect(tagsOf(outer)).toEqual([
            '<span>a</span>',
            '<button>Add</button>',
        ]);

        render(view([]), container);
        expect(outer.querySelectorAll('span').length).toBe(0);
        expect(outer.lastElementChild?.tagName).toBe('BUTTON');
    });

    it('also works when mapped items have no explicit keys', () => {
        function unkeyedView(items: string[]) {
            return jsx('div', {
                children: [
                    items.map((s) => jsx('span', { children: s })),
                    jsx('button', { children: 'Add' }),
                ],
            });
        }

        render(unkeyedView(['a', 'b', 'c']), container);
        render(unkeyedView(['a', 'b', 'c', 'd']), container);

        const outer = container.firstElementChild as HTMLElement;
        expect(tagsOf(outer)).toEqual([
            '<span>a</span>',
            '<span>b</span>',
            '<span>c</span>',
            '<span>d</span>',
            '<button>Add</button>',
        ]);
    });
});
