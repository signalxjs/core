// Shared deploy-smoke assertions (rfc-deploy §6): the SAME marker set runs
// against every runtime — the exit criterion ("serves identically from
// node server.mjs and from Miniflare/workerd") is literally this module
// passing twice. Every assertion takes fetchFn(path, init) => Response.

export function assert(cond, message) {
    if (!cond) {
        // THROW, never process.exit(): the smoke scripts hold live workerd /
        // child processes whose try/finally cleanup must run — an exit here
        // would strand them and hang CI.
        throw new Error(`deploy-smoke: ${message}`);
    }
    console.log(`✔ ${message}`);
}

const BROWSER_UA = 'Mozilla/5.0 (deploy-smoke)';

// What the resume example's SSR-time server-function call renders (rfc-server
// §7 v1.1, #309). Asserting it on every tier is the cross-runtime proof that
// the ambient request scope works there — the string can only appear if
// `rq.request` and `rq.url` resolved during an IN-PROCESS call, which is
// exactly what used to throw. Passed explicitly: the storefront app has no
// server functions, so it must not be held to it.
export const SSR_CONTEXT_MARKER = 'SSR request: GET /';

/** Streamed document: resume attributes, boundary table, completion script. */
export async function assertDocument(fetchFn, { label, appMarker, ssrMarker }) {
    const res = await fetchFn('/', { headers: { 'user-agent': BROWSER_UA } });
    assert(res.status === 200, `${label}: document 200`);
    assert((res.headers.get('content-type') ?? '').includes('text/html'), `${label}: text/html`);
    const html = await res.text();
    assert(html.includes('data-sigx-on:'), `${label}: resume QRL attributes rendered`);
    assert(html.includes('__SIGX_BOUNDARIES__'), `${label}: boundary table emitted`);
    assert(
        html.includes('__SIGX_STREAMING_COMPLETE__') && html.includes('sigx:ready'),
        `${label}: completion script emitted`
    );
    assert(html.includes(appMarker), `${label}: app content rendered (${appMarker})`);
    if (ssrMarker) {
        assert(
            html.includes(ssrMarker),
            `${label}: SSR-time server-function call saw the request (${ssrMarker})`
        );
    }
    return html;
}

/** Crawlers get a complete document too. */
export async function assertBotDocument(fetchFn, { label, appMarker }) {
    const res = await fetchFn('/', {
        headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }
    });
    assert(res.status === 200, `${label}: bot document 200`);
    const html = await res.text();
    assert(html.includes(appMarker), `${label}: bot got the content`);
}

/** A real emitted asset round-trips byte-identical through the static tier. */
export async function assertStaticAsset(fetchFn, { label, clientDir }) {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const manifest = JSON.parse(readFileSync(join(clientDir, '.vite/manifest.json'), 'utf-8'));
    const entry = Object.values(manifest).find((c) => c.isEntry);
    assert(entry?.file, `${label}: client manifest has an entry chunk`);
    const res = await fetchFn('/' + entry.file);
    assert(res.status === 200, `${label}: static asset 200 (/${entry.file})`);
    assert(
        (res.headers.get('content-type') ?? '').includes('javascript'),
        `${label}: asset content-type is JS`
    );
    const body = await res.text();
    const disk = readFileSync(join(clientDir, entry.file), 'utf-8');
    assert(body === disk, `${label}: asset body matches the file on disk`);
}

/** POST {base}/{symbol} with {"args":[...]} → {data} (rfc-server wire). */
export async function assertServerFn(fetchFn, { label, origin, symbol, args, expectInData }) {
    const res = await fetchFn('/_sigx/fn/' + encodeURIComponent(symbol), {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ args })
    });
    assert(res.status === 200, `${label}: server-fn 200 (got ${res.status})`);
    const envelope = await res.json();
    assert(
        typeof envelope.data === 'string' && envelope.data.includes(expectInData),
        `${label}: server-fn {data} contains "${expectInData}" (got ${JSON.stringify(envelope.data)})`
    );
    return envelope.data;
}

