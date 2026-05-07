/**
 * @sigx/runtime-dom internal APIs
 * 
 * ⚠️ These are low-level DOM renderer primitives for SSR hydration and
 * framework extensions. They are NOT part of the public API and may change
 * without notice.
 * 
 * @internal
 */

// Renderer primitives for SSR hydration
export { patch, mount, unmount, mountComponent } from './render.js';

// DOM operation hooks
export { patchProp } from './patchProp.js';
export { patchDirective, onElementMounted } from './directives.js';
export { nodeOps } from './nodeOps.js';

// Built-in directive registry
export { registerBuiltInDirective, resolveBuiltInDirective } from './directives.js';
