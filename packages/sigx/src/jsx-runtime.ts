// Platform identity side effect by precise subpath — named in runtime-dom's
// `sideEffects`, so bundlers keep it even when tree-shaking this re-export
// module (every JSX-compiled file imports the jsx runtime).
import '@sigx/runtime-dom/platform';
export * from '@sigx/runtime-core';
export { jsx, jsxs, jsxDEV, Fragment } from '@sigx/runtime-core';
