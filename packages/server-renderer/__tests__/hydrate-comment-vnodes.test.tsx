/**
 * Tests for Comment VNode SSR hydration
 *
 * Verifies that:
 * 1. SSR emits <!---> placeholders for falsy conditional children
 * 2. Hydration assigns .dom to Comment VNodes
 * 3. Reactive updates after hydration don't crash
 *
 * These tests are written TDD-style — they should FAIL against the current
 * (buggy) code and PASS once the fixes are applied.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { component, Comment, Text } from 'sigx';
import { renderToString } from '../src/server/index';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    nextTick,
} from './test-utils';

// ─── SSR Output Tests ──────────────────────────────────────────────

describe('SSR Comment VNode rendering', () => {
    it('should emit <!---> for falsy conditional children', async () => {
        const App = component(() => {
            return () => (
                <div>
                    {false && <span>hidden</span>}
                    <p>visible</p>
                </div>
            );
        }, { name: 'App' });

        const html = await renderToString(<App />);
        // The falsy child should produce an empty comment placeholder
        expect(html).toContain('<!---->');
        expect(html).toContain('<p>visible</p>');
    });

    it('should emit <!---> for null conditional children', async () => {
        const showHidden = false as boolean;
        const App = component(() => {
            return () => (
                <div>
                    {showHidden && <span>hidden</span>}
                    <p>visible</p>
                </div>
            );
        }, { name: 'App' });

        const html = await renderToString(<App />);
        expect(html).toContain('<!---->');
    });

    it('should emit multiple <!---> for multiple falsy children', async () => {
        const App = component(() => {
            return () => (
                <div>
                    {false && <button>A</button>}
                    {false && <button>B</button>}
                    <span>always</span>
                </div>
            );
        }, { name: 'App' });

        const html = await renderToString(<App />);
        // Should have two comment placeholders
        const commentCount = (html.match(/<!---->/g) || []).length;
        expect(commentCount).toBe(2);
        expect(html).toContain('<span>always</span>');
    });

    it('should emit <!---> alongside rendered conditional siblings', async () => {
        const App = component(() => {
            return () => (
                <div>
                    {true && <button>Mode A</button>}
                    {false && <button>Mode B</button>}
                    <span>always</span>
                </div>
            );
        }, { name: 'App' });

        const html = await renderToString(<App />);
        expect(html).toContain('<button>Mode A</button>');
        expect(html).toContain('<!---->');
        expect(html).toContain('<span>always</span>');
    });
});

// ─── Hydration Tests ───────────────────────────────────────────────

describe('Hydration of Comment VNodes', () => {
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

    it('should assign .dom to Comment VNodes during hydration', async () => {
        // Simulate SSR HTML with a comment placeholder for a falsy child
        container = createSSRContainer(
            '<div><!----><p>visible</p></div>'
        );

        const App = component(() => {
            return () => (
                <div>
                    {false && <span>hidden</span>}
                    <p>visible</p>
                </div>
            );
        }, { name: 'App' });

        // Should not throw during hydration
        expect(() => hydrate(<App />, container)).not.toThrow();
        await nextTick();

        // The p element should still be there
        expect(container.querySelector('p')?.textContent).toBe('visible');
    });

    it('should not crash when toggling conditional children after hydration', async () => {
        // SSR output: mode='a' is active, mode='b' is falsy comment
        container = createSSRContainer(
            '<div><button>Mode A</button><!----><span>always</span></div>'
        );

        let stateRef: any;
        const App = component((ctx) => {
            const state = ctx.signal({ mode: 'a' as string });
            stateRef = state;
            return () => (
                <div>
                    {state.mode === 'a' && <button>Mode A</button>}
                    {state.mode === 'b' && <button>Mode B</button>}
                    <span>always</span>
                </div>
            );
        }, { name: 'App' });

        hydrate(<App />, container);
        await nextTick();

        // Toggle mode — this is the crash site from the bug report
        expect(() => {
            stateRef.mode = 'b';
        }).not.toThrow();
        await nextTick();

        expect(container.textContent).toContain('Mode B');
        expect(container.textContent).toContain('always');
        expect(container.textContent).not.toContain('Mode A');
    });

    it('should handle multiple conditional children toggling after hydration', async () => {
        // SSR: admin section active, flows inactive
        container = createSSRContainer(
            '<div><button>Admin Menu</button><!----><span>Title</span></div>'
        );

        let stateRef: any;
        const App = component((ctx) => {
            const state = ctx.signal({ section: 'admin' as string });
            stateRef = state;
            return () => (
                <div>
                    {state.section === 'admin' && <button>Admin Menu</button>}
                    {state.section === 'flows' && <button>Flows Menu</button>}
                    <span>Title</span>
                </div>
            );
        }, { name: 'App' });

        hydrate(<App />, container);
        await nextTick();

        // Toggle from admin to flows
        expect(() => {
            stateRef.section = 'flows';
        }).not.toThrow();
        await nextTick();

        expect(container.textContent).toContain('Flows Menu');
        expect(container.textContent).not.toContain('Admin Menu');
    });

    it('should handle toggling back and forth after hydration', async () => {
        container = createSSRContainer(
            '<div><button>A</button><!----><span>static</span></div>'
        );

        let stateRef: any;
        const App = component((ctx) => {
            const state = ctx.signal({ show: 'a' as string });
            stateRef = state;
            return () => (
                <div>
                    {state.show === 'a' && <button>A</button>}
                    {state.show === 'b' && <button>B</button>}
                    <span>static</span>
                </div>
            );
        }, { name: 'App' });

        hydrate(<App />, container);
        await nextTick();

        // Toggle a → b → a — should survive round-trip
        expect(() => { stateRef.show = 'b'; }).not.toThrow();
        await nextTick();
        expect(container.textContent).toContain('B');

        expect(() => { stateRef.show = 'a'; }).not.toThrow();
        await nextTick();
        expect(container.textContent).toContain('A');
    });

    it('should hydrate when all conditional children are falsy', async () => {
        container = createSSRContainer(
            '<div><!----><span>always</span></div>'
        );

        const App = component(() => {
            return () => (
                <div>
                    {false && <button>never</button>}
                    <span>always</span>
                </div>
            );
        }, { name: 'App' });

        expect(() => hydrate(<App />, container)).not.toThrow();
        await nextTick();

        expect(container.querySelector('span')?.textContent).toBe('always');
    });
});
