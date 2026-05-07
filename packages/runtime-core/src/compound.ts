import type { AnyComponentFactory } from './component.js';

/**
 * Creates a compound component by attaching sub-components as static properties.
 * 
 * This enables the pattern of `Parent.Child` components (e.g., `Menu.Item`, `Card.Body`)
 * while preserving full TypeScript type inference for both the parent and children.
 * 
 * @param main - The main/parent component factory
 * @param sub - An object containing sub-components to attach
 * @returns The main component with sub-components attached as static properties
 * 
 * @example
 * ```tsx
 * // Define individual components
 * const _Menu = component<MenuProps>(ctx => { ... });
 * const _MenuItem = component<MenuItemProps>(ctx => { ... });
 * const _MenuTitle = component<MenuTitleProps>(ctx => { ... });
 * 
 * // Create compound component
 * export const Menu = compound(_Menu, {
 *     Item: _MenuItem,
 *     Title: _MenuTitle,
 * });
 * 
 * // Usage in JSX
 * <Menu>
 *     <Menu.Title>Navigation</Menu.Title>
 *     <Menu.Item value="home">Home</Menu.Item>
 *     <Menu.Item value="about">About</Menu.Item>
 * </Menu>
 * ```
 */
export function compound<
    TMain extends AnyComponentFactory,
    TSub extends Record<string, AnyComponentFactory>
>(main: TMain, sub: TSub): TMain & TSub {
    return Object.assign(main, sub) as TMain & TSub;
}
