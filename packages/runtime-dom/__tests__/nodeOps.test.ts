/**
 * nodeOps tests — low-level DOM manipulation helpers
 *
 * Validates that every function in the nodeOps object correctly
 * delegates to the underlying DOM API (happy-dom environment).
 */

import { describe, it, expect, vi } from 'vitest';
import { nodeOps } from '../src/index';

describe('nodeOps', () => {
    // --- createElement -----------------------------------------------------------

    describe('createElement', () => {
        it('creates a div element', () => {
            const el = nodeOps.createElement('div');
            expect(el).toBeInstanceOf(HTMLDivElement);
            expect(el.tagName).toBe('DIV');
        });

        it('creates a span element', () => {
            const el = nodeOps.createElement('span');
            expect(el).toBeInstanceOf(HTMLSpanElement);
            expect(el.tagName).toBe('SPAN');
        });

        it('creates an SVG namespace element when isSVG is true', () => {
            const el = nodeOps.createElement('svg', true);
            expect(el.namespaceURI).toBe('http://www.w3.org/2000/svg');
            expect(el.tagName).toBe('svg');
        });

        it('creates a customized built-in element with is option', () => {
            const spy = vi.spyOn(document, 'createElement');
            const el = nodeOps.createElement('button', false, 'my-button');
            expect(el.tagName).toBe('BUTTON');
            expect(spy).toHaveBeenCalledWith('button', { is: 'my-button' });
            spy.mockRestore();
        });
    });

    // --- createText / createComment ----------------------------------------------

    describe('createText', () => {
        it('creates a text node with the given value', () => {
            const node = nodeOps.createText('hello');
            expect(node.nodeType).toBe(Node.TEXT_NODE);
            expect(node.nodeValue).toBe('hello');
        });
    });

    describe('createComment', () => {
        it('creates a comment node', () => {
            const node = nodeOps.createComment('test');
            expect(node.nodeType).toBe(Node.COMMENT_NODE);
            expect(node.nodeValue).toBe('test');
        });
    });

    // --- insert ------------------------------------------------------------------

    describe('insert', () => {
        it('appends child to parent when no anchor is given', () => {
            const parent = document.createElement('div');
            const child = document.createElement('span');
            nodeOps.insert(child, parent);
            expect(parent.childNodes.length).toBe(1);
            expect(parent.firstChild).toBe(child);
        });

        it('inserts child before the anchor element', () => {
            const parent = document.createElement('div');
            const anchor = document.createElement('b');
            parent.appendChild(anchor);

            const child = document.createElement('span');
            nodeOps.insert(child, parent, anchor);

            expect(parent.childNodes.length).toBe(2);
            expect(parent.firstChild).toBe(child);
            expect(parent.lastChild).toBe(anchor);
        });

        it('appends child when anchor is not a child of parent', () => {
            const parent = document.createElement('div');
            const existing = document.createElement('i');
            parent.appendChild(existing);

            const orphanAnchor = document.createElement('b');
            const child = document.createElement('span');
            nodeOps.insert(child, parent, orphanAnchor);

            expect(parent.lastChild).toBe(child);
        });
    });

    // --- remove ------------------------------------------------------------------

    describe('remove', () => {
        it('removes a child from its parent', () => {
            const parent = document.createElement('div');
            const child = document.createElement('span');
            parent.appendChild(child);

            nodeOps.remove(child);
            expect(parent.childNodes.length).toBe(0);
        });

        it('does not throw when child has no parent', () => {
            const orphan = document.createElement('span');
            expect(() => nodeOps.remove(orphan)).not.toThrow();
        });
    });

    // --- setText / setElementText -------------------------------------------------

    describe('setText', () => {
        it('updates the nodeValue of a text node', () => {
            const node = document.createTextNode('old');
            nodeOps.setText(node, 'new text');
            expect(node.nodeValue).toBe('new text');
        });
    });

    describe('setElementText', () => {
        it('sets textContent on an element', () => {
            const el = document.createElement('div');
            nodeOps.setElementText(el, 'content');
            expect(el.textContent).toBe('content');
        });
    });

    // --- parentNode / nextSibling ------------------------------------------------

    describe('parentNode', () => {
        it('returns the parent of a node', () => {
            const parent = document.createElement('div');
            const child = document.createElement('span');
            parent.appendChild(child);

            expect(nodeOps.parentNode(child)).toBe(parent);
        });
    });

    describe('nextSibling', () => {
        it('returns the next sibling of a node', () => {
            const parent = document.createElement('div');
            const first = document.createElement('span');
            const second = document.createElement('b');
            parent.appendChild(first);
            parent.appendChild(second);

            expect(nodeOps.nextSibling(first)).toBe(second);
        });
    });

    // --- querySelector -----------------------------------------------------------

    describe('querySelector', () => {
        it('delegates to document.querySelector', () => {
            const el = document.createElement('div');
            el.id = 'nodeops-test-qs';
            document.body.appendChild(el);

            const found = nodeOps.querySelector!('#nodeops-test-qs');
            expect(found).toBe(el);

            document.body.removeChild(el);
        });
    });

    // --- setScopeId --------------------------------------------------------------

    describe('setScopeId', () => {
        it('sets an empty attribute with the given id', () => {
            const el = document.createElement('div');
            nodeOps.setScopeId!(el, 'v-abc');
            expect(el.hasAttribute('v-abc')).toBe(true);
            expect(el.getAttribute('v-abc')).toBe('');
        });
    });

    // --- cloneNode ---------------------------------------------------------------

    describe('cloneNode', () => {
        it('creates a deep clone of the node', () => {
            const el = document.createElement('div');
            const child = document.createElement('span');
            el.appendChild(child);

            const clone = nodeOps.cloneNode!(el) as HTMLElement;
            expect(clone).not.toBe(el);
            expect(clone.tagName).toBe('DIV');
            expect(clone.childNodes.length).toBe(1);
            expect((clone.firstChild as HTMLElement).tagName).toBe('SPAN');
        });
    });

    // --- getActiveElement --------------------------------------------------------

    describe('getActiveElement', () => {
        it('returns document.activeElement', () => {
            const result = nodeOps.getActiveElement!();
            expect(result).toBe(document.activeElement);
        });
    });
});
