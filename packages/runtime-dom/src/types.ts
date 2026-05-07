/**
 * Module augmentation for DOM platform.
 * When @sigx/runtime-dom is imported, these types automatically extend the core types.
 */
declare module '@sigx/runtime-core' {
    /** DOM platform sets HTMLElement as the default element type */
    interface PlatformTypes {
        element: HTMLElement;
    }
}

// Export something to make this a module (required for augmentation to work)
export { };
