/**
 * Live-client detection — "is this a live client (vs. a server render)?"
 *
 * The async layer must not auto-run fetchers during a server render (the
 * server walk installs its own `_useAsync` provider and serializes results
 * instead). Historically that gate was `typeof window !== 'undefined'`,
 * which really tests "is this a browser" — wrong for non-web renderers
 * (signalxjs/lynx, signalxjs/terminal): their runtimes have no `window`,
 * yet they ARE live clients and their reads must fetch.
 *
 * Non-web platform-identity modules call `declareLiveClient()` once on
 * import; the browser check remains the fallback so web behavior is
 * unchanged without any declaration.
 *
 * ⚠️ `@sigx/runtime-dom/platform` must NOT call `declareLiveClient()`:
 * the `sigx` umbrella imports it unconditionally, so server-side SSR code
 * evaluates it too — declaring there would defeat the server guard. Web
 * relies on the window fallback; only genuinely windowless clients declare.
 */

let declared: boolean | null = null;

/**
 * Declare this runtime a live client (or explicitly not one). Called by
 * non-web platform-identity modules on import — never by app code.
 */
export function declareLiveClient(live = true): void {
    declared = live;
}

/** Declaration wins; `typeof window` is the fallback. */
export function isLiveClient(): boolean {
    return declared ?? typeof window !== 'undefined';
}
