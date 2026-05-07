/**
 * Tests for lazy() component hydration and CSR mount behavior.
 * 
 * Reproduces two bugs:
 * 1. SSR Hydration Mismatch - lazy component returns null on first render during hydration,
 *    causing duplicate DOM when it resolves.
 * 2. CSR Conditional Mount - lazy component fails to render when mounted inside a 
 *    conditional branch for the first time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { component, signal, jsx, Fragment, Text, lazy, type ComponentFactory } from 'sigx';
import { render } from '@sigx/runtime-dom';
import { hydrate } from '../src/client/hydrate-core';
import {
    createSSRContainer,
    cleanupContainer,
    cleanupScripts,
    ssrComponentMarkers,
    nextTick,
} from './test-utils';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a controllable lazy component for testing.
 * Returns the lazy factory plus a resolve/reject function.
 */
function createControllableLazy(componentFactory: ComponentFactory<any, any, any>) {
    let resolveFn!: (mod: any) => void;
    let rejectFn!: (err: Error) => void;

    const LazyComp = lazy<ComponentFactory<any, any, any>>(() => {
        return new Promise<{ default: ComponentFactory<any, any, any> }>((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });
    });

    const resolveWith = () => {
        resolveFn({ default: componentFactory });
    };

    const rejectWith = (err: Error) => {
        rejectFn(err);
    };

    return { LazyComp, resolveWith, rejectWith };
}

/**
 * Create a lazy component that resolves with a delay
 */
function createDelayedLazy(componentFactory: ComponentFactory<any, any, any>, delayMs: number = 10) {
    return lazy<ComponentFactory<any, any, any>>(() => {
        return new Promise<{ default: ComponentFactory<any, any, any> }>((resolve) => {
            setTimeout(() => {
                resolve({ default: componentFactory });
            }, delayMs);
        });
    });
}

/**
 * Create a pre-resolved lazy component (simulates cached chunk)
 */
function createResolvedLazy(componentFactory: ComponentFactory<any, any, any>) {
    return lazy<ComponentFactory<any, any, any>>(() => Promise.resolve({ default: componentFactory }));
}

/**
 * Wait for a specified number of milliseconds
 */
function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Bug 1: SSR Hydration Mismatch with lazy() components
// ============================================================================

