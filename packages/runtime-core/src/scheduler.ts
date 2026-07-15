/**
 * Render job queue.
 *
 * Component render effects don't run inline on notification — they queue
 * here (deduplicated per component) and drain at the end of each
 * reactivity notification wave via `setFlushHandler`. Jobs run in mount
 * order (`id` = a monotonic uid minted per component): parents always
 * mount before their children and components never re-parent, so id
 * order guarantees parent-before-child. A parent render that writes a
 * child's props therefore merges with the child's own subscription into
 * ONE child render per wave.
 *
 * The flush is fully synchronous — by the time a signal write returns,
 * the DOM is updated, exactly as before this queue existed.
 */

import { setFlushHandler } from '@sigx/reactivity/internals';

export interface SchedulerJob {
    (): void;
    /** Mount-order uid: lower ids (ancestors) flush first. */
    id: number;
    /** Dedup flag: true while sitting in the queue. */
    queued?: boolean;
}

let nextId = 0;

/** Mint a mount-order job id (one per component instance). */
export function nextJobId(): number {
    return nextId++;
}

const queue: SchedulerJob[] = [];
let flushIndex = -1;
let isFlushing = false;
let registered = false;

/**
 * Dev-only runaway-flush guards (#111).
 *
 * The flush is synchronous, so a render that (directly or via a store
 * action called during render) writes reactive state a render depends on
 * re-queues work forever and wedges the main thread with zero feedback.
 * Two loop shapes occur in practice and each evades the other's counter,
 * so BOTH guards are needed:
 *
 * - Re-queue loops ("ping-pong"): a fixed set of jobs writing each
 *   other's deps re-queue the same job ids over and over. The per-job
 *   counter catches this early and names the offending job.
 * - Fresh-mount loops: every iteration re-renders an ancestor that
 *   remounts descendants, so each cycle queues NEW jobs with new ids —
 *   no single job is ever re-queued and only the total flush length
 *   gives the loop away.
 *
 * A third shape exists that CANNOT be caught here: loops that re-trigger
 * on microtask cadence (each write lands in its own flush — e.g. a render
 * kicks an async store action that writes after an await). Both counters
 * are per-flush and reset between turns, so such loops never trip them.
 *
 * Limits are far above anything a legitimate update produces; checks are
 * compiled out of production builds.
 */
const MAX_JOB_REQUEUES = 100;
const MAX_FLUSH_JOBS = 10000;
// Per-flush re-queue counts (dev only); cleared when the flush ends.
const requeueCounts = new Map<SchedulerJob, number>();

/**
 * Enqueue a render job, keeping the queue sorted by id. Duplicate
 * enqueues of a queued job are no-ops. Jobs queued mid-flush are placed
 * after the currently flushing position so the running loop picks them
 * up in the same flush.
 */
export function queueJob(job: SchedulerJob): void {
    // Register the drain hook on first use rather than at module load: a
    // module-level side effect is at odds with the package's
    // `sideEffects: false` declaration and could be dropped by a
    // tree-shaker. queueJob always runs during a notification wave,
    // BEFORE flushPendingEffects consults the handler at the wave's end,
    // so even the very first wave drains correctly.
    if (!registered) {
        registered = true;
        setFlushHandler(flushJobs);
    }
    if (job.queued) return;
    if (__DEV__ && isFlushing) {
        // Runaway guard, ping-pong shape (see the guard docs above).
        const n = (requeueCounts.get(job) ?? 0) + 1;
        requeueCounts.set(job, n);
        if (n > MAX_JOB_REQUEUES) {
            throw new Error(
                `Unbounded render flush: render job ${job.id} was re-queued more than ` +
                `${MAX_JOB_REQUEUES} times in a single flush — a render is writing reactive ` +
                `state it depends on (directly, or via a store action called during render).`
            );
        }
    }
    job.queued = true;
    let lo = isFlushing ? flushIndex + 1 : 0;
    let hi = queue.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (queue[mid].id <= job.id) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    queue.splice(lo, 0, job);
}

/**
 * Drain the queue. Re-entrant calls return immediately — jobs queued
 * while flushing are handled by the already-running loop. A throwing
 * job propagates to the write site (matching pre-queue semantics); the
 * finally block resets state so the queue can't wedge.
 */
export function flushJobs(): void {
    if (isFlushing) return;
    isFlushing = true;
    try {
        for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
            if (__DEV__ && flushIndex >= MAX_FLUSH_JOBS) {
                // Runaway guard, fresh-mount shape (see the guard docs above).
                throw new Error(
                    `Unbounded render flush: a single flush executed more than ` +
                    `${MAX_FLUSH_JOBS} render jobs — a render is writing reactive state ` +
                    `it depends on (directly, or via a store action called during render).`
                );
            }
            const job = queue[flushIndex];
            job.queued = false;
            job();
        }
    } finally {
        for (let i = flushIndex + 1; i < queue.length; i++) {
            // Only reachable when a job threw: unmark survivors so they
            // can re-queue on the next wave.
            queue[i].queued = false;
        }
        queue.length = 0;
        flushIndex = -1;
        isFlushing = false;
        if (__DEV__) requeueCounts.clear();
    }
}
