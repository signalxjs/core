import { defineApp } from 'sigx';
import { resumePlugin } from '@sigx/resume';
import { serverPlugin } from '@sigx/server/plugin';
import { resumeManifest } from 'virtual:sigx-manifests';
import { App } from './App';
import { Poll } from './resume/Poll';
import { requestSummary } from './api.server';
import { appTypes } from './money';

/**
 * The boundary-refresh registry (rfc-server §6.3): registry key → server
 * component, explicitly passed to `createBoundaryRefresh` — same posture as
 * the server-fn registry, never ambient. Keys are the components'
 * transform-stamped `__resumeId` (the export name).
 */
export const refreshComponents = { Poll };

/**
 * Per-request app factory (docs/router-ssr-contract.md §1).
 *
 * The resume pack installs HERE (#413: `app.use(...)` is the one install
 * shape) — its manifest comes from `virtual:sigx-manifests` (inlined by the
 * SSR build; undefined under dev, where resume runs manifest-less). So does
 * the custom-type vocabulary (#411): `serverPlugin({ types })` provides it
 * to the render (state blob, boundary table) and stamps the RPC wire.
 *
 * The `await` is a server function called IN-PROCESS — a direct invocation,
 * no HTTP hop. It reads the live document request through the ambient scope
 * every handler opens around a render (rfc-server §7 v1.1, #309); the same
 * function called from the browser goes over the wire instead.
 */
export async function createApp(_url: string) {
    return defineApp(<App ssrRequest={await requestSummary()} />)
        .use(resumePlugin({ manifest: resumeManifest }))
        .use(serverPlugin({ types: appTypes }));
}

/**
 * The app a boundary refresh re-renders under (rfc-server §6.3) — the
 * `app:` option of every entry's `createBoundaryRefresh`. The refresh must
 * see the same app-level DI the document render did (the `types` above:
 * otherwise a refreshed boundary would encode a Money the page revived), but
 * not `createApp`'s per-request document work (`requestSummary()`), which
 * would run on every mutation. So: the DI half only. The entries still pass
 * `plugins:` explicitly, and explicit plugins win over the app's.
 */
export function refreshApp() {
    return defineApp(<></>).use(serverPlugin({ types: appTypes }));
}
