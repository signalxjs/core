import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = (name: string, sub = 'dist/index.js') =>
    resolve(__dirname, 'node_modules', name, sub);

// DEV ONLY: pin every @sigx/* package and its /internals subpath to a single
// canonical location in this app's node_modules. Without this, pnpm's
// symlinked layout can make the dev-server module runner fail subpath
// resolution from the @sigx/server-renderer dist or pick up multiple copies
// of the same package. End users on flat-install package managers (npm/yarn)
// typically don't need such an extensive map.
//
// The map must NOT apply to builds: the orchestrated SSR build (rfc-ssr-
// platform §3.1) externalizes the whole @sigx family from the server bundle
// so it shares one module graph with the production request handler — an
// aliased ABSOLUTE path is no longer a bare import and would get bundled,
// splitting DI token identities between the app and the handler.
const devAliases = {
    'sigx/jsx-runtime': pkg('sigx', 'dist/sigx.js'),
    'sigx/jsx-dev-runtime': pkg('sigx', 'dist/sigx.js'),
    'sigx/internals': pkg('sigx', 'dist/internals.js'),
    'sigx': pkg('sigx', 'dist/sigx.js'),
    '@sigx/runtime-core/internals': pkg('@sigx/runtime-core', 'dist/internals.js'),
    '@sigx/runtime-core': pkg('@sigx/runtime-core'),
    '@sigx/runtime-dom/platform': pkg('@sigx/runtime-dom', 'dist/platform.js'),
    '@sigx/runtime-dom/internals': pkg('@sigx/runtime-dom', 'dist/internals.js'),
    '@sigx/runtime-dom': pkg('@sigx/runtime-dom'),
    '@sigx/reactivity/internals': pkg('@sigx/reactivity', 'dist/internals.js'),
    '@sigx/reactivity': pkg('@sigx/reactivity'),
    '@sigx/server-renderer/server': pkg('@sigx/server-renderer', 'dist/server/index.js'),
    '@sigx/server-renderer/client': pkg('@sigx/server-renderer', 'dist/client/index.js'),
    '@sigx/server-renderer/node': pkg('@sigx/server-renderer', 'dist/node.js'),
    '@sigx/server-renderer': pkg('@sigx/server-renderer')
};

export default defineConfig(({ command }) => ({
    plugins: [sigx({ ssr: { entry: 'src/entry-server.tsx' } })],
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    },
    ...(command === 'serve' && {
        resolve: { alias: devAliases },
        ssr: { noExternal: ['sigx', '@sigx/server-renderer'] }
    })
}));
