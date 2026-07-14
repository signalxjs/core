/**
 * Live-client declaration semantics (issue #204). The windowless-runtime
 * behavior is proven end-to-end in packages/sigx/__tests__/
 * platform-neutral.test.ts (esbuild + node:vm); this file pins the
 * declaration/fallback precedence directly. Module-level state — this
 * file relies on vitest's per-file module isolation.
 */

import { describe, it, expect } from 'vitest';
import { declareLiveClient, isLiveClient } from '@sigx/runtime-core/internals';

describe('declareLiveClient / isLiveClient', () => {
    it('falls back to the window check when nothing is declared, and a declaration wins in BOTH directions', () => {
        // happy-dom provides window ⇒ fallback says live.
        expect(isLiveClient()).toBe(true);

        // An explicit declaration overrides the fallback — even against a
        // present window (an embedder can declare itself NOT a live client).
        declareLiveClient(false);
        expect(isLiveClient()).toBe(false);

        declareLiveClient();
        expect(isLiveClient()).toBe(true);
    });
});
