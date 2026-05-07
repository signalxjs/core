import { guid as guidFn } from "../utils/index.js";

export type guid = string;
export const guid = guidFn;

export enum InstanceLifetimes {
    Transient = 0,
    Scoped = 1,
    Singleton = 2
}

export interface Subscription {
    unsubscribe(): void;
}

export interface Topic<T> {
    publish(data: T): void;
    subscribe(handler: (data: T) => void): Subscription;
    destroy(): void;
}
