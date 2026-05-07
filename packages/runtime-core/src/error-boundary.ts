/**
 * ErrorBoundary component for catching render errors.
 *
 * Catches errors thrown during child component rendering and displays
 * a fallback UI. Works during both SSR and client-side rendering.
 *
 * @example
 * ```tsx
 * import { ErrorBoundary } from 'sigx';
 *
 * <ErrorBoundary
 *     fallback={(error, retry) => (
 *         <div>
 *             <p>Something went wrong: {error.message}</p>
 *             <button onClick={retry}>Retry</button>
 *         </div>
 *     )}
 * >
 *     <RiskyComponent />
 * </ErrorBoundary>
 * ```
 */

import { component, type Define } from './component.js';
import type { JSXElement } from './jsx-runtime.js';

/**
 * Props for the ErrorBoundary component
 */
type ErrorBoundaryProps =
    Define.Prop<'fallback', JSXElement | ((error: Error, retry: () => void) => JSXElement)> &
    Define.Slot<'default'>;

/**
 * ErrorBoundary component.
 *
 * Wraps children and catches errors thrown during rendering.
 * When an error occurs, displays the `fallback` UI.
 * Provides a `retry` function to reset and re-render children.
 */
export const ErrorBoundary = component<ErrorBoundaryProps>((ctx) => {
    const { fallback } = ctx.props;
    const { slots } = ctx;

    const state = ctx.signal({ hasError: false, error: null as Error | null });

    const retry = () => {
        state.hasError = false;
        state.error = null;
    };

    return () => {
        if (state.hasError && state.error) {
            if (typeof fallback === 'function') {
                return (fallback as (error: Error, retry: () => void) => JSXElement)(state.error, retry);
            }
            return fallback ?? null;
        }

        try {
            return slots.default();
        } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            state.hasError = true;
            state.error = error;

            if (process.env.NODE_ENV !== 'production') {
                console.error('[ErrorBoundary] Caught error during render:', error);
            }

            if (typeof fallback === 'function') {
                return (fallback as (error: Error, retry: () => void) => JSXElement)(error, retry);
            }
            return fallback ?? null;
        }
    };
}, { name: 'ErrorBoundary' });
