/**
 * `@sigx/reactivity` hot paths — the propagation machinery every app pays on
 * every write, and the deep-watch traversal #546 is about.
 *
 * Why this suite exists: reactivity had 16 benches, all of them in the vitest
 * harness (the `__tests__` `.bench.ts` files), which is not baselined, not in
 * `bench:quick`, and not run by any CI job. So the package underneath every
 * other number in this repo was the one package CI could not see move. And
 * `watch(deep: true)` — profiled at 13.0 % of `state/*` and 6.5 % of
 * `changes-fanout` in `@sigx/actors`, the headline of #546 — had no bench at
 * all, in either harness.
 *
 * TWO SIZING RULES, both load-bearing:
 *
 * 1. Every `run()` performs a SIZED BATCH (the `x1k` / `x10k` / `x100` in each
 *    name). mitata measures one `run()` call and `check-regression` cannot gate
 *    a p50 below ~0.1 ms — timer resolution dominates below that (#474/#477).
 *    A signal write is tens of nanoseconds, so measuring one would produce a
 *    number no gate could ever read.
 * 2. A bench and its `floorOf` use the SAME batch size. `ratioToFloor` divides
 *    two p50s; pairing an x100 bench with an x10k floor would report the batch
 *    ratio and call it overhead. Hence two floor families, each internally
 *    consistent — the writes at x10k, the walks at x100 — and the benches whose
 *    batch matches neither are reported as absolute timings, exactly as
 *    `slots.ts` does for its small-n reads.
 *
 * `plain deep walk x100` is the floor that carries the #546 argument: the same
 * traversal over the RAW fixture, no proxy and no tracking. The ratio of a
 * `watch(deep)` bench to it is precisely what the reactive machinery adds on
 * top of the walk itself — the figure that survives a change of machine, and
 * the one that should collapse if #546 lands.
 *
 * The guards matter more here than in most suites. A watcher that has silently
 * stopped watching, or an effect graph that has come detached, does no work and
 * reports a spectacular number forever. Every deep-watch bench therefore proves
 * the whole contract before it is measured, including the case a traversal
 * optimisation is most likely to break: an object added in one turn and mutated
 * in the next (`signalxjs/actors#38` calls a miss there silent data loss under
 * write-behind).
 */
import { signal, computed, effect, batch, watch } from 'sigx';
import { assert, type MicroBench, type MicroSuite } from './types.ts';

const ROWS = 200;
const FLAT_KEYS = 200;

interface Row {
    id: number;
    label: string;
    nested: { a: number; b: number };
}

interface State {
    rows: Row[];
}

function makeState(rows: number): State {
    return {
        rows: Array.from({ length: rows }, (_, i) => ({
            id: i,
            label: `row ${i}`,
            nested: { a: i, b: 0 }
        }))
    };
}

/** state + rows array + one object per row + one nested object per row. */
function objectCount(rows: number): number {
    return 2 + rows * 2;
}

function makeFlat(keys: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < keys; i++) out[`k${i}`] = 0;
    return out;
}

/**
 * Mirrors reactivity's own `traverse` (`packages/reactivity/src/watch.ts:14`)
 * shape for shape — it is module-private and not exported, and this is also
 * literally what `@sigx/actors` ships since actors#38, so the copy is the
 * honest thing to measure rather than a workaround.
 */
function trackDeep(value: unknown, seen: Set<unknown>): void {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) trackDeep(value[i], seen);
    } else if (value instanceof Map) {
        value.forEach((v, k) => {
            trackDeep(k, seen);
            trackDeep(v, seen);
        });
    } else if (value instanceof Set) {
        value.forEach((v) => trackDeep(v, seen));
    } else {
        for (const key of Object.keys(value)) {
            trackDeep((value as Record<string, unknown>)[key], seen);
        }
    }
}

