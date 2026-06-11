import type { FrameworkAdapter } from './adapters/types.ts';

/**
 * Load all framework adapters. Adapters are imported dynamically so that
 * NODE_ENV is set to production first (React/Vue pick their prod builds off
 * it) and so a missing sigx dist produces a clear actionable error.
 */
export async function loadAdapters(): Promise<FrameworkAdapter[]> {
    // Fair comparison: React and Vue select dev vs prod builds via NODE_ENV.
    process.env.NODE_ENV ||= 'production';

    let sigx: FrameworkAdapter;
    try {
        sigx = (await import('./adapters/sigx.ts')).default;
        // Smoke-render so a stale/partial dist also fails here with the hint.
        await sigx.renderToString('small-page');
    } catch (err) {
        console.error('[benchmarks] Could not load/render via @sigx/server-renderer dist — run pnpm build first (at the repo root).');
        console.error(`  cause: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    }

    const vue = (await import('./adapters/vue.ts')).default;
    const react = (await import('./adapters/react.ts')).default;
    const preact = (await import('./adapters/preact.ts')).default;
    return [sigx, vue, react, preact];
}
