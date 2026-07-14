/**
 * __SIGX_ASYNC__ serialization — the hydration state transfer for
 * useAsync/useStream resolved values.
 *
 * The wire format is request-global and keyed by the user's explicit keys
 * (never component IDs or signal positions):
 *
 *   <script>window.__SIGX_ASYNC__ = { "stats": {...}, "user:1": {...} }</script>
 *
 * The client treats the blob as the page's initial-data cache (see
 * runtime-core use-async.ts): every mount of a key restores from it and
 * skips its fetch; refresh() is the explicit invalidation.
 *
 * The escaping/key-safety/type-handler machinery lives in the shared
 * serializer module (`./serialize`) — one discipline for every blob.
 */

import { assignmentJs, isSerializable, DANGEROUS_KEYS, type SSRTypeHandler } from './serialize';

export { isSerializable, DANGEROUS_KEYS };

/**
 * Raw JS statement merging values into `window.__SIGX_ASYNC__`. Used inside
 * replacement <script>s, where it must run BEFORE the `$SIGX_REPLACE` call
 * that triggers hydration listeners.
 */
export function asyncAssignmentJs(
    values: Record<string, unknown>,
    handlers: readonly SSRTypeHandler[] = []
): string {
    return assignmentJs('__SIGX_ASYNC__', values, handlers);
}

/** Full `<script>` tag emitting values — flushed with the shell. */
export function serializeAsyncScript(
    values: Record<string, unknown>,
    handlers: readonly SSRTypeHandler[] = []
): string {
    return `<script>${asyncAssignmentJs(values, handlers)}</script>`;
}
