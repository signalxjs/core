// The resumable side: the generated loader entry — delegation listeners for
// the build-wide event union; registry and runtime load on first interaction.
import 'virtual:sigx-resume/entry';

// The islands side: lazy per-island loaders + the boundary scheduler for the
// two deliberate islands (cart badge: client:load, HUD: client:idle). The
// scheduler is runtime-free (~2 kB); the sigx runtime + restoration hooks
// arrive with the first strategy that fires — here immediately, because the
// badge is client:load, but the chunk is modulepreloaded so it's one warm
// fetch, not a waterfall (#293).
import 'virtual:sigx-islands';
import { hydrateIslands } from '@sigx/ssr-islands/client';

hydrateIslands();
