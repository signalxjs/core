import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxResume } from '@sigx/vite/resume';

// Same consumer-shaped setup as examples/ssr-islands: the @sigx family is
// externalized from the dev-server module graph so the app, the request
// handler, and resumePlugin() share one set of module instances.
const SIGX_FAMILY = [
    'sigx',
    '@sigx/server-renderer',
    '@sigx/resume',
    '@sigx/runtime-core',
    '@sigx/runtime-dom',
    '@sigx/reactivity'
];

export default defineConfig(({ command }) => ({
    plugins: [
        sigx({ ssr: { entry: 'src/entry-server.tsx' } }),
        sigxResume()
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
