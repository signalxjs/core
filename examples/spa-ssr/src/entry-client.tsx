import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { App } from './App';
import { createRouter, parseUrl, useRouter } from './router';

// One router for the page. Initialised from the current URL so the first client
// render matches the server's HTML.
const app = defineApp(<App />);
app.defineProvide(useRouter, () => createRouter(parseUrl(window.location.pathname)));
app.use(ssrClientPlugin).hydrate('#app');
