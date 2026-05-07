/**
 * DOM renderer creation and render API.
 *
 * Creates the platform-specific renderer from nodeOps and exports
 * the public render function and low-level renderer primitives.
 */

import { createRenderer, setDefaultMount } from '@sigx/runtime-core/internals';
import type { JSXElement } from '@sigx/runtime-core';
import type { AppContext } from '@sigx/runtime-core';
import { renderTargetNotFoundError, mountTargetNotFoundError } from '@sigx/runtime-core';
import { nodeOps } from './nodeOps.js';

const renderer = createRenderer(nodeOps);

/**
 * Render a SignalX element to a DOM container.
 * Supports both Element references and CSS selectors.
 * 
 * @example
 * ```tsx
 * import { render } from 'sigx';
 * 
 * // Using CSS selector
 * render(<App />, "#app");
 * 
 * // Using element reference
 * render(<App />, document.getElementById('app')!);
 * ```
 */
export const render = (element: JSXElement, container: Element | string, appContext?: AppContext): void => {
    const target = typeof container === 'string'
        ? document.querySelector(container)
        : container;

    if (!target) {
        throw renderTargetNotFoundError(String(container));
    }

    return renderer.render(element, target as Element, appContext);
};

// Export primitives for SSR plugins and hydration
export const { patch, mount, unmount, mountComponent } = renderer;

// Set up the default mount function for this platform
setDefaultMount((component: any, container: HTMLElement | Element | ShadowRoot | string, appContext?: AppContext): (() => void) => {
    const target = typeof container === 'string'
        ? document.querySelector(container)
        : container;

    if (!target) {
        throw mountTargetNotFoundError(String(container));
    }

    render(component, target as Element, appContext);

    return () => {
        render(null, target as Element);
    };
});
