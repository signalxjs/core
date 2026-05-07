# @sigx/runtime-dom

DOM runtime for SignalX. Provides the DOM-specific renderer, event handling, attribute patching, directive system, and SVG support.

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

## Key Exports

| Export | Description |
|---|---|
| `render(vnode, container)` | Mount a component tree to a DOM element |
| `Portal` | Render children into a different DOM container |
| `show` | Built-in directive for conditional display |

The module also handles DOM property/attribute patching, event delegation, form control bindings, SVG namespace handling, and directive lifecycle management.

> **Note:** Most users should install [`sigx`](https://www.npmjs.com/package/sigx) instead, which bundles this package with the core runtime and reactivity system.

## Documentation

Full documentation and guides are available at the [SignalX repository](https://github.com/signalxjs/core).

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
