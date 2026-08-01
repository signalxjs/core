/// <reference types="vite/client" />
/// <reference types="@sigx/vite/client" />

// Those two lines type every `virtual:*` module the sigx plugins generate
// (#562). This app installs BOTH strategy packs, so both manifests arrive
// fully typed — each pack registers its own key by being imported.
