import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
    // Vite 8 uses Oxc for JSX transforms
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    },
    test: {
        environment: 'happy-dom',
        include: ['packages/**/__tests__/**/*.test.{ts,tsx}'],
        globals: true,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['packages/*/src/**/*.ts'],
            exclude: ['**/*.d.ts', '**/index.ts']
        }
    },
    resolve: {
        alias: {
            '@sigx/reactivity/internals': resolve(__dirname, 'packages/reactivity/src/internals.ts'),
            '@sigx/reactivity': resolve(__dirname, 'packages/reactivity/src/index.ts'),
            '@sigx/runtime-core/internals': resolve(__dirname, 'packages/runtime-core/src/internals.ts'),
            '@sigx/runtime-core': resolve(__dirname, 'packages/runtime-core/src/index.ts'),
            '@sigx/runtime-dom/internals': resolve(__dirname, 'packages/runtime-dom/src/internals.ts'),
            '@sigx/runtime-dom': resolve(__dirname, 'packages/runtime-dom/src/index.ts'),
            '@sigx/server-renderer/server': resolve(__dirname, 'packages/server-renderer/src/server/index.ts'),
            '@sigx/server-renderer/client': resolve(__dirname, 'packages/server-renderer/src/client/index.ts'),
            '@sigx/server-renderer': resolve(__dirname, 'packages/server-renderer/src/index.ts'),
            'sigx/internals': resolve(__dirname, 'packages/sigx/src/internals.ts'),
            'sigx/hydration': resolve(__dirname, 'packages/sigx/src/hydration.ts'),
            'sigx/jsx-runtime': resolve(__dirname, 'packages/sigx/src/jsx-runtime.ts'),
            'sigx/jsx-dev-runtime': resolve(__dirname, 'packages/sigx/src/jsx-runtime.ts'),
            'sigx': resolve(__dirname, 'packages/sigx/src/index.ts')
        }
    }
});
