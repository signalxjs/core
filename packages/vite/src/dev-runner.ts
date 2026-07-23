// ============================================================================
// Loading @sigx packages through Vite's dev SSR module runner
//
// INTERNAL — deliberately not in package.json `exports`. `@sigx/vite/ssr` is a
// public entry, so the virtual id and its codegen live here instead: they are
// wiring between the dev handler and the `sigx()` plugin, not API an app calls.
// ============================================================================

/**
 * `virtual:sigx-ssr-node` — a one-line re-export shim for the dev request
 * handler's renderer (#425).
 *
 * `vite.ssrLoadModule('@sigx/server-renderer/node')` names the package as the
 * ROOT of the request, and a root request is always INLINED by the module
 * runner — `ssr.external` only ever governs an *import* made from inside a
 * module. So a project that externalizes the @sigx family (the
 * consumer-shaped dev setup) got the renderer inlined while the app's own
 * `@sigx/*` imports resolved through Node: two live copies of the same file,
 * two sets of `Symbol()` DI tokens, and every app-carried provide
 * (`app.use(pack())` → `provideSSRPlugin`, `provideHydrateDefaults`,
 * `provideTypeHandlers`) invisible to the renderer. The render came out
 * silently plugin-less — resume and islands pages shipped with no boundary
 * table at all.
 *
 * The shim puts the package behind an *import*, where the project's
 * external/noExternal decision applies exactly as it does to the app's
 * imports: externalized ⇒ both reach Node's instance, noExternal (the
 * `sigx()` default) ⇒ both stay in the runner. One graph either way.
 * Resolved and loaded by the `sigx()` plugin.
 */
export const SSR_NODE_VIRTUAL_ID = 'virtual:sigx-ssr-node';
export const SSR_NODE_RESOLVED_ID = '\0' + SSR_NODE_VIRTUAL_ID;

/** The shim's body — deliberately nothing but the re-export. */
export function generateSSRNodeShimCode(): string {
    return `export * from '@sigx/server-renderer/node';\n`;
}

/**
 * Did this load fail because the specifier does not RESOLVE, as opposed to
 * throwing while it evaluated? The distinction decides whether a fallback
 * load is safe: an unresolvable id means "that module is not here", while an
 * error from inside the module is the module's own and must surface. Same
 * classification the server-fn plugin uses to tell "@sigx/server not
 * installed" from "@sigx/server threw".
 */
export function isModuleResolutionError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return (
        (err as { code?: string } | null)?.code === 'ERR_MODULE_NOT_FOUND' ||
        /Failed to (resolve|load) (import|url)|Cannot find (module|package)/.test(message)
    );
}
