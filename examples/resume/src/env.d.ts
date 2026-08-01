/// <reference types="@sigx/vite/client" />

// That one line types every `virtual:*` module the sigx plugins generate
// (#562). `resumeManifest` carries its real type because this app imports
// @sigx/resume; `islandsManifest` stays `unknown` — islands is not installed
// here, and the value is `undefined` in this app anyway.

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
