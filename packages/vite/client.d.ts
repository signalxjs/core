/**
 * Ambient types for the modules the sigx Vite plugins generate (#562).
 *
 * Reference it once, next to `vite/client`, in any `.d.ts` of your app:
 *
 * ```ts
 * /// <reference types="@sigx/vite/client" />
 * ```
 *
 * Before this file every app hand-copied `declare module 'virtual:…'` blocks,
 * and the three copies in this repo's own examples had already drifted apart —
 * two of them typed a pack manifest as `unknown` that the third typed properly.
 *
 * This file NEVER imports `@sigx/ssr-islands` or `@sigx/resume`: both are
 * OPTIONAL peers of `@sigx/vite`, and an app that installs only one of them
 * must still type-check. The pack manifests go through the registry interface
 * below, which each pack fills in from its own entry — registration happens
 * because you imported the pack, the mechanism the `client:*` / `use:`
 * attribute types already use (a type-only subpath is the anti-pattern
 * #481/#482 removed).
 *
 * Deliberately NOT declared: `virtual:sigx-resume` (the QRL handler chunk) and
 * `virtual:sigx-ssr-node`. Both are imported only by generated code, never from
 * a user's source, so a declaration would advertise an entry point that is not
 * one.
 */

/**
 * Manifest types contributed by the strategy packs. Empty here; augmented by
 * `@sigx/ssr-islands` (`islands`) and `@sigx/resume` (`resume`) through
 * `declare global`, so a key exists exactly when its pack is installed and
 * imported.
 *
 * Keys must stay DISJOINT across packs — interface merging rejects a duplicate
 * member, which is also why the packs cannot each re-declare
 * `virtual:sigx-manifests` instead: inside a module file that is a module
 * *augmentation*, and augmenting a module the program has not declared yet is
 * an error (TS2664), so it would compile only for users who also reference this
 * file, and fail from inside `node_modules` for everyone else.
 */
interface SigxPackManifests {}

/** The islands manifest type when `@sigx/ssr-islands` is present, else `unknown`. */
type SigxIslandsManifest = SigxPackManifests extends { islands: infer T } ? T : unknown;
/** The resume manifest type when `@sigx/resume` is present, else `unknown`. */
type SigxResumeManifest = SigxPackManifests extends { resume: infer T } ? T : unknown;

/**
 * The server-function registry (rfc-server §3) — emitted by `sigxServer()` as
 * `dist/server/sigx-server-fns.js` beside the server entry, or inlined into the
 * one bundle in a bundled build. Pass it to the endpoint EXPLICITLY; it is
 * never ambient.
 *
 * Resolves in the SSR environment only.
 */
declare module 'virtual:sigx-server-fns' {
    export const serverFns: Record<string, () => Promise<unknown>>;
}

/**
 * Build-emitted document artifacts (rfc-deploy §3.2) — resolved by
 * `sigx({ ssr })` in the ssr environment. Importing it under dev throws:
 * dev has no manifests, and `createDevRequestHandler` resolves the template
 * and assets live.
 */
declare module 'virtual:sigx-app' {
    import type { CollectedAssets, ViteManifest } from '@sigx/vite/ssr';
    export const template: string;
    export const assets: CollectedAssets;
    export const manifest: ViteManifest;
    export const islandsManifest: SigxIslandsManifest | undefined;
    export const resumeManifest: SigxResumeManifest | undefined;
}

/**
 * The narrow sibling for the entry-server's app factory (#413) — unlike
 * `virtual:sigx-app` it resolves in EVERY mode: real inlined literals in the
 * SSR build, `undefined` under dev, where the packs run manifest-less.
 */
declare module 'virtual:sigx-manifests' {
    export const islandsManifest: SigxIslandsManifest | undefined;
    export const resumeManifest: SigxResumeManifest | undefined;
}

/** Island registration, provided by `sigxIslands()` — side effects only. */
declare module 'virtual:sigx-islands';

/** The loader bootstrap provided by `sigxResume()` — side effects only. */
declare module 'virtual:sigx-resume/entry';
