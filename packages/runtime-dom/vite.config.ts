import { defineLibConfig } from '../vite/src/lib.js';

export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'internals': 'src/internals.ts',
        // Side-effect entry: platform identity (model processor + default
        // mount). Its OWN dist file so sideEffects can name it precisely —
        // the index entry stays fully tree-shakeable.
        'platform': 'src/platform.ts'
    },
    external: [/@sigx\/.*/]  // External: all @sigx/* packages
});
