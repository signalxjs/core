/**
 * Test-only `JSX.IntrinsicElements` for runtime-core's own tests (#529).
 *
 * runtime-core declares no elements (rfc-1.0 §4.1) — a platform package
 * does. The root `pnpm typecheck` program has @sigx/runtime-dom's real table
 * in scope and EXCLUDES this file (root tsconfig `exclude`; the two would
 * merge conflicting property types). `tsconfig.test.json`'s isolated program
 * has no platform package, so these seven tags — every host element the
 * tests under this directory write — come from here. An explicit list, not
 * an index signature: `<anything>` must not typecheck. Not in the tarball
 * (`files: ["dist", "src"]`).
 */

declare global {
    namespace JSX {
        interface IntrinsicElements {
            b: any;
            button: any;
            div: any;
            input: any;
            li: any;
            span: any;
            textarea: any;
        }
    }
}

export {};
