/**
 * Live-client declaration semantics (issue #204). The windowless-runtime
 * behavior is proven end-to-end in packages/sigx/__tests__/
 * platform-neutral.test.ts (esbuild + node:vm); this file pins the
 * declaration/fallback precedence directly. Module-level state — this
 * file relies on vitest's per-file module isolation.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { declareLiveClient, isLiveClient } from '@sigx/runtime-core/internals';

const marker = () =>
    (globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__;

afterEach(() => {
    delete (globalThis as { __SIGX_LIVE_CLIENT__?: unknown }).__SIGX_LIVE_CLIENT__;
});

describe('declareLiveClient / isLiveClient', () => {
    it('falls back to the window check when nothing is declared, and a declaration wins in BOTH directions', () => {
        // happy-dom provides window ⇒ fallback says live — and the fallback
        // must NOT stamp the global marker (web SSR evaluates this module;
        // a stamp would trip @sigx/server's live-client guard).
        expect(isLiveClient()).toBe(true);
        expect(marker()).toBeUndefined();

        // An explicit declaration overrides the fallback — even against a
        // present window (an embedder can declare itself NOT a live client) —
        // and stamps globalThis.__SIGX_LIVE_CLIENT__ for @sigx/server's
        // live-client guard (rfc-server rev 2, N.2).
        declareLiveClient(false);
        expect(isLiveClient()).toBe(false);
        expect(marker()).toBe(false);

        declareLiveClient();
        expect(isLiveClient()).toBe(true);
        expect(marker()).toBe(true);
    });
});
