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

## Platform identity and directive registration

Importing `@sigx/runtime-dom` sets up the DOM platform: the renderer mount,
the form model processor (two-way `model={...}` binding on inputs,
checkboxes, radios, selects, textareas), and the standard built-in
directives (`show`) register automatically — that's platform identity, the
same way `@sigx/lynx` registers its own model processor. `use:show={value}`
and `model={...}` work with zero setup.

Custom directives register through the seams:

```tsx
import { defineApp, defineDirective } from 'sigx';

const focus = defineDirective<boolean, HTMLElement>({
    mounted(el, { value }) {
        if (value) el.focus();
    }
});

defineApp(<App />)
    .directive('focus', focus)   // per app — works on the client and in SSR
    .mount('#app');

// or globally (e.g. for apps using bare render()):
import { registerBuiltInDirective } from '@sigx/runtime-dom';
registerBuiltInDirective('focus', focus);
```

To light up IntelliSense for your directive's `use:*` attribute, augment the
JSX extension point with the one-line `DirectiveAttribute` alias:

```ts
declare global {
    namespace JSX {
        interface DirectiveAttributeExtensions {
            /** Focus the element when the value is true. */
            'use:focus'?: JSX.DirectiveAttribute<boolean>;
        }
    }
}
```

The augmentation is program-wide: any file in the app (or a directive
package's published types) can declare it, and every JSX file gets the
typed attribute. Unregistered names still work untyped via the
`use:${string}` catch-all.
