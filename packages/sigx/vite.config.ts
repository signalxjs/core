import { defineLibConfig } from '../vite/src/lib.js';

// Thin re-export layer — all @sigx/* sub-packages are external.
// The downstream bundler (Vite) resolves the full chain at app build time.
export default defineLibConfig({
    entry: {
        'sigx': 'src/index.ts',
        'hydration': 'src/hydration.ts',
        'internals': 'src/internals.ts'
    },
    root: import.meta.url
});
