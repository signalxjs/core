/**
 * SSR Client Plugin tests
 * Tests the ssrClientPlugin install behavior and hydrate() method
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the hydration and render internals before importing the plugin
vi.mock('../src/client/hydrate-core', () => ({
    hydrate: vi.fn()
}));

vi.mock('sigx', () => ({
    render: vi.fn()
}));

import { ssrClientPlugin } from '../src/client/plugin';
import { hydrate as hydrateImpl } from '../src/client/hydrate-core';
import { render } from 'sigx';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createMockApp = (rootComponent?: any) => ({
    _rootComponent: rootComponent || null,
    _context: {},
    use: vi.fn()
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ssrClientPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('has correct name property', () => {
        expect(ssrClientPlugin.name).toBe('@sigx/server-renderer/client');
    });

    it('has install function', () => {
        expect(typeof ssrClientPlugin.install).toBe('function');
    });

    describe('install', () => {
        it('adds hydrate method to app', () => {
            const app = createMockApp();
            ssrClientPlugin.install!(app as any);
            expect(typeof (app as any).hydrate).toBe('function');
        });
    });

    describe('hydrate()', () => {
        let app: ReturnType<typeof createMockApp>;
        const RootComponent = { setup: () => {} };

        beforeEach(() => {
            app = createMockApp(RootComponent);
            ssrClientPlugin.install!(app as any);
        });

        it('resolves string selector via document.querySelector', () => {
            const container = document.createElement('div');
            container.id = 'app';
            container.innerHTML = '<span>SSR</span>';
            document.body.appendChild(container);

            try {
                (app as any).hydrate('#app');
                expect(hydrateImpl).toHaveBeenCalledWith(
                    RootComponent,
                    container,
                    app._context
                );
            } finally {
                document.body.removeChild(container);
            }
        });

        it('uses element directly when given an Element', () => {
            const container = document.createElement('div');
            container.innerHTML = '<span>SSR</span>';

            (app as any).hydrate(container);

            expect(hydrateImpl).toHaveBeenCalledWith(
                RootComponent,
                container,
                app._context
            );
        });

        it('throws when container not found (string selector)', () => {
            expect(() => (app as any).hydrate('#nonexistent')).toThrowError(
                /Cannot find container/
            );
        });

        it('throws when no root component on app', () => {
            const noRootApp = createMockApp(null);
            ssrClientPlugin.install!(noRootApp as any);
            const container = document.createElement('div');
            container.innerHTML = '<span>SSR</span>';

            expect(() => (noRootApp as any).hydrate(container)).toThrowError(
                /No root component found/
            );
        });

        it('returns the app for chaining', () => {
            const container = document.createElement('div');
            container.innerHTML = '<span>SSR</span>';
            const result = (app as any).hydrate(container);
            expect(result).toBe(app);
        });

        it('sets container._app to app', () => {
            const container = document.createElement('div');
            container.innerHTML = '<span>SSR</span>';
            (app as any).hydrate(container);
            expect((container as any)._app).toBe(app);
        });

        it('calls hydrateImpl when container has SSR content (element child)', () => {
            const container = document.createElement('div');
            container.innerHTML = '<div>server rendered</div>';

            (app as any).hydrate(container);

            expect(hydrateImpl).toHaveBeenCalledOnce();
            expect(render).not.toHaveBeenCalled();
        });

        it('calls render when container is empty (no SSR content)', () => {
            const container = document.createElement('div');
            // empty container — no children at all → falls back to client render

            (app as any).hydrate(container);

            expect(render).toHaveBeenCalledWith(
                RootComponent,
                container,
                app._context
            );
            expect(hydrateImpl).not.toHaveBeenCalled();
        });

        it('calls render when container only has a comment node', () => {
            const container = document.createElement('div');
            container.appendChild(document.createComment('ssr-placeholder'));

            (app as any).hydrate(container);

            expect(render).toHaveBeenCalledWith(
                RootComponent,
                container,
                app._context
            );
            expect(hydrateImpl).not.toHaveBeenCalled();
        });

        it('calls hydrateImpl when container has a text node (non-comment)', () => {
            const container = document.createElement('div');
            container.appendChild(document.createTextNode('hello'));

            (app as any).hydrate(container);

            expect(hydrateImpl).toHaveBeenCalledOnce();
            expect(render).not.toHaveBeenCalled();
        });
    });
});
