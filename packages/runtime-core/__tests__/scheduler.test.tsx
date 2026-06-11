import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@sigx/runtime-dom';
import { component, jsx } from '@sigx/runtime-core';
import { signal, batch, computed, effect } from '@sigx/reactivity';
import { queueJob, flushJobs, nextJobId, type SchedulerJob } from '../src/scheduler';

/**
 * Render queue semantics (#59): per-component dedup, parent-before-child
 * ordering, synchronous flush, and interaction with unmounts and
 * re-entrant writes.
 */
describe('render scheduler', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    it('flushes synchronously: DOM is updated when the write returns', () => {
        const count = signal({ v: 0 });
        const Comp = component(() => () => jsx('div', { children: String(count.v) }));
        render(jsx(Comp, {}), container);

        count.v = 5;
        expect(container.textContent).toBe('5');
    });

    it('renders parent before child within one flush', () => {
        const shared = signal({ v: 0 });
        const order: string[] = [];

        const Child = component<{ v: number }>((ctx) => () => {
            order.push('child');
            return jsx('span', { children: `${shared.v}:${ctx.props.v}` });
        });
        const Parent = component(() => () => {
            order.push('parent');
            return jsx('div', { children: jsx(Child, { v: shared.v }) });
        });

        render(jsx(Parent, {}), container);
        order.length = 0;

        shared.v = 1;
        expect(order).toEqual(['parent', 'child']);
    });

    it('batch over two signals still renders once total', () => {
        const a = signal({ v: 0 });
        const b = signal({ v: 0 });
        const renders = vi.fn();
        const Comp = component(() => () => {
            renders();
            return jsx('div', { children: `${a.v}${b.v}` });
        });
        render(jsx(Comp, {}), container);

        batch(() => {
            a.v = 1;
            b.v = 1;
        });
        expect(renders).toHaveBeenCalledTimes(2);
        expect(container.textContent).toBe('11');
    });

    it('does not run a queued job for a child unmounted earlier in the same flush', () => {
        const shared = signal({ v: 0 });
        const childRenders = vi.fn();

        const Child = component(() => () => {
            childRenders();
            return jsx('span', { children: String(shared.v) });
        });
        const Parent = component(() => () =>
            jsx('div', {
                children: shared.v < 1 ? jsx(Child, {}) : jsx('p', { children: 'gone' }),
            })
        );

        render(jsx(Parent, {}), container);
        expect(childRenders).toHaveBeenCalledTimes(1);

        // Parent flushes first (lower id), unmounts Child; Child's queued
        // job must be a no-op (stopped effect).
        shared.v = 1;
        expect(childRenders).toHaveBeenCalledTimes(1);
        expect(container.textContent).toBe('gone');
    });

    it('a cascade (render writing another signal) converges in the same flush', () => {
        const first = signal({ v: 0 });
        const second = signal({ v: 0 });

        const Downstream = component(() => () => jsx('em', { children: String(second.v) }));
        const Upstream = component(() => () => {
            // render-time write to a DIFFERENT component's source
            if (first.v > 0 && second.v !== first.v) {
                second.v = first.v;
            }
            return jsx('div', { children: [jsx('b', { children: String(first.v) }), jsx(Downstream, {})] });
        });

        render(jsx(Upstream, {}), container);
        first.v = 3;
        expect(container.textContent).toBe('33');
    });

    it('scheduler option: notifications hand the job to the scheduler instead of running', () => {
        const s = signal({ v: 0 });
        const runs = vi.fn();
        const scheduled: Array<() => void> = [];

        effect(() => { runs(s.v); }, { scheduler: (run) => scheduled.push(run) });
        expect(runs).toHaveBeenCalledTimes(1); // first run is inline

        s.v = 1;
        expect(runs).toHaveBeenCalledTimes(1); // deferred
        expect(scheduled.length).toBe(1);

        scheduled[0]();
        expect(runs).toHaveBeenCalledTimes(2);
        expect(runs).toHaveBeenLastCalledWith(1);
    });

    it('scheduled job validates: value-stable computed source is a no-op run', () => {
        const s = signal({ count: 2 });
        const runs = vi.fn();
        const scheduled: Array<() => void> = [];
        const isPositive = computed(() => s.count > 0);

        effect(() => { runs(isPositive.value); }, { scheduler: (run) => scheduled.push(run) });
        expect(runs).toHaveBeenCalledTimes(1);

        s.count = 5; // computed value unchanged
        expect(scheduled.length).toBe(1);
        scheduled[0]();
        expect(runs).toHaveBeenCalledTimes(1); // validated clean: skipped
    });

    it('scheduled job after stop() is a no-op', () => {
        const s = signal({ v: 0 });
        const runs = vi.fn();
        const scheduled: Array<() => void> = [];

        const runner = effect(() => { runs(s.v); }, { scheduler: (run) => scheduled.push(run) });
        s.v = 1;
        runner.stop();
        scheduled.forEach(run => run());
        expect(runs).toHaveBeenCalledTimes(1);
    });

    it('manual runner() bypasses the scheduler and runs synchronously', () => {
        const s = signal({ v: 0 });
        const runs = vi.fn();
        const scheduled: Array<() => void> = [];

        const runner = effect(() => { runs(s.v); }, { scheduler: (run) => scheduled.push(run) });
        runner();
        expect(runs).toHaveBeenCalledTimes(2);
        expect(scheduled.length).toBe(0);
    });

    it('a scheduled job invoked while its effect is mid-run is dropped', () => {
        const s = signal({ v: 0 });
        const runs = vi.fn();
        let captured: (() => void) | undefined;
        let invokeCapturedDuringRun = false;

        const runner = effect(() => {
            runs(s.v);
            if (invokeCapturedDuringRun && captured) {
                const job = captured;
                captured = undefined;
                // A misbehaving/async scheduler firing the stored job
                // while the effect is on the stack: must be a no-op.
                job();
            }
        }, { scheduler: (run) => { captured = run; } });
        expect(runs).toHaveBeenCalledTimes(1);

        s.v = 1; // notification is captured, not run
        expect(runs).toHaveBeenCalledTimes(1);
        expect(captured).toBeDefined();

        invokeCapturedDuringRun = true;
        runner(); // manual run invokes the stale job from inside itself
        expect(runs).toHaveBeenCalledTimes(2); // exactly the manual run — no re-entry

        // Still fully functional afterwards.
        invokeCapturedDuringRun = false;
        s.v = 2;
        captured!();
        expect(runs).toHaveBeenCalledTimes(3);
        expect(runs).toHaveBeenLastCalledWith(2);
    });
});

