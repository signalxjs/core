/**
 * @sigx/resume
 *
 * Resumability for SignalX SSR — the second first-party strategy
 * pack on @sigx/server-renderer's public plugin API (#241).
 *
 * Server pages render fully; the browser ships only a tiny delegation
 * loader. Event handlers are extracted at build time by `sigxResume()`
 * (`@sigx/vite/resume`) into lazily-imported QRL chunks that run against a
 * resumed scope of named signals — component setup never re-runs on load,
 * and the component chunk itself loads only when a handler writes state
 * (upgrade-on-write).
 *
 * @example server
 * ```ts
 * import { createSSR } from '@sigx/server-renderer';
 * import { resumePlugin } from '@sigx/resume';
 *
 * const ssr = createSSR().use(resumePlugin({ manifest }));
 * ```
 *
 * The client entry is `@sigx/resume/client` (lazy-loaded on first
 * interaction) and the delegation loader is `@sigx/resume/loader` — the
 * generated `virtual:sigx-resume/entry` wires them up; apps rarely import
 * either directly.
 */

export { resumePlugin } from './plugin';
export type { ResumePluginOptions, ResumeManifest, ResumeChunkRef } from './types';
