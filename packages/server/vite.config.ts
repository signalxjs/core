import { defineLibConfig } from '../vite/src/lib.js';

// @sigx/server has 5 entry points (rfc-server §2):
// - index: the isomorphic serverFn marker + error channel (server builds see
//   the real pipeline; the `browser` export condition swaps in browser.js)
// - browser: throwing serverFn variants — defense in depth for files the
//   transform did not extract (misconfigured include pattern)
// - client/index: the fetch stubs the transform emits imports of — dep-free
//   (size-limit checks it with no ignore list)
// - server/index: handleServerFnRequest, WinterCG-clean (edge-safe)
// - node: createServerFnHandler, the connect-style adapter (node: imports
//   live only here, like @sigx/server-renderer/node)
export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'browser': 'src/browser.ts',
        'client/index': 'src/client/index.ts',
        'server/index': 'src/server/index.ts',
        'node': 'src/node.ts'
    },
    external: ['sigx', /@sigx\/.*/, /^node:/],
    platform: 'neutral'
});
