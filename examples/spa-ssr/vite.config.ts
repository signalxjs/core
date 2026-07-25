import { defineConfig } from 'vite';
import sigx from '@sigx/vite';

// The `@sigx/*` dev alias map that used to live here is gone: the plugin
// generates it from the installed set now (#487), one entry per exports
// subpath, and skips any package this config aliases itself. Keeping a
// hand-written copy would only mean maintaining it per package.
export default defineConfig(({ command }) => ({
    plugins: [sigx({ ssr: { entry: 'src/entry-server.tsx' } })],
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    },
    ...(command === 'serve' && {
        ssr: { noExternal: ['sigx', '@sigx/server-renderer'] }
    })
}));
