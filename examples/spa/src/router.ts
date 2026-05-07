import { signal } from 'sigx';

export type Route = '/' | '/counter' | '/forms' | '/about';

const ROUTES: ReadonlyArray<Route> = ['/', '/counter', '/forms', '/about'];

function parseHash(): Route {
    const path = (typeof window === 'undefined' ? '/' : window.location.hash.replace(/^#/, '') || '/') as Route;
    return ROUTES.includes(path) ? path : '/';
}

export const route = signal({ path: parseHash() });

if (typeof window !== 'undefined') {
    window.addEventListener('hashchange', () => {
        route.path = parseHash();
    });
}

export function navigate(path: Route): void {
    if (typeof window !== 'undefined') {
        window.location.hash = path;
    } else {
        route.path = path;
    }
}