/**
 * GET {base}/{symbol}?args=… → {data} + Cache-Control (rfc-server §4.1).
 * Asserts the example's cache-marked `getCatalog` read end to end: the GET
 * transport (no body, no content-type, no Origin — a browser's same-origin
 * GET sends none), the declared Cache-Control + Vary, and the #364 rich
 * types as their WIRE tags in the raw envelope (`$date`/`$set`/`$bigint` —
 * this probe reads JSON directly, no codec). The revived-instance check
 * (`instanceof Date/Set`, `typeof bigint`) lives in the example's Catalog
 * component, which runs the real stub in the browser.
 */
export async function assertCatalogGet(fetchFn, { label }) {
    const symbol = '@sigx/resume-example/src/api.server.ts#getCatalog';
    const args = encodeURIComponent(JSON.stringify(['quotes']));
    const res = await fetchFn(`/_sigx/fn/${encodeURIComponent(symbol)}?args=${args}`, {});
    assert(res.status === 200, `${label}: GET read 200 (got ${res.status})`);
    assert(
        res.headers.get('cache-control') === 'private, max-age=60, stale-while-revalidate=300',
        `${label}: GET read Cache-Control (got ${res.headers.get('cache-control')})`
    );
    assert(
        (res.headers.get('vary') ?? '').toLowerCase().includes('cookie'),
        `${label}: GET read Vary: Cookie (got ${res.headers.get('vary')})`
    );
    const { data } = await res.json();
    assert(data?.section === 'quotes', `${label}: GET read echoed its query argument`);
    assert(data?.total?.$bigint === '3', `${label}: BigInt survived as $bigint (got ${JSON.stringify(data?.total)})`);
    assert(
        Array.isArray(data?.tags?.$set) && data.tags.$set.includes('zero-js'),
        `${label}: Set survived as $set (got ${JSON.stringify(data?.tags)})`
    );
    assert(
        typeof data?.updatedAt?.$date === 'number',
        `${label}: Date survived as $date (got ${JSON.stringify(data?.updatedAt)})`
    );
}

/**
 * Zero-JS form action (rfc-server §6.4): a NATIVE urlencoded POST — no JS,
 * no JSON — to the example's form-marked `submitFeedback`. Asserts the
 * whole no-JS round-trip: 303 with Location echoing the same-origin
 * Referer's path, and the §5.2b posture (an Origin-less form POST is 403
 * under the default policy — Origin is the CSRF defense on this path).
 * Also asserts the stamped attributes actually rendered into the document.
 */
export async function assertFormPost(fetchFn, { label, origin, html }) {
    const symbol = '@sigx/resume-example/src/api.server.ts#submitFeedback';
    const path = `/_sigx/fn/${encodeURIComponent(symbol)}`;
    if (html) {
        assert(
            html.includes(`action="${path}"`) && html.includes('method="post"'),
            `${label}: the <form> carries the build-stamped action/method`
        );
        assert(
            html.includes('data-sigx-pd:submit'),
            `${label}: the stamped form also carries data-sigx-pd:submit (no double submit)`
        );
    }
    const res = await fetchFn(path, {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            origin,
            referer: `${origin}/?from=smoke`
        },
        body: 'message=hello+from+the+smoke',
        redirect: 'manual'
    });
    assert(res.status === 303, `${label}: form POST → 303 (got ${res.status})`);
    assert(
        res.headers.get('location') === '/?from=smoke',
        `${label}: 303 Location echoes the Referer path (got ${res.headers.get('location')})`
    );
    const noOrigin = await fetchFn(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'message=x',
        redirect: 'manual'
    });
    assert(
        noOrigin.status === 403,
        `${label}: an Origin-less form POST is 403 (§5.2b; got ${noOrigin.status})`
    );
}

/** Non-asset paths fall through the static tier to the worker/handler. */
export async function assertFallthrough(fetchFn, { label }) {
    const res = await fetchFn('/definitely-not-an-asset', {
        headers: { 'user-agent': BROWSER_UA }
    });
    assert(res.status === 200, `${label}: non-asset path reached the document handler`);
    assert((await res.text()).includes('sigx:ready'), `${label}: fallthrough rendered a document`);
}