/**
 * The contract every `watch(deep)` bench depends on, proven on a THROWAWAY
 * fixture so the measured one keeps its shape.
 *
 * The second half is the re-track case: an object added in one turn, mutated in
 * the next. A traversal that stopped re-subscribing to newly added subtrees
 * would still pass a naive "does it fire?" check while quietly missing writes —
 * and would then report a huge win here for doing nothing at all.
 */
function assertDeepWatchContract(): void {
    const probe = signal<State>({ rows: [] });
    let fired = 0;
    const handle = watch(() => probe, () => { fired++; }, { deep: true });

    probe.rows.push({ id: 0, label: 'probe', nested: { a: 0, b: 0 } });
    const afterAdd = fired;
    assert(afterAdd > 0, 'adding a row did not notify the deep watcher');

    probe.rows[0].nested.b = 1;
    assert(
        fired > afterAdd,
        'mutating an object added in an earlier turn did not notify — the traversal is not re-subscribing to new subtrees'
    );

    handle.stop();
}

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

/**
 * The irreducible write: a property assignment with no proxy in the way.
 *
 * `obj.v = obj.v + 1`, not `obj.v = i`, for two reasons. It is the honest
 * shape — the set trap this floors ALREADY reads the old value (`Reflect.get`,
 * then the `Object.is` change test), so a store-only floor would flatter the
 * ratio by comparing one operation against two. And a run of 10 000 stores
 * whose intermediate values are never read is exactly the loop V8 is entitled
 * to sink: the first draft measured 1.27 ns per write, which is a floor
 * reporting how well it was optimised away rather than what a write costs.
 * The read-modify-write chain cannot be sunk.
 */
function plainWriteFloor(): MicroBench {
    const obj = { v: 0 };
    return {
        suite: 'reactivity',
        name: 'plain object write x10k',
        isFloor: true,
        check: () => {
            const before = obj.v;
            obj.v = obj.v + 1;
            assert(obj.v === before + 1, 'the floor object did not take the write');
        },
        run: () => {
            for (let i = 0; i < 10_000; i++) obj.v = obj.v + 1;
        }
    };
}

/**
 * The irreducible deep walk: the same traversal `watch(deep)` performs, over
 * the RAW fixture — no proxy, no get trap, no dep bookkeeping. Everything a
 * `watch(deep)` bench costs above this ratio is the reactive machinery.
 */
function plainWalkFloor(): MicroBench {
    const raw = makeState(ROWS);
    return {
        suite: 'reactivity',
        name: 'plain deep walk x100',
        isFloor: true,
        check: () => {
            const seen = new Set<unknown>();
            trackDeep(raw, seen);
            assert(
                seen.size === objectCount(ROWS),
                `walk visited ${seen.size} objects, expected ${objectCount(ROWS)} — it is not covering the fixture`
            );
        },
        run: () => {
            for (let i = 0; i < 100; i++) trackDeep(raw, new Set());
        }
    };
}

// ---------------------------------------------------------------------------
// watch(deep) — the #546 group
// ---------------------------------------------------------------------------

/**
 * One deep watcher over a `rows` fixture, `mutationsPerTurn` leaf writes per
 * turn. Every turn re-runs the watcher's effect, which re-walks the whole tree
 * through the proxy: the cost #546 is about.
 */
function deepWatchBench(config: {
    name: string;
    rows: number;
    mutationsPerTurn: number;
    turns: number;
    quick?: boolean;
    floorOf?: string;
}): MicroBench {
    const state = signal(makeState(config.rows));
    let fired = 0;
    watch(() => state, () => { fired++; }, { deep: true });

    let n = 0;
    let cursor = 0;
    const turn = (): void => {
        if (config.mutationsPerTurn === 1) {
            state.rows[cursor = (cursor + 1) % config.rows].nested.b = ++n;
            return;
        }
        // Batched, so the turn is ONE notification wave — an actor turn that
        // mutates eight things still walks once, not eight times.
        batch(() => {
            for (let i = 0; i < config.mutationsPerTurn; i++) {
                state.rows[cursor = (cursor + 1) % config.rows].nested.b = ++n;
            }
        });
    };

    return {
        suite: 'reactivity',
        name: config.name,
        ...(config.quick ? { quick: true } : {}),
        ...(config.floorOf ? { floorOf: config.floorOf } : {}),
        check: () => {
            assertDeepWatchContract();
            const before = fired;
            turn();
            assert(
                fired > before,
                'a leaf mutation did not fire the deep watcher — the traversal never subscribed to the leaves'
            );
        },
        run: () => {
            for (let i = 0; i < config.turns; i++) turn();
        }
    };
}