describe('Bug 1: lazy() SSR hydration mismatch', () => {
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

    it('should NOT duplicate content when lazy component resolves after hydration', async () => {
        // Inner component that the lazy wrapper will resolve to
        const Dashboard = component(() => {
            return () => <div class="dashboard"><h1>Dashboard</h1></div>;
        }, { name: 'Dashboard' });

        const { LazyComp, resolveWith } = createControllableLazy(Dashboard);

        // SSR output: the server fully rendered the Dashboard content
        // The lazy component on the server resolved and rendered: <div class="dashboard"><h1>Dashboard</h1></div>
        // Wrapped in the LazyWrapper component marker and the Dashboard component marker
        const dashboardHtml = '<div class="dashboard"><h1>Dashboard</h1></div>';
        const innerComponent = ssrComponentMarkers(2, dashboardHtml);
        const ssrHtml = ssrComponentMarkers(1, innerComponent);
        container = createSSRContainer(ssrHtml);

        // Verify initial state - one dashboard
        expect(container.querySelectorAll('.dashboard').length).toBe(1);

        // Hydrate with the lazy component (which hasn't loaded yet on client)
        const vnode = {
            type: LazyComp,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();

        // At this point the lazy wrapper returned null on first render.
        // The SSR DOM should still be visible (one instance)
        expect(container.querySelectorAll('.dashboard').length).toBe(1);

        // Now resolve the lazy component
        resolveWith();
        await nextTick();
        await wait(50); // Give reactive effects time to propagate

        // BUG: The dashboard should appear exactly once, not twice
        // The hydrator should have used the existing SSR DOM, not mounted a duplicate
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelector('.dashboard h1')?.textContent).toBe('Dashboard');
    });

    it('should NOT duplicate content when lazy component resolves immediately via microtask', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard Content</div>;
        }, { name: 'Dashboard' });

        // Lazy that resolves immediately (like a cached module)
        const LazyDashboard = createResolvedLazy(Dashboard);

        const dashboardHtml = '<div class="dashboard">Dashboard Content</div>';
        const innerComponent = ssrComponentMarkers(2, dashboardHtml);
        const ssrHtml = ssrComponentMarkers(1, innerComponent);
        container = createSSRContainer(ssrHtml);

        const vnode = {
            type: LazyDashboard,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();
        await wait(50);

        // Should be exactly one instance
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
    });

    it('should properly hydrate lazy component that was already loaded (preloaded)', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Preloaded Dashboard</div>;
        }, { name: 'Dashboard' });

        // Preload the lazy component first
        const LazyDashboard = createResolvedLazy(Dashboard);
        await LazyDashboard.preload();

        const dashboardHtml = '<div class="dashboard">Preloaded Dashboard</div>';
        const innerComponent = ssrComponentMarkers(2, dashboardHtml);
        const ssrHtml = ssrComponentMarkers(1, innerComponent);
        container = createSSRContainer(ssrHtml);

        const vnode = {
            type: LazyDashboard,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();

        // Preloaded component should hydrate synchronously - no duplication
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelector('.dashboard')?.textContent).toBe('Preloaded Dashboard');
    });

    it('should clean up SSR DOM when lazy component eventually renders different content', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard-v2">Updated Dashboard</div>;
        }, { name: 'Dashboard' });

        const { LazyComp, resolveWith } = createControllableLazy(Dashboard);

        // SSR rendered some content for this component
        const ssrHtml = ssrComponentMarkers(1, '<div class="dashboard-v1">Old Dashboard</div>');
        container = createSSRContainer(ssrHtml);

        const vnode = {
            type: LazyComp,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();

        // SSR content should still be present
        expect(container.querySelectorAll('.dashboard-v1').length).toBe(1);

        // Resolve with component that renders different content
        resolveWith();
        await nextTick();
        await wait(50);

        // Old SSR content should be gone, new content should be present
        expect(container.querySelectorAll('.dashboard-v1').length).toBe(0);
        expect(container.querySelectorAll('.dashboard-v2').length).toBe(1);
    });
});

// ============================================================================
// Bug 3: [Hydrate] Expected element but got: null with lazy() sibling elements
// ============================================================================

