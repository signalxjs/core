import { defineLibConfig } from '../vite/src/lib.js';

// Resume starts with 2 entry points; ./client and ./loader join as the
// program lands (#241):
// - index: universal (re-exports the plugin + server surface)
// - server/index: server-side resume rendering (WinterCG-clean)
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'server/index': 'src/server/index.ts'
    },
    // Keep the whole @sigx family + node builtins external — this pack only
    // rides the public @sigx/server-renderer plugin API; it must never bundle
    // a second copy of any @sigx/* (which would split the reactivity graph).
    external: ['sigx', /@sigx\/.*/, /^node:/]
});