/**
 * The depth-limited path (`typeof deep === 'number'`), which takes a different
 * branch in `watch()` and must not regress when the unlimited one is optimised.
 *
 * A wide FLAT object on purpose: at depth 1 the traversal reads every own key
 * and recurses into none, so this measures the branch honestly. Pointing it at
 * the nested `rows` fixture would instead measure a watcher that never fires,
 * which is not a cost anyone pays.
 */
function shallowWatchBench(): MicroBench {
    const state = signal(makeFlat(FLAT_KEYS));
    let fired = 0;
    watch(() => state, () => { fired++; }, { deep: 1 });

    let n = 0;
    let cursor = 0;
    const turn = (): void => {
        state[`k${cursor = (cursor + 1) % FLAT_KEYS}`] = ++n;
    };

    return {
        suite: 'reactivity',
        name: `watch(deep: 1) flat ${FLAT_KEYS}-key state x1k`,
        check: () => {
            const before = fired;
            turn();
            assert(fired > before, 'a key write did not fire the depth-1 watcher');
            // The last key must be tracked too — a traversal that stopped early
            // would still pass the check above.
            const afterFirst = fired;
            state[`k${FLAT_KEYS - 1}`] = ++n;
            assert(fired > afterFirst, `k${FLAT_KEYS - 1} is not tracked — the depth-1 walk is not covering every key`);
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) turn();
        }
    };
}

/**
 * What `@sigx/actors` actually ships since actors#38, and therefore the real
 * baseline #546 has to beat — NOT the pre-#38 per-mutation watch.
 *
 * A scheduler-deferred effect parks its re-run; the write flips a dirty bit
 * synchronously; the walk happens once, at the turn boundary, re-subscribing
 * anything the turn added. The remaining cost is one full traversal per dirty
 * turn, which is exactly the ceiling actors#38 documented and could not remove
 * from the caller's side.
 */
function turnBoundaryBench(): MicroBench {
    const state = signal(makeState(ROWS));
    let dirty = false;
    let version = 0;
    let parked: (() => void) | null = null;

    effect(() => { trackDeep(state, new Set()); }, {
        scheduler: (job: () => void) => {
            dirty = true;
            parked = job;
        }
    });

    const consumeDirty = (): void => {
        if (!dirty) return;
        dirty = false;
        version++;
        const job = parked;
        parked = null;
        if (job) job();
    };

    let n = 0;
    let cursor = 0;
    const turn = (): void => {
        state.rows[cursor = (cursor + 1) % ROWS].nested.b = ++n;
        consumeDirty();
    };

    return {
        suite: 'reactivity',
        name: 'turn-boundary dirty walk x100',
        floorOf: 'plain deep walk x100',
        check: () => {
            const before = version;
            state.rows[0].nested.b = ++n;
            assert(dirty, 'a leaf mutation did not set the dirty bit synchronously');
            consumeDirty();
            assert(version === before + 1, 'the turn boundary did not fold the dirty bit into a version');

            // Read-only turns must cost nothing — if this fires, the bench is
            // measuring a walk per turn regardless of whether anything changed.
            consumeDirty();
            assert(version === before + 1, 'a clean turn still bumped the version');
        },
        run: () => {
            for (let i = 0; i < 100; i++) turn();
        }
    };
}