describe('Bug 3: lazy() hydration null element with siblings', () => {
    let container: HTMLDivElement;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        cleanupScripts();
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
        consoleWarnSpy.mockRestore();
    });

    it('should NOT warn "[Hydrate] Expected element but got: null" when lazy has sibling elements', async () => {
        // The inner component that the lazy wrapper will resolve to
        const Dashboard = component(() => {
            return () => <div class="dashboard"><h1>Dashboard</h1></div>;
        }, { name: 'Dashboard' });

        const { LazyComp, resolveWith } = createControllableLazy(Dashboard);

        // A sibling component rendered after the lazy component
        const clicked = signal(false);
        const Footer = component(() => {
            return () => <footer class="footer" onClick={() => { clicked.value = true; }}>Footer Content</footer>;
        }, { name: 'Footer' });

        // Parent layout that renders lazy component followed by a sibling
        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {jsx(LazyComp, {})}
                    {jsx(Footer, {})}
                </div>
            );
        }, { name: 'Layout' });

        // SSR output: server fully resolved the lazy component
        // Component tree: Layout(1) > div.layout > [LazyWrapper(2) > Dashboard(3), Footer(4)]
        // SSR HTML: <div class="layout"><div class="dashboard"><h1>Dashboard</h1></div><!--$c:3--><!--$c:2--><footer class="footer">Footer Content</footer><!--$c:4--></div><!--$c:1-->
        const dashboardHtml = '<div class="dashboard"><h1>Dashboard</h1></div>';
        const lazyContent = ssrComponentMarkers(3, dashboardHtml); // Dashboard inner marker
        const lazyWrapper = ssrComponentMarkers(2, lazyContent);   // LazyWrapper marker
        const footerHtml = '<footer class="footer">Footer Content</footer>';
        const footerComponent = ssrComponentMarkers(4, footerHtml);
        const layoutContent = `<div class="layout">${lazyWrapper}${footerComponent}</div>`;
        const ssrHtml = ssrComponentMarkers(1, layoutContent);

        container = createSSRContainer(ssrHtml);

        // Verify initial SSR DOM
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelectorAll('.footer').length).toBe(1);

        // Hydrate - LazyComp hasn't loaded its chunk yet, will return null on first render
        const vnode = {
            type: Layout,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();

        // The hydration warning should NOT have been emitted
        const hydrateWarnings = consoleWarnSpy.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('[Hydrate] Expected element but got:')
        );
        expect(hydrateWarnings).toHaveLength(0);

        // Both elements should still be in the DOM (SSR content preserved)
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelectorAll('.footer').length).toBe(1);
        expect(container.querySelector('.footer')?.textContent).toBe('Footer Content');

        // Footer's event handler should have been attached during hydration
        const footerEl = container.querySelector('.footer') as HTMLElement;
        footerEl.click();
        expect(clicked.value).toBe(true);

        // Resolve the lazy component
        resolveWith();
        await nextTick();
        await wait(50);

        // After resolution, content should still be correct (no duplication)
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelectorAll('.footer').length).toBe(1);
    });

    it('should correctly hydrate multiple siblings after a lazy component', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        const { LazyComp, resolveWith } = createControllableLazy(Dashboard);

        const Sidebar = component(() => {
            return () => <aside class="sidebar">Sidebar</aside>;
        }, { name: 'Sidebar' });

        const Footer = component(() => {
            return () => <footer class="footer">Footer</footer>;
        }, { name: 'Footer' });

        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {jsx(LazyComp, {})}
                    {jsx(Sidebar, {})}
                    {jsx(Footer, {})}
                </div>
            );
        }, { name: 'Layout' });

        // SSR: Layout(1) > [LazyWrapper(2) > Dashboard(3), Sidebar(4), Footer(5)]
        const dashboardContent = ssrComponentMarkers(3, '<div class="dashboard">Dashboard</div>');
        const lazyWrapper = ssrComponentMarkers(2, dashboardContent);
        const sidebar = ssrComponentMarkers(4, '<aside class="sidebar">Sidebar</aside>');
        const footer = ssrComponentMarkers(5, '<footer class="footer">Footer</footer>');
        const layoutContent = `<div class="layout">${lazyWrapper}${sidebar}${footer}</div>`;
        const ssrHtml = ssrComponentMarkers(1, layoutContent);

        container = createSSRContainer(ssrHtml);

        const vnode = {
            type: Layout,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();

        // No hydration warnings
        const hydrateWarnings = consoleWarnSpy.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('[Hydrate] Expected element but got:')
        );
        expect(hydrateWarnings).toHaveLength(0);

        // All three components should have their DOM intact
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelectorAll('.sidebar').length).toBe(1);
        expect(container.querySelectorAll('.footer').length).toBe(1);

        // Resolve lazy and verify no duplication
        resolveWith();
        await nextTick();
        await wait(50);

        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelectorAll('.sidebar').length).toBe(1);
        expect(container.querySelectorAll('.footer').length).toBe(1);
    });
});

// ============================================================================
// Bug 4: SSR rendered nothing for lazy, but client has chunk loaded
// ============================================================================

