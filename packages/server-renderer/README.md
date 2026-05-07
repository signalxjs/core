# @sigx/server-renderer

Server-side rendering and client hydration for SignalX. Supports streaming and string-based rendering, plugin-driven architecture, and head management.

## Install

```bash
npm install @sigx/server-renderer
```

## Server-Side Rendering

```tsx
import { renderToStream, renderToString } from '@sigx/server-renderer/server';
import App from './App';

// Streaming (recommended)
const stream = renderToStream(<App />);

// Or render to string
const html = await renderToString(<App />);
```

## Client Hydration

```tsx
import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import App from './App';

defineApp(<App />)
  .use(ssrClientPlugin)
  .hydrate('#root');
```

## Plugin System

```tsx
import { createSSR } from '@sigx/server-renderer';

const ssr = createSSR().use(myPlugin());
const html = await ssr.render(<App />);
```

## Key Exports

**Main entry (`@sigx/server-renderer`)**
- `createSSR` — Plugin-driven SSR instance
- `renderToStream`, `renderToString`, `renderVNodeToString`
- `createSSRContext` — Create an SSR rendering context
- `ssrClientPlugin` — Client-side hydration plugin
- `useHead`, `renderHeadToString` — Head tag management

**Server (`@sigx/server-renderer/server`)**
- Streaming and string rendering APIs
- SSR context and serialization utilities

**Client (`@sigx/server-renderer/client`)**
- `hydrate`, `hydrateNode` — Core hydration functions
- `ssrClientPlugin` — Plugin for `defineApp().use()`

## Documentation

Full documentation and guides are available at the [SignalX repository](https://github.com/signalxjs/core).

## License

[MIT](https://github.com/signalxjs/core/blob/main/LICENSE)