// ---------------------------------------------------------------------------
// Propagation and tracking (migrated from the vitest harness, batch-sized)
// ---------------------------------------------------------------------------

/** The proxy set trap with nothing listening — pure overhead over the floor. */
function writeNoSubscribers(): MicroBench {
    const state = signal({ v: 0 });
    return {
        suite: 'reactivity',
        name: 'signal write, no subscribers x10k',
        floorOf: 'plain object write x10k',
        check: () => {
            state.v = 7;
            assert(state.v === 7, 'the signal did not take the write');
        },
        run: () => {
            for (let i = 0; i < 10_000; i++) state.v = i;
        }
    };
}

function writeOneEffect(): MicroBench {
    const state = signal({ v: 0 });
    let runs = 0;
    effect(() => {
        void state.v;
        runs++;
    });
    let n = 0;
    return {
        suite: 'reactivity',
        name: 'signal write, 1 effect x10k',
        floorOf: 'plain object write x10k',
        check: () => {
            const before = runs;
            state.v = ++n;
            assert(runs === before + 1, `write ran the effect ${runs - before} times, expected exactly 1`);
        },
        run: () => {
            for (let i = 0; i < 10_000; i++) state.v = ++n;
        }
    };
}

function writeFanout(): MicroBench {
    const state = signal({ v: 0 });
    let runs = 0;
    for (let i = 0; i < 100; i++) {
        effect(() => {
            void state.v;
            runs++;
        });
    }
    let n = 0;
    return {
        suite: 'reactivity',
        name: 'signal write fanned out to 100 effects x1k',
        quick: true,
        check: () => {
            const before = runs;
            state.v = ++n;
            assert(
                runs === before + 100,
                `write ran ${runs - before} effects, expected exactly 100 — the graph has come detached`
            );
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) state.v = ++n;
        }
    };
}

function batchedWrites(): MicroBench {
    const state = signal({ a: 0, b: 0, c: 0 });
    let runs = 0;
    effect(() => {
        void (state.a + state.b + state.c);
        runs++;
    });
    let n = 0;
    return {
        suite: 'reactivity',
        name: 'batch of 3 writes into one effect x1k',
        check: () => {
            const before = runs;
            batch(() => {
                state.a = ++n;
                state.b = n + 1;
                state.c = n + 2;
            });
            assert(runs === before + 1, `three batched writes ran the effect ${runs - before} times, expected 1`);
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) {
                batch(() => {
                    state.a = ++n;
                    state.b = n + 1;
                    state.c = n + 2;
                });
            }
        }
    };
}

function diamond(): MicroBench {
    const src = signal({ n: 0 });
    const c1 = computed(() => src.n + 1);
    const c2 = computed(() => src.n + 2);
    const sink = computed(() => c1.value + c2.value);
    effect(() => { void sink.value; });
    let n = 0;
    return {
        suite: 'reactivity',
        name: 'diamond write + read x1k',
        check: () => {
            src.n = ++n;
            assert(sink.value === n * 2 + 3, `diamond sink is ${sink.value}, expected ${n * 2 + 3}`);
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) {
                src.n = ++n;
                void sink.value;
            }
        }
    };
}

function computedChain(): MicroBench {
    const src = signal({ v: 0 });
    let prev = computed(() => src.v);
    for (let i = 0; i < 50; i++) {
        const source = prev;
        prev = computed(() => source.value + 1);
    }
    const tail = prev;
    let n = 0;
    return {
        suite: 'reactivity',
        name: '50-deep computed chain write + read x1k',
        check: () => {
            src.v = ++n;
            assert(tail.value === n + 50, `chain tail is ${tail.value}, expected ${n + 50} — the chain is not 50 deep`);
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) {
                src.v = ++n;
                void tail.value;
            }
        }
    };
}

/**
 * The value-equality cutoff: the computed's value never changes, so the
 * downstream effect must not re-run. The guard IS the headline — a build that
 * lost the cutoff would report a much worse number, and one that broke the
 * effect entirely would report a much better one.
 */
