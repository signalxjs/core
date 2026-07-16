import { defineLibConfig } from '../vite/src/lib.js';

// Server-Renderer has separate entry points for different environments:
// - index: re-exports everything (universal)
// - server/index: SSR rendering (Node.js only)
// - client/index: hydration (Browser only)
// - client/scheduler: the EAGER hydration scheduler — imports nothing from
//   the sigx family; the executor (renderer + hydrateComponent) is a dist
//   chunk it dynamically imports on the first strategy that fires.
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'server/index': 'src/server/index.ts',
        'node': 'src/node.ts',
        'client/index': 'src/client/index.ts',
        'client/scheduler': 'src/client/scheduler.ts'
    },
    // node: builtins must stay external (renderToNodeStream needs node:stream);
    // the default browser platform otherwise stubs them to empty modules,
    // which breaks the node streaming API in the built dist.
    external: ['sigx', /@sigx\/.*/, '@sigx/runtime-core', '@sigx/runtime-dom', '@sigx/reactivity', /^node:/]
});
