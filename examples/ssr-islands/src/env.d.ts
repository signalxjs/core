/// <reference types="@sigx/vite/client" />

// That one line types every `virtual:*` module the sigx plugins generate
// (#562). `islandsManifest` carries its real type because this app imports
// @sigx/ssr-islands; `resumeManifest` stays `unknown` — resume is not
// installed here, and the value is `undefined` in this app anyway.