describe('Bug 4: lazy() SSR rendered null but client renders content', () => {
    let container: HTMLDivElement;
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        cleanupScripts();
        consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        if (container) {
            cleanupContainer(container);
        }
        cleanupScripts();
        consoleWarnSpy.mockRestore();
    });

    it('should mount fresh when SSR rendered nothing but client has content (pre-loaded lazy)', async () => {
        // The actual component
        const Dashboard = component(() => {
            return () => <div class="dashboard"><h1>Dashboard</h1></div>;
        }, { name: 'Dashboard' });

        // Pre-loaded lazy component — resolves synchronously because chunk is cached
        const LazyDashboard = createResolvedLazy(Dashboard);
        await LazyDashboard.preload();

        // A parent that wraps the lazy component (like UnifiedLayout > RouterView > LazyPage)
        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {jsx(LazyDashboard, {})}
                </div>
            );
        }, { name: 'Layout' });

        // SSR output: the lazy component returned null on the server (chunk not available),
        // so only component markers were emitted — NO actual HTML content for the lazy part.
        // Layout(1) > div.layout > LazyWrapper(2) rendered nothing > <!--$c:2-->
        const lazyWrapper = ssrComponentMarkers(2, ''); // Empty — SSR lazy returned null
        const layoutContent = `<div class="layout">${lazyWrapper}</div>`;
        const ssrHtml = ssrComponentMarkers(1, layoutContent);

        container = createSSRContainer(ssrHtml);

        // Verify: no dashboard in SSR content
        expect(container.querySelectorAll('.dashboard').length).toBe(0);

        // Hydrate — the lazy component is already pre-loaded, so it renders content immediately
        const vnode = {
            type: Layout,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();
        await wait(50);

        // Should NOT warn "Expected element but got: null"
        const hydrateWarnings = consoleWarnSpy.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('[Hydrate] Expected element')
        );
        expect(hydrateWarnings).toHaveLength(0);

        // Dashboard should be mounted fresh (not hydrated against non-existent DOM)
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelector('.dashboard h1')?.textContent).toBe('Dashboard');
    });

    it('should mount fresh when SSR rendered nothing and lazy resolves via microtask', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Quick Dashboard</div>;
        }, { name: 'Dashboard' });

        // Resolves via microtask (Promise.resolve)
        const LazyDashboard = createResolvedLazy(Dashboard);

        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {jsx(LazyDashboard, {})}
                </div>
            );
        }, { name: 'Layout' });

        // SSR: lazy returned null → empty markers
        const lazyWrapper = ssrComponentMarkers(2, '');
        const layoutContent = `<div class="layout">${lazyWrapper}</div>`;
        const ssrHtml = ssrComponentMarkers(1, layoutContent);
        container = createSSRContainer(ssrHtml);

        const vnode = {
            type: Layout,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();
        await wait(50);

        // No warnings
        const hydrateWarnings = consoleWarnSpy.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('[Hydrate] Expected element')
        );
        expect(hydrateWarnings).toHaveLength(0);

        // Dashboard should appear
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
    });

    it('should mount fresh when SSR rendered nothing for lazy with siblings present', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        const LazyDashboard = createResolvedLazy(Dashboard);
        await LazyDashboard.preload();

        const Footer = component(() => {
            return () => <footer class="footer">Footer</footer>;
        }, { name: 'Footer' });

        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {jsx(LazyDashboard, {})}
                    {jsx(Footer, {})}
                </div>
            );
        }, { name: 'Layout' });

        // SSR: lazy rendered nothing, but Footer rendered normally
        const lazyWrapper = ssrComponentMarkers(2, ''); // Empty lazy
        const footerComponent = ssrComponentMarkers(3, '<footer class="footer">Footer</footer>');
        const layoutContent = `<div class="layout">${lazyWrapper}${footerComponent}</div>`;
        const ssrHtml = ssrComponentMarkers(1, layoutContent);

        container = createSSRContainer(ssrHtml);

        // Footer should be in SSR, dashboard should not
        expect(container.querySelectorAll('.footer').length).toBe(1);
        expect(container.querySelectorAll('.dashboard').length).toBe(0);

        const vnode = {
            type: Layout,
            props: {},
            key: null,
            children: [],
            dom: null
        };

        hydrate(vnode, container);
        await nextTick();
        await wait(50);

        // No warnings
        const hydrateWarnings = consoleWarnSpy.mock.calls.filter(
            (call: any[]) => typeof call[0] === 'string' && call[0].includes('[Hydrate] Expected element')
        );
        expect(hydrateWarnings).toHaveLength(0);

        // Both should be present: dashboard mounted fresh, footer hydrated
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelectorAll('.footer').length).toBe(1);
    });
});

// ============================================================================
// Bug 2: CSR Conditional Mount Failure with lazy() components
// ============================================================================

