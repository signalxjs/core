/**
 * Tests for lazy() component timing issues during navigation.
 *
 * Reproduces:
 * - Lazy route not loading on first navigation
 * - Rapid navigation between lazy routes not rendering
 * - Works once a route has been loaded and shown once
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { component, signal, jsx, lazy } from 'sigx';
import { render } from '@sigx/runtime-dom';

function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function tick(): Promise<void> {
    return new Promise(resolve => queueMicrotask(resolve));
}

describe('lazy() timing and navigation', () => {
    let container: HTMLDivElement;

    afterEach(() => {
        container?.remove();
    });

    // ========================================================================
    // Bug: First lazy route load doesn't render
    // ========================================================================

    it('should render lazy component on first mount (basic async)', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        let resolveLazy!: (mod: { default: typeof Dashboard }) => void;
        const LazyDashboard = lazy(() =>
            new Promise<{ default: typeof Dashboard }>(r => { resolveLazy = r; })
        );

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(LazyDashboard, {}), container);

        // Initially null
        expect(container.querySelector('.dashboard')).toBeNull();

        // Resolve
        resolveLazy({ default: Dashboard });
        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.dashboard')).toBeTruthy();
        expect(container.querySelector('.dashboard')?.textContent).toBe('Dashboard');
    });

    it('should render lazy component on first conditional mount', async () => {
        // Simulates: navigate to admin section, lazy dashboard should load
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        let resolveLazy!: (mod: { default: typeof Dashboard }) => void;
        const LazyDashboard = lazy(() =>
            new Promise<{ default: typeof Dashboard }>(r => { resolveLazy = r; })
        );

        const currentRoute = signal({ path: '/public' });

        // Simulates a simplified RouterView that switches components based on route
        const App = component(() => {
            return () => (
                <div class="app">
                    {currentRoute.path === '/admin/dashboard'
                        ? jsx(LazyDashboard, {})
                        : <div class="public">Public Page</div>
                    }
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        expect(container.querySelector('.public')).toBeTruthy();

        // Navigate to dashboard
        currentRoute.path = '/admin/dashboard';
        await tick();

        // Lazy loading started, null rendered
        expect(container.querySelector('.public')).toBeNull();
        expect(container.querySelector('.dashboard')).toBeNull();

        // Chunk loads
        resolveLazy({ default: Dashboard });
        await tick();
        await tick();
        await wait(10);

        // Dashboard should be visible now
        expect(container.querySelector('.dashboard')).toBeTruthy();
        expect(container.querySelector('.dashboard')?.textContent).toBe('Dashboard');
    });

    // ========================================================================
    // Bug: Rapidly clicking between lazy routes - components don't render
    // ========================================================================

    it('should handle rapid navigation between two lazy routes', async () => {
        const PageA = component(() => {
            return () => <div class="page-a">Page A</div>;
        }, { name: 'PageA' });

        const PageB = component(() => {
            return () => <div class="page-b">Page B</div>;
        }, { name: 'PageB' });

        let resolveA!: (mod: { default: typeof PageA }) => void;
        let resolveB!: (mod: { default: typeof PageB }) => void;

        const LazyA = lazy(() =>
            new Promise<{ default: typeof PageA }>(r => { resolveA = r; })
        );
        const LazyB = lazy(() =>
            new Promise<{ default: typeof PageB }>(r => { resolveB = r; })
        );

        const route = signal({ page: 'a' as 'a' | 'b' | 'home' });

        const App = component(() => {
            return () => (
                <div class="app">
                    {route.page === 'a'
                        ? jsx(LazyA, {})
                        : route.page === 'b'
                            ? jsx(LazyB, {})
                            : <div class="home">Home</div>
                    }
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);
        await tick();

        // Initial: page a (lazy, pending)
        expect(container.querySelector('.page-a')).toBeNull();

        // Rapidly switch: a → b → a → b
        route.page = 'b';
        await tick();
        route.page = 'a';
        await tick();
        route.page = 'b';
        await tick();

        // Now resolve both
        resolveA({ default: PageA });
        resolveB({ default: PageB });
        await tick();
        await tick();
        await wait(20);

        // Currently on page b - it should render
        expect(container.querySelector('.page-b')).toBeTruthy();
        expect(container.querySelector('.page-b')?.textContent).toBe('Page B');
    });

    it('should handle navigating away before lazy resolves, then back', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        let resolveLazy!: (mod: { default: typeof Dashboard }) => void;
        const LazyDashboard = lazy(() =>
            new Promise<{ default: typeof Dashboard }>(r => { resolveLazy = r; })
        );

        const route = signal({ page: 'home' as string });

        const App = component(() => {
            return () => (
                <div class="app">
                    {route.page === 'dashboard'
                        ? jsx(LazyDashboard, {})
                        : <div class="home">Home</div>
                    }
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        // Navigate to dashboard (starts loading)
        route.page = 'dashboard';
        await tick();
        expect(container.querySelector('.dashboard')).toBeNull();

        // Navigate away before it resolves
        route.page = 'home';
        await tick();
        expect(container.querySelector('.home')).toBeTruthy();

        // Chunk resolves while we're on home page
        resolveLazy({ default: Dashboard });
        await tick();
        await wait(10);

        // Navigate back to dashboard - should render immediately (module cached)
        route.page = 'dashboard';
        await tick();
        await wait(10);

        expect(container.querySelector('.dashboard')).toBeTruthy();
        expect(container.querySelector('.dashboard')?.textContent).toBe('Dashboard');
    });

    it('should render when lazy resolves DURING the same tick as mount', async () => {
        // Edge case: the promise resolves synchronously (already cached/resolved)
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        // Promise.resolve() resolves in microtask - very fast
        const LazyDashboard = lazy(
            () => Promise.resolve({ default: Dashboard })
        );

        const route = signal({ page: 'home' as string });

        const App = component(() => {
            return () => (
                <div class="app">
                    {route.page === 'dashboard'
                        ? jsx(LazyDashboard, {})
                        : <div class="home">Home</div>
                    }
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        route.page = 'dashboard';
        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.dashboard')).toBeTruthy();
    });

    // ========================================================================
    // Verify: once loaded, always works
    // ========================================================================

    it('should always work after lazy component has been loaded once', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        const LazyDashboard = lazy(
            () => Promise.resolve({ default: Dashboard })
        );

        // Preload to simulate "already been loaded once"
        await LazyDashboard.preload();

        const route = signal({ page: 'home' as string });

        const App = component(() => {
            return () => (
                <div class="app">
                    {route.page === 'dashboard'
                        ? jsx(LazyDashboard, {})
                        : <div class="home">Home</div>
                    }
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        // Toggle multiple times - should work every time
        for (let i = 0; i < 5; i++) {
            route.page = 'dashboard';
            await tick();
            expect(container.querySelector('.dashboard')).toBeTruthy();

            route.page = 'home';
            await tick();
            expect(container.querySelector('.home')).toBeTruthy();
        }
    });

    // ========================================================================
    // Verify: the .then() callback updates the correct loadState
    // ========================================================================

    it('should update the mounted instance loadState when promise resolves', async () => {
        // This tests the closure capture issue: .then() captures loadState from
        // the first instance. If the component is unmounted and remounted, the
        // new instance has a different loadState.
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        let resolveCount = 0;
        let resolveLazy!: (mod: { default: typeof Dashboard }) => void;
        const LazyDashboard = lazy(() =>
            new Promise<{ default: typeof Dashboard }>(r => {
                resolveCount++;
                resolveLazy = r;
            })
        );

        const route = signal({ page: 'home' as string });

        const App = component(() => {
            return () => (
                <div class="app">
                    {route.page === 'dashboard'
                        ? jsx(LazyDashboard, {})
                        : <div class="home">Home</div>
                    }
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        // First mount of lazy component
        route.page = 'dashboard';
        await tick();

        // lazy() should have created the promise only once
        expect(resolveCount).toBe(1);

        // Navigate away (component unmounted, effect stopped)
        route.page = 'home';
        await tick();

        // Navigate back (new instance, but promise already exists)
        route.page = 'dashboard';
        await tick();

        // Promise created only once (closure shares it)
        expect(resolveCount).toBe(1);

        // Now resolve - should the current (2nd) instance render?
        resolveLazy({ default: Dashboard });
        await tick();
        await tick();
        await wait(20);

        // The dashboard should be visible
        expect(container.querySelector('.dashboard')).toBeTruthy();
    });

    // ========================================================================
    // Bug fix: lazy() should forward props to inner component
    // ========================================================================

    it('should forward props to inner component', async () => {
        const Greeting = component<{ title: string; count: number }>(({ props }) => {
            return () => <div class="greeting">{props.title} ({props.count})</div>;
        }, { name: 'Greeting' });

        let resolveLazy!: (mod: { default: typeof Greeting }) => void;
        const LazyGreeting = lazy(() =>
            new Promise<{ default: typeof Greeting }>(r => { resolveLazy = r; })
        );

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(LazyGreeting, { title: 'Hello', count: 42 }), container);

        // Resolve
        resolveLazy({ default: Greeting });
        await tick();
        await tick();
        await wait(10);

        const el = container.querySelector('.greeting');
        expect(el).toBeTruthy();
        expect(el?.textContent).toBe('Hello (42)');
    });

    it('should forward children to inner component', async () => {
        const Wrapper = component(({ slots }) => {
            return () => <div class="wrapper">{slots.default()}</div>;
        }, { name: 'Wrapper' });

        const LazyWrapper = lazy(
            () => Promise.resolve({ default: Wrapper })
        );

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(LazyWrapper, { children: [<span class="child">Inside</span>] }), container);

        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.wrapper')).toBeTruthy();
        expect(container.querySelector('.child')?.textContent).toBe('Inside');
    });

    it('should forward props reactively when parent updates', async () => {
        const Display = component<{ value: string }>(({ props }) => {
            return () => <div class="display">{props.value}</div>;
        }, { name: 'Display' });

        const LazyDisplay = lazy(
            () => Promise.resolve({ default: Display })
        );

        const state = signal({ text: 'initial' });

        const App = component(() => {
            return () => jsx(LazyDisplay, { value: state.text });
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);

        await tick();
        await tick();
        await wait(10);

        expect(container.querySelector('.display')?.textContent).toBe('initial');

        // Update prop reactively
        state.text = 'updated';
        await tick();
        await wait(10);

        expect(container.querySelector('.display')?.textContent).toBe('updated');
    });

    // ========================================================================
    // Edge case: conditional + parent re-render while lazy is pending
    // ========================================================================

    it('should render lazy component when parent re-renders during pending state', async () => {
        // Tests: parent re-renders for unrelated reason while lazy is pending
        // The lazy component's reactive subscription should survive the parent patch.
        const Panel = component(() => {
            return () => <div class="panel">Panel</div>;
        }, { name: 'Panel' });

        let resolveLazy!: (mod: { default: typeof Panel }) => void;
        const LazyPanel = lazy(() =>
            new Promise<{ default: typeof Panel }>(r => { resolveLazy = r; })
        );

        const counter = signal({ value: 0 });

        const App = component(() => {
            return () => (
                <div class="app">
                    <span class="count">{counter.value}</span>
                    {jsx(LazyPanel, {})}
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);
        await tick();

        // Panel not loaded yet
        expect(container.querySelector('.panel')).toBeNull();
        expect(container.querySelector('.count')?.textContent).toBe('0');

        // Parent re-renders due to unrelated state change
        counter.value = 1;
        await tick();
        expect(container.querySelector('.count')?.textContent).toBe('1');
        expect(container.querySelector('.panel')).toBeNull(); // still loading

        // More parent re-renders
        counter.value = 2;
        await tick();

        // NOW resolve the lazy
        resolveLazy({ default: Panel });
        await tick();
        await tick();
        await wait(10);

        // Panel should render despite parent having re-rendered multiple times
        expect(container.querySelector('.panel')).toBeTruthy();
        expect(container.querySelector('.panel')?.textContent).toBe('Panel');
    });

    it('should render lazy in conditional after branch becomes true post-resolve', async () => {
        // Tests: lazy promise resolves while branch is FALSE,
        // then branch becomes TRUE — component should render immediately
        const Content = component(() => {
            return () => <div class="content">Loaded</div>;
        }, { name: 'Content' });

        const LazyContent = lazy(
            () => Promise.resolve({ default: Content })
        );

        const show = signal({ value: false });

        const App = component(() => {
            return () => (
                <div class="app">
                    {show.value ? jsx(LazyContent, {}) : <div class="placeholder">Hidden</div>}
                </div>
            );
        }, { name: 'App' });

        container = document.createElement('div');
        document.body.appendChild(container);
        render(jsx(App, {}), container);
        await tick();

        expect(container.querySelector('.placeholder')).toBeTruthy();

        // Let the lazy resolve while condition is still false
        await tick();
        await tick();
        await wait(10);

        // Now toggle condition to true — module is already loaded
        show.value = true;
        await tick();
        await wait(10);

        expect(container.querySelector('.content')).toBeTruthy();
        expect(container.querySelector('.content')?.textContent).toBe('Loaded');
    });
});
