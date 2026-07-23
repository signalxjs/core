/**
 * Ambient declarations shared by every example.
 *
 * Examples resolve `sigx` / `@sigx/*` to package SOURCE through the path
 * aliases (that is the point — they exercise the working tree, not a
 * published dist). Those sources reference `__DEV__`, the compile-time flag
 * each package declares in its own `src/env.d.ts` and the bundler replaces.
 * Nothing pulls those files into an example's program — a `.d.ts` is only
 * included when a config names it — so the flag has to be declared once
 * here, for the examples' own type-check.
 *
 * Referenced from each example's own tsconfig include list.
 */

declare const __DEV__: boolean;
