import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxIslands } from '@sigx/vite/islands';

// The @sigx family is EXTERNALIZED from the dev-server module graph (the
// consumer-shaped setup): the app's imports, server.mjs's own imports, and
// the request handler's renderer all resolve to Node's instances, so the
// app, the handler, and islandsPlugin() share one module graph — the
// consistency rule createDevRequestHandler documents. Only this app's source
// runs through the runner. (What makes the handler follow this setup rather
// than force-inline the renderer is the `virtual:sigx-ssr-node` shim, #425.)
// (Contrast examples/spa-ssr, which takes the opposite, all-in-runner route
// via source aliases for watch-mode DX.)
const SIGX_FAMILY = [
    'sigx',
    '@sigx/server-renderer',
    '@sigx/ssr-islands',
    '@sigx/runtime-core',
    '@sigx/runtime-dom',
    '@sigx/reactivity'
];

export default defineConfig(({ command }) => ({
    plugins: [
        sigx({ ssr: { entry: 'src/entry-server.tsx' } }),
        sigxIslands()
    ],
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    },
    ...(command === 'serve' && {
        ssr: { external: SIGX_FAMILY }
    })
}));
