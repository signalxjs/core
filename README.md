<div align="center">
  <img src="./logo/signalx-logo-150x119.png" alt="SignalX" width="150" />

# SignalX

**Vue‑grade reactivity. TypeScript‑grade types. JSX you'd actually write.**

[![npm](https://img.shields.io/npm/v/sigx.svg?label=sigx&color=blue)](https://www.npmjs.com/package/sigx)
[![license](https://img.shields.io/npm/l/sigx.svg)](./LICENSE)
[![ci](https://github.com/signalxjs/core/actions/workflows/ci.yml/badge.svg)](https://github.com/signalxjs/core/actions/workflows/ci.yml)
[![types](https://img.shields.io/npm/types/sigx.svg)](https://www.typescriptlang.org/)

</div>

> 🚧 SignalX is in early public release (`0.4.x`). The API surface is small and stabilising — feedback is very welcome. See [CHANGELOG.md](./CHANGELOG.md) for what's new.

## What is SignalX?

SignalX is a small reactive component framework: deeply reactive **signals**, lazy **computed** values, and fine‑grained **effects**, all wired into **TSX** components. It targets developers who already love TypeScript and JSX, and want a reactive runtime that feels like Vue's but reads and types like idiomatic TSX code.

Under the hood, SignalX uses a vnode renderer with keyed reconciliation — much like Vue 3 — but a state change only invalidates the components that actually read the changed signals. The vdom diff is bounded by signal granularity, not by the size of your component tree.

The name says it: **Signal** for the reactivity model, **X** for TSX.

## What's distinctive

```tsx
import { signal } from "sigx";

const state = signal({ count: 0, todos: [] as string[] });

state.count++;                    // direct mutation — no .value, no setState
state.todos.push("ship sigx");    // arrays trigger updates too
state.$set({ count: 0, todos: [] }); // replace the whole object atomically
```

> No `.value` for objects, no `setState`, no `produce()` callbacks — just mutate. Primitives use `.value`; everything else is transparent through a Proxy.

Notice the ergonomics — direct mutation on object signals, no `.value`, no setter callbacks. This is what SignalX inherits from Vue's `reactive()` proxy and rounds off into a single primitive. Vue 3 splits reactivity into two: **`ref()`** for single cells (accessed via `.value`) and **`reactive()`** for deep proxies (accessed directly). Idiomatic Vue mixes both based on the value type. SignalX collapses them into one `signal()` that dispatches automatically — primitives get a `.value` cell, objects become a deeply reactive Proxy. Solid takes a different shape with immutable setters (`setState(...)`). Preact signals uses a single shallow cell with `.value` for everything; deep state typically means multiple signals.

## A real component

```tsx
import { component, render } from "sigx";

export const Counter = component(({ signal }) => {
  const state = signal({ count: 0 });   // object  → reactive proxy, mutate directly
  const ticks = signal(0);              // primitive → cell with `.value`

  return () => (
    <div>
      <p>Count: {state.count} · Ticks: {ticks.value}</p>
      <button onClick={() => state.count++}>Increment</button>
      <button onClick={() => ticks.value++}>Tick</button>
    </div>
  );
});

render(<Counter />, document.getElementById("app")!);
```

A few things to notice:

- **One primitive, two ergonomics.** `signal({...})` gives back a deeply reactive Proxy you mutate directly (`state.count++`). `signal(0)` gives back a single cell accessed via `.value` (`ticks.value++`). The runtime decides which based on the initial value — you don't pick a different API.
- The factory receives a per‑instance scope (the destructured `{ signal }`). State created here is bound to this component instance — there's no global registry to clean up.
- The factory **returns a render closure**. That closure re‑runs *only* when its tracked signals change — and when it does, the diff is scoped to this component's subtree. Sibling components and ancestors don't re‑render.
- It's just TSX. No template language, no SFC compiler, no JSX pragma you have to remember.

## Props, events, slots — the `Define` namespace

Real components need to declare what they accept. The component's TypeScript type is composed from `Define.*` helpers, and everything wires through to JSX automatically — there's no separate `defineProps` / `defineEmits` macro.

```tsx
import { component, type Define } from "sigx";

type ButtonProps =
  & Define.Prop<"label", string, true>                  // required (3rd arg = required)
  & Define.Prop<"variant", "primary" | "ghost">         // optional (3rd arg defaults to false)
  & Define.Event<"click", MouseEvent>                   // emits → parent reads as onClick
  & Define.Slot<"icon">;                                // optional <icon> slot

const Button = component<ButtonProps>(({ props, slots, emit }) => {
  return () => (
    <button
      class={`btn btn-${props.variant ?? "primary"}`}
      onClick={(e) => emit("click", e)}
    >
      {slots.icon?.()}
      {props.label}
    </button>
  );
});

// Caller side — the JSX type-checks against ButtonProps:
<Button
  label="Save"
  variant="primary"
  onClick={(e) => console.log(e)}
  slots={{ icon: () => <span>💾</span> }}
/>
```

`Define.Expose<{...}>` adds a typed imperative API (read via `ref={r => ...}`) for the rare cases JSX state isn't enough.

> Runnable: [`examples/spa/src/pages/Forms.tsx`](./examples/spa/src/pages/Forms.tsx) — a `Stepper` child uses `Define.Prop` + `Define.Event`, the parent listens via `onStep`.

## Two-way binding with `model`

`model={() => state.x}` is a getter — SignalX intercepts the property access and wires up both read and write. It works on native form elements out of the box:

```tsx
<input model={() => form.name} />
<input type="checkbox" model={() => form.agreed} />
<input type="checkbox" value="apple" model={() => form.fruits} />  {/* arrays */}
<input type="radio" value="medium" model={() => form.size} />
<select model={() => form.country}>…</select>
<textarea model={() => form.bio} />
```

To accept it on a custom component, declare it with `Define.Model`:

```tsx
import { component, type Define } from "sigx";

type RatingProps = Define.Model<number>;

const Rating = component<RatingProps>(({ props }) => {
  return () => (
    <div>
      {[1, 2, 3, 4, 5].map(n => (
        <button onClick={() => props.model && (props.model.value = n)}>
          {n <= (props.model?.value ?? 0) ? "★" : "☆"}
        </button>
      ))}
    </div>
  );
});

<Rating model={() => state.rating} />
```

Inside the component, `props.model` is a `Model<T>` object — read or write through `props.model.value`, or pass `props.model` to a child to forward the binding without unwrapping. For multiple bindings, use `Define.Model<"name", T>` and the caller writes `model:name={() => state.x}`.

### Modifiers

`modelModifiers` tunes how native inputs write back:

```tsx
<input model={() => form.name} modelModifiers={{ trim: true }} />
<input model={() => form.qty} modelModifiers={{ number: true }} />
<input model={() => form.note} modelModifiers={{ lazy: true }} />      {/* sync on change, not every keystroke */}
<input model={() => form.search} modelModifiers={{ debounce: 300 }} /> {/* delay write-back 300ms */}
```

### Custom elements

Teach the `model` directive about a custom element or web component with `registerModelProcessor`. Registered processors run before the built-in DOM handling, in registration order; the first to return `true` wins, and anything unhandled falls through to the native behavior:

```tsx
import { registerModelProcessor } from "sigx";

const off = registerModelProcessor((type, props, [obj, key], originalProps) => {
  if (type !== "my-toggle") return false;
  props.checked = obj[key];
  props.onToggle = (e) => { obj[key] = e.detail.value; };
  return true;
});
// `off()` unregisters it.
```

> Runnable: [`examples/spa/src/pages/Forms.tsx`](./examples/spa/src/pages/Forms.tsx) — native `model` on `<input>`, `<select>`, `<textarea>`, modifiers, plus a custom `Rating` component declared with `Define.Model<number>`.

## Quick start

```bash
npm install sigx
npm install -D @sigx/vite vite
```

`vite.config.ts`:

```ts
import { defineConfig } from "vite";
import sigx from "@sigx/vite";

export default defineConfig({
  plugins: [sigx()],
});
```

`tsconfig.json` — point the JSX runtime at SignalX:

```jsonc
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@sigx/runtime-core"
  }
}
```

That's it. Write components, run `vite`, ship.

## Packages in this repo

| Package | npm | Description |
|---|---|---|
| [`@sigx/reactivity`](./packages/reactivity)         | [`@sigx/reactivity`](https://www.npmjs.com/package/@sigx/reactivity)         | Signals, computed, and effects — the reactive primitives |
| [`@sigx/runtime-core`](./packages/runtime-core)     | [`@sigx/runtime-core`](https://www.npmjs.com/package/@sigx/runtime-core)     | Component model and renderer base shared between targets |
| [`@sigx/runtime-dom`](./packages/runtime-dom)       | [`@sigx/runtime-dom`](https://www.npmjs.com/package/@sigx/runtime-dom)       | DOM renderer |
| [`sigx`](./packages/sigx)                           | [`sigx`](https://www.npmjs.com/package/sigx)                                 | The public umbrella package — what you import in apps |
| [`@sigx/server-renderer`](./packages/server-renderer) | [`@sigx/server-renderer`](https://www.npmjs.com/package/@sigx/server-renderer) | SSR — render components to HTML on the server |
| [`@sigx/vite`](./packages/vite)                     | [`@sigx/vite`](https://www.npmjs.com/package/@sigx/vite)                     | Vite plugin for dev/build with HMR |


## How SignalX differs

This is a friendly orientation, not a leaderboard. All four projects below are excellent — I built SignalX because I wanted a specific combination of ergonomics that none of them quite hit for me.

| | **SignalX** | **Vue 3** | **Solid** | **Preact signals** |
|---|---|---|---|---|
| Reactive primitive(s) | One: `signal()` | Two: `ref()` + `reactive()` | One: `createSignal()` | One: `signal()` (shallow) |
| Object access | `state.x++` | `state.x++` (via `reactive`) | `setState("x", v => v+1)` | one signal per field |
| Primitive access | `count.value++` | `count.value++` (via `ref`) | `setCount(c => c+1)` | `count.value++` |
| Authoring | TSX components | SFCs (or TSX) | TSX components | JSX components |
| Render model | VDOM, signal‑scoped diff | VDOM, signal‑scoped diff | No VDOM — compiled DOM ops | VDOM (Preact) with signal fast paths |
| First‑class SSR | ✅ `@sigx/server-renderer` | ✅ | ✅ | Via host framework |

Where each shines:
- **Vue 3** is the most batteries‑included full‑stack framework with the deepest ecosystem. SignalX shares its reactivity philosophy and its rendering family — `reactive()` and `signal()` give you the same direct‑mutation feel.
- **Solid** is the only one of the four with no virtual DOM at all — JSX compiles to direct DOM operations. If you want the absolute minimum render overhead, Solid is the answer.
- **Preact signals** is the lightest signals primitive and the easiest to drop into an existing React/Preact app, but the signal itself is shallow — deep reactive state means composing several of them.
- **SignalX** is for people who want a single primitive that handles both cases, in pure TSX, with a small surface and no template compiler.

## Examples

Runnable examples live in [`examples/`](./examples):

- [`hello`](./examples/hello) — the smallest possible client‑side app: one component, one signal, one button
- [`spa`](./examples/spa) — a minimal hash‑routed single‑page app (three pages, no router package)
- [`spa-ssr`](./examples/spa-ssr) — server‑rendered SPA with Express + `@sigx/server-renderer` and client hydration

```bash
pnpm install
pnpm build
pnpm --filter @sigx/hello-example dev
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

For day‑to‑day contributing, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Acknowledgements

SignalX's reactivity model is **deeply inspired by Vue 3's fine‑grained reactivity system**. Huge thanks to Evan You and the Vue team for showing what a great Proxy‑based reactive runtime can look like — SignalX takes that lineage and pairs it with TSX‑first authoring and direct‑mutation ergonomics.

Thanks also to the **Solid** team for the signal‑first philosophy, to the **Preact signals** authors for the lightweight take, and to the contributors of the **TC39 Signals proposal** for the shared vocabulary the broader community is converging on.

## License

[MIT](./LICENSE) © Andreas Ekdahl
