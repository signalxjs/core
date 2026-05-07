/**
 * Hydration utilities for SSR
 * 
 * This module provides utilities for server-side rendering and client-side hydration.
 * Can be imported as `sigx/hydration` for tree-shaking when only hydration utilities are needed.
 * 
 * @module sigx/hydration
 * 
 * @example
 * ```ts
 * import { getHydrationDirective, filterClientDirectives } from 'sigx/hydration';
 * ```
 */

export {
    CLIENT_DIRECTIVE_PREFIX,
    CLIENT_DIRECTIVES,
    type ClientDirective,
    type HydrationStrategy,
    type HydrationDirective
} from '@sigx/runtime-core';

export {
    filterClientDirectives,
    getHydrationDirective,
    hasClientDirective,
    serializeProps,
    createEmit
} from '@sigx/runtime-core/internals';
