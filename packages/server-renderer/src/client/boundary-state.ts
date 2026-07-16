/**
 * Boundary server-state staging — the #120 signal-state hand-off between the
 * scheduler and a pack's client `transformComponentContext` hook.
 *
 * The scheduler stages a boundary's captured state right before its
 * `hydrateComponent` call; the pack's hook consumes it during context
 * construction to seed restored signal values (islands' restoring signal).
 * Moved here from the islands pack so the core scheduler can stage without
 * a pack import cycle.
 */

let _pendingBoundaryState: Record<string, any> | null = null;

/**
 * Stage boundary server-state before a `hydrateComponent` call. A falsy
 * state clears any stale pending value.
 */
export function seedBoundaryState(state: Record<string, any> | null | undefined): void {
    _pendingBoundaryState = state || null;
}

/**
 * Read and clear the pending boundary server-state. Returns null when
 * nothing is staged (the common case — non-boundary components hydrate
 * untouched).
 */
export function consumeBoundaryState(): Record<string, any> | null {
    const state = _pendingBoundaryState;
    _pendingBoundaryState = null;
    return state;
}
