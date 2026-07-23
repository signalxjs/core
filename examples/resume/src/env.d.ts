// The generated loader bootstrap provided by sigxResume() (side effects only).
declare module 'virtual:sigx-resume/entry';

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
    import type { ResumeManifest } from '@sigx/resume';
    export const islandsManifest: unknown | undefined;
    export const resumeManifest: ResumeManifest | undefined;
}

// The server-fn registry (explicitly passed, never ambient).
declare module 'virtual:sigx-server-fns' {
    export const serverFns: Record<string, () => Promise<unknown>>;
}

// jsr: specifiers resolve at runtime in Deno (auto-fetched) — TypeScript's
// resolver doesn't understand them, so the copyable entry.deno.ts gets its
// types here.
declare module 'jsr:@std/http@^1.0.0/file-server' {
    export function serveDir(
        request: Request,
        options?: {
            fsRoot?: string;
            urlRoot?: string;
            quiet?: boolean;
            showIndex?: boolean;
        }
    ): Promise<Response>;
}
