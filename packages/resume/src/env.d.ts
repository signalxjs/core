/**
 * Compile-time dev flag. Replaced at build time: `false` in the prod dist
 * (dev-only blocks are stripped), the runtime NODE_ENV check in the dev dist.
 * Defined by `defineLibConfig` (package builds) and `vitest.config.ts` (tests).
 */
declare const __DEV__: boolean;
