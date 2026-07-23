// ============================================================================
// virtual:sigx-app — the document-side artifacts as a module (rfc-deploy
// §3.2). The sibling of virtual:sigx-server-fns: what a fetch handler needs
// (template, precomputed assets, manifests) with no filesystem in the
// OUTPUT. The build always runs in Node — load() reads the client outDir
// with fs at build time and inlines everything as literals.
//
// Also materialized as dist/server/sigx-app.js (the emitFile chunk pattern
// the server-fn registry uses), so a Node server.mjs collapses from four
// readFiles to one import — one documented pattern across all platforms.
// ============================================================================

import { readFileSync } from 'fs';
import { join } from 'path';
import { collectAssets, type ViteManifest } from './ssr.js';

export const APP_VIRTUAL_ID = 'virtual:sigx-app';
export const APP_RESOLVED_ID = '\0' + APP_VIRTUAL_ID;
export const APP_FILE = 'sigx-app.js';

// virtual:sigx-manifests — the narrow sibling for the ENTRY-SERVER side
// (#413): just the pack manifests, resolvable in every mode, so the
// per-request app factory can construct its packs
// (`app.use(islandsPlugin({ manifest: islandsManifest }))`) without the
// server wiring threading manifests in. Serve mode exports undefineds —
// dev packs are manifest-less by design (QRLs/chunks resolve through the
// virtual registries).
export const MANIFESTS_VIRTUAL_ID = 'virtual:sigx-manifests';
export const MANIFESTS_RESOLVED_ID = '\0' + MANIFESTS_VIRTUAL_ID;

/** Serve mode / client builds: no manifests, and none are needed. */
export function generateManifestsServeCode(): string {
    return 'export const islandsManifest = undefined;\nexport const resumeManifest = undefined;\n';
}

/**
 * Build mode: inline the pack manifests from the client build's outputs.
 * Same client-before-ssr `buildApp` ordering guarantee as virtual:sigx-app.
 */
export function generateManifestsModuleCode(clientDir: string): string {
    const islandsManifest = readJsonIfExists(join(clientDir, '.vite/sigx-islands-manifest.json'));
    const resumeManifest = readJsonIfExists(join(clientDir, '.vite/sigx-resume-manifest.json'));
    return [
        `export const islandsManifest = ${islandsManifest === undefined ? 'undefined' : JSON.stringify(islandsManifest)};`,
        `export const resumeManifest = ${resumeManifest === undefined ? 'undefined' : JSON.stringify(resumeManifest)};`,
        ''
    ].join('\n');
}

/** Serve mode has no manifests — dev already solves template/assets live. */
export function generateServeError(): string {
    return (
        `throw new Error("[sigx] virtual:sigx-app is a BUILD artifact - it does not exist under vite dev. ` +
        `Use createDevRequestHandler from '@sigx/vite/ssr' for the dev server (template and assets are resolved live).");`
    );
}

/** Absent (ENOENT) → undefined; unreadable or invalid JSON → loud, named. */
function readJsonIfExists(file: string): unknown | undefined {
    let raw: string;
    try {
        raw = readFileSync(file, 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw new Error(
            `[sigx] virtual:sigx-app: failed to read ${file}: ${err instanceof Error ? err.message : String(err)}`
        );
    }
    try {
        return JSON.parse(raw) as unknown;
    } catch (err) {
        throw new Error(
            `[sigx] virtual:sigx-app: invalid JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}

/**
 * Generate the virtual module's code by reading the CLIENT build's outputs.
 * Requires the client environment to have built first — `buildApp` ordering
 * (client → ssr) is what guarantees it.
 */
export function generateAppModuleCode(clientDir: string, base: string): string {
    let template: string;
    try {
        template = readFileSync(join(clientDir, 'index.html'), 'utf-8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        throw new Error(
            `[sigx] virtual:sigx-app: no index.html in the client outDir (${clientDir}). ` +
            `The client environment must build before the ssr environment - build with ` +
            `'vite build --app' (builder mode) so the sigx plugin's buildApp ordering applies.`
        );
    }
    const manifest = readJsonIfExists(join(clientDir, '.vite/manifest.json')) as
        | ViteManifest
        | undefined;
    if (!manifest) {
        throw new Error(
            `[sigx] virtual:sigx-app: no .vite/manifest.json in the client outDir (${clientDir}). ` +
            `The sigx plugin enables the client manifest itself - was the client environment built ` +
            `by a config without sigx({ ssr })?`
        );
    }
    const entries = Object.keys(manifest).filter((key) => manifest[key].isEntry);
    const assets = collectAssets(manifest, entries, base);
    const islandsManifest = readJsonIfExists(join(clientDir, '.vite/sigx-islands-manifest.json'));
    const resumeManifest = readJsonIfExists(join(clientDir, '.vite/sigx-resume-manifest.json'));

    return [
        `export const template = ${JSON.stringify(template)};`,
        `export const assets = ${JSON.stringify(assets)};`,
        `export const manifest = ${JSON.stringify(manifest)};`,
        `export const islandsManifest = ${islandsManifest === undefined ? 'undefined' : JSON.stringify(islandsManifest)};`,
        `export const resumeManifest = ${resumeManifest === undefined ? 'undefined' : JSON.stringify(resumeManifest)};`,
        ''
    ].join('\n');
}
