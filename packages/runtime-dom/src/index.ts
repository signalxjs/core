// Import JSX types (global augmentation)
import './jsx';
// Import type augmentation for @sigx/runtime-core
import './types';
// Import JSX type augmentation for built-in directives (IntelliSense for use:show, etc.)
import './directives/show-jsx-types';

// Platform setup (side effects)
import './model-processor.js';

// Re-export public API from focused modules
export { render, patch, mount, unmount, mountComponent } from './render.js';
export { patchProp } from './patchProp.js';
export { patchDirective, onElementMounted, registerBuiltInDirective, resolveBuiltInDirective } from './directives.js';
export type { DOMDirective } from './directives.js';
export { nodeOps } from './nodeOps.js';

// Export Portal component and moveBefore utilities
export { Portal, supportsMoveBefore, moveNode } from './Portal.js';

// Export built-in directives
export { show } from './directives/show.js';

// Register built-in directives so use:show={value} works without importing
import { show as _showDirective } from './directives/show.js';
import { registerBuiltInDirective as _register } from './directives.js';
_register('show', _showDirective);
