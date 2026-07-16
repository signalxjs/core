import { defineLibConfig } from '../vite/src/lib.js';

// A pure client-side policy pack riding the §7 engine seam — one entry.
// Renderer-portable: depends on @sigx/runtime-core + @sigx/reactivity only
// (never the sigx umbrella, which drags the DOM platform). Keep the whole
// @sigx family external: this pack rides public seams only; it must never
// bundle a second copy of any @sigx/* (which would split the reactivity
// graph).
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts'
    },
    external: [/@sigx\/.*/, /^node:/]
});
