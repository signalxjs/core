import { signal, defineInjectable, type Signal } from 'sigx';
import { TechDetails } from './lazy-sections';

export type Route = '/' | '/counter' | '/forms' | '/data' | '/ai' | '/about';

/**
 * The route table owns its lazy chunk refs (docs/router-ssr-contract.md §2):
 * the client entry settles the matched route's chunks before hydrate() —
 * server-resolved <Defer> content must hydrate against the real component —
 * and the server maps the same knowledge to modulepreload links.
 */
const ROUTE_TABLE: ReadonlyArray<{ path: Route; chunks?: () => Promise<unknown>[] }> = [
    { path: '/' },
    { path: '/counter' },
    { path: '/forms' },
    { path: '/data' },
    { path: '/ai' },
    { path: '/about', chunks: () => [TechDetails.preload()] }
];

const ROUTES: ReadonlyArray<Route> = ROUTE_TABLE.map(r => r.path);

export function parseUrl(url: string): Route {
    const path = url.split('?')[0].split('#')[0];
    return ROUTES.includes(path as Route) ? (path as Route) : '/';
}

/** The matched route's lazy chunk loads (empty for chunk-less routes). */
export function routeChunks(path: Route): Promise<unknown>[] {
    return ROUTE_TABLE.find(r => r.path === path)?.chunks?.() ?? [];
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

// DI token, declared *required* (no fallback). Components retrieve the
// per-request router via useRouter(); both entries (entry-server.tsx and
// entry-client.tsx) must call `app.defineProvide(useRouter, () => createRouter(...))`
// so each app instance gets its own router. This is what makes concurrent SSR
// requests safe: each request creates a fresh router scoped to its app context.
// Used unprovided, it throws SIGX202 naming the injectable.
export const useRouter = defineInjectable<Router>('Router');
