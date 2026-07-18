// ============================================================================
// SigxAdapter — the deployment build seam (rfc-deploy §3.1).
//
// An adapter is a PLAIN OBJECT consumed by the sigx plugin's config build
// branch — not a second Vite plugin. The ssr environment's resolve behavior
// encodes the module-graph/DI-token invariant this codebase documents
// obsessively; keeping one authority over that environment keeps the
// invariant auditable in one file instead of depending on plugin-order
// mergeConfig semantics to overturn `external: true` from a second package.
// ============================================================================

import type { ViteDevServer } from 'vite';
import { defaultServerConditions } from 'vite';

export interface SigxAdapter {
    /** 'node', 'cloudflare', … */
    name: string;

    /**
     * 'external' — today's output: deps resolve from node_modules at
     *              runtime (Node/Bun hosts).
     * 'bundled'  — fully self-contained server build: `resolve.noExternal:
     *              true`, platform conditions, target 'esnext' (edge).
     * Binary on purpose: partially-external is the dangerous middle ground
     * for DI-token identity and is unrepresentable here. 'bundled' is safe
     * for the same invariant because it is total — the platform entry, the
     * strategy packs, the handlers, and the registry land in ONE bundle =
     * one module graph.
     */
    serverBuild: 'external' | 'bundled';

    /** Extra resolve.conditions for the ssr environment, e.g. ['workerd', 'worker']. */
    conditions?: string[];

    /** Specifiers left as runtime imports in a bundled build (e.g. /^cloudflare:/). */
    runtimeExternal?: (string | RegExp)[];

    /** Platform entry module (project-relative). Default: ssr.entry (today's behavior). */
    entry?: string;

    /** Server-build target. Default 'esnext' for 'bundled'. */
    target?: string;

    /**
     * BEFORE any environment builds: scaffold-iff-absent build inputs — the
     * platform entry, most importantly. The documented adapter-package
     * convention (the `wrangler.jsonc` posture applied to the entry, PR
     * #322 review): write it once when missing, then NEVER touch it — the
     * file is user-owned from that moment.
     */
    setup?(ctx: AdapterSetupContext): void | Promise<void>;

    /**
     * After BOTH environments have written: copy statics, write platform
     * config, validate. The `.vercel/output` assembly hook.
     */
    generate?(ctx: AdapterGenerateContext): void | Promise<void>;

    /** Dev-server hook for platform-binding proxies (rfc-deploy §4.6). */
    dev?(server: ViteDevServer): void | Promise<void>;
}

export interface AdapterSetupContext {
    root: string;
    /** The app's SSR entry (ssr.entry) — what a scaffolded platform entry imports. */
    ssrEntry: string;
    logger: { info(msg: string): void; warn(msg: string): void };
}

export interface AdapterGenerateContext {
    root: string;
    clientOutDir: string; // absolute
    serverOutDir: string; // absolute
    ssrInput: string;     // the resolved server entry
    logger: { info(msg: string): void; warn(msg: string): void };
}

/**
 * The default adapter: today's externalized Node output, byte-identical.
 * Deploy with `node --conditions production server.mjs`.
 */
export function nodeAdapter(): SigxAdapter {
    return { name: 'node', serverBuild: 'external' };
}

/**
 * The ssr-environment config fragment for an adapter — the ONE authority
 * over the module-graph/DI invariant (rfc-deploy §3.1).
 *
 * Vite 8 semantics this encodes: a specified `resolve.conditions` array
 * REPLACES the defaults wholesale (never merges) — which is exactly how a
 * workerd-targeted bundle drops the `node` condition. The
 * `development|production` token resolves per the build's production flag,
 * so the bundled output contains the prod dists.
 */
export function adapterSsrEnvironment(
    adapter: SigxAdapter,
    serverOutDir: string,
    input: string
): Record<string, unknown> {
    if (adapter.serverBuild === 'bundled') {
        return {
            resolve: {
                noExternal: true,
                conditions: [...(adapter.conditions ?? []), 'module', 'development|production']
            },
            build: {
                target: adapter.target ?? 'esnext',
                outDir: serverOutDir,
                rollupOptions: {
                    input,
                    ...(adapter.runtimeExternal && { external: adapter.runtimeExternal })
                }
            }
        };
    }
    // 'external' — the pre-adapter shape, byte-identical for nodeAdapter().
    return {
        resolve: {
            external: true,
            ...(adapter.conditions && {
                conditions: [...adapter.conditions, ...defaultServerConditions]
            })
        },
        build: {
            outDir: serverOutDir,
            rollupOptions: {
                input
            }
        }
    };
}
