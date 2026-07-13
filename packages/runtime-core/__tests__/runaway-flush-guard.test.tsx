/**
 * Dev-mode runaway-flush guards (issue #111).
 *
 * A render that writes reactive state a render depends on (directly, or
 * via a store action called during render) re-queues work forever; the
 * flush is synchronous, so the page used to freeze solid with zero
 * feedback. In dev builds the scheduler now bounds the flush and throws
 * an actionable error instead. Two loop shapes, two guards:
 *
 * - ping-pong: a fixed set of jobs re-queue each other → per-job counter
 * - fresh mounts: every iteration queues NEW jobs → total flush length
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal } from '@sigx/reactivity';
import { queueJob, flushJobs, nextJobId } from '../src/scheduler';
import type { SchedulerJob } from '../src/scheduler';

describe('dev-mode runaway flush guards (issue #111)', () => {
    describe('scheduler', () => {
        it('throws when one job is re-queued past the per-job limit (ping-pong shape)', () => {
            // Two jobs that re-queue each other forever — the shape produced
            // by two renders each writing a signal the other depends on.
            // Neither job is ever "new", so only the per-job counter sees it.
            let a!: SchedulerJob;
            let b!: SchedulerJob;
            a = Object.assign(() => queueJob(b), { id: nextJobId() });
            b = Object.assign(() => queueJob(a), { id: nextJobId() });

            queueJob(a);
            expect(() => flushJobs()).toThrow(
                /Unbounded render flush: render job \d+ was re-queued more than \d+ times/
            );
        });

        it('throws when fresh jobs keep the flush from draining (fresh-mount shape)', () => {
            // Every job queues a brand-new job with a new id — the shape
            // produced by a loop that remounts descendants on each iteration.
            // No job is ever re-queued, so only the flush total sees it.
            let spawned = 0;
            const makeJob = (): SchedulerJob =>
                Object.assign(
                    () => {
                        // Safety cap so a broken guard fails the test instead
                        // of hanging it.
                        if (++spawned < 20000) queueJob(makeJob());
                    },
                    { id: nextJobId() }
                );

            queueJob(makeJob());
            expect(() => flushJobs()).toThrow(
                /Unbounded render flush: a single flush executed more than \d+ render jobs/
            );
        });

        it('recovers after a guard trip: the next flush runs normally', () => {
            let a!: SchedulerJob;
            let b!: SchedulerJob;
            a = Object.assign(() => queueJob(b), { id: nextJobId() });
            b = Object.assign(() => queueJob(a), { id: nextJobId() });
            queueJob(a);
            expect(() => flushJobs()).toThrow(/Unbounded render flush/);

            let ran = false;
            queueJob(Object.assign(() => { ran = true; }, { id: nextJobId() }));
            flushJobs();
            expect(ran).toBe(true);
        });
    });

    describe('component level', () => {
        let container: HTMLElement;

        beforeEach(() => {
            container = document.createElement('div');
            document.body.appendChild(container);
            // The unhandled render error is reported via console.error on its
            // way out — silence it, the throw itself is what we assert on.
            vi.spyOn(console, 'error').mockImplementation(() => {});
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it('two renders writing each other\'s deps throw the dev error instead of freezing', () => {
            const go = signal(false);
            const a = signal(0);
            const b = signal(0);
            let n = 0;

            // Once `go` flips, A's render writes B's dep and vice versa —
            // the exact self-retriggering shape diagnosed in production
            // (store actions called inside render closures).
            const A = component(() => () => {
                if (go.value && a.value >= 0) b.value = ++n;
                return jsx('i', {});
            });
            const B = component(() => () => {
                if (go.value && b.value >= 0) a.value = ++n;
                return jsx('i', {});
            });
            const Parent = component(() => () =>
                jsx('div', { children: [jsx(A, {}), jsx(B, {})] }));

            render(jsx(Parent, {}), container);

            // One signal write used to wedge the main thread forever.
            expect(() => { go.value = true; }).toThrow(/Unbounded render flush/);
        });
    });
});