describe('Bug 2: lazy() CSR conditional mount failure', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        container.id = 'app';
        document.body.appendChild(container);
    });

    afterEach(() => {
        if (container) {
            container.remove();
        }
    });

    it('should render lazy component when it resolves after mount', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        const { LazyComp, resolveWith } = createControllableLazy(Dashboard);

        // Mount the lazy component directly
        render(jsx(LazyComp, {}), container);
        await nextTick();

        // Initially null - nothing rendered yet
        expect(container.querySelectorAll('.dashboard').length).toBe(0);

        // Resolve the lazy component
        resolveWith();
        await nextTick();
        await wait(50);

        // Dashboard should appear after resolution
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelector('.dashboard')?.textContent).toBe('Dashboard');
    });

    it('should render lazy component inside conditional branch on first mount', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Admin Dashboard</div>;
        }, { name: 'Dashboard' });

        const { LazyComp, resolveWith } = createControllableLazy(Dashboard);

        const showAdmin = signal(false);

        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {showAdmin.value ? (
                        <div class="admin-section">
                            {jsx(LazyComp, {})}
                        </div>
                    ) : (
                        <div class="inbox-section">Inbox</div>
                    )}
                </div>
            );
        }, { name: 'Layout' });

        render(jsx(Layout, {}), container);
        await nextTick();

        // Initially showing inbox
        expect(container.querySelector('.inbox-section')).toBeTruthy();
        expect(container.querySelector('.admin-section')).toBeNull();

        // Switch to admin branch
        showAdmin.value = true;
        await nextTick();

        // Admin section should be visible, lazy component loading
        expect(container.querySelector('.admin-section')).toBeTruthy();
        expect(container.querySelector('.inbox-section')).toBeNull();

        // Resolve the lazy component
        resolveWith();
        await nextTick();
        await wait(50);

        // BUG: Dashboard should appear inside the admin section
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelector('.dashboard')?.textContent).toBe('Admin Dashboard');
    });

    it('should render lazy component that resolves almost instantly in conditional branch', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Quick Dashboard</div>;
        }, { name: 'Dashboard' });

        // Resolves via microtask
        const LazyDashboard = createResolvedLazy(Dashboard);

        const showAdmin = signal(false);

        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {showAdmin.value ? (
                        jsx(LazyDashboard, {})
                    ) : (
                        <div class="inbox">Inbox</div>
                    )}
                </div>
            );
        }, { name: 'Layout' });

        render(jsx(Layout, {}), container);
        await nextTick();

        expect(container.querySelector('.inbox')).toBeTruthy();

        // Switch to admin
        showAdmin.value = true;
        await nextTick();
        await wait(50);

        // Dashboard should eventually appear
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelector('.dashboard')?.textContent).toBe('Quick Dashboard');
    });

    it('should render lazy component with delayed resolution in conditional branch', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Delayed Dashboard</div>;
        }, { name: 'Dashboard' });

        const LazyDashboard = createDelayedLazy(Dashboard, 30);

        const showAdmin = signal(false);

        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {showAdmin.value ? (
                        jsx(LazyDashboard, {})
                    ) : (
                        <div class="inbox">Inbox</div>
                    )}
                </div>
            );
        }, { name: 'Layout' });

        render(jsx(Layout, {}), container);
        await nextTick();

        // Switch to admin
        showAdmin.value = true;
        await nextTick();

        // Wait for the lazy component to resolve
        await wait(100);
        await nextTick();

        // Dashboard should appear after delay
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
        expect(container.querySelector('.dashboard')?.textContent).toBe('Delayed Dashboard');
    });

    it('should not stack duplicate content when toggling conditional branch with lazy component', async () => {
        const Dashboard = component(() => {
            return () => <div class="dashboard">Dashboard</div>;
        }, { name: 'Dashboard' });

        const LazyDashboard = createResolvedLazy(Dashboard);
        await LazyDashboard.preload(); // Ensure it's loaded

        const showAdmin = signal(false);

        const Layout = component(() => {
            return () => (
                <div class="layout">
                    {showAdmin.value ? (
                        jsx(LazyDashboard, {})
                    ) : (
                        <div class="inbox">Inbox</div>
                    )}
                </div>
            );
        }, { name: 'Layout' });

        render(jsx(Layout, {}), container);
        await nextTick();

        // Toggle multiple times
        showAdmin.value = true;
        await nextTick();
        await wait(20);

        showAdmin.value = false;
        await nextTick();

        showAdmin.value = true;
        await nextTick();
        await wait(20);

        // Should have exactly one dashboard instance
        expect(container.querySelectorAll('.dashboard').length).toBe(1);
    });
});
