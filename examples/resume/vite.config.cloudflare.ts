// The Cloudflare build (rfc-deploy §4.2): same app, same plugins — the
// adapter swaps the server build from externalized-Node to a fully bundled
// workerd-conditioned worker. Separate outDirs so `dist/` (node) and
// `dist-cf/` (worker) coexist from one checkout:
//
//     pnpm build:cloudflare   →  vite build --app -c vite.config.cloudflare.ts
//     wrangler deploy         →  (reads wrangler.jsonc)
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxResume } from '@sigx/vite/resume';
import { sigxServer } from '@sigx/vite/server';
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
        sigxServer()
    ],
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    }
});
