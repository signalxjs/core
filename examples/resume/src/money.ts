import { defineTypeHandler } from '@sigx/serialize';
import { registerWireTypeHandlers } from '@sigx/server/plugin';

/**
 * A custom wire type (#411, #595): the runnable reference for
 * `serverPlugin({ types })`. Without a handler a class instance crosses the
 * wire as a plain object and loses its prototype; with one it arrives as a
 * live `Money` on whichever side decodes it.
 */
export class Money {
    constructor(readonly cents: number) {}

    toString(): string {
        return `$${(this.cents / 100).toFixed(2)}`;
    }
}

export const moneyType = defineTypeHandler({
    name: 'money',
    tag: '$money',
    test: (v): v is Money => v instanceof Money,
    serialize: (m) => m.cents,
    revive: (cents) => new Money(cents)
});

/** Every custom type this app registers — ONE array for every boundary. */
export const appTypes = [moneyType];

// Where the app has an App, `serverPlugin({ types: appTypes })` registers
// the list for both vocabularies (entry-server.tsx). This example also has
// two app-LESS faces that must decode a Money before any app exists: the
// server-fn endpoint (a `getCatalog` GET can be the process's first
// request) and the zero-JS page, whose resumed Catalog handler calls the
// stub. Both import this module, so registering the wire half here covers
// them — the README's app-less route. Tag-keyed, so it is idempotent with
// serverPlugin's own registration.
registerWireTypeHandlers(appTypes);
