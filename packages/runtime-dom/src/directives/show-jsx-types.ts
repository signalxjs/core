/**
 * JSX type augmentation for the `show` directive.
 *
 * Adds `use:show` to `DirectiveAttributeExtensions` so that typing `use:`
 * in JSX triggers IntelliSense with `use:show` as a suggestion.
 */
import type { DirectiveDefinition } from '@sigx/runtime-core';

declare global {
    namespace JSX {
        interface DirectiveAttributeExtensions {
            /**
             * Toggle element visibility via `display` CSS property.
             *
             * The element stays in the DOM — only its `display` is toggled.
             * Preserves original display value (e.g., `flex`, `grid`).
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
            'use:show'?: boolean | DirectiveDefinition<boolean, HTMLElement> | [DirectiveDefinition<boolean, HTMLElement>, boolean];
        }
    }
}
