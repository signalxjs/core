# @sigx/reactivity

Reactivity system for SignalX. Provides fine-grained reactive primitives including signals, computed values, effects, and watchers.

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

## API

| Export | Description |
|---|---|
| `signal(value)` | Create a reactive signal |
| `computed(fn)` | Derived reactive value |
| `effect(fn)` | Run a side effect when dependencies change |
| `batch(fn)` | Batch multiple updates into a single notification |
| `watch(source, callback)` | Watch a reactive source with old/new value tracking |
| `untrack(fn)` | Read reactive values without tracking dependencies |
| `effectScope()` | Create a scope to collect and dispose effects |
| `toRaw(value)` | Get the raw underlying value of a reactive object |
| `isReactive(value)` | Check if a value is reactive |
| `isComputed(value)` | Check if a value is a computed signal |
| `detectAccess(fn)` | Detect which signals are accessed in a function |

## Documentation

Full documentation and guides are available at the [SignalX repository](https://github.com/signalxjs/core).

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
