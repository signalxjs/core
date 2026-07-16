import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxResume } from '@sigx/vite/resume';
import { sigxIslands } from '@sigx/vite/islands';

// Both strategy packs on one app: resume owns src/resume/** (the ~50 product
// cards and forms — zero JS until interaction), islands owns src/islands/**
// (the two places that genuinely need live JS at load: the cart badge and
// the JS HUD). Disjoint file conventions keep the transforms disjoint.
const SIGX_FAMILY = [
    'sigx',
    '@sigx/server-renderer',
    '@sigx/resume',
    '@sigx/ssr-islands',
    '@sigx/runtime-core',
    '@sigx/runtime-dom',
    '@sigx/reactivity'
];

export default defineConfig(({ command }) => ({
    plugins: [
        sigx({ ssr: { entry: 'src/entry-server.tsx' } }),
        sigxResume(),
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
