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

## Host attributes on components (`Define.Attrs`)

This package owns what `Define.Attrs` means on the web, by augmenting
`ComponentAttributes` from `@sigx/runtime-core`. A component that forwards its
leftover props to an element declares the opt-in and gets the set:

```tsx
type ButtonProps = Define.Prop<'variant', 'primary' | 'ghost'> & Define.Attrs;
```

The set is **universal attributes only** — the global HTML attributes (`id`,
`class`, `style`, `title`, `role`, `tabIndex`, `hidden`, `dir`, `lang`, …), the
`data-*` and `aria-*` patterns, and DOM event handlers. Per-tag attributes are
deliberately excluded: `size`, `type`, `value`, `disabled`, `name`,
`placeholder` and friends are exactly the names real components declare as
domain props, so they belong to each component's own contract rather than to a
passthrough.

Handlers are advertised in **camelCase only** (`onClick`, not `onclick`), even
though both work at runtime. Two spellings of one event resolve to the same DOM
listener slot, so only one of them ever runs — sigx warns about that in dev,
and `mergeProps` merges them into a single entry. Advertising one spelling is
the type-level half of the same fix.

There is no `[key: string]` index signature and no `on${string}` catch-all:
either would disable excess-property checking on every opted-in component, and
typo safety is the reason the opt-in exists at all.

## Model directive modifiers

`model={...}` accepts a `modelModifiers` prop. The built-ins are:

| Modifier   | Kind            | Effect                                                        |
| ---------- | --------------- | ------------------------------------------------------------ |
| `trim`     | value transform | Strip leading/trailing whitespace before write-back.         |
| `number`   | value transform | Coerce a numeric string to a number (no-op if not numeric).  |
| `lazy`     | timing          | Sync on `change` (blur/enter) instead of every keystroke.    |
| `debounce` | timing          | Delay write-back by N ms (`true` ⇒ 300ms).                    |

```tsx
<input type="text" model={() => state.name} modelModifiers={{ trim: true }} />
<input type="text" model={() => state.age}  modelModifiers={{ number: true }} />
<input type="text" model={() => state.q}    modelModifiers={{ debounce: 300 }} />
```

Modifiers are **scoped per element type**: `trim`/`number` are value transforms,
so they're only offered on value-bearing elements (text/number/range/textarea/
select). On a checkbox/radio they're a compile error (and a dev-time warning) —
only the timing modifiers (`lazy`/`debounce`) apply there.

### Custom modifiers (`registerModelModifier`)

The modifier system is a pluggable registry in `@sigx/runtime-core`, symmetric
with `registerModelProcessor`. Value transforms run at the write-back boundary in
the core runtime, so they work on **every** binding path (default `model`, named
`model:name`, custom-element processors, components) and on **every platform**
(DOM, Lynx, SSR) with no platform code. Only `timing` is platform-specific.

```ts
import { registerModelModifier } from 'sigx';

// 1. Register the runtime behavior.
registerModelModifier('uppercase', {
    transform: (v) => (typeof v === 'string' ? v.toUpperCase() : v),
});

// 2. Augment the matching capability group so it type-checks in JSX.
//    ValueModelModifiers → value transforms (auto-scoped to value-bearing
//    elements, absent from checkbox/radio); TimingModelModifiers → timing.
declare module '@sigx/runtime-core' {
    interface ValueModelModifiers {
        uppercase?: boolean;
    }
}

// Now this type-checks on a text input and errors on a checkbox:
<input type="text" model={() => state.code} modelModifiers={{ uppercase: true }} />;
```

A modifier definition has an optional `transform(value, ctx)` (value transform)
and/or `timing` (`'lazy' | 'debounce'`). `registerModelModifier` returns an
unregister function.
