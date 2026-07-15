/**
 * errorScope — setup-time error boundary for the calling component's subtree
 * (docs/rfc-async.md §4). Not a wrapper component: call it inside setup and
 * the component's own subtree is scoped.
 *
 *   const Widget = component((ctx) => {
 *       errorScope({ fallback: (e, retry) => <Oops error={e} retry={retry} /> });
 *       return () => <RiskyTree />;
 *   });
 *
 * Catches: the component's own render throws, and descendant setup / render /
 * reactive re-render throws (routed here by handleComponentError's parent-
 * chain walk). Also receives unhandled data errors bubbled by `match()`
 * (a cell errored with no `error` arm).
 *
 * Does NOT catch: fetcher rejections (they land on the cell's `.error` —
 * value-first), or DOM event-handler throws (those go to app `onError`).
 *
 * `retry` is a real teardown: the subtree renders under a keyed Fragment
 * whose key bumps on retry, forcing unmount (every descendant effect
 * stopped, onUnmounted run) + fresh mount — not a flag flip over stale state.
 */

import { signal, batch } from '@sigx/reactivity';
import { getCurrentInstance } from './component-lifecycle.js';
import { createToken } from './di/token.js';
import { jsx, Fragment, type JSXElement } from './jsx-runtime.js';
import type { ViewFn } from './component-types.js';
import type { ComponentInstance } from './app-types.js';
import { errorScopeOutsideSetupError } from './errors.js';

export interface ErrorScopeOptions {
    /** Rendered in place of the subtree while errored. Omitted ⇒ renders nothing. */
    fallback?: (error: Error, retry: () => void) => JSXElement;
    /** Observer — called before the fallback renders. Its own throws are swallowed. */
    onError?: (error: Error, instance: ComponentInstance | null, info: string) => void;
}

/** DI token under which a scope's handle lives on the owning ctx. @internal */
export const ERROR_SCOPE_TOKEN = createToken<ErrorScopeHandle>('sigx:errorScope');

/**
 * Server-rendered error staged for the NEXT errorScope() call — the SSR
 * hydrator seeds it right before hydrating a component whose boundary
 * record carries a server-caught scope error, so the scope starts in the
 * errored state, the fallback hydrates against the server's fallback HTML,
 * and `retry` is live (a real remount). @internal
 */
let _pendingScopeError: Error | null = null;

/** Stage (or clear, with null) the server-caught error for the next scope. @internal */
export function seedErrorScopeError(error: Error | null): void {
    _pendingScopeError = error;
}

/** @internal */
export interface ErrorScopeHandle {
    /** Returns true when this scope takes the error (renders its fallback). */
    handle(err: Error, instance: ComponentInstance | null, info: string): boolean;
}

interface InternalErrorScope {
    state: { error: Error | null; generation: number };
    retry: () => void;
    fallback?: (error: Error, retry: () => void) => JSXElement;
}

/**
 * Scope the calling component's subtree. Setup-only.
 */
export function errorScope(options: ErrorScopeOptions): void {
    const ctx = getCurrentInstance();
    if (!ctx) {
        throw errorScopeOutsideSetupError();
    }

    const node = ctx as unknown as { provides?: Map<symbol, unknown>; __errorScope?: InternalErrorScope };
    if (node.__errorScope) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('[errorScope] called twice in one component setup — the second call is ignored.');
        }
        return;
    }

    // A server-caught error staged by the hydrator seeds the scope errored:
    // the first render is the fallback (matching the server's fallback HTML)
    // and retry() performs the remount the server could not.
    const seeded = _pendingScopeError;
    _pendingScopeError = null;

    const state = signal({ error: seeded, generation: 0 });
    // Synchronous mirror of `state.error !== null`: handle() must decide
    // (and dedupe) synchronously, but the reactive write is deferred below.
    let errored = seeded !== null;

    const retry = () => {
        errored = false;
        batch(() => {
            // The generation key bump forces the keyed subtree Fragment to
            // remount (different-key patch = unmount + mount): descendant
            // effects stop, onUnmounted hooks run, state starts fresh.
            state.generation++;
            state.error = null;
        });
    };

    const handle: ErrorScopeHandle = {
        handle(err, instance, info) {
            // Already showing the fallback — a throw from the fallback itself
            // (or a sibling error racing in) bubbles to the next scope up.
            if (errored) return false;
            errored = true;
            if (options.onError) {
                try {
                    options.onError(err, instance, info);
                } catch (observerErr) {
                    console.error('[errorScope] onError observer threw:', observerErr);
                }
            }
            // Descendant setup/first-render throws surface while THIS
            // component's render effect is still on the stack, and its
            // re-entrant notifications are dropped (render-loop guard).
            // Step out of the effect frame before the reactive write.
            queueMicrotask(() => {
                if (errored) state.error = err;
            });
            return true;
        },
    };

    (node.provides ??= new Map()).set(ERROR_SCOPE_TOKEN, handle);
    node.__errorScope = { state, retry, fallback: options.fallback };
}

/**
 * Wrap a component's render fn with its errorScope view: fallback while
 * errored, otherwise the subtree under the generation-keyed Fragment.
 * Called by the renderer after setup returns (renderFn exists only then).
 *
 * @internal
 */
export function wrapErrorScopeRender(original: ViewFn, es: InternalErrorScope): ViewFn {
    return () => {
        const err = es.state.error;
        if (err) {
            return es.fallback ? es.fallback(err, es.retry) : null;
        }
        return jsx(Fragment, { children: [original()] }, String(es.state.generation));
    };
}

/** @internal — renderer hook: wrap if the ctx carries a scope. */
export function applyErrorScope(ctx: unknown, renderFn: ViewFn): ViewFn {
    const es = (ctx as { __errorScope?: InternalErrorScope }).__errorScope;
    return es ? wrapErrorScopeRender(renderFn, es) : renderFn;
}
