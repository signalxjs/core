# SignalX

Lightweight reactive component framework with signals and TSX support. This is the main entry point that re-exports the public API from `@sigx/reactivity`, `@sigx/runtime-core`, and `@sigx/runtime-dom`.

## Install

```bash
npm install sigx
```

## Usage

```tsx
import { component, signal, render } from 'sigx';

const Counter = component(() => {
  const count = signal(0);

  return () => (
    <div>
      <p>Count: {count.value}</p>
      <button onClick={() => count.value++}>Increment</button>
    </div>
  );
});

render(<Counter />, document.getElementById('app')!);
```

## Key Exports

- **Reactivity** — `signal`, `computed`, `effect`, `batch`, `watch`, `untrack`
- **Components** — `component`, `lazy`, `defineApp`
- **Lifecycle** — `onMounted`, `onUnmounted`, `onCreated`, `onUpdated`
- **Rendering** — `render`, `Portal`, `Suspense`, `Fragment`
- **Control Flow** — `Show`, `Switch`, `Match`
- **JSX** — `jsx`, `jsxs`, `jsxDEV`

## Documentation

Full documentation and guides are available at the [SignalX repository](https://github.com/signalxjs/core).

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
