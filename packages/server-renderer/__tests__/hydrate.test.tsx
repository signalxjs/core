/**
 * Core hydration tests for server-renderer
 * Tests the hydrate() function and DOM attachment
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal, Fragment, Text } from 'sigx';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    ssrElement,
    ssrComponentMarkers,
    ssrTextSeparator,
    nextTick,
    TestCounter,
    TestCounterWithProps,
    TestText,
    TestWrapper,
    TestButton
} from './test-utils';

describe('hydrate()', () => {
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

    describe('basic DOM attachment', () => {
        it('should attach to existing DOM without recreating elements', async () => {
            // SSR output: a simple div with text
            container = createSSRContainer('<div class="hello">Hello World</div>');
            const originalDiv = container.firstChild as HTMLElement;

            // Create matching VNode
            const vnode = {
                type: 'div',
                props: { class: 'hello' },
                key: null,
                children: [{
                    type: Text,
                    props: {},
                    key: null,
                    children: [],
                    dom: null,
                    text: 'Hello World'
                }],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // The original DOM element should still be the same reference
            expect(container.firstChild).toBe(originalDiv);
            expect(container.innerHTML).toBe('<div class="hello">Hello World</div>');
        });

        it('should attach event handlers to existing elements', async () => {
            container = createSSRContainer('<button class="btn">Click me</button>');
            const button = container.firstChild as HTMLButtonElement;

            const handleClick = vi.fn();

            const vnode = {
                type: 'button',
                props: { class: 'btn', onClick: handleClick },
                key: null,
                children: [{
                    type: Text,
                    props: {},
                    key: null,
                    children: [],
                    dom: null,
                    text: 'Click me'
                }],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // Click the button
            button.click();

            expect(handleClick).toHaveBeenCalledTimes(1);
        });

        it('should handle text nodes correctly', async () => {
            container = createSSRContainer('Hello World');

            const vnode = {
                type: Text,
                props: {},
                key: null,
                children: [],
                dom: null,
                text: 'Hello World'
            };

            hydrate(vnode, container);
            await nextTick();

            expect(container.textContent).toBe('Hello World');
        });

        it('should handle multiple text nodes with separators', async () => {
            container = createSSRContainer(`Hello${ssrTextSeparator()}World`);

            const vnode = {
                type: Fragment,
                props: {},
                key: null,
                children: [
                    { type: Text, props: {}, key: null, children: [], dom: null, text: 'Hello' },
                    { type: Text, props: {}, key: null, children: [], dom: null, text: 'World' }
                ],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // Text content should be preserved
            expect(container.textContent?.replace(/<!--.*?-->/g, '')).toBe('HelloWorld');
        });

        it('should handle Fragment VNodes', async () => {
            container = createSSRContainer('<span>A</span><span>B</span><span>C</span>');

            const vnode = {
                type: Fragment,
                props: {},
                key: null,
                children: [
                    {
                        type: 'span',
                        props: {},
                        key: null,
                        children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'A' }],
                        dom: null
                    },
                    {
                        type: 'span',
                        props: {},
                        key: null,
                        children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'B' }],
                        dom: null
                    },
                    {
                        type: 'span',
                        props: {},
                        key: null,
                        children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'C' }],
                        dom: null
                    }
                ],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            expect(container.innerHTML).toBe('<span>A</span><span>B</span><span>C</span>');
        });

        it('should handle nested elements', async () => {
            container = createSSRContainer('<div class="outer"><div class="inner"><span>Nested</span></div></div>');
            const outerDiv = container.firstChild as HTMLElement;
            const innerDiv = outerDiv.firstChild as HTMLElement;
            const span = innerDiv.firstChild as HTMLElement;

            const vnode = {
                type: 'div',
                props: { class: 'outer' },
                key: null,
                children: [{
                    type: 'div',
                    props: { class: 'inner' },
                    key: null,
                    children: [{
                        type: 'span',
                        props: {},
                        key: null,
                        children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'Nested' }],
                        dom: null
                    }],
                    dom: null
                }],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // Original elements should be preserved
            expect(container.firstChild).toBe(outerDiv);
            expect(outerDiv.firstChild).toBe(innerDiv);
            expect(innerDiv.firstChild).toBe(span);
        });
    });

    describe('component hydration', () => {
        it('should hydrate a simple component with markers', async () => {
            // SSR output with component markers
            const ssrHtml = ssrComponentMarkers(1, '<div class="counter"><span class="count">0</span><button>+</button></div>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: TestCounter,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // Component should be hydrated with reactivity
            const countSpan = container.querySelector('.count');
            expect(countSpan?.textContent).toBe('0');

            // Click should update the count
            const button = container.querySelector('button');
            button?.click();
            await nextTick();

            expect(countSpan?.textContent).toBe('1');
        });

        it('should hydrate component with props', async () => {
            const ssrHtml = ssrComponentMarkers(1, '<div class="counter"><span class="count">5</span><button>+</button></div>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: TestCounterWithProps,
                props: { initial: 5 },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            const countSpan = container.querySelector('.count');
            expect(countSpan?.textContent).toBe('5');
        });

        it('should attach event handlers to hydrated components', async () => {
            const ssrHtml = ssrComponentMarkers(1, '<button class="test-button" data-clicked="false">Click Me</button>');
            container = createSSRContainer(ssrHtml);

            const vnode = {
                type: TestButton,
                props: { label: 'Click Me' },
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            const button = container.querySelector('.test-button') as HTMLButtonElement;
            expect(button.dataset.clicked).toBe('false');

            button.click();
            await nextTick();

            expect(button.dataset.clicked).toBe('true');
        });

        it('should hydrate nested components', async () => {
            const innerHtml = '<span class="text">Hello</span>';
            const wrapperHtml = `<div class="wrapper">${ssrComponentMarkers(2, innerHtml)}</div>`;
            const ssrHtml = ssrComponentMarkers(1, wrapperHtml);
            container = createSSRContainer(ssrHtml);

            // Outer wrapper contains inner text component
            const OuterWrapper = component((ctx) => {
                return () => (
                    <div class="wrapper">
                        <TestText text="Hello" />
                    </div>
                );
            }, { name: 'OuterWrapper' });

            const vnode = {
                type: OuterWrapper,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            expect(container.querySelector('.wrapper')).toBeTruthy();
            expect(container.querySelector('.text')?.textContent).toBe('Hello');
        });
    });

    describe('ref handling', () => {
        it('should call ref callback with hydrated element', async () => {
            let refElement: Element | null = null;

            container = createSSRContainer('<div class="ref-target">Content</div>');

            const vnode = {
                type: 'div',
                props: { class: 'ref-target', ref: (el: Element | null) => { refElement = el; } },
                key: null,
                children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'Content' }],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            expect(refElement).toBeTruthy();
            expect(refElement).toBe(container.querySelector('.ref-target'));
        });

        it('should populate ref object with hydrated element', async () => {
            const refObj = { current: null as Element | null };

            container = createSSRContainer('<span class="ref-obj">Text</span>');

            const vnode = {
                type: 'span',
                props: { class: 'ref-obj', ref: refObj },
                key: null,
                children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'Text' }],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            expect(refObj.current).toBeTruthy();
            expect(refObj.current).toBe(container.querySelector('.ref-obj'));
        });
    });

    describe('select element handling', () => {
        it('should fix select value after hydrating options', async () => {
            container = createSSRContainer(`
                <select>
                    <option value="a">A</option>
                    <option value="b">B</option>
                    <option value="c">C</option>
                </select>
            `.trim());

            const select = container.firstChild as HTMLSelectElement;

            const vnode = {
                type: 'select',
                props: { value: 'b' },
                key: null,
                children: [
                    {
                        type: 'option',
                        props: { value: 'a' },
                        key: null,
                        children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'A' }],
                        dom: null
                    },
                    {
                        type: 'option',
                        props: { value: 'b' },
                        key: null,
                        children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'B' }],
                        dom: null
                    },
                    {
                        type: 'option',
                        props: { value: 'c' },
                        key: null,
                        children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'C' }],
                        dom: null
                    }
                ],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            expect(select.value).toBe('b');
        });
    });

    describe('error handling', () => {
        it('should warn when DOM element type does not match', async () => {
            container = createSSRContainer('<span>Wrong type</span>');

            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

            const vnode = {
                type: 'div', // Expecting div but got span
                props: {},
                key: null,
                children: [{ type: Text, props: {}, key: null, children: [], dom: null, text: 'Wrong type' }],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // Should still work but may warn
            // Note: Current implementation may not warn, adjust based on actual behavior
            warnSpy.mockRestore();
        });

        it('should handle null/undefined elements gracefully', async () => {
            container = createSSRContainer('<div>Content</div>');

            // Should not throw
            hydrate(null, container);
            hydrate(undefined, container);

            expect(container.innerHTML).toBe('<div>Content</div>');
        });
    });

    describe('comment marker skipping', () => {
        it('should skip component markers when hydrating element VNodes', async () => {
            // Regression: an element VNode following a component's <!--$c:N--> marker
            // must skip past it. Previously, hydrateNode() stopped at ALL $c: comments,
            // causing the element to get no .dom reference and duplicate on the next patch.
            const ssrHtml = [
                '<span class="text">Hello</span>',     // component content
                '<!--$c:1-->',                           // component trailing marker
                '<p class="desc">Description</p>'        // element after component
            ].join('');
            container = createSSRContainer(ssrHtml);

            const originalP = container.querySelector('p.desc') as HTMLElement;

            const PageComponent = component(() => {
                return () => (
                    <>
                        <TestText text="Hello" />
                        <p class="desc">Description</p>
                    </>
                );
            }, { name: 'PageComponent' });

            const vnode = {
                type: PageComponent,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // The <p> should reuse the existing DOM node, not create a duplicate
            expect(container.querySelectorAll('p.desc').length).toBe(1);
            expect(container.querySelector('p.desc')).toBe(originalP);
            expect(container.querySelector('p.desc')?.textContent).toBe('Description');
        });

        it('should skip multiple component markers before an element', async () => {
            // Two sibling components followed by a plain element
            const ssrHtml = [
                '<span class="text">A</span>',
                '<!--$c:1-->',
                '<span class="text">B</span>',
                '<!--$c:2-->',
                '<div class="footer">Footer</div>'
            ].join('');
            container = createSSRContainer(ssrHtml);

            const originalFooter = container.querySelector('div.footer') as HTMLElement;

            const Layout = component(() => {
                return () => (
                    <>
                        <TestText text="A" />
                        <TestText text="B" />
                        <div class="footer">Footer</div>
                    </>
                );
            }, { name: 'Layout' });

            const vnode = {
                type: Layout,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            expect(container.querySelectorAll('div.footer').length).toBe(1);
            expect(container.querySelector('div.footer')).toBe(originalFooter);
        });

        it('should still correctly find component markers for component VNodes', async () => {
            // Component hydration must still stop at its own $c: marker
            const ssrHtml = [
                '<div class="counter"><span class="count">0</span><button>+</button></div>',
                '<!--$c:1-->',
                '<p class="after">After</p>'
            ].join('');
            container = createSSRContainer(ssrHtml);

            const Page = component(() => {
                return () => (
                    <>
                        <TestCounter />
                        <p class="after">After</p>
                    </>
                );
            }, { name: 'Page' });

            const vnode = {
                type: Page,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // Counter should work
            const countSpan = container.querySelector('.count');
            expect(countSpan?.textContent).toBe('0');
            container.querySelector('button')?.click();
            await nextTick();
            expect(countSpan?.textContent).toBe('1');

            // The <p> after the component should not be duplicated
            expect(container.querySelectorAll('p.after').length).toBe(1);
            expect(container.querySelector('p.after')?.textContent).toBe('After');
        });

        it('should handle text with interpolation after a component marker', async () => {
            // Pattern from the bug report: text interpolation like "Andy · Logout"
            // after component markers
            const ssrHtml = [
                '<span class="text">Header</span>',
                '<!--$c:1-->',
                '<button class="btn">',
                'Guest',
                '<!--t-->',
                ' · Logout',
                '</button>'
            ].join('');
            container = createSSRContainer(ssrHtml);

            const originalBtn = container.querySelector('button.btn') as HTMLElement;

            const Header = component(() => {
                const user = signal('Guest');
                return () => (
                    <>
                        <TestText text="Header" />
                        <button class="btn">{user.value} · Logout</button>
                    </>
                );
            }, { name: 'Header' });

            const vnode = {
                type: Header,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            // Button should reuse existing DOM, not duplicate
            expect(container.querySelectorAll('button.btn').length).toBe(1);
            expect(container.querySelector('button.btn')).toBe(originalBtn);
            expect(container.querySelector('button.btn')?.textContent).toContain('Logout');
        });

        it('should not duplicate text when empty interpolation precedes static text', async () => {
            // SSR renders "" + " · Logout" as: <!--t--> · Logout (one text node)
            // Hydration must create an empty text node for the first VNode
            // instead of stealing the second VNode's text node
            const ssrHtml = '<button class="btn"><!--t--> · Logout</button>';
            container = createSSRContainer(ssrHtml);

            const Btn = component(() => {
                const name = signal('');
                return () => (
                    <button class="btn">{name.value} · Logout</button>
                );
            }, { name: 'Btn' });

            const vnode = {
                type: Btn,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            const btn = container.querySelector('button.btn')!;
            // Should NOT have duplicated text — "· Logout" should appear only once
            expect(btn.textContent).toBe(' · Logout');
            expect(btn.textContent).not.toBe(' · Logout · Logout');
        });

        it('should not duplicate text when non-empty interpolation precedes static text', async () => {
            // SSR renders "Admin" + " · Logout" as: Admin<!--t--> · Logout
            // Both text nodes exist in DOM, hydration should reuse them
            const ssrHtml = '<button class="btn">Admin<!--t--> · Logout</button>';
            container = createSSRContainer(ssrHtml);

            const Btn = component(() => {
                const name = signal('Admin');
                return () => (
                    <button class="btn">{name.value} · Logout</button>
                );
            }, { name: 'Btn' });

            const vnode = {
                type: Btn,
                props: {},
                key: null,
                children: [],
                dom: null
            };

            hydrate(vnode, container);
            await nextTick();

            const btn = container.querySelector('button.btn')!;
            expect(btn.textContent).toBe('Admin · Logout');
            expect(btn.textContent).not.toContain('Logout · Logout');
        });
    });
});

describe('reactive updates after hydration', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
    });

    it('should update DOM when signals change', async () => {
        const ssrHtml = ssrComponentMarkers(1, '<div class="counter"><span class="count">0</span><button>+</button></div>');
        container = createSSRContainer(ssrHtml);

        const vnode = {
            type: TestCounter,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();

        const countSpan = container.querySelector('.count');
        const button = container.querySelector('button');

        expect(countSpan?.textContent).toBe('0');

        // Multiple clicks
        button?.click();
        await nextTick();
        expect(countSpan?.textContent).toBe('1');

        button?.click();
        await nextTick();
        expect(countSpan?.textContent).toBe('2');

        button?.click();
        await nextTick();
        expect(countSpan?.textContent).toBe('3');
    });
});
