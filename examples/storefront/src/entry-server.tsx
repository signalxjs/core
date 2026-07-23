import { defineApp } from 'sigx';
import { islandsPlugin } from '@sigx/ssr-islands';
import { resumePlugin } from '@sigx/resume';
import { islandsManifest, resumeManifest } from 'virtual:sigx-manifests';
import { App } from './App';

/**
 * Per-request app factory (docs/router-ssr-contract.md §1). Both packs
 * install here (#413) — islands FIRST, so it wins the resolveBoundary
 * consult for `client:*` sites; resume declines those either way, but the
 * order keeps ownership explicit.
 */
export function createApp(_url: string) {
    return defineApp(<App />)
        .use(islandsPlugin({ manifest: islandsManifest }))
        .use(resumePlugin({ manifest: resumeManifest }));
}
