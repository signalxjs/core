// Registers a lazy loader per island (code-split chunks load on demand when
// each island's hydration strategy fires) — provided by sigxIslands().
import 'virtual:sigx-islands';

import { registerClientPlugin } from '@sigx/server-renderer/client';
import { islandsPlugin, hydrateIslands } from '@sigx/ssr-islands';

// The app-less islands entry: the page is server-only, so the client ships
// NO page code — just this bootstrap plus per-island chunks. The plugin
// registration restores each island's server signal state on hydration;
// hydrateIslands() schedules every __SIGX_BOUNDARIES__ entry per its
// client:* strategy.
//
// (Pages that DO ship a root app declare islands mode with
// `defineApp(<App/>).use(ssrClientPlugin).use(islandsPlugin()).hydrate('#app')`
// instead — same table, same scheduler, root walk skipped.)
registerClientPlugin(islandsPlugin());
hydrateIslands();
