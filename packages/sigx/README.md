# SignalX

Lightweight reactive component framework with signals and TSX support. This is the main entry point that re-exports the public API from `@sigx/reactivity`, `@sigx/runtime-core`, and `@sigx/runtime-dom`.

📚 **Full guides, API reference and live examples → <https://sigx.dev/core/>**

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

## 📚 Documentation

Full guides, the complete API reference and live examples → **<https://sigx.dev/core/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
