/**
 * Keyed moves of fragment and component children.
 *
 * Regression coverage for the reconciler move path: `vnode.dom` for
 * fragments and components is their TRAILING ANCHOR COMMENT, and the old
 * diff moved only that anchor — reordering a keyed fragment/component
 * child left its rendered content behind. The LIS diff's moveVNode must
 * relocate the whole host range, without remounting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '../src/index';
import { component, signal } from 'sigx';
import { jsx, Fragment } from '@sigx/runtime-core';

describe('keyed fragment/component moves', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        render(null as any, container);
        container.remove();
    });

    it('moves a keyed component child with its content, without remounting', () => {
        const setupCalls = vi.fn();
        const Item = component<{ label: string }>((ctx) => {
            setupCalls();
            return () => <li>{ctx.props.label}</li>;
        });

        const order = signal(['a', 'b', 'c']);
        const List = component(() => {
            return () => (
                <ul>
                    {order.map(label => <Item key={label} label={label} />)}
                </ul>
            );
        });

        render(<List />, container);
        expect([...container.querySelectorAll('li')].map(li => li.textContent)).toEqual(['a', 'b', 'c']);
        expect(setupCalls).toHaveBeenCalledTimes(3);

        order.$set(['c', 'a', 'b']);

        // Content moved with the component — and no remount happened.
        expect([...container.querySelectorAll('li')].map(li => li.textContent)).toEqual(['c', 'a', 'b']);
        expect(setupCalls).toHaveBeenCalledTimes(3);
    });

    it('moves a keyed fragment child with all of its nodes', () => {
        const order = signal(['a', 'b', 'c']);
        // Keyed fragments need the long form — the <>...</> shorthand can't
        // carry a key (a keyless fragment would just patch positionally and
        // never exercise the move path).
        const List = component(() => {
            return () => (
                <div>
                    {order.map(label =>
                        jsx(Fragment, {
                            key: label,
                            children: [
                                <span data-part="1">{label}1</span>,
                                <span data-part="2">{label}2</span>
                            ]
                        })
                    )}
                </div>
            );
        });

        render(<List />, container);
        const texts = () => [...container.querySelectorAll('span')].map(s => s.textContent);
        expect(texts()).toEqual(['a1', 'a2', 'b1', 'b2', 'c1', 'c2']);

        order.$set(['c', 'a', 'b']);

        // Both spans of each fragment must travel together, in order.
        expect(texts()).toEqual(['c1', 'c2', 'a1', 'a2', 'b1', 'b2']);
    });
});
