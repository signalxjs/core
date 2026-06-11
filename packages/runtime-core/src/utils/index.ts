/** Check whether a value is thenable (Promise-like). */
export function isPromise(value: any): boolean {
    return !!value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

/** @deprecated Use the {@link isPromise} function export instead. Kept until dependents (e.g. @sigx/store) migrate. */
export class Utils {
    static isPromise(value: any): boolean {
        return isPromise(value);
    }
}

export function guid(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
