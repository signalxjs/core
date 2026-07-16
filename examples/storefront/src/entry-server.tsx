import { defineApp } from 'sigx';
import { App } from './App';

/** Per-request app factory (docs/router-ssr-contract.md §1). */
export function createApp(_url: string) {
    return defineApp(<App />);
}
