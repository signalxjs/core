# @sigx/vite

Vite plugin for [SignalX](https://github.com/signalxjs/core) — wires up dev-mode
source aliasing, HMR for `component()`, and ships a small CLI that generates
TypeScript definitions for tag-named components.

## Install

```bash
npm install -D @sigx/vite
```

`@sigx/vite` peer-depends on `vite >= 8` and `sigx`.

## Usage

Add the plugin to your `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import sigx from '@sigx/vite';

export default defineConfig({
  plugins: [sigx()],
});
```

Named import works too:

```ts
import { sigxPlugin } from '@sigx/vite';
```

That's it — the plugin handles the rest. In dev it aliases the `@sigx/*`
packages to their source so a single reactivity instance is shared across the
graph; in build mode it gets out of the way.

### Options

```ts
sigx({
  hmr: true, // default — set to false to disable HMR transforms
});
```

| Option | Type      | Default | Description                                                  |
| ------ | --------- | ------- | ------------------------------------------------------------ |
| `hmr`  | `boolean` | `true`  | Inject the HMR runtime and transform `component()` factories so state survives module reloads. |

## TSX setup

For JSX/TSX, configure your `tsconfig.json` to use SignalX's JSX runtime:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "sigx"
  }
}
```

## CLI: `sigx-types`

The package also exposes a `sigx-types` CLI that scans your project for
components declared with a tag name (e.g. `component('my-button', …)`) and
emits global type augmentations into `node_modules/.sigx/`, so JSX gets
intellisense for `<my-button>` without manual imports.

```bash
npx sigx-types              # one-shot generation
npx sigx-types --watch      # regenerate on change
npx sigx-types --help
```

| Flag             | Default                | Description                                       |
| ---------------- | ---------------------- | ------------------------------------------------- |
| `--watch`, `-w`  | off                    | Watch `src/`, `components/`, `pages/` for changes |
| `--out`, `-o`    | `node_modules/.sigx`   | Output directory                                  |
| `--include`      | `**/*.tsx,**/*.ts,**/*.jsx` | Glob patterns to scan (comma-separated)      |
| `--exclude`      | `node_modules/**,dist/**,**/*.d.ts` | Glob patterns to skip                |

Add the output to your `tsconfig.json` `include` so the editor picks it up:

```json
{
  "include": ["src", "node_modules/.sigx/**/*.d.ts"]
}
```

## How HMR works

When `hmr: true` (default), the plugin transforms each module that imports
`component()` so that:

1. Each component definition is registered with a stable id (`moduleId:index`).
2. Live instances are tracked by id.
3. On module reload, existing instances are re-bound to the new factory and
   re-rendered without losing their per-instance signal state.

If something looks off after an HMR update, a full reload always falls back to
a clean state.

## Subpath exports

For advanced setups, the package exposes:

- `@sigx/vite/hmr` — the browser-side HMR runtime (normally injected for you).
- `@sigx/vite/lib` — `defineLibConfig` helper used internally by the `@sigx/*`
  packages to produce their library builds with Vite 8 / Rolldown.

Most users won't need either directly.
