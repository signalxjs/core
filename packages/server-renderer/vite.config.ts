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
    external: ['sigx', /@sigx\/.*/, '@sigx/runtime-core', '@sigx/runtime-dom', '@sigx/reactivity']
});
