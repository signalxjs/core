// Platform identity side effects, imported by the precise subpath that is
// named in runtime-dom's `sideEffects` — every bundler must keep it even
// when tree-shaking re-export chains. Carries the form model processor,
// the default mount registration, and the standard built-in directives
// (`show`).
import '@sigx/runtime-dom/platform';

// Re-export public APIs only (internals available via 'sigx/internals')
export * from '@sigx/reactivity';
export * from '@sigx/runtime-core';

// From runtime-dom: only public symbols
export { render, Portal, supportsMoveBefore, moveNode, show, useHead } from '@sigx/runtime-dom';
export type { HeadConfig, HeadMeta, HeadLink, HeadScript, HeadStyle, HeadNoscript, HeadBase } from '@sigx/runtime-dom';
export type { DOMDirective } from '@sigx/runtime-dom';
