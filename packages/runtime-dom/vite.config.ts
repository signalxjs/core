import { defineLibConfig } from '../vite/src/lib.js';

export default defineLibConfig({
    entry: {
        'index': 'src/index.ts',
        'internals': 'src/internals.ts',
        // Side-effect entry: registers the DOM form model processor.
        // Kept as its OWN dist file so sideEffects can name it precisely —
        // the index entry stays fully tree-shakeable.
        'model-processor': 'src/model-processor.ts'
    },
    external: [/@sigx\/.*/]  // External: all @sigx/* packages
});
