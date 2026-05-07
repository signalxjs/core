/**
 * @sigx/server-renderer/client
 * 
 * Client-side hydration — strategy-agnostic core.
 * Plugin-based extension for islands, resumable SSR, etc.
 */

// Load SSR type augmentations (SSRHelper, ComponentSetupContext extensions)
import '../client-directives.js';

// Load context extension (side-effect: registers SSR context for all components)
import './hydrate-context';

// Export the SSR client plugin (recommended way to hydrate)
export { ssrClientPlugin, type HydrateFn } from './plugin.js';

// Export core hydration
export { hydrate, hydrateNode } from './hydrate-core';

// Export component hydration (used by SSR strategy plugins)
export { hydrateComponent } from './hydrate-component';
export type { ComponentFactory } from './hydrate-component';

// Export context utilities for plugins
export {
    registerClientPlugin,
    getClientPlugins,
    clearClientPlugins,
    setPendingServerState,
    getCurrentAppContext,
    setCurrentAppContext,
    createRestoringSignal
} from './hydrate-context';
export type { SSRSignalFn, InternalVNode } from './hydrate-context';
