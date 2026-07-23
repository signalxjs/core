/// <reference types="vite/client" />

// Generated bootstraps (side effects only).
declare module 'virtual:sigx-resume/entry';
declare module 'virtual:sigx-islands';

// Build-emitted document artifacts (rfc-deploy §3.2) — resolved by
// sigx({ ssr }) in the ssr environment; throws under dev.
declare module 'virtual:sigx-app' {
    import type { CollectedAssets, ViteManifest } from '@sigx/vite/ssr';
    export const template: string;
    export const assets: CollectedAssets;
    export const manifest: ViteManifest;
    export const islandsManifest: unknown | undefined;
    export const resumeManifest: unknown | undefined;
}
// The pack manifests for the entry-server's app factory (#413) — resolved
// in every mode; undefined under dev (packs run manifest-less there).
declare module 'virtual:sigx-manifests' {
    import type { IslandsManifestV2 } from '@sigx/ssr-islands';
    import type { ResumeManifest } from '@sigx/resume';
    export const islandsManifest: IslandsManifestV2 | undefined;
    export const resumeManifest: ResumeManifest | undefined;
}