describe('render queue internals', () => {
    function makeJob(record: number[], id: number): SchedulerJob {
        return Object.assign(() => { record.push(id); }, { id });
    }

    it('flushes jobs in id order regardless of queueing order', () => {
        const order: number[] = [];
        const a = makeJob(order, nextJobId());
        const b = makeJob(order, nextJobId());
        const c = makeJob(order, nextJobId());

        // Out-of-order enqueue exercises both binary-insert branches;
        // duplicate enqueue of a queued job is a no-op.
        queueJob(c);
        queueJob(a);
        queueJob(b);
        queueJob(b);
        flushJobs();

        expect(order).toEqual([a.id, b.id, c.id]);
    });

    it('a throwing job propagates, and later jobs are unmarked so they can re-queue', () => {
        const order: number[] = [];
        const boom: SchedulerJob = Object.assign(() => {
            throw new Error('boom');
        }, { id: nextJobId() });
        const after = makeJob(order, nextJobId());

        queueJob(boom);
        queueJob(after);
        expect(() => flushJobs()).toThrow('boom');

        // The wedged flush dropped `after`, but unmarked it...
        expect(order).toEqual([]);
        expect(after.queued).toBe(false);

        // ...so it can re-queue and run on the next wave.
        queueJob(after);
        flushJobs();
        expect(order).toEqual([after.id]);
    });
});
