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

// Export built-in directives. Directives are content, not platform identity —
// nothing registers automatically. Register per app via
// `app.directive('show', show)` (works on the client and during SSR), or
// globally via `registerShowDirective()` for apps using bare `render()`.
export { show } from './directives/show.js';
export { registerShowDirective } from './directives/register-show.js';

// Head management (browser-standalone; server collection via instance seam)
export { useHead } from './use-head.js';
export type { HeadConfig, HeadMeta, HeadLink, HeadScript } from './use-head.js';
