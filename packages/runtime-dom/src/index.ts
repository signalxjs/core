// Import JSX types (global augmentation)
import './jsx';
// Import type augmentation for @sigx/runtime-core
import './types';
// Import JSX type augmentation for built-in directives (IntelliSense for use:show, etc.)
import './directives/show-jsx-types';

// Platform setup (side effects)
import './platform.js';

// Re-export public API from focused modules
export { render, patch, mount, unmount, mountComponent } from './render.js';
export { patchProp } from './patchProp.js';
export { patchDirective, onElementMounted, registerBuiltInDirective, resolveBuiltInDirective } from './directives.js';
export type { DOMDirective } from './directives.js';
export { nodeOps } from './nodeOps.js';

// Export Portal component and moveBefore utilities
export { Portal, supportsMoveBefore, moveNode } from './Portal.js';

// Built-in directives. Standard built-ins (`show`) register automatically
// with the platform (see ./platform.ts) — their JSX types are globally
// visible, so the runtime must always resolve them. Custom directives
// register per app via `app.directive(name, def)` (client + SSR) or
// globally via `registerBuiltInDirective(name, def)`.
export { show } from './directives/show.js';

// Head management (browser-standalone; server collection via instance seam)
export { useHead } from './use-head.js';
export type { HeadConfig, HeadMeta, HeadLink, HeadScript } from './use-head.js';
