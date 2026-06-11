/**
 * Global registration for the `show` directive — enables the
 * `use:show={value}` shorthand in apps that use bare `render()` (no app
 * context). Apps built with `defineApp()` can use
 * `app.directive('show', show)` instead for per-app registration.
 *
 * Idempotent: calling more than once is a no-op.
 */

import { registerBuiltInDirective } from '../directives.js';
import { show } from './show.js';

export function registerShowDirective(): void {
    registerBuiltInDirective('show', show);
}
