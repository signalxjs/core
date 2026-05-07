/**
 * SSR directive type augmentation.
 *
 * When `@sigx/server-renderer` is imported, directives gain the `getSSRProps` hook.
 * This keeps `@sigx/runtime-core` and `@sigx/runtime-dom` free of SSR knowledge —
 * the SSR layer owns this extension.
 *
 * Uses TypeScript module augmentation on `DirectiveDefinitionExtensions` which
 * is the designated extension point in `@sigx/runtime-core`.
 */
import type { DirectiveBinding } from '@sigx/runtime-core';

declare module '@sigx/runtime-core' {
    interface DirectiveDefinitionExtensions<T> {
        /**
         * Called during SSR to produce props that should be merged into the element's HTML.
         * Return an object with keys like `style`, `class`, or any attribute.
         *
         * This hook is ONLY available when `@sigx/server-renderer` is in the project.
         */
        getSSRProps?(binding: DirectiveBinding<T>): Record<string, any> | void;
    }
}
