/**
 * Type-only entry for @sigx/ssr-islands.
 *
 * `import '@sigx/ssr-islands/jsx'` enables the client:* hydration directive
 * props (client:load, client:idle, client:visible, client:media, client:only)
 * on JSX components without pulling in any runtime. Importing anything from the
 * main `@sigx/ssr-islands` or `@sigx/ssr-islands/client` entry registers the
 * same augmentation; this entry is for consumers who want only the types.
 */

declare module '@sigx/runtime-core' {
    interface ComponentAttributeExtensions {
        'client:load'?: boolean;
        'client:idle'?: boolean;
        'client:visible'?: boolean;
        'client:media'?: string;
        'client:only'?: boolean;
    }
}

export {};
