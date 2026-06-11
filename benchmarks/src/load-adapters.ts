import type { FrameworkAdapter } from './adapters/types.ts';

/**
 * Load all framework adapters. Adapters are imported dynamically so that
 * NODE_ENV is set to production first (React/Vue pick their prod builds off
 * it) and so a missing sigx dist produces a clear actionable error.
 */
/** Load just the sigx adapter (used by the quick suite). */
export async function loadSigx(): Promise<FrameworkAdapter> {
    // Fair comparison: React and Vue select dev vs prod builds via NODE_ENV.
    process.env.NODE_ENV ||= 'production';
    try {
        const sigx = (await import('./adapters/sigx.ts')).default;
        // Smoke-render so a stale/partial dist also fails here with the hint.
        await sigx.renderToString('small-page');
        return sigx;
    } catch (err) {
        console.error('[benchmarks] Could not load/render via @sigx/server-renderer dist — run pnpm build first (at the repo root).');
        console.error(`  cause: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }
}

export async function loadAdapters(): Promise<FrameworkAdapter[]> {
    const sigx = await loadSigx();
    const vue = (await import('./adapters/vue.ts')).default;
    const react = (await import('./adapters/react.ts')).default;
    const preact = (await import('./adapters/preact.ts')).default;
    return [sigx, vue, react, preact];
}
