import { signal, defineInjectable, type Signal } from 'sigx';

export type Route = '/' | '/counter' | '/forms' | '/about';

const ROUTES: ReadonlyArray<Route> = ['/', '/counter', '/forms', '/about'];

export function parseUrl(url: string): Route {
    const path = url.split('?')[0].split('#')[0];
    return ROUTES.includes(path as Route) ? (path as Route) : '/';
}

export interface Router {
    readonly route: Signal<{ path: Route }>;
    navigate(path: Route): void;
}

export function createRouter(initialPath: Route): Router {
    const route = signal({ path: initialPath });

    function navigate(path: Route): void {
        if (typeof window !== 'undefined') {
            window.history.pushState({}, '', path);
        }
        route.path = path;
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('popstate', () => {
            route.path = parseUrl(window.location.pathname);
        });
    }

    return { route, navigate };
}

// DI token. Components retrieve the per-request router via useRouter().
// The default factory throws on purpose — both entries (entry-server.tsx and
// entry-client.tsx) must call `app.defineProvide(useRouter, () => createRouter(...))`
// so each app instance gets its own router. This is what makes concurrent SSR
// requests safe: each request creates a fresh router scoped to its app context.
export const useRouter = defineInjectable<Router>(() => {
    throw new Error(
        'useRouter() called without a Router provided. ' +
        'app.defineProvide(useRouter, () => createRouter(...)) before mount/hydrate.'
    );
});
