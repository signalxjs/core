import { defineLibConfig } from '../vite/src/lib.js';

// Resume has 4 entry points (#241):
// - index: universal (re-exports the plugin + server surface)
// - server/index: server-side resume rendering (WinterCG-clean)
// - client/index: browser runtime, lazy-loaded on first interaction
// - loader/index: the delegation loader — the page's ONLY initial script;
//   imports nothing (size-limit checks it with no ignore list)
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'server/index': 'src/server/index.ts',
        'client/index': 'src/client/index.ts',
        'loader/index': 'src/loader/index.ts'
    },
    // Keep the whole @sigx family + node builtins external — this pack only
    // rides the public @sigx/server-renderer plugin API; it must never bundle
    // a second copy of any @sigx/* (which would split the reactivity graph).
    external: ['sigx', /@sigx\/.*/, /^node:/]
});
