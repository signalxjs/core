// The island-registration module provided by sigxIslands() (side effects only).
declare module 'virtual:sigx-islands';

// The pack manifests for the entry-server's app factory (#413) — resolved
// in every mode; undefined under dev (packs run manifest-less there).
declare module 'virtual:sigx-manifests' {
    import type { IslandsManifestV2 } from '@sigx/ssr-islands';
    export const islandsManifest: IslandsManifestV2 | undefined;
    export const resumeManifest: unknown | undefined;
}
