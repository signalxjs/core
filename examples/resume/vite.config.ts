import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxResume } from '@sigx/vite/resume';
import { sigxServer } from '@sigx/vite/server';

// Same consumer-shaped setup as examples/ssr-islands: the @sigx family is
// externalized from the dev-server module graph so the app, the request
// handler, and resumePlugin() share one set of module instances.
const SIGX_FAMILY = [
    'sigx',
    '@sigx/server-renderer',
    '@sigx/resume',
    '@sigx/server',
    '@sigx/runtime-core',
    '@sigx/runtime-dom',
    '@sigx/reactivity'
];

export default defineConfig(({ command }) => ({
    plugins: [
        sigx({ ssr: { entry: 'src/entry-server.tsx' } }),
        sigxResume(),
        // Single-flight boundary refresh in dev (rfc-server §6.3): the
        // module's `renderBoundaries` export reaches the dev fn endpoint.
        sigxServer({ renderBoundaries: '/src/dev-refresh.ts' })
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
