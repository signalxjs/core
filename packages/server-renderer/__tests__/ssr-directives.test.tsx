/**
 * SSR directive tests
 *
 * Tests that getSSRProps is called during server rendering
 * and that use:* props are excluded from HTML output.
 */

import { describe, it, expect } from 'vitest';
import { defineDirective, defineApp, component } from 'sigx';
import { renderToString } from '../src/server/index';

describe('SSR directives', () => {
    it('should not render use:* as HTML attributes', async () => {
        const dir = defineDirective<string>({
            mounted() {}
        });

        const html = await renderToString(
            <div use:test={[dir, 'hello']}>Content</div>
        );

        expect(html).not.toContain('use:test');
        expect(html).toContain('Content');
    });

    it('should call getSSRProps and merge into HTML output', async () => {
        const dir = defineDirective<boolean>({
            getSSRProps({ value }) {
                if (!value) {
                    return { style: { display: 'none' } };
                }
            }
        });

        const html = await renderToString(
            <div use:vis={[dir, false]}>Hidden</div>
        );

        expect(html).toContain('display:none');
        expect(html).not.toContain('use:vis');
    });

    it('should not add SSR props when getSSRProps returns void', async () => {
        const dir = defineDirective<boolean>({
            getSSRProps({ value }) {
                if (!value) {
                    return { style: { display: 'none' } };
                }
                // Return void when value is truthy
            }
        });

        const html = await renderToString(
            <div use:vis={[dir, true]}>Visible</div>
        );

        expect(html).not.toContain('display:none');
        expect(html).not.toContain('use:vis');
    });

    it('should merge class from getSSRProps', async () => {
        const dir = defineDirective<string>({
            getSSRProps({ value }) {
                return { class: value };
            }
        });

        const html = await renderToString(
            <div use:cls={[dir, 'extra-class']}>Content</div>
        );

        expect(html).toContain('extra-class');
        expect(html).not.toContain('use:cls');
    });

    it('should work with show directive SSR', async () => {
        // Import show from runtime-dom
        const { show } = await import('@sigx/runtime-dom');

        const html = await renderToString(
            <div use:show={[show, false]}>Hidden content</div>
        );

        expect(html).toContain('display:none');
        expect(html).not.toContain('use:show');
        expect(html).toContain('Hidden content');
    });

    it('should not add display:none when show is true', async () => {
        const { show } = await import('@sigx/runtime-dom');

        const html = await renderToString(
            <div use:show={[show, true]}>Visible content</div>
        );

        expect(html).not.toContain('display:none');
        expect(html).not.toContain('use:show');
    });

    it('should handle multiple directives with getSSRProps', async () => {
        const dirA = defineDirective<boolean>({
            getSSRProps({ value }) {
                if (!value) return { style: { display: 'none' } };
            }
        });
        const dirB = defineDirective<string>({
            getSSRProps({ value }) {
                return { class: value };
            }
        });

        const html = await renderToString(
            <div use:a={[dirA, false]} use:b={[dirB, 'highlighted']}>Content</div>
        );

        expect(html).toContain('display:none');
        expect(html).toContain('highlighted');
        expect(html).not.toContain('use:a');
        expect(html).not.toContain('use:b');
    });

    it('should handle directive without getSSRProps', async () => {
        const dir = defineDirective<string>({
            mounted() { /* DOM only */ }
        });

        const html = await renderToString(
            <div use:domonly={[dir, 'value']}>Content</div>
        );

        // Should render normally without any directive artifacts
        expect(html).toContain('<div>Content</div>');
        expect(html).not.toContain('use:domonly');
    });

    it('should handle directive value passed directly (no tuple)', async () => {
        const dir = defineDirective<void>({
            getSSRProps() {
                return { 'data-dir': 'applied' };
            }
        });

        const html = await renderToString(
            <div use:mydir={dir}>Content</div>
        );

        expect(html).toContain('data-dir="applied"');
        expect(html).not.toContain('use:mydir');
    });

    it('should merge show directive style with element inline style', async () => {
        const { show } = await import('@sigx/runtime-dom');

        const html = await renderToString(
            <div style={{ display: 'flex', color: 'red' }} use:show={[show, false]}>Content</div>
        );

        // show=false should override display to none
        expect(html).toContain('display:none');
        // but preserve the other style properties
        expect(html).toContain('color:red');
        expect(html).not.toContain('display:flex');
    });

    it('should preserve element style when show is true', async () => {
        const { show } = await import('@sigx/runtime-dom');

        const html = await renderToString(
            <div style={{ display: 'flex', color: 'red' }} use:show={[show, true]}>Content</div>
        );

        // show=true returns void, so element style is untouched
        expect(html).toContain('display:flex');
        expect(html).toContain('color:red');
    });

    it('should merge directive style with string element style', async () => {
        const dir = defineDirective<boolean>({
            getSSRProps({ value }) {
                if (!value) return { style: { display: 'none' } };
            }
        });

        const html = await renderToString(
            <div style="color:red;font-size:14px" use:vis={[dir, false]}>Content</div>
        );

        // Should parse string style and merge with directive style
        expect(html).toContain('display:none');
        expect(html).toContain('color:red');
        expect(html).toContain('font-size:14px');
    });

    it('should resolve built-in show directive with shorthand boolean (false)', async () => {
        const html = await renderToString(
            <div use:show={false}>Hidden</div>
        );

        expect(html).toContain('display:none');
        expect(html).not.toContain('use:show');
        expect(html).toContain('Hidden');
    });

    it('should resolve built-in show directive with shorthand boolean (true)', async () => {
        const html = await renderToString(
            <div use:show={true}>Visible</div>
        );

        expect(html).not.toContain('display:none');
        expect(html).not.toContain('use:show');
        expect(html).toContain('Visible');
    });
});

