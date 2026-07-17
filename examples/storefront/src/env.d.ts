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
// Type-only: enables the client:* directive props on JSX components.
import '@sigx/ssr-islands/jsx';
