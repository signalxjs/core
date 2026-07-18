// The Netlify build (rfc-deploy §4.5): same app, same plugins — the adapter
// bundles the server and generates the Frameworks API function
// (.netlify/v1/functions/sigx-ssr) after both environments have written.
// Separate outDirs so `dist/` (node) and `dist-netlify/` coexist:
//
//     pnpm build:netlify           →  vite build --app -c vite.config.netlify.ts
//     netlify deploy --prod --no-build   (publish dir: dist-netlify/client)
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxResume } from '@sigx/vite/resume';
import { sigxServer } from '@sigx/vite/server';
import { netlify } from '@sigx/netlify';

export default defineConfig({
    plugins: [
        sigx({
            ssr: {
                entry: 'src/entry-server.tsx',
                clientOutDir: 'dist-netlify/client',
                serverOutDir: 'dist-netlify/server',
                adapter: netlify()
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
