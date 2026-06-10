# @sigx/runtime-core

Runtime core for SignalX. Provides the platform-agnostic component system, JSX runtime, reconciler, lifecycle hooks, dependency injection, and control flow primitives.

📚 **Full guides, API reference and live examples → <https://sigx.dev/core/packages/runtime-core/overview/>**

## Install

```bash
npm install @sigx/runtime-core
```

## Usage

```tsx
import { component, signal, onMounted, onUnmounted } from '@sigx/runtime-core';

const Timer = component(() => {
  const elapsed = signal(0);
  let interval: number;

  onMounted(() => {
    interval = setInterval(() => elapsed.value++, 1000);
  });

  onUnmounted(() => {
    clearInterval(interval);
  });

  return () => <span>Elapsed: {elapsed.value}s</span>;
});
```

> **Note:** Most users should install [`sigx`](https://www.npmjs.com/package/sigx) instead, which bundles this package with a DOM renderer and the reactivity system.

## 📚 Documentation

The complete export list (component model, JSX runtime, lifecycle, lazy/Suspense, DI, control flow, directives, error handling), guides and live examples → **<https://sigx.dev/core/packages/runtime-core/overview/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
