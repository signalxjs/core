// The Vercel build (rfc-deploy §4.4): same app, same plugins — the adapter
// bundles the server and generates the full Build Output API v3 layout
// (.vercel/output) after both environments have written. Separate outDirs
// so `dist/` (node) and `dist-vercel/` coexist from one checkout:
//
//     pnpm build:vercel          →  vite build --app -c vite.config.vercel.ts
//     vercel deploy --prebuilt   →  (uploads .vercel/output)
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxResume } from '@sigx/vite/resume';
import { sigxServer } from '@sigx/vite/server';
import { vercel } from '@sigx/vercel';

export default defineConfig({
    plugins: [
        sigx({
            ssr: {
                entry: 'src/entry-server.tsx',
                clientOutDir: 'dist-vercel/client',
                serverOutDir: 'dist-vercel/server',
                adapter: vercel()
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
