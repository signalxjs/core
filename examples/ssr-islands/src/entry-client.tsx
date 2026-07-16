// Registers a lazy loader per island (code-split chunks load on demand when
// each island's hydration strategy fires) — provided by sigxIslands().
import 'virtual:sigx-islands';

import { hydrateIslands } from '@sigx/ssr-islands/client';

// The app-less islands entry: the page is server-only, so the client ships
// NO page code — just this bootstrap plus per-island chunks. The whole
// eager surface is the boundary scheduler (~2 kB, no sigx runtime): the
// hydration core AND the islands state-restoration hooks load together, on
// the first client:* strategy that fires (#293). hydrateIslands() registers
// those hooks itself — this one call is the entire client bootstrap.
//
// (Pages that DO ship a root app declare islands mode with
// `defineApp(<App/>).use(ssrClientPlugin).use(islandsPlugin()).hydrate('#app')`
// instead — same table, same scheduler, root walk skipped; that form loads
// the runtime eagerly by definition.)
hydrateIslands();
