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

    const arr = signal([0, 1, 2, 3]);
    effect(() => { void arr.length; });
    let an = 0;
    bench('array push+pop churn with length subscriber', () => {
        arr.push(++an);
        arr.pop();
    });

    const nested = signal({ a: { b: { c: 0 } } });
    void nested.a.b.c; // warm the nested proxy caches: bench measures steady state
    bench('untracked nested object read', () => {
        void nested.a.b.c; // outside any effect: pure get-trap fixed cost
    });

    const prim = signal(0);
    effect(() => { void prim.value; });
    let pn = 0;
    bench('primitive .value write with 1 effect', () => {
        prim.value = ++pn;
    });

    const replaceKeys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const replaceTarget = signal(Object.fromEntries(
        replaceKeys.map(k => [k, 0])
    ) as Record<string, number>);
    effect(() => { void replaceTarget.k0; });
    let rn = 0;
    bench('$set replace of 10-key object', () => {
        // Plain-loop build keeps the (required) fresh object cheap so $set
        // dominates the measurement, not iterator/fromEntries overhead.
        ++rn;
        const next: Record<string, number> = {};
        for (const k of replaceKeys) next[k] = rn;
        replaceTarget.$set(next);
    });

    const fiveDeps = signal({ a: 0, b: 0, c: 0, d: 0, e: 0 });
    bench('create-and-stop 1k effects over 5 deps', () => {
        for (let i = 0; i < 1_000; i++) {
            const runner = effect(() => {
                void (fiveDeps.a + fiveDeps.b + fiveDeps.c + fiveDeps.d + fiveDeps.e);
            });
            runner.stop();
        }
    });

    // Hoisted so the loop measures signal()'s shouldNotProxy root check,
    // not Date/TypedArray construction.
    const sharedDate = new Date(0);
    const sharedBuf = new Uint8Array(4);
    bench('signal() on non-proxyable roots (Date, typed array)', () => {
        for (let i = 0; i < 1_000; i++) {
            signal(sharedDate);
            signal(sharedBuf);
        }
    });

    const withExotic = signal({ at: sharedDate, buf: sharedBuf });
    bench('read non-proxyable values off an object signal', () => {
        // get trap runs shouldNotProxy on every object-valued read
        void withExotic.at;
        void withExotic.buf;
    });
});
