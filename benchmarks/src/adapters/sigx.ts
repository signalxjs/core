/**
 * sigx adapter — renders the shared scenario trees (../scenarios/build.ts,
 * built with sigx's jsx() runtime) through @sigx/server-renderer (built dist
 * via the workspace dep).
 */
import { renderToString } from '@sigx/server-renderer/server';
import { renderToNodeStream } from '@sigx/server-renderer/node';
import type { FrameworkAdapter } from './types.ts';
import { measureReadable } from './measure.ts';
import { build } from '../scenarios/build.ts';

const adapter: FrameworkAdapter = {
    name: 'sigx',
    renderToString: (scenario) => renderToString(build(scenario)),
    renderStream: (scenario) => measureReadable(() => renderToNodeStream(build(scenario)))
};

export default adapter;
