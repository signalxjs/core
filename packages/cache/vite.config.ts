import { defineLibConfig } from '../vite/src/lib.js';

// A pure client-side policy pack riding the §7 engine seam — one entry.
// Keep the whole @sigx family external: this pack rides public seams only;
// it must never bundle a second copy of any @sigx/* (which would split the
// reactivity graph).
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts'
    },
    external: ['sigx', 'sigx/internals', /@sigx\/.*/, /^node:/]
});
