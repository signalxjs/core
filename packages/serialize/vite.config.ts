import { defineLibConfig } from '../vite/src/lib.js';

// The base of the stack: ZERO dependencies, by design. Every other package
// (runtime-core, server-renderer, resume, cache, server) depends on this one,
// and `@sigx/server`'s dependency-free client stub imports it directly — so a
// dependency here would land in the size-limited fetch-stub entry.
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts'
    },
    external: [/^node:/],
    platform: 'neutral'
});
