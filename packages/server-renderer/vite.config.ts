import { defineLibConfig } from '../vite/src/lib.js';

// Server-Renderer has 3 separate entry points for different environments:
// - index: re-exports everything (universal)
// - server/index: SSR rendering (Node.js only) 
// - client/index: hydration (Browser only)
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'server/index': 'src/server/index.ts',
        'client/index': 'src/client/index.ts'
    },
    // node: builtins must stay external (renderToNodeStream needs node:stream);
    // the default browser platform otherwise stubs them to empty modules,
    // which breaks the node streaming API in the built dist.
    external: ['sigx', /@sigx\/.*/, '@sigx/runtime-core', '@sigx/runtime-dom', '@sigx/reactivity', /^node:/]
});
