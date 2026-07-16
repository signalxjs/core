// The resumable side: the generated loader entry — delegation listeners for
// the build-wide event union; registry and runtime load on first interaction.
import 'virtual:sigx-resume/entry';

// The islands side: lazy per-island loaders + the scheduler for the two
// deliberate islands (cart badge: client:load, HUD: client:idle).
import 'virtual:sigx-islands';
import { registerClientPlugin } from '@sigx/server-renderer/client';
import { islandsPlugin, hydrateIslands } from '@sigx/ssr-islands';

registerClientPlugin(islandsPlugin());
hydrateIslands();
