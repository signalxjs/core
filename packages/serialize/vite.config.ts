import { defineLibConfig } from '../vite/src/lib.js';

// The base of the stack: ZERO dependencies, by design. Every other package
// (runtime-core, server-renderer, resume, cache, server) depends on this one,
// and `@sigx/server`'s dependency-free client stub imports it directly — so a
// dependency here would land in the size-limited fetch-stub entry.
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        // Opt-in binary vocabulary (#569) — its own entry so `$bytes` stays
        // out of the 1 KB root entry and the stub bundles that replicate it.
        'bytes': 'src/bytes.ts'
    },
    external: [/^node:/],
    platform: 'neutral'
});
