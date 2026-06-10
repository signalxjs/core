# @sigx/runtime-dom

DOM runtime for SignalX. Provides the DOM-specific renderer, event handling, attribute patching, directive system, and SVG support.

📚 **Full guides, API reference and live examples → <https://sigx.dev/core/packages/runtime-dom/overview/>**

## Install

```bash
npm install @sigx/runtime-dom
```

## Usage

```tsx
import { component, signal } from '@sigx/runtime-core';
import { render } from '@sigx/runtime-dom';

const App = component(() => {
  const name = signal('world');

  return () => (
    <div>
      <input
        value={name.value}
        onInput={(e) => (name.value = e.currentTarget.value)}
      />
      <p>Hello, {name.value}!</p>
    </div>
  );
});

render(<App />, document.getElementById('app')!);
```

> **Note:** Most users should install [`sigx`](https://www.npmjs.com/package/sigx) instead, which bundles this package with the core runtime and reactivity system.

## 📚 Documentation

The full export list (`render`, `Portal`, the `show` directive) plus DOM patching, event delegation, form bindings and SVG handling — guides and live examples → **<https://sigx.dev/core/packages/runtime-dom/overview/>**

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
