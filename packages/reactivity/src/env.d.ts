/**
 * Compile-time dev flag. Replaced at build time: `false` in the prod dist
 * (dev-only blocks are stripped), the runtime NODE_ENV check in the dev dist.
 * Defined by `defineLibConfig` (package builds) and `vitest.config.ts` (tests).
 */
declare const __DEV__: boolean;

/**
 * The package's own version, replaced at build time by `defineLibConfig`
 * from its package.json; `vitest.setup.ts` defines it for tests. Read via
 * `typeof` so an unbundled evaluation resolves to `'unknown'`, not a throw.
 */
declare const __SIGX_VERSION__: string;
