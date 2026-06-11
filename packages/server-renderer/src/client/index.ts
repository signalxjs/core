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

// Head management — usable from shared component code (client implementation
// applies to the DOM; on the server the same import collects into the render
// context). Exported here so client bundles don't pull in server-only code.
export { useHead } from '../head.js';
export type { HeadConfig } from '../head.js';

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
    getCurrentAppContext,
    setCurrentAppContext
} from './hydrate-context';
export type { InternalVNode } from './hydrate-context';
