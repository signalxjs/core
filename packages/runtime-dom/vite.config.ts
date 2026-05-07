import { defineLibConfig } from '../vite/src/lib.js';

export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'internals': 'src/internals.ts'
    },
    external: [/@sigx\/.*/]  // External: all @sigx/* packages
});
