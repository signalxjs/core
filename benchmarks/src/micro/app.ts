/**
 * The bench server app (rfc-server-v4). The runtime is fail-closed — a bare
 * `serverFn` denies 401, which the per-bench correctness guards catch as
 * "expected 200, got 401" — so the request-path suites stamp a real app
 * here, imported for its side effect by every suite that defines fns.
 *
 * A trivial authenticator, deliberately: the benches now measure the
 * pipeline a real authenticated app pays on every request — config
 * resolution, the middleware slot, the principal memo, the identity gate,
 * and the default `requireAuthenticated` policy — while the authenticator
 * itself stays O(1) so the numbers keep measuring the FRAMEWORK's overhead,
 * not a cookie parser's. Timing rows shifted when this landed (the pipeline
 * is real work); the baseline was re-recorded on the bench VM immediately
 * after, from main — the re-baseline workflow's Azure federated credential
 * only matches main's OIDC subject, so AGENTS.md's "run it from your
 * branch" cannot work until a branch-pattern credential is added.
 */
import { createServerApp } from '@sigx/server/server';

export const benchApp = createServerApp({
    authenticate: () => ({ id: 'bench' })
});
