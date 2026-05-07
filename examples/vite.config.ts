import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    // Vite 8 uses oxc instead of esbuild for JSX transforms
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    },
    resolve: {
        alias: {
            'sigx/jsx-runtime': resolve(__dirname, '../packages/sigx/src/index.ts'),
            'sigx/jsx-dev-runtime': resolve(__dirname, '../packages/sigx/src/index.ts'),
            'sigx/internals': resolve(__dirname, '../packages/sigx/src/internals.ts'),
            'sigx': resolve(__dirname, '../packages/sigx/src/index.ts'),
            '@sigx/vite': resolve(__dirname, '../packages/vite/src/index.ts'),
            '@sigx/reactivity/internals': resolve(__dirname, '../packages/reactivity/src/internals.ts'),
            '@sigx/reactivity': resolve(__dirname, '../packages/reactivity/src/index.ts'),
            '@sigx/runtime-core/internals': resolve(__dirname, '../packages/runtime-core/src/internals.ts'),
            '@sigx/runtime-core': resolve(__dirname, '../packages/runtime-core/src/index.ts'),
            '@sigx/runtime-dom/internals': resolve(__dirname, '../packages/runtime-dom/src/internals.ts'),
            '@sigx/runtime-dom': resolve(__dirname, '../packages/runtime-dom/src/index.ts'),
            '@sigx/server-renderer': resolve(__dirname, '../packages/server-renderer/src/index.ts')
        }
    },
    server: {
        port: 8080,
        open: true,
        forwardConsole: true
    }
});