function stableComputedCutoff(): MicroBench {
    const src = signal({ count: 1 });
    const isPositive = computed(() => src.count > 0);
    let runs = 0;
    effect(() => {
        void isPositive.value;
        runs++;
    });
    let n = 1;
    return {
        suite: 'reactivity',
        name: 'value-stable computed write (cutoff) x10k',
        check: () => {
            const before = runs;
            src.count = ++n;
            assert(runs === before, `the cutoff let ${runs - before} effect run(s) through — the value did not change`);
        },
        run: () => {
            for (let i = 0; i < 10_000; i++) src.count = ++n;
        }
    };
}

function reTrackFiftyDeps(): MicroBench {
    const state = signal(makeFlat(50));
    let runs = 0;
    effect(() => {
        let sum = 0;
        for (let i = 0; i < 50; i++) sum += state[`k${i}`];
        void sum;
        runs++;
    });
    let n = 0;
    return {
        suite: 'reactivity',
        name: 're-track: effect with 50 deps re-running x1k',
        check: () => {
            const before = runs;
            state.k0 = ++n;
            assert(runs === before + 1, `write ran the effect ${runs - before} times, expected 1`);
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) state.k0 = ++n;
        }
    };
}

function setReplace(): MicroBench {
    const keys = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const state = signal(makeFlat(10));
    let runs = 0;
    effect(() => {
        void state.k0;
        runs++;
    });
    let n = 0;
    const replace = (): void => {
        // A plain loop keeps the (required) fresh object cheap, so $set
        // dominates rather than iterator/fromEntries overhead.
        ++n;
        const next: Record<string, number> = {};
        for (const k of keys) next[k] = n;
        state.$set(next);
    };
    return {
        suite: 'reactivity',
        name: '$set replace of 10-key object x1k',
        check: () => {
            const before = runs;
            replace();
            assert(runs > before, '$set did not notify the k0 subscriber');
            assert(state.k0 === n, `$set left k0 at ${state.k0}, expected ${n}`);
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) replace();
        }
    };
}

function mapChurn(): MicroBench {
    const m = signal(new Map<number, number>());
    let runs = 0;
    effect(() => {
        void (m.size + (m.has(1) ? 1 : 0));
        runs++;
    });
    let i = 0;
    const churn = (): void => {
        const k = (i = (i + 1) % 64);
        m.set(k, i);
        m.delete(k);
    };
    return {
        suite: 'reactivity',
        name: 'Map set+delete churn with size/has subscriber x1k',
        check: () => {
            const before = runs;
            churn();
            assert(runs > before, 'a Map set+delete did not notify the size subscriber');
            assert(m.size === 0, `the Map kept ${m.size} entries — churn is not balanced`);
        },
        run: () => {
            for (let n = 0; n < 1_000; n++) churn();
        }
    };
}

function arrayChurn(): MicroBench {
    const arr = signal([0, 1, 2, 3]);
    let runs = 0;
    effect(() => {
        void arr.length;
        runs++;
    });
    let n = 0;
    return {
        suite: 'reactivity',
        name: 'array push+pop churn with length subscriber x1k',
        check: () => {
            const before = runs;
            arr.push(++n);
            arr.pop();
            assert(runs > before, 'push+pop did not notify the length subscriber');
            assert(arr.length === 4, `the array is ${arr.length} long — churn is not balanced`);
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) {
                arr.push(++n);
                arr.pop();
            }
        }
    };
}

/** Outside any effect: the get trap's fixed cost with no tracking to do. */
function untrackedNestedRead(): MicroBench {
    const state = signal({ a: { b: { c: 0 } } });
    return {
        suite: 'reactivity',
        name: 'untracked nested object read x10k',
        check: () => {
            assert(state.a.b.c === 0, 'the nested read did not resolve');
        },
        run: () => {
            for (let i = 0; i < 10_000; i++) void state.a.b.c;
        }
    };
}

