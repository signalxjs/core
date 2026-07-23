/**
 * Resume's setup-context augmentation (#416) — types the transform↔runtime
 * contract that used to exist only as inline casts at the two stamp sites.
 * Follows the established augmentation pattern (`@sigx/server-renderer`'s
 * `ssr`, `@sigx/ssr-islands`' `client:*` attributes).
 */

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
