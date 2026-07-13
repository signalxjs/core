# @sigx/ssr-islands

Islands architecture for SignalX SSR. Renders pages on the server and selectively hydrates only the components that need interactivity, controlled by `client:*` directives. Everything outside an island stays as static HTML — no JavaScript shipped, no hydration cost.

## 📚 Documentation

Full guides, API reference and live examples → **<https://sigx.dev/server/>**

## A taste

```bash
npm install @sigx/ssr-islands sigx vite
```

```tsx
<Counter client:load />     {/* hydrate immediately */}
<Counter client:idle />     {/* hydrate when the browser is idle */}
<Counter client:visible />  {/* hydrate when it scrolls into view */}
<Counter client:only />     {/* skip SSR — mount fresh on the client only */}
```

See the [docs](https://sigx.dev/server/) for the Vite plugin setup and the full list of hydration strategies.

## License

MIT © Andreas Ekdahl
