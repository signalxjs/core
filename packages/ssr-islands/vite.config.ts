import { defineLibConfig } from '../vite/src/lib.js';

// Islands mirrors server-renderer with 3 entry points:
// - index: universal (re-exports server + client)
// - server/index: server-side island rendering (Node.js)
// - client/index: client-side island hydration (browser)
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'server/index': 'src/server/index.ts',
        'client/index': 'src/client/index.ts'
    },
    // Keep the whole @sigx family + node builtins external — this pack only
    // rides the public @sigx/server-renderer plugin API; it must never bundle
    // a second copy of any @sigx/* (which would split the reactivity graph).
    external: ['sigx', /@sigx\/.*/, /^node:/]
});
