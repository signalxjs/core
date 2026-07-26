/**
 * `$models` must reach `ctx.props` on the server too (#527).
 *
 * The client merges each `$models` entry back into props under its own name,
 * so `props.model` / `props.title` is a `Model` during setup. The SSR path had
 * its own destructure that discarded `$models` outright, so the same component
 * saw `undefined` on the server and a `Model` on the client — a render that
 * disagreed with its own hydration.
 *
 * Both paths now go through `splitComponentProps`, so the fix is structural
 * rather than a second implementation kept in step by hand.
 */

import { describe, it, expect } from 'vitest';
import { component, jsx, signal, isModel } from 'sigx';
import type { Define } from 'sigx';
import { renderToString } from '../src/index';

describe('SSR props carry models', () => {
    it('exposes an unnamed model as props.model during server setup', async () => {
        let seen: unknown;
        const Input = component<Define.Model<string>>(({ props }) => {
            seen = props.model;
            return () => jsx('input', { value: String(props.model?.value ?? '') });
        });

        const state = signal({ value: 'from-server' });
        const html = await renderToString(jsx(Input, { model: [state, 'value'] }));

        expect(isModel(seen)).toBe(true);
        expect((seen as { value: string }).value).toBe('from-server');
        expect(html).toContain('value="from-server"');
    });

    it('exposes a named model under its own name', async () => {
        let seen: unknown;
        const Titled = component<Define.Model<'title', string>>(({ props }) => {
            seen = props.title;
            return () => jsx('h1', { children: String(props.title?.value ?? '') });
        });

        const state = signal({ title: 'Hello' });
        const html = await renderToString(jsx(Titled, { 'model:title': [state, 'title'] }));

        expect(isModel(seen)).toBe(true);
        expect(html).toContain('Hello');
    });

    it('does not serialize the model object as an attribute', async () => {
        // It reaches props as a Model, and the serializer skips Model values —
        // so it informs the render without ever becoming markup.
        const Wrapper = component<Define.Model<string>>(({ props }) => {
            return () => jsx('div', { title: String(props.model?.value ?? '') });
        });

        const state = signal({ value: 'v' });
        const html = await renderToString(jsx(Wrapper, { model: [state, 'value'] }));

        // (the trailing `<!--$c:N-->` is the component hydration marker)
        expect(html).toContain('<div title="v"></div>');
        expect(html).not.toContain('object Object');
        expect(html).not.toContain('model');
    });
});
