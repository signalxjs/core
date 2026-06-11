import { bench, describe } from 'vitest';
import { signal, computed, effect, batch } from '../src/index';

/**
 * Reactivity propagation benchmarks (`pnpm bench`).
 *
 * These measure framework overhead (tracking, triggering, recomputation),
 * not real workloads. Compare relative before/after numbers on the same
 * machine (`pnpm bench:json` on the baseline, `pnpm bench:compare` on the
 * change); absolute numbers are not meaningful across machines.
 */

describe('signal write propagation', () => {
    const fanout = signal({ v: 0 });
    for (let i = 0; i < 100; i++) {
        effect(() => { void fanout.v; });
    }
    let n = 0;
    bench('write fanned out to 100 effects', () => {
        fanout.v = ++n;
    });

    const batched = signal({ a: 0, b: 0, c: 0 });
    effect(() => { void (batched.a + batched.b + batched.c); });
    let m = 0;
    bench('batch of 3 writes into one effect', () => {
        batch(() => {
            batched.a = ++m;
            batched.b = m + 1;
            batched.c = m + 2;
        });
    });
});

describe('computed graphs', () => {
    const dsrc = signal({ n: 0 });
    const c1 = computed(() => dsrc.n + 1);
    const c2 = computed(() => dsrc.n + 2);
    const dsink = computed(() => c1.value + c2.value);
    effect(() => { void dsink.value; });
    let dn = 0;
    bench('diamond write + read', () => {
        dsrc.n = ++dn;
        void dsink.value;
    });

    const csrc = signal({ v: 0 });
    let prev = computed(() => csrc.v);
    for (let i = 0; i < 50; i++) {
        const source = prev;
        prev = computed(() => source.value + 1);
    }
    const tail = prev;
    let cn = 0;
    bench('50-deep computed chain write + read', () => {
        csrc.v = ++cn;
        void tail.value;
    });

    const stableSrc = signal({ count: 1 });
    const isPositive = computed(() => stableSrc.count > 0);
    effect(() => { void isPositive.value; });
    let sn = 1;
    bench('value-stable computed write (cutoff headline)', () => {
        stableSrc.count = ++sn; // stays positive: ideal cost is zero effect runs
    });
});

describe('allocation and tracking churn', () => {
    bench('create 10k object signals', () => {
        for (let i = 0; i < 10_000; i++) {
            signal({ v: i });
        }
    });

    const m = signal(new Map<number, number>());
    effect(() => { void (m.size + (m.has(1) ? 1 : 0)); });
    let mi = 0;
    bench('Map set+delete churn with size/has subscriber', () => {
        const k = (mi = (mi + 1) % 64);
        m.set(k, mi);
        m.delete(k);
    });

    const wide = signal(Object.fromEntries(
        Array.from({ length: 50 }, (_, i) => [`p${i}`, 0])
    ) as Record<string, number>);
    effect(() => {
        let sum = 0;
        for (let i = 0; i < 50; i++) sum += wide[`p${i}`];
        void sum;
    });
    let wn = 0;
    bench('re-track cost: effect with 50 deps re-running', () => {
        wide.p0 = ++wn;
    });
});
