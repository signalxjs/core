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

## Development vs production builds

Every sigx package ships two builds: the development build (helpful warnings +
devtools support) and a production build with all of that compiled out. Your
bundler picks the right one automatically via the `development`/`production`
export conditions — Vite needs no configuration. Running plain Node (SSR)
without a bundler? The development build is the default and checks
`process.env.NODE_ENV` at runtime; use `node --conditions=production` to get
the stripped build.
