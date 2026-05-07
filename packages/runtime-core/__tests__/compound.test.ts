import { describe, it, expect } from 'vitest';
import { component, compound } from '../src';
import { VNode } from '../src/jsx-runtime';

describe('compound', () => {
    it('should create a compound component with sub-components', () => {
        const Parent = component(() => () => null);
        const Child = component(() => () => null);

        const CompoundParent = compound(Parent, { Child });

        expect(CompoundParent).toBe(Parent);
        expect(CompoundParent.Child).toBe(Child);
    });

    it('should support multiple sub-components', () => {
        const Menu = component(() => () => null);
        const MenuItem = component(() => () => null);
        const MenuTitle = component(() => () => null);
        const MenuDivider = component(() => () => null);

        const CompoundMenu = compound(Menu, {
            Item: MenuItem,
            Title: MenuTitle,
            Divider: MenuDivider,
        });

        expect(CompoundMenu.Item).toBe(MenuItem);
        expect(CompoundMenu.Title).toBe(MenuTitle);
        expect(CompoundMenu.Divider).toBe(MenuDivider);
    });

    it('should preserve the main component __setup function', () => {
        const setup = () => () => null;
        const Parent = component(setup);
        const Child = component(() => () => null);

        const CompoundParent = compound(Parent, { Child });

        expect(CompoundParent.__setup).toBe(setup);
    });

    it('should preserve sub-component __setup functions', () => {
        const parentSetup = () => () => null;
        const childSetup = () => () => null;
        
        const Parent = component(parentSetup);
        const Child = component(childSetup);

        const CompoundParent = compound(Parent, { Child });

        expect(CompoundParent.Child.__setup).toBe(childSetup);
    });

    it('should preserve component names', () => {
        const Parent = component(() => () => null, { name: 'Parent' });
        const Child = component(() => () => null, { name: 'Child' });

        const CompoundParent = compound(Parent, { Child });

        expect(CompoundParent.__name).toBe('Parent');
        expect(CompoundParent.Child.__name).toBe('Child');
    });

    it('should allow calling the compound component as a function', () => {
        const Parent = component(() => () => null);
        const Child = component(() => () => null);

        const CompoundParent = compound(Parent, { Child });
        const result = CompoundParent({ prop: 'value' } as any) as VNode;

        expect(result.type).toBe(CompoundParent);
        expect(result.props.prop).toBe('value');
    });

    it('should allow calling sub-components as functions', () => {
        const Parent = component(() => () => null);
        const Child = component(() => () => null);

        const CompoundParent = compound(Parent, { Child });
        const result = CompoundParent.Child({ childProp: 'test' } as any) as VNode;

        expect(result.type).toBe(Child);
        expect(result.props.childProp).toBe('test');
    });

    it('should support nested compound components', () => {
        const GrandChild = component(() => () => null);
        const Child = compound(
            component(() => () => null),
            { GrandChild }
        );
        const Parent = compound(
            component(() => () => null),
            { Child }
        );

        expect(Parent.Child).toBe(Child);
        expect(Parent.Child.GrandChild).toBe(GrandChild);
    });
});