describe('SSR custom directive registration via app.directive()', () => {
    it('should resolve custom directive with getSSRProps via app.directive()', async () => {
        const dir = defineDirective<string>({
            getSSRProps({ value }) {
                return { 'data-tooltip': value };
            }
        });

        const app = defineApp(<div use:tooltip="hello world">Content</div>);
        app.directive('tooltip', dir);

        const html = await renderToString(app);

        expect(html).toContain('data-tooltip="hello world"');
        expect(html).not.toContain('use:tooltip');
    });

    it('should merge custom directive SSR style props', async () => {
        const dir = defineDirective<boolean>({
            getSSRProps({ value }) {
                if (!value) return { style: { opacity: '0.5' } };
            }
        });

        const app = defineApp(<div style={{ color: 'red' }} use:fade={false}>Content</div>);
        app.directive('fade', dir);

        const html = await renderToString(app);

        expect(html).toContain('opacity:0.5');
        expect(html).toContain('color:red');
        expect(html).not.toContain('use:fade');
    });

    it('should ignore custom directive without getSSRProps in SSR', async () => {
        const dir = defineDirective<string>({
            mounted() { /* client-only */ }
        });

        const app = defineApp(<div use:domonly="value">Content</div>);
        app.directive('domonly', dir);

        const html = await renderToString(app);

        expect(html).toContain('<div>Content</div>');
        expect(html).not.toContain('use:domonly');
    });

    it('should prioritise explicit tuple over app-registered directive in SSR', async () => {
        const registered = defineDirective<string>({
            getSSRProps({ value }) {
                return { 'data-from': 'registered' };
            }
        });
        const explicit = defineDirective<string>({
            getSSRProps({ value }) {
                return { 'data-from': 'explicit' };
            }
        });

        const app = defineApp(<div use:test={[explicit, 'val']}>Content</div>);
        app.directive('test', registered);

        const html = await renderToString(app);

        expect(html).toContain('data-from="explicit"');
        expect(html).not.toContain('data-from="registered"');
    });

    it('should prioritise built-in over app-registered directive with same name in SSR', async () => {
        const customDir = defineDirective<boolean>({
            getSSRProps({ value }) {
                return { 'data-custom': 'true' };
            }
        });

        const app = defineApp(<div use:show={false}>Content</div>);
        app.directive('show', customDir);

        const html = await renderToString(app);

        // Built-in show should apply display:none
        expect(html).toContain('display:none');
        // Custom one should not have been used
        expect(html).not.toContain('data-custom');
    });

    it('should resolve custom directive inside a component in SSR', async () => {
        const badge = defineDirective<string>({
            getSSRProps({ value }) {
                return { 'data-badge': value };
            }
        });

        const Card = component(() => {
            return () => <div use:badge="new">Card content</div>;
        });

        const app = defineApp(<Card />);
        app.directive('badge', badge);

        const html = await renderToString(app);

        expect(html).toContain('data-badge="new"');
        expect(html).not.toContain('use:badge');
    });

    it('should merge class from custom directive getSSRProps', async () => {
        const dir = defineDirective<string>({
            getSSRProps({ value }) {
                return { class: value };
            }
        });

        const app = defineApp(<div use:cls="extra">Content</div>);
        app.directive('cls', dir);

        const html = await renderToString(app);

        expect(html).toContain('extra');
        expect(html).not.toContain('use:cls');
    });
});
