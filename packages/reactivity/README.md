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

## 📚 Documentation

The complete API reference (`signal`, `computed`, `effect`, `batch`, `watch`, `untrack`, `effectScope`, and more), guides and live examples → **<https://sigx.dev/core/packages/reactivity/overview/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
