/**
 * The request-path micro suites, in one list — the single source both
 * `run-micro.ts` (full run) and `quick.ts` (gated subset) read.
 */
import type { MicroSuite } from './types.ts';
import { codecSuite } from './codec.ts';
import { serverFnSuite } from './serverfn.ts';
import { keyMatchSuite } from './keymatch.ts';
import { refreshSuite } from './refresh.ts';
import { packsSuite } from './packs.ts';

export const SUITES: MicroSuite[] = [
    codecSuite,
    serverFnSuite,
    keyMatchSuite,
    refreshSuite,
    packsSuite
];

export type { MicroBench, MicroSuite, ByteMetric, SuiteName } from './types.ts';
