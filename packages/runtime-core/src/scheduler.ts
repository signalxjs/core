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

/**
 * Enqueue a render job, keeping the queue sorted by id. Duplicate
 * enqueues of a queued job are no-ops. Jobs queued mid-flush are placed
 * after the currently flushing position so the running loop picks them
 * up in the same flush.
 */
export function queueJob(job: SchedulerJob): void {
    if (job.queued) return;
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
    }
}

// Drain render jobs at the end of every reactivity notification wave.
setFlushHandler(flushJobs);
