// Registers the edge-runtime import guard (see edge-hooks.mjs) before the
// smoke-test app loads. Usage:
//   node --conditions production --import ./packages/server-renderer/scripts/edge-register.mjs \
//        packages/server-renderer/scripts/edge-smoke.mjs
import { register } from 'node:module';

register('./edge-hooks.mjs', import.meta.url);
