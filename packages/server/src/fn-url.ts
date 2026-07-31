/**
 * How a server-function call becomes a URL (rfc-server §4/§4.1, #355) — the
 * path codec and the GET read's query codec. Shared in-package by the
 * `/client` stubs (which spend a call as a URL) and the `/server` endpoint
 * (which reads one back), with no external dependency so `/client` stays
 * inside its size-limit ceiling. The two directions live side by side on
 * purpose: they are one grammar, and a change to either half that forgets
 * the other is a silent 404 or a silently retyped argument.
 *
 * ## The path
 *
 * A stable symbol is `<stableId>/<name>` and its slashes are REAL path
 * separators, not `%2F`. That is the point: `%2F` routes are a documented
 * proxy/CDN hazard (a hop that decodes or merges encoded slashes mangles
 * them) and they read as line noise in a network tab. Encoding is therefore
 * PER SEGMENT — `@`, `.`, `-`, `_`, `~` and the rest of RFC 3986's `pchar`
 * survive literally, so a normal id spends no `%` at all:
 *
 * ```
 * @acme/api/src/cart.server.ts/addToCart
 *   -> /_sigx/fn/@acme/api/src/cart.server.ts/addToCart
 * ```
 *
 * Hashed symbols (`addToCart_fn_9f3a01cc`) contain no `/` and pass through
 * both directions untouched.
 *
 * The build side normalizes ids so no segment is ever `.`, `..` or empty
 * (`routeSafeId` in `@sigx/vite`) — `new URL()` resolves dot segments away
 * and would silently retarget the route. Nothing here re-checks that: a path
 * that does not round-trip to a registered symbol is an unknown function and
 * 404s like any other.
 *
 * ## The read query
 *
 * A cache-marked GET used to carry `?args=<percent-encoded JSON>`, which is
 * `%5B%22`-noise for the overwhelmingly common case of a couple of scalars.
 * When EVERY argument is a simple scalar they ride as named params instead:
 *
 * ```
 * ?a0=shoes&a1=42&a2=true
 * ```
 *
 * Types survive because the grammar is deliberately lopsided: a param reads
 * back as a number/boolean/null only when its raw text says so, and a STRING
 * that would be misread that way is the one case that gets JSON-quoted
 * (`a0="42"`). Anything richer than scalars — objects, arrays, `Date`, `Map`,
 * `Set`, `BigInt`, `undefined`, non-finite numbers — falls back to the
 * `?args=` blob, all-or-nothing so one call never mixes the two encodings and
 * the cache key stays a pure function of the arguments.
 *
 * ## Why the halves are split
 *
 * This file is the ENCODE half (what a caller does); `./fn-url-decode` is the
 * mirror. They are separate modules only because they would otherwise bundle
 * into one chunk shared by both entries, and `/client` is size-limited — it
 * would pay for decode logic it never runs. `fn-url.test.ts` round-trips the
 * two together, which is what actually keeps them in step.
 */

/** Text a bare param would read back as a number. Deliberately strict:
 *  `007` and `+1` are NOT numbers here, so they survive as the strings they
 *  almost certainly were. Shared with the decode half. */
export const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/** Ditto — the three bare words that are not strings. */
export const LITERALS: Record<string, boolean | null> = { true: true, false: false, null: null };

/** Values that can ride as a named param at all. */
function isSimpleScalar(value: unknown): boolean {
    return (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
    );
}

/** Symbol → path. Mirrors `decodeFnPath`; keep the two in step. */
export function encodeFnPath(symbol: string): string {
    return symbol
        .split('/')
        .map((segment) => encodeURIComponent(segment).replace(/%40/g, '@'))
        .join('/');
}

/**
 * One argument → one param's raw text. A string is quoted ONLY when it would
 * otherwise be read back as a non-string — that quoting is the sole reason
 * `%22` can still appear in a read URL, and only for a string that genuinely
 * looks like `42`/`true`/`null` or already starts with a quote.
 */
function encodeScalar(value: unknown): string {
    if (typeof value !== 'string') return String(value);
    return NUMERIC.test(value) || value in LITERALS || value.startsWith('"')
        ? JSON.stringify(value)
        : value;
}

/**
 * Arguments → query string (no leading `?`; empty when there are none, which
 * the endpoint already reads as `[]`). `encodeBlob` is passed in rather than
 * imported so this module stays free of the wire codec — `/client` and
 * `/server` each hand over their own.
 */
export function encodeReadQuery(args: unknown[], encodeBlob: (args: unknown[]) => string): string {
    const params = new URLSearchParams();
    if (args.every(isSimpleScalar)) {
        args.forEach((arg, index) => params.set(`a${index}`, encodeScalar(arg)));
    } else {
        params.set('args', encodeBlob(args));
    }
    return params.toString();
}

