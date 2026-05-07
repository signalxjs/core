import { defineConfig } from 'vite';
import sigx from '@sigx/vite';

export default defineConfig({
    plugins: [sigx()],
    oxc: {
        jsx: {
            runtime: 'automatic',
            importSource: 'sigx'
        }
    },
    server: {
        port: 5173,
        open: true
    }
});
