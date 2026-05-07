/**
 * SSR Client Plugin
 * 
 * Provides app.hydrate() method for client-side hydration of server-rendered HTML.
 * This plugin follows the same pattern as the router plugin.
 */

import type { Plugin, App, AppContext } from '@sigx/runtime-core';
import { render } from 'sigx';
import { hydrate as hydrateImpl } from './hydrate-core';

// ============================================================================
// Type Augmentation
// ============================================================================

/**
 * Hydrate function signature - matches MountFn pattern
 */
export type HydrateFn<TContainer = any> = (
    element: any,
    container: TContainer,
    appContext: AppContext
) => (() => void) | void;

declare module '@sigx/runtime-core' {
    interface App<TContainer = any> {
        /**
         * Hydrate the app from server-rendered HTML.
         * 
         * Unlike mount() which creates new DOM, hydrate() attaches to existing
         * server-rendered DOM, adding event handlers and establishing reactivity.
         * 
         * @example
         * ```tsx
         * import { defineApp } from 'sigx';
         * import { ssrClientPlugin } from '@sigx/server-renderer/client';
         * 
         * const app = defineApp(<App />);
         * app.use(router)
         *    .use(ssrClientPlugin)
         *    .hydrate(document.getElementById('app')!);
         * ```
         */
        hydrate?(container: TContainer): App<TContainer>;
    }
}

// ============================================================================
// Plugin Implementation
// ============================================================================

/**
 * SSR Client Plugin
 * 
 * Adds the hydrate() method to the app instance for client-side hydration.
 * Also registers the SSR context extension for all components.
 * 
 * @example
 * ```tsx
 * import { defineApp } from 'sigx';
 * import { ssrClientPlugin } from '@sigx/server-renderer/client';
 * 
 * const app = defineApp(<App />);
 * app.use(ssrClientPlugin)
 *    .use(router)
 *    .hydrate('#app');
 * ```
 */
export const ssrClientPlugin: Plugin = {
    name: '@sigx/server-renderer/client',

    install(app: App) {
        // Add hydrate method to the app instance
        (app as any).hydrate = function(container: Element | string): App {
            // Resolve container if string selector
            const resolvedContainer = typeof container === 'string'
                ? document.querySelector(container)
                : container;

            if (!resolvedContainer) {
                throw new Error(
                    `[ssrClientPlugin] Cannot find container: ${container}. ` +
                    'Make sure the element exists in the DOM before calling hydrate().'
                );
            }

            // Get the root component from the app
            const rootComponent = (app as any)._rootComponent;
            
            if (!rootComponent) {
                throw new Error(
                    '[ssrClientPlugin] No root component found on app. ' +
                    'Make sure you created the app with defineApp(<Component />).'
                );
            }

            // Check if there's actual SSR content to hydrate
            // If container is empty or only has comments, fall back to client-side render
            const hasSSRContent = resolvedContainer.firstElementChild !== null ||
                (resolvedContainer.firstChild !== null && 
                 resolvedContainer.firstChild.nodeType !== Node.COMMENT_NODE);

            // Get app context for passing to render (needed for inject() to work)
            const appContext = (app as any)._context;

            if (hasSSRContent) {
                // Perform hydration with app context for DI
                hydrateImpl(rootComponent, resolvedContainer, appContext);
            } else {
                // No SSR content - fall back to client-side render (dev mode)
                render(rootComponent, resolvedContainer, appContext);
            }

            // Store container on the vnode for potential unmount
            (resolvedContainer as any)._app = app;

            return app;
        };
    }
};
