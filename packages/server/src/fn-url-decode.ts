/**
 * The reading half of the URL grammar (rfc-server §4/§4.1, #355) — path →
 * symbol, query → arguments. The mirror of `./fn-url`, which owns the
 * writing half and the shared scalar grammar; see that file's header for what
 * the URLs look like and why.
 *
 * Separate module, one reason only: `/client` is size-limited and would
 * otherwise pull this in through a shared chunk to run none of it. Nothing
 * here is server-specific in principle — `fn-url.test.ts` round-trips both
 * halves together, and that test is what keeps them honest.
 */

import { LITERALS, NUMERIC } from './fn-url';

/** The endpoint's default mount path — the one literal in this package. */
export const DEFAULT_FN_BASE = '/_sigx/fn';

/**
 * A mount path as a routing PREFIX: exactly one trailing slash, so `/rpc` and
 * `/rpc/` route identically and everything after it IS the symbol (#355/#543).
 *
 * One function because there were three copies of the same expression — in
 * `matchesServerFn`, in `handleServerFnRequest`, and in the Node adapter — and
 * a mount path that three sites derive independently is exactly the shape #563
 * is about. (`@sigx/vite` keeps its own fourth copy: it is build-time code and
 * `@sigx/server` is an optional peer there, the same trade `resume-extract.ts`
 * documents for `encodeFnPath`.)
 */
export function fnPathPrefix(base: string = DEFAULT_FN_BASE): string {
    return base.endsWith('/') ? base : base + '/';
}

/**
 * Path → symbol. Throws `URIError` on a malformed escape (`%FF`) — the
 * endpoint catches it and answers 400 rather than letting it surface as a
 * masked 500.
 */
export function decodeFnPath(path: string): string {
    return path
        .split('/')
        .map((segment) => decodeURIComponent(segment))
        .join('/');
}

/** One param's raw text → one argument. The mirror of `encodeScalar`. */
function decodeScalar(text: string): unknown {
    if (text.startsWith('"')) return JSON.parse(text) as string;
    if (text in LITERALS) return LITERALS[text];
    return NUMERIC.test(text) ? Number(text) : text;
}

/** Why a read query was rejected — the endpoint maps these to 400 text. */
export type ReadQueryError = 'both' | 'sparse' | 'malformed';

const ARG_PARAM = /^a\d+$/;

/**
 * Query → arguments, or a reason to 400. Returns `null` for "no named
 * arguments here, use the blob path" so the caller keeps owning `args=`
 * parsing (it needs the revive-and-drop-dangerous-keys reviver, which is
 * entry-specific).
 */
export function decodeReadQuery(params: URLSearchParams): unknown[] | ReadQueryError | null {
    const hasBlob = params.has('args');
    if (!params.has('a0')) {
        // A lone `a1` with no `a0` is a caller bug, not an empty call —
        // saying so beats invoking the handler with the wrong arity.
        for (const key of params.keys()) {
            if (ARG_PARAM.test(key)) return hasBlob ? 'both' : 'sparse';
        }
        return null;
    }
    if (hasBlob) return 'both';
    const args: unknown[] = [];
    for (let index = 0; params.has(`a${index}`); index++) {
        try {
            args.push(decodeScalar(params.get(`a${index}`)!));
        } catch {
            return 'malformed';
        }
    }
    // Every `aN` must have been consumed: a gap means the caller dropped an
    // argument, and shifting the rest down would call the handler with
    // plausible-looking nonsense.
    for (const key of params.keys()) {
        if (ARG_PARAM.test(key) && Number(key.slice(1)) >= args.length) return 'sparse';
    }
    return args;
}
