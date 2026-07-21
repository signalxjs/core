import { createSSR } from '@sigx/server-renderer';
import { resumePlugin } from '@sigx/resume';
import { createBoundaryRefresh } from '@sigx/resume/server';
import { refreshComponents } from './entry-server';

/**
 * Dev half of single-flight boundary refresh (rfc-server §6.3): the
 * `renderBoundaries` export `sigxServer({ renderBoundaries })` forwards to
 * the dev fn endpoint — same registry, same machinery as server.mjs's prod
 * wiring, loaded through the SSR module runner so it shares the dev module
 * graph. No manifest in dev: QRLs resolve through the virtual registry.
 */
export const renderBoundaries = createBoundaryRefresh({
    ssr: createSSR().use(resumePlugin()),
    components: refreshComponents
});
