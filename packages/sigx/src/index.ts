// Import for side effects (sets default mount function and registers JSX globals)
import '@sigx/runtime-dom';

// Re-export public APIs only (internals available via 'sigx/internals')
export * from '@sigx/reactivity';
export * from '@sigx/runtime-core';

// From runtime-dom: only public symbols
export { render, Portal, supportsMoveBefore, moveNode, show } from '@sigx/runtime-dom';
export type { DOMDirective } from '@sigx/runtime-dom';
