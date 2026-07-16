/**
 * useStream — progressive text (LLM-token-style). Returns a string signal
 * that accumulates the source's chunks.
 *
 * - Server, streaming: tokens append into the page as they arrive; the
 *   final text swaps in and is serialized under `key`.
 * - Server, blocking: drained fully, final text inline.
 * - Client, hydrating: final text restored from `key` — the source is NOT
 *   re-run (no duplicate LLM calls).
 * - Client, navigation: runs live; the signal updates per chunk.
 *
 * This module provides the default CLIENT semantics. Server renderers
 * install a per-instance provider (`_useStream` on the setup context) that
 * takes over during SSR.
 */

import { signal } from '@sigx/reactivity';
import { getCurrentInstance } from './component-lifecycle.js';
import { hookOutsideSetupError } from './errors.js';
import { peekRestored } from './async/restore.js';
import { isLiveClient } from './async/environment.js';

export function useStream(
    key: string,
    source: () => AsyncIterable<string>
): { readonly value: string } {
    const instance = getCurrentInstance();
    if (!instance) {
        throw hookOutsideSetupError('useStream');
    }

    if ((instance as any)._useStream) {
        return (instance as any)._useStream(key, source);
    }

    // ── Default client semantics ──
    const restored = peekRestored(key);
    const text = signal(restored.hit ? String(restored.value) : '');

    if (!restored.hit && isLiveClient()) {
        // Stop pulling when the component unmounts — breaking the for-await
        // closes the iterator (its return() runs), releasing the source.
        let stopped = false;
        instance.onUnmounted(() => { stopped = true; });

        void (async () => {
            let acc = '';
            for await (const token of source()) {
                if (stopped) break;
                acc += token;
                text.value = acc;
            }
        })().catch(err => console.error('[useStream] source error:', err));
    }

    return text;
}
