/**
 * Guard for the attribute contract the resume pack (#241) rests on: the prop
 * serializer renders plain string props — including colon-namespaced
 * `data-sigx-*` keys — as HTML attributes, while `on*` event props are
 * dropped. If serializeOpenTagProps ever changes either behavior, QRL
 * smuggling breaks; this test names the dependents.
 */

import { describe, it, expect } from 'vitest';
import { renderToString } from '../src/index';

describe('prop serialization contract (resume pack dependency)', () => {
    it('renders data-sigx-* string props verbatim and drops on* props', async () => {
        const vnode = {
            type: 'button',
            props: {
                onClick: () => {},
                'data-sigx-on:click': 'Counter_click_ab12cd34',
                'data-sigx-pd:click': '',
                'data-sigx-b': '3'
            },
            key: null,
            children: ['go'],
            dom: null
        } as any;

        const html = await renderToString(vnode);
        expect(html).toContain('data-sigx-on:click="Counter_click_ab12cd34"');
        expect(html).toContain('data-sigx-pd:click=""');
        expect(html).toContain('data-sigx-b="3"');
        expect(html).not.toContain('onClick');
    });

    it('escapes attribute values (QRL values are attacker-adjacent strings)', async () => {
        const vnode = {
            type: 'button',
            props: { 'data-sigx-on:click': '"><script>alert(1)</script>' },
            key: null,
            children: [],
            dom: null
        } as any;

        const html = await renderToString(vnode);
        expect(html).not.toContain('<script>alert');
        expect(html).toContain('&quot;&gt;');
    });
});
