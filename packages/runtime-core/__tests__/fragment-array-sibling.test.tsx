import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { jsx } from '@sigx/runtime-core';

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
