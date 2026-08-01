/**
 * Resume's setup-context augmentation (#416) — types the transform↔runtime
 * contract that used to exist only as inline casts at the two stamp sites.
 * Follows the established augmentation pattern (`@sigx/server-renderer`'s
 * `ssr`, `@sigx/ssr-islands`' `client:*` attributes).
 *
 * It also carries resume's half of the `virtual:sigx-manifests` /
 * `virtual:sigx-app` manifest types (#562, below), for the same reason and by
 * the same mechanism: registration rides the pack's own import.
 */

import type { ResumeManifest } from './types';

/**
 * The resume half of `virtual:sigx-manifests` / `virtual:sigx-app` (#562).
 * `@sigx/vite` cannot type these itself — this pack is an OPTIONAL peer of it,
 * so an app without resume must still type-check — so `@sigx/vite/client`
 * declares an empty registry and each pack fills in its own key here. Keys stay
 * disjoint across packs: interface merging rejects a duplicate member.
 */
declare global {
    interface SigxPackManifests {
        resume: ResumeManifest;
    }
}

declare module '@sigx/runtime-core' {
    interface ComponentSetupContext {
        /**
         * The per-request boundary id of the resume component currently
         * rendering — stamped by the resume plugin's
         * `transformComponentContext` during the server render, and by the
         * upgrade restore hook on the client. The `sigxResume()` transform
         * injects `data-sigx-b={ctx.$sigxB}` on interactive elements, so
         * each QRL-carrying element self-describes its boundary (lexical
         * ownership — no DOM-ancestry search). Absent outside resume
         * components.
         */
        $sigxB?: string;
    }
}

export {};
