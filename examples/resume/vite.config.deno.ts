// The Deno build (rfc-deploy §4.3): same app, same plugins — the server
// build goes BUNDLED because Deno cannot select custom export conditions
// (no --conditions flag), so the prod dists must be resolved at build time.
// No @sigx/deno package exists (deliberately): the SigxAdapter is a plain
// object, and hand-rolling it here IS the documentation.
//
//     pnpm build:deno   →  vite build --app -c vite.config.deno.ts
//     deno run --allow-net --allow-read --allow-env dist-deno/server/entry.deno.js
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';
import { sigxResume } from '@sigx/vite/resume';
import { sigxServer } from '@sigx/vite/server';

export default defineConfig({
    plugins: [
        sigx({
            ssr: {
                entry: 'src/entry-server.tsx',
                clientOutDir: 'dist-deno/client',
                serverOutDir: 'dist-deno/server',
                adapter: {
                    name: 'deno',
                    serverBuild: 'bundled',
                    conditions: ['deno'],
                    // jsr: specifiers stay runtime imports — Deno fetches
                    // and caches them itself.
                    runtimeExternal: [/^jsr:/],
                    entry: 'src/entry.deno.ts'
                }
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
