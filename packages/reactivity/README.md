# @sigx/reactivity

Reactivity system for SignalX. Provides fine-grained reactive primitives including signals, computed values, effects, and watchers.

📚 **Full guides, API reference and live examples → <https://sigx.dev/core/packages/reactivity/overview/>**

## Install

```bash
npm install @sigx/reactivity
```

## Usage

```tsx
import { signal, computed, effect, batch } from '@sigx/reactivity';

const count = signal(0);
const doubled = computed(() => count.value * 2);

effect(() => {
  console.log(`count: ${count.value}, doubled: ${doubled.value}`);
});

batch(() => {
  count.value++;
  count.value++;
});
// Logs once: "count: 2, doubled: 4"
```

### Reading a value tracks the key; enumerating tracks the key set

Reading `state.foo` subscribes to that one key. **Enumerating** a reactive
object — `Object.keys()`, `for…in`, object spread, rest destructuring —
subscribes to its *key set* instead, so a key appearing or disappearing re-runs
the reader while a value change does not:

```tsx
const state = signal<Record<string, number>>({ a: 1 });

effect(() => console.log(Object.keys(state)));
state.b = 2;   // logs ['a', 'b'] — the key set changed
state.a = 99;  // logs nothing    — no key appeared or disappeared
```

`'x' in state` subscribes to the same per-key dependency a read of `state.x`
would, so presence and value always agree. Arrays subscribe through `length`,
which an index write already updates. `Map` and `Set` track iteration and
`.size` the same way.

Because each added key re-runs an enumerating reader, filling an object key by
key is quadratic — wrap bulk key changes in `batch()`:

```tsx
batch(() => { for (const [k, v] of entries) state[k] = v; });   // one re-run
```

## 📚 Documentation

The complete API reference (`signal`, `isSignal`, `computed`, `effect`, `batch`, `watch`, `untrack`, `effectScope`, `onScopeDispose`, `toSignal`, `toSignals`, and more), guides and live examples → **<https://sigx.dev/core/packages/reactivity/overview/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
