# @sigx/runtime-core

Runtime core for SignalX. Provides the platform-agnostic component system, JSX runtime, reconciler, lifecycle hooks, dependency injection, and control flow primitives.

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

## Key Exports

- **Component** — `component`, `getCurrentInstance`, `getComponentMeta`
- **Lifecycle** — `onMounted`, `onUnmounted`, `onCreated`, `onUpdated`
- **JSX Runtime** — `jsx`, `jsxs`, `jsxDEV`, `Fragment`, `Text`, `Comment`
- **Lazy Loading** — `lazy`, `Suspense`, `isLazyComponent`
- **Async** — `useAsync`
- **Control Flow** — `Show`, `Switch`, `Match`
- **App** — `defineApp`
- **DI** — `defineInjectable`, `defineProvide`, `useAppContext`
- **Model** — `createModel`, `createModelFromBinding`, `isModel`
- **Directives** — `defineDirective`, `isDirective`
- **Error Handling** — `ErrorBoundary`
- **Messaging** — Domain models and pub/sub messaging

> **Note:** Most users should install [`sigx`](https://www.npmjs.com/package/sigx) instead, which bundles this package with a DOM renderer and the reactivity system.

## Documentation

Full documentation and guides are available at the [SignalX repository](https://github.com/signalxjs/core).

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
