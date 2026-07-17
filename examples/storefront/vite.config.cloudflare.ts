// The Cloudflare build (rfc-deploy §4.2): same app, same plugins — the
// adapter swaps the server build to a fully bundled workerd-conditioned
// worker. Separate outDirs so `dist/` (node) and `dist-cf/` (worker)
// coexist from one checkout.
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxResume } from '@sigx/vite/resume';
import { sigxIslands } from '@sigx/vite/islands';
import { cloudflare } from '@sigx/cloudflare';

export default defineConfig({
    plugins: [
        sigx({
            ssr: {
                entry: 'src/entry-server.tsx',
                clientOutDir: 'dist-cf/client',
                serverOutDir: 'dist-cf/server',
                adapter: cloudflare()
            }
        }),
        sigxResume(),
        sigxIslands()
    ],
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    }
});
