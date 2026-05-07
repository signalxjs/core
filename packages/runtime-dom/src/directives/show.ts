/**
 * Built-in `show` directive — toggles element visibility via `display` CSS property.
 *
 * Unlike conditional rendering (ternary in JSX), `use:show` keeps the element in the DOM
 * and only toggles its `display` style. This is useful when toggling is frequent and you
 * want to preserve element state (e.g., scroll position, input focus).
 *
 * @example
 * ```tsx
 * // Shorthand — directive resolved automatically:
 * <div use:show={isVisible}>Content</div>
 *
 * // Explicit tuple form:
 * import { show } from 'sigx';
 * <div use:show={[show, isVisible]}>Content</div>
 * ```
 */

import { defineDirective } from '@sigx/runtime-core';

/** Symbol key for storing the original display value on elements. */
const ORIGINAL_DISPLAY = Symbol('sigx.show.originalDisplay');

/** HTMLElement with the show directive's original display property. */
interface ShowElement extends HTMLElement {
    [ORIGINAL_DISPLAY]?: string;
}

export const show = defineDirective<boolean, HTMLElement>({
    mounted(el, { value }) {
        const showEl = el as ShowElement;
        // Save the original display value now that all props have been applied
        const saved = showEl.style.display === 'none' ? '' : showEl.style.display;
        showEl[ORIGINAL_DISPLAY] = saved;
        showEl.style.display = value ? saved : 'none';
    },

    updated(el, { value, oldValue }) {
        if (value !== oldValue) {
            const showEl = el as ShowElement;
            showEl.style.display = value ? showEl[ORIGINAL_DISPLAY] ?? '' : 'none';
        }
    },

    unmounted(el) {
        const showEl = el as ShowElement;
        // Restore original display on cleanup
        const original = showEl[ORIGINAL_DISPLAY];
        if (original !== undefined) {
            showEl.style.display = original;
        }
    }
});
