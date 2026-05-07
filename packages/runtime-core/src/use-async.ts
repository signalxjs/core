/**
 * useAsync — composable for loading async dependencies in components.
 *
 * Wraps an async loader in a reactive signal with loading/error states.
 * No renderer changes required — works with sigx's existing effect system.
 *
 * @example
 * ```tsx
 * import { component, useAsync } from 'sigx';
 *
 * const CodeEditor = component(({ signal: s }) => {
 *     const libs = useAsync(async () => {
 *         const { EditorView } = await import('@codemirror/view');
 *         const { json } = await import('@codemirror/lang-json');
 *         return { EditorView, json };
 *     });
 *
 *     return () => {
 *         if (libs.loading) return <div class="skeleton" />;
 *         if (libs.error) return <div class="error">{libs.error.message}</div>;
 *         return <div ref={el => new libs.value!.EditorView({ parent: el })} />;
 *     };
 * });
 * ```
 */

import { signal, batch } from '@sigx/reactivity';

/**
 * Reactive state returned by useAsync.
 */
export interface AsyncState<T> {
    /** The resolved value, or null while loading / on error. */
    readonly value: T | null;
    /** True while the loader is in progress. */
    readonly loading: boolean;
    /** The error if the loader rejected, or null. */
    readonly error: Error | null;
}

/**
 * Load an async resource inside a component's setup function.
 *
 * Returns a reactive object with `value`, `loading`, and `error` fields.
 * The component's render function re-runs automatically when the state changes.
 *
 * @param loader — async function that returns the resource
 * @returns reactive AsyncState
 */
export function useAsync<T>(loader: () => Promise<T>): AsyncState<T> {
    const state = signal({
        value: null as T | null,
        loading: true,
        error: null as Error | null,
    });

    loader()
        .then((val) => {
            batch(() => {
                state.value = val;
                state.loading = false;
            });
        })
        .catch((err) => {
            batch(() => {
                state.error = err instanceof Error ? err : new Error(String(err));
                state.loading = false;
            });
        });

    return state as AsyncState<T>;
}
