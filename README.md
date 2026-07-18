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

## A taste

```tsx
import { component, signal, render } from "sigx";

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

No `.value` for objects, no `setState`, no `produce()` callbacks — just mutate. Primitives use `.value`; everything else is transparent through a Proxy.

## 📚 Documentation

Full guides, API reference and live examples → **<https://sigx.dev/core/>**

## Packages in this repo

| Package | npm | Docs | Description |
|---|---|---|---|
| `@sigx/reactivity`     | [npm](https://www.npmjs.com/package/@sigx/reactivity)     | [docs](https://sigx.dev/core/packages/reactivity/overview/)   | Signals, computed, and effects — the reactive primitives |
| `@sigx/runtime-core`   | [npm](https://www.npmjs.com/package/@sigx/runtime-core)   | [docs](https://sigx.dev/core/packages/runtime-core/overview/) | Component model and renderer base shared between targets |
| `@sigx/runtime-dom`    | [npm](https://www.npmjs.com/package/@sigx/runtime-dom)    | [docs](https://sigx.dev/core/packages/runtime-dom/overview/)  | DOM renderer |
| `sigx`                 | [npm](https://www.npmjs.com/package/sigx)                 | [docs](https://sigx.dev/core/)                                | The public umbrella package — what you import in apps |
| `@sigx/server-renderer`| [npm](https://www.npmjs.com/package/@sigx/server-renderer)| [docs](https://sigx.dev/server/)                              | SSR — render components to HTML on the server (pluggable hydration strategies) |
| `@sigx/ssr-islands`    | [npm](https://www.npmjs.com/package/@sigx/ssr-islands)    | [docs](https://sigx.dev/server/)                              | Islands architecture — selective hydration via `client:*` directives (reference strategy pack) |
| `@sigx/resume`         | [npm](https://www.npmjs.com/package/@sigx/resume)         | [docs](https://sigx.dev/server/)                              | Resumability — QRL event handlers, zero-JS pages, upgrade-on-write hydration |
| `@sigx/cache`          | [npm](https://www.npmjs.com/package/@sigx/cache)          | [docs](https://sigx.dev/)                                     | Cache policy for value-first async — staleTime, revalidation, `invalidate()`, optimistic `mutate()` (rfc-async §7 pack) |
| `@sigx/server`         | [npm](https://www.npmjs.com/package/@sigx/server)         | [docs](https://sigx.dev/server/)                              | Server functions (RPC) — `serverFn` in `*.server.ts` modules, typed fetch stubs, security-first endpoint (rfc-server) |
| `@sigx/vite`           | [npm](https://www.npmjs.com/package/@sigx/vite)           | [docs](https://sigx.dev/vite/)                                | Vite plugin for dev/build with HMR |
| `@sigx/cloudflare`     | [npm](https://www.npmjs.com/package/@sigx/cloudflare)     | [docs](https://sigx.dev/deploy/cloudflare/)                   | Cloudflare Workers deployment adapter — bundled workerd build, `wrangler.jsonc` + entry scaffolding, dev binding proxies (rfc-deploy) |
| `@sigx/vercel`         | [npm](https://www.npmjs.com/package/@sigx/vercel)         | [docs](https://sigx.dev/deploy/vercel/)                       | Vercel deployment adapter — Build Output API v3 generation: static/, the render function, config.json routes (rfc-deploy) |

## Part of SignalX

SignalX is a family of packages for building reactive apps:

- **Core** → <https://sigx.dev/core/>
- **Store** → <https://sigx.dev/store/>
- **Router** → <https://sigx.dev/router/>
- **SSG** → <https://sigx.dev/ssg/>
- **Lynx (native)** → <https://sigx.dev/lynx/>

## Acknowledgements

SignalX's reactivity model is **deeply inspired by Vue 3's fine‑grained reactivity system**. Huge thanks to Evan You and the Vue team. Thanks also to the **Solid** team for the signal‑first philosophy, the **Preact signals** authors for the lightweight take, and the contributors of the **TC39 Signals proposal** for the shared vocabulary.

For day‑to‑day contributing, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE) © Andreas Ekdahl
