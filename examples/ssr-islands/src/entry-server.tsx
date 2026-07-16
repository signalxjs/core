import { defineApp } from 'sigx';
import { App } from './App';

/**
 * Per-request app factory (docs/router-ssr-contract.md §1) — the shape both
 * request handlers consume. This page has no per-request state, but the
 * factory contract stays: a fresh app per request is what makes concurrent
 * SSR safe once state arrives.
 */
export function createApp(url: string) {
    // `?deferred` — the deferred-only variant page (see App.tsx): no island
    // can fire at load, so no sigx runtime may execute until one does.
    const deferred = url.includes('deferred');
    return defineApp(<App deferred={deferred} />);
}
