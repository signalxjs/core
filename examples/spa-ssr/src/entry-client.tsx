import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { App } from './App';
import { createRouter, parseUrl, useRouter } from './router';
import { TechDetails } from './lazy-sections';

// One router for the page. Initialised from the current URL so the first client
// render matches the server's HTML.
const app = defineApp(<App />);
app.defineProvide(useRouter, () => createRouter(parseUrl(window.location.pathname)));

async function start() {
    // Server-resolved Suspense content must hydrate against the REAL
    // component, so preload the lazy chunk(s) the current route renders
    // before walking the DOM.
    if (parseUrl(window.location.pathname) === '/about') {
        await TechDetails.preload?.();
    }
    // hydrate() is installed by ssrClientPlugin (declared optional on App)
    app.use(ssrClientPlugin).hydrate!('#app');
}

void start();
