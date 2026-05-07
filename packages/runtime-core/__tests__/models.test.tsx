import { describe, it, expect, vi } from "vitest";
import { jsx, VNode, isModel } from "../src/jsx-runtime";
import { component, ModelBinding, Model, type Define } from "../src/component";
import { signal, computed } from "@sigx/reactivity";

describe("Model Binding Architecture", () => {
    describe("jsx runtime - model processing", () => {
        it("should collect default model into $models for components", () => {
            // Create a mock component
            const TestComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "test" });
            const vnode = jsx(TestComponent, {
                model: [state, "value"]
            }) as VNode;

            expect(vnode.props.$models).toBeDefined();
            expect(isModel(vnode.props.$models.model)).toBe(true);
            expect(vnode.props.$models.model.value).toBe("test");
            expect(vnode.props.$models.model.binding[0]).toBe(state);
            expect(vnode.props.$models.model.binding[1]).toBe("value");
        });

        it("should collect named models into $models for components", () => {
            const TestComponent = component<Define.Model<"title", string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ title: "Hello" });
            const vnode = jsx(TestComponent, {
                "model:title": [state, "title"]
            }) as VNode;

            expect(vnode.props.$models).toBeDefined();
            expect(isModel(vnode.props.$models.title)).toBe(true);
            expect(vnode.props.$models.title.value).toBe("Hello");
            expect(vnode.props.$models.title.binding[0]).toBe(state);
            expect(vnode.props.$models.title.binding[1]).toBe("title");
        });

        it("should collect multiple named models", () => {
            type Props = Define.Model<"value", string> & Define.Model<"error", string>;
            const TestComponent = component<Props>(({ props }) => {
                return () => null;
            });

            const state = signal({ email: "test@test.com", emailError: "Required" });
            const vnode = jsx(TestComponent, {
                "model:value": [state, "email"],
                "model:error": [state, "emailError"]
            }) as VNode;

            expect(isModel(vnode.props.$models.value)).toBe(true);
            expect(vnode.props.$models.value.value).toBe("test@test.com");
            expect(isModel(vnode.props.$models.error)).toBe(true);
            expect(vnode.props.$models.error.value).toBe("Required");
        });

        it("should create onUpdate handler on props for emit compatibility", () => {
            const TestComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "initial" });
            const vnode = jsx(TestComponent, {
                model: [state, "value"]
            }) as VNode;

            // The update handler should be on props for emit compatibility
            expect(vnode.props["onUpdate:modelValue"]).toBeDefined();
            expect(typeof vnode.props["onUpdate:modelValue"]).toBe("function");

            // Calling the handler should update the state
            vnode.props["onUpdate:modelValue"]("updated");
            expect(state.value).toBe("updated");
        });

        it("should handle tuple forwarding (already detected)", () => {
            const TestComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "test" });
            // Simulate forwarding - tuple is passed directly
            const vnode = jsx(TestComponent, {
                model: [state, "value"]
            }) as VNode;

            expect(isModel(vnode.props.$models.model)).toBe(true);
            expect(vnode.props.$models.model.value).toBe("test");
        });

        it("should not create $models for intrinsic elements", () => {
            const state = signal({ value: "test" });
            const vnode = jsx("input", {
                model: [state, "value"]
            }) as VNode;

            // For intrinsic elements, $models should not be set
            expect(vnode.props.$models).toBeUndefined();
            // Platform processor sets props.value directly for input elements
            expect(vnode.props.value).toBe("test");
        });

        it("should delete model prop from processedProps", () => {
            const TestComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "test" });
            const vnode = jsx(TestComponent, {
                model: [state, "value"]
            }) as VNode;

            expect(vnode.props.model).toBeUndefined();
            expect(vnode.props["model:value"]).toBeUndefined();
        });

        it("should keep regular props separate from models", () => {
            type Props = Define.Model<string> & Define.Prop<"label", string>;
            const TestComponent = component<Props>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "test" });
            const vnode = jsx(TestComponent, {
                model: [state, "value"],
                label: "My Label"
            }) as VNode;

            // Model should be in $models as a Model<T> object
            expect(isModel(vnode.props.$models.model)).toBe(true);
            expect(vnode.props.$models.model.value).toBe("test");
            // Regular prop should be in props directly
            expect(vnode.props.label).toBe("My Label");
        });
    });

    describe("Model binding types", () => {
        it("should correctly type default model", () => {
            type Props = Define.Model<number>;
            
            const TestComponent = component<Props>(({ props }) => {
                // Type assertions - Model<T> objects are on props now
                const model: Model<number> | undefined = props.model;
                if (model) {
                    const value: number = model.value;
                }
                
                return () => null;
            });

            expect(TestComponent).toBeDefined();
        });

        it("should correctly type named model", () => {
            type Props = Define.Model<"count", number>;
            
            const TestComponent = component<Props>(({ props }) => {
                // Type assertions - named models are on props
                const countModel: Model<number> | undefined = props.count;
                if (countModel) {
                    const value: number = countModel.value;
                }
                
                return () => null;
            });

            expect(TestComponent).toBeDefined();
        });

        it("should correctly type multiple models", () => {
            type Props = Define.Model<string> & Define.Model<"error", string>;
            
            const TestComponent = component<Props>(({ props }) => {
                // Default model
                const model = props.model;
                if (model) {
                    const value: string = model.value;
                }
                
                // Named model
                const errorModel = props.error;
                if (errorModel) {
                    const errorValue: string = errorModel.value;
                }
                
                return () => null;
            });

            expect(TestComponent).toBeDefined();
        });
    });

    describe("Update handler chaining", () => {
        it("should call existing handler when updating model", () => {
            const TestComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "initial" });
            const existingHandler = vi.fn();
            
            const vnode = jsx(TestComponent, {
                model: [state, "value"],
                "onUpdate:modelValue": existingHandler
            }) as VNode;

            // Call the update handler
            vnode.props["onUpdate:modelValue"]("new value");

            // Both the state should be updated AND the existing handler called
            expect(state.value).toBe("new value");
            expect(existingHandler).toHaveBeenCalledWith("new value");
        });

        it("should call onUpdate handler on state object if present", () => {
            const TestComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const customHandler = vi.fn();
            const state = signal({ 
                value: "initial",
                "onUpdate:value": customHandler
            });
            
            const vnode = jsx(TestComponent, {
                model: [state, "value"]
            }) as VNode;

            // Call the update handler
            vnode.props["onUpdate:modelValue"]("new value");

            // The custom handler should be called instead of direct assignment
            expect(customHandler).toHaveBeenCalledWith("new value");
        });
    });

    describe("Empty models", () => {
        it("should not set $models when no models are passed", () => {
            type Props = Define.Model<string> & Define.Prop<"label", string>;
            const TestComponent = component<Props>(({ props }) => {
                return () => null;
            });

            const vnode = jsx(TestComponent, {
                label: "Just a label"
            }) as VNode;

            expect(vnode.props.$models).toBeUndefined();
            expect(vnode.props.label).toBe("Just a label");
        });
    });

    describe("Model<T> write behavior", () => {
        it("should update source state when writing to model.value", () => {
            const TestComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "initial" });
            const vnode = jsx(TestComponent, {
                model: [state, "value"]
            }) as VNode;

            // Get the Model<T> object
            const model = vnode.props.$models.model;
            expect(model.value).toBe("initial");

            // Write via model.value (this calls the update handler)
            model.value = "updated";
            expect(state.value).toBe("updated");
        });

        it("should forward Model<T> objects to child components", () => {
            const ParentComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const ChildComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "test" });
            
            // Create parent with model
            const parentVnode = jsx(ParentComponent, {
                model: [state, "value"]
            }) as VNode;
            
            const parentModel = parentVnode.props.$models.model;

            // Forward the Model<T> to child
            const childVnode = jsx(ChildComponent, {
                model: parentModel
            }) as VNode;

            // Child should receive a working Model<T>
            expect(isModel(childVnode.props.$models.model)).toBe(true);
            expect(childVnode.props.$models.model.value).toBe("test");

            // Writing via child's model should update the original state
            childVnode.props.$models.model.value = "from child";
            expect(state.value).toBe("from child");
        });
    });

    describe("Model binding with computed values", () => {
        it("should bind to writable computed via function form", () => {
            const TestComponent = component<Define.Model<number>>(({ props }) => {
                return () => null;
            });

            const state = signal({ count: 5 });
            const doubled = computed({
                get: () => state.count * 2,
                set: (val: number) => { state.count = val / 2; }
            });

            // Use function form to bind to computed.value
            const vnode = jsx(TestComponent, {
                model: () => doubled.value
            }) as VNode;

            // Should read the computed value
            expect(vnode.props.$models.model.value).toBe(10);

            // Writing should trigger the computed setter
            vnode.props.$models.model.value = 20;
            expect(state.count).toBe(10); // 20 / 2
            expect(doubled.value).toBe(20);
        });

        it("should bind to writable computed via tuple form", () => {
            const TestComponent = component<Define.Model<number>>(({ props }) => {
                return () => null;
            });

            const state = signal({ count: 3 });
            const tripled = computed({
                get: () => state.count * 3,
                set: (val: number) => { state.count = val / 3; }
            });

            // Use tuple form to bind to computed.value
            const vnode = jsx(TestComponent, {
                model: [tripled, "value"]
            }) as VNode;

            // Should read the computed value
            expect(vnode.props.$models.model.value).toBe(9);

            // Writing should trigger the computed setter
            vnode.props.$models.model.value = 15;
            expect(state.count).toBe(5); // 15 / 3
        });

        it("should read from read-only computed and throw on write", () => {
            const TestComponent = component<Define.Model<number>>(({ props }) => {
                return () => null;
            });

            const state = signal({ count: 7 });
            const doubled = computed(() => state.count * 2);

            const vnode = jsx(TestComponent, {
                model: () => doubled.value
            }) as VNode;

            // Should read the computed value
            expect(vnode.props.$models.model.value).toBe(14);

            // Writing to read-only computed throws an error
            expect(() => {
                vnode.props.$models.model.value = 100;
            }).toThrow();
            
            // State should be unchanged
            expect(state.count).toBe(7);
            expect(doubled.value).toBe(14);
        });

        it("should reactively update when computed dependencies change", () => {
            const TestComponent = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ firstName: "John", lastName: "Doe" });
            const fullName = computed({
                get: () => `${state.firstName} ${state.lastName}`,
                set: (val: string) => {
                    const [first, last] = val.split(" ");
                    state.firstName = first;
                    state.lastName = last || "";
                }
            });

            const vnode = jsx(TestComponent, {
                model: () => fullName.value
            }) as VNode;

            expect(vnode.props.$models.model.value).toBe("John Doe");

            // Change via model
            vnode.props.$models.model.value = "Jane Smith";
            expect(state.firstName).toBe("Jane");
            expect(state.lastName).toBe("Smith");
            expect(fullName.value).toBe("Jane Smith");

            // Change underlying state
            state.firstName = "Bob";
            expect(vnode.props.$models.model.value).toBe("Bob Smith");
        });

        it("should work with named models and computed", () => {
            const TestComponent = component<Define.Model<"amount", number>>(({ props }) => {
                return () => null;
            });

            const state = signal({ price: 100 });
            const withTax = computed({
                get: () => state.price * 1.2,
                set: (val: number) => { state.price = val / 1.2; }
            });

            const vnode = jsx(TestComponent, {
                "model:amount": () => withTax.value
            }) as VNode;

            expect(vnode.props.$models.amount.value).toBe(120);
            
            vnode.props.$models.amount.value = 240;
            expect(state.price).toBe(200);
        });
    });

    describe("JSX call-site type checking", () => {
        // These tests verify that TypeScript accepts all valid model syntaxes at JSX call sites.
        // Running `tsc --noEmit` on tests would have caught the getter syntax type regression.

        it("should accept getter function syntax for default model", () => {
            const Input = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ username: "" });

            // Getter function syntax - this is what broke in the type regression
            const vnode = <Input model={() => state.username} />;
            expect(vnode).toBeDefined();
        });

        it("should accept getter function syntax for named model", () => {
            const Input = component<Define.Model<"title", string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ title: "Hello" });

            // Named model with getter syntax
            const vnode = <Input model:title={() => state.title} />;
            expect(vnode).toBeDefined();
        });

        it("should accept tuple syntax for default model", () => {
            const Input = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const state = signal({ value: "" });

            // Tuple syntax
            const vnode = <Input model={[state, "value"]} />;
            expect(vnode).toBeDefined();
        });

        it("should accept Model<T> forwarding for default model", () => {
            const Child = component<Define.Model<string>>(({ props }) => {
                return () => null;
            });

            const Parent = component<Define.Model<string>>(({ props }) => {
                // Forward model to child - should accept Model<T> object
                return () => <Child model={props.model} />;
            });

            expect(Parent).toBeDefined();
        });

        it("should accept number type for string|number model", () => {
            // Like daisyui Input which uses Define.Model<string | number>
            const Input = component<Define.Model<string | number>>(({ props }) => {
                return () => null;
            });

            const state = signal({ count: 42 });

            // Number getter should work
            const vnode = <Input model={() => state.count} />;
            expect(vnode).toBeDefined();
        });
    });
});