function createSignals(): MicroBench {
    return {
        suite: 'reactivity',
        name: 'create 10k object signals',
        check: () => {
            const one = signal({ v: 1 });
            assert(one.v === 1, 'a freshly created signal did not read back');
        },
        run: () => {
            for (let i = 0; i < 10_000; i++) signal({ v: i });
        }
    };
}

function createAndStopEffects(): MicroBench {
    const state = signal({ a: 0, b: 0, c: 0, d: 0, e: 0 });
    return {
        suite: 'reactivity',
        name: 'create-and-stop 1k effects over 5 deps',
        check: () => {
            let runs = 0;
            const runner = effect(() => {
                void (state.a + state.b + state.c + state.d + state.e);
                runs++;
            });
            assert(runs === 1, `the effect ran ${runs} times on creation, expected 1`);
            runner.stop();
            state.a++;
            assert(runs === 1, 'a stopped effect still ran — the cleanup path is not detaching it');
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) {
                const runner = effect(() => {
                    void (state.a + state.b + state.c + state.d + state.e);
                });
                runner.stop();
            }
        }
    };
}

/** The `shouldNotProxy` slow path: exotics with internal slots, never proxied. */
function nonProxyableRoots(): MicroBench {
    // Hoisted so the loop measures the root check, not Date/TypedArray
    // construction.
    const date = new Date(0);
    const buf = new Uint8Array(4);
    return {
        suite: 'reactivity',
        name: 'signal() on non-proxyable roots x1k',
        check: () => {
            assert(signal(date) === date, 'a Date was proxied — shouldNotProxy did not reject it');
            assert(signal(buf) === buf, 'a typed array was proxied — shouldNotProxy did not reject it');
        },
        run: () => {
            for (let i = 0; i < 1_000; i++) {
                signal(date);
                signal(buf);
            }
        }
    };
}

function nonProxyableReads(): MicroBench {
    const date = new Date(0);
    const buf = new Uint8Array(4);
    const state = signal({ at: date, buf });
    return {
        suite: 'reactivity',
        name: 'read non-proxyable values off an object signal x10k',
        check: () => {
            assert(state.at === date, 'the Date came back wrapped — the get trap proxied an exotic');
            assert(state.buf === buf, 'the typed array came back wrapped');
        },
        run: () => {
            for (let i = 0; i < 10_000; i++) {
                void state.at;
                void state.buf;
            }
        }
    };
}

export const reactivitySuite: MicroSuite = {
    name: 'reactivity',
    benches(): MicroBench[] {
        // Floors first — `run-micro` resolves `floorOf` against benches already
        // measured in this suite.
        return [
            plainWriteFloor(),
            writeNoSubscribers(),
            writeOneEffect(),
            writeFanout(),
            batchedWrites(),

            plainWalkFloor(),
            deepWatchBench({
                name: 'watch(deep) 1 mutation, small state x1k',
                rows: 1,
                mutationsPerTurn: 1,
                turns: 1_000
            }),
            deepWatchBench({
                name: `watch(deep) 1 mutation, ${ROWS}-row state x100`,
                rows: ROWS,
                mutationsPerTurn: 1,
                turns: 100,
                quick: true,
                floorOf: 'plain deep walk x100'
            }),
            deepWatchBench({
                name: `watch(deep) 8 mutations per batch, ${ROWS}-row state x100`,
                rows: ROWS,
                mutationsPerTurn: 8,
                turns: 100,
                floorOf: 'plain deep walk x100'
            }),
            shallowWatchBench(),
            turnBoundaryBench(),

            diamond(),
            computedChain(),
            stableComputedCutoff(),
            reTrackFiftyDeps(),
            setReplace(),
            mapChurn(),
            arrayChurn(),
            untrackedNestedRead(),
            createSignals(),
            createAndStopEffects(),
            nonProxyableRoots(),
            nonProxyableReads()
        ];
    }
};
