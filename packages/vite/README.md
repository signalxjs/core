# @sigx/vite

Vite plugin for [SignalX](https://sigx.dev/core/) — wires up dev-mode source
aliasing, HMR for `component()`, and ships a small `sigx-types` CLI that
generates TypeScript definitions for tag-named components.

📚 **Full guides, API reference and live examples → <https://sigx.dev/vite/>**

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

That's it — the plugin handles the rest. In dev it aliases the `@sigx/*`
packages to their source so a single reactivity instance is shared across the
graph; in build mode it gets out of the way.

## 📚 Documentation

Plugin options, HMR, the `sigx-types` CLI, TSX setup and subpath exports —
full guides, the complete reference and live examples → **<https://sigx.dev/vite/>**
