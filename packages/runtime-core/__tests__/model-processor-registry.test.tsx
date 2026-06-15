import { describe, it, expect, vi, afterEach } from "vitest";
import {
    jsx,
    VNode,
    registerModelProcessor,
    setPlatformModelProcessor,
    getPlatformModelProcessor,
} from "../src/jsx-runtime";
import { signal, computed } from "@sigx/reactivity";

describe("registerModelProcessor (custom element registry)", () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
        cleanups.forEach((c) => c());
        cleanups.length = 0;
    });

    it("runs a registered processor for intrinsic elements", () => {
        const seen: string[] = [];
        cleanups.push(
            registerModelProcessor((type, props) => {
                seen.push(type);
                if (type !== "my-toggle") return false;
                props.handledByUser = true;
                return true;
            })
        );

        const state = signal({ on: true });
        const vnode = jsx("my-toggle", { model: [state, "on"] }) as VNode;

        expect(seen).toContain("my-toggle");
        expect(vnode.props.handledByUser).toBe(true);
        // handled → generic fallback (modelValue) is not applied
        expect(vnode.props.modelValue).toBeUndefined();
    });

    it("first processor returning true wins (registration order)", () => {
        const calls: string[] = [];
        cleanups.push(
            registerModelProcessor((_type, props) => {
                calls.push("a");
                props.by = "a";
                return true;
            })
        );
        cleanups.push(
            registerModelProcessor((_type, props) => {
                calls.push("b");
                props.by = "b";
                return true;
            })
        );

        const state = signal({ x: 1 });
        const vnode = jsx("input", { model: [state, "x"] }) as VNode;

        expect(calls).toEqual(["a"]); // b never runs
        expect(vnode.props.by).toBe("a");
    });

    it("falls through to the next processor when one returns false", () => {
        const calls: string[] = [];
        cleanups.push(
            registerModelProcessor((_type) => {
                calls.push("a");
                return false;
            })
        );
        cleanups.push(
            registerModelProcessor((_type, props) => {
                calls.push("b");
                props.by = "b";
                return true;
            })
        );

        const state = signal({ x: 1 });
        const vnode = jsx("input", { model: [state, "x"] }) as VNode;

        expect(calls).toEqual(["a", "b"]);
        expect(vnode.props.by).toBe("b");
    });

    it("falls through to the platform processor when no user processor handles it", () => {
        const platformCalls: string[] = [];
        const prev = getPlatformModelProcessor();
        setPlatformModelProcessor((type, props) => {
            platformCalls.push(type);
            props.platform = true;
            return true;
        });
        cleanups.push(() => setPlatformModelProcessor(prev as any));
        cleanups.push(registerModelProcessor(() => false));

        const state = signal({ x: 1 });
        const vnode = jsx("input", { model: [state, "x"] }) as VNode;

        expect(platformCalls).toEqual(["input"]);
        expect(vnode.props.platform).toBe(true);
    });

    it("unregister removes the processor", () => {
        const calls: string[] = [];
        const off = registerModelProcessor((type, props) => {
            calls.push(type);
            props.by = "a";
            return true;
        });
        off();

        const state = signal({ x: 1 });
        const vnode = jsx("input", { model: [state, "x"] }) as VNode;

        expect(calls).toEqual([]);
        // no processor handled → generic fallback applies, custom prop absent
        expect(vnode.props.by).toBeUndefined();
        expect(vnode.props.modelValue).toBe(1);
    });
});

describe("model binding dev guard", () => {
    it("warns when the model getter is a transformed expression", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = signal({ count: 5 });

        jsx("input", { model: () => state.count * 2 });

        expect(warn).toHaveBeenCalled();
        expect(String(warn.mock.calls[0][0])).toContain("model");
        warn.mockRestore();
    });

    it("does not warn for a direct property getter", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = signal({ name: "a" });

        jsx("input", { model: () => state.name });

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("does not warn for nested property paths", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = signal({ form: { name: "a" } });

        jsx("input", { model: () => state.form.name });

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    it("does not warn for a writable computed", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = signal({ count: 5 });
        const doubled = computed({
            get: () => state.count * 2,
            set: (v: number) => {
                state.count = v / 2;
            },
        });

        jsx("input", { model: () => doubled.value });

        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });
});
