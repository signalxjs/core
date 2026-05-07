/**
 * Built-in directive SSR support — lazy patching.
 *
 * This module patches `getSSRProps` onto built-in directives (like `show`)
 * at runtime, keeping `@sigx/runtime-dom` free of SSR knowledge.
 *
 * @internal
 */
import { show } from '@sigx/runtime-dom';

let _initialized = false;

/**
 * Patch `getSSRProps` onto the `show` directive for SSR support.
 *
 * Called lazily from `initDirectivesForSSR()` — not at import time,
 * so tree-shaking can eliminate this in client-only builds.
 */
function initShowForSSR(): void {
    (show as any).getSSRProps = ({ value }: { value: boolean }) => {
        if (!value) {
            return { style: { display: 'none' } };
        }
    };
}

/**
 * Initialize SSR support for all built-in directives.
 *
 * Must be called before any SSR rendering occurs.
 * Safe to call multiple times — only patches once.
 */
export function initDirectivesForSSR(): void {
    if (_initialized) return;
    _initialized = true;
    initShowForSSR();
}
