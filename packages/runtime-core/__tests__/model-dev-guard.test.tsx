import { describe, it, expect, vi } from "vitest";
import { jsx } from "../src/jsx-runtime";
import { signal, computed } from "@sigx/reactivity";

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

    it("does not warn when both the property and getter result are NaN", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = signal({ amount: NaN });

        // NaN !== NaN would be a false positive; Object.is(NaN, NaN) is true.
        jsx("input", { model: () => state.amount });

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
