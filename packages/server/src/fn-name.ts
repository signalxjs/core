/**
 * The export name carried by a stable key (`<id>/<name>`, rfc-server-v5
 * §1.3) — its last segment. `''` for the unstamped sentinel. Shared by the
 * in-process transport (which reads the key off the wrapper at call time)
 * and the endpoint; kept out of `fn-url.ts` so the size-limited client
 * entry never pulls it in.
 */
export function fnNameOf(key: string): string {
    return key.slice(key.lastIndexOf('/') + 1);
}
