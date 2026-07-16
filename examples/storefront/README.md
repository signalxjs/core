# SignalX Storefront

The resumability showcase: a storefront with **~50 interactive components and
zero JavaScript execution on load** — except the two islands you can see.

```sh
pnpm build                                   # workspace dists (once)
pnpm --filter @sigx/storefront-example dev   # dev server
# or production:
pnpm --filter @sigx/storefront-example build
pnpm --filter @sigx/storefront-example start
node smoke.mjs                               # browser verification (after build)
node smoke.mjs --dev                         # behavioral verification against the dev server
```

> **Measuring it**: judge payload in a **production** build — dev mode serves
> dozens of unbundled modules (Vite), which the HUD labels accordingly. The
> zero-execution claim is about `build` + `start`.

Open the network/console panels and watch the JS HUD (bottom right):

| Try | What happens |
|---|---|
| Load the page | 4 category sections **stream** in; 48 product cards render, fully interactive — but the only JS that executes is the sub-kilobyte loader entry plus the cart badge + HUD islands. |
| Click any "Add to cart" | One shared handler chunk loads, the click **replays** (never lost), the qty write upgrades exactly that card, and the cart badge — an island — hears the `CustomEvent` from the resumed handler. |
| Click a second card | Nothing new loads. Chunks are shared; each card only pays for its own upgrade. |
| Submit the newsletter | Navigation is prevented **synchronously** (`data-sigx-pd`) before any JS loads; the submit replays through the handler. |
| Claim the deal | The deliberately non-extractable handler (module-scope pricing table — see the build warning) falls back to **wake-on-interaction**: first click hydrates, second click counts. |

## How it's put together

- `src/resume/**` — resumable components (`sigxResume()` owns the directory).
  `ProductCard` is the workhorse: named signal + `CustomEvent` dispatch, both
  expressible through the resumed scope, so it needs no code until clicked.
- `src/islands/**` — the two deliberate JS spends (`sigxIslands()` owns it):
  `CartBadge` (`client:load`) listens for `cart:add`; `JsHud` (`client:idle`)
  watches the resource timeline so the page proves its own claim.
- `server.mjs` — one SSR instance with BOTH packs:
  `createSSR().use(islandsPlugin({manifest})).use(resumePlugin({manifest}))`.
- Cross-boundary communication is plain `CustomEvent`s — resumable cards and
  the badge island never import each other.

This example exists to answer "what does resumability buy on a REAL page?":
with hydration, this page would boot ~50 components before the first
interaction; here it boots zero, and interaction cost is proportional to what
you actually touch.
