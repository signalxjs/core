import { describe, it, expect, expectTypeOf, vi, afterEach } from 'vitest';
import { createTopic, toSubscriber, createTopicGroup } from '../src/messaging';
import { listTopics, onTopicCreated } from '../src/messaging/registry';
import type { Topic } from '../src/models';

// The registry is realm-global: destroy any topics a test left registered so
// suites stay independent.
afterEach(() => {
    listTopics().forEach(topic => topic.destroy());
});

describe('createTopic', () => {
    it('returns an object with publish, subscribe, and destroy', () => {
        const topic = createTopic<string>();
        expect(topic).toHaveProperty('publish');
        expect(topic).toHaveProperty('subscribe');
        expect(topic).toHaveProperty('destroy');
        expect(typeof topic.publish).toBe('function');
        expect(typeof topic.subscribe).toBe('function');
        expect(typeof topic.destroy).toBe('function');
    });

    it('accepts optional namespace and name options', () => {
        const topic1 = createTopic<number>({ namespace: 'app', name: 'counter' });
        const topic2 = createTopic<number>({ namespace: 'app' });
        const topic3 = createTopic<number>({ name: 'counter' });
        const topic4 = createTopic<number>({});

        // All should work identically regardless of options
        for (const topic of [topic1, topic2, topic3, topic4]) {
            const handler = vi.fn();
            topic.subscribe(handler);
            topic.publish(42);
            expect(handler).toHaveBeenCalledWith(42);
        }
    });

    it('publish delivers data to a subscriber', () => {
        const topic = createTopic<string>();
        const handler = vi.fn();
        topic.subscribe(handler);

        topic.publish('hello');

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith('hello');
    });

    it('multiple subscribers receive the same message', () => {
        const topic = createTopic<number>();
        const handler1 = vi.fn();
        const handler2 = vi.fn();
        const handler3 = vi.fn();

        topic.subscribe(handler1);
        topic.subscribe(handler2);
        topic.subscribe(handler3);

        topic.publish(99);

        expect(handler1).toHaveBeenCalledWith(99);
        expect(handler2).toHaveBeenCalledWith(99);
        expect(handler3).toHaveBeenCalledWith(99);
    });

    it('unsubscribe removes a specific subscriber', () => {
        const topic = createTopic<string>();
        const handler1 = vi.fn();
        const handler2 = vi.fn();

        const sub1 = topic.subscribe(handler1);
        topic.subscribe(handler2);

        sub1.unsubscribe();
        topic.publish('after-unsub');

        expect(handler1).not.toHaveBeenCalled();
        expect(handler2).toHaveBeenCalledWith('after-unsub');
    });

    it('unsubscribe is idempotent (calling twice does not error)', () => {
        const topic = createTopic<string>();
        const handler = vi.fn();
        const sub = topic.subscribe(handler);

        sub.unsubscribe();
        expect(() => sub.unsubscribe()).not.toThrow();

        topic.publish('test');
        expect(handler).not.toHaveBeenCalled();
    });

    it('publish after unsubscribe does not call removed handler', () => {
        const topic = createTopic<number>();
        const handler = vi.fn();
        const sub = topic.subscribe(handler);

        topic.publish(1);
        expect(handler).toHaveBeenCalledTimes(1);

        sub.unsubscribe();

        topic.publish(2);
        topic.publish(3);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(1);
    });

    it('destroy removes all subscribers', () => {
        const topic = createTopic<string>();
        const handler1 = vi.fn();
        const handler2 = vi.fn();

        topic.subscribe(handler1);
        topic.subscribe(handler2);

        topic.publish('before');
        expect(handler1).toHaveBeenCalledTimes(1);
        expect(handler2).toHaveBeenCalledTimes(1);

        topic.destroy();

        topic.publish('after');
        expect(handler1).toHaveBeenCalledTimes(1);
        expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('publish after destroy does nothing', () => {
        const topic = createTopic<string>();
        const handler = vi.fn();
        topic.subscribe(handler);

        topic.destroy();

        topic.publish('msg1');
        topic.publish('msg2');
        expect(handler).not.toHaveBeenCalled();
    });

    it('typed messages preserve type through pub/sub', () => {
        interface Message {
            id: number;
            text: string;
        }

        const topic = createTopic<Message>();
        const received: Message[] = [];

        topic.subscribe((msg) => {
            received.push(msg);
        });

        const sent: Message = { id: 1, text: 'typed' };
        topic.publish(sent);

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual(sent);
        expect(received[0].id).toBe(1);
        expect(received[0].text).toBe('typed');
    });
});

describe('toSubscriber', () => {
    it('returns a subscribe-only interface without publish or destroy', () => {
        const topic = createTopic<string>();
        const subscriber = toSubscriber(topic);

        expect(subscriber).toHaveProperty('subscribe');
        expect(typeof subscriber.subscribe).toBe('function');
        expect(subscriber).not.toHaveProperty('publish');
        expect(subscriber).not.toHaveProperty('destroy');
    });

    it('subscribe works and delivers messages from the underlying topic', () => {
        const topic = createTopic<number>();
        const subscriber = toSubscriber(topic);
        const handler = vi.fn();

        subscriber.subscribe(handler);
        topic.publish(42);

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith(42);
    });
});

describe('subscriber error isolation', () => {
    it('a throwing subscriber does not skip later subscribers or break publish', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const topic = createTopic<string>();
        const second = vi.fn();

        topic.subscribe(() => {
            throw new Error('bad observer');
        });
        topic.subscribe(second);

        expect(() => topic.publish('msg')).not.toThrow();
        expect(second).toHaveBeenCalledWith('msg');
        expect(errorSpy).toHaveBeenCalled();

        errorSpy.mockRestore();
    });

    it('a handler unsubscribing during publish does not skip siblings', () => {
        const topic = createTopic<number>();
        const second = vi.fn();

        const sub = topic.subscribe(() => sub.unsubscribe());
        topic.subscribe(second);

        topic.publish(1);
        expect(second).toHaveBeenCalledWith(1);
    });
});

describe('lifecycle', () => {
    it('subscribe after destroy throws', () => {
        const topic = createTopic<string>({ namespace: 'test.lifecycle', name: 'sub-after-destroy' });
        topic.destroy();

        expect(() => topic.subscribe(() => {})).toThrow(/destroyed topic/);
    });

    it('destroy is idempotent', () => {
        const topic = createTopic<string>();
        topic.destroy();
        expect(() => topic.destroy()).not.toThrow();
        expect(topic.disposed).toBe(true);
    });

    it('exposes subscriberCount and hasSubscribers', () => {
        const topic = createTopic<number>();
        expect(topic.subscriberCount).toBe(0);
        expect(topic.hasSubscribers).toBe(false);

        const sub1 = topic.subscribe(() => {});
        const sub2 = topic.subscribe(() => {});
        expect(topic.subscriberCount).toBe(2);
        expect(topic.hasSubscribers).toBe(true);

        sub1.unsubscribe();
        sub2.unsubscribe();
        expect(topic.subscriberCount).toBe(0);
        expect(topic.hasSubscribers).toBe(false);
    });

    it('exposes namespace and name as readonly metadata', () => {
        const topic = createTopic<number>({ namespace: 'app', name: 'counter' });
        expect(topic.namespace).toBe('app');
        expect(topic.name).toBe('counter');
    });
});

describe('onActivate / onDeactivate (refCount hooks)', () => {
    it('fires onActivate on 0 -> 1 and onDeactivate on last unsubscribe', () => {
        const onActivate = vi.fn();
        const onDeactivate = vi.fn();
        const topic = createTopic<number>({ onActivate, onDeactivate });

        const sub1 = topic.subscribe(() => {});
        expect(onActivate).toHaveBeenCalledTimes(1);

        const sub2 = topic.subscribe(() => {});
        expect(onActivate).toHaveBeenCalledTimes(1);

        sub1.unsubscribe();
        expect(onDeactivate).not.toHaveBeenCalled();

        sub2.unsubscribe();
        expect(onDeactivate).toHaveBeenCalledTimes(1);
    });

    it('re-subscribing after deactivation fires onActivate again', () => {
        const onActivate = vi.fn();
        const onDeactivate = vi.fn();
        const topic = createTopic<number>({ onActivate, onDeactivate });

        topic.subscribe(() => {}).unsubscribe();
        topic.subscribe(() => {});

        expect(onActivate).toHaveBeenCalledTimes(2);
        expect(onDeactivate).toHaveBeenCalledTimes(1);
    });

    it('destroy while active fires onDeactivate', () => {
        const onDeactivate = vi.fn();
        const topic = createTopic<number>({ onDeactivate });

        topic.subscribe(() => {});
        topic.destroy();

        expect(onDeactivate).toHaveBeenCalledTimes(1);
    });

    it('a throwing onActivate is isolated and the subscription still works', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const topic = createTopic<number>({
            onActivate: () => {
                throw new Error('bad hook');
            }
        });

        const received = vi.fn();
        const sub = topic.subscribe(received);

        expect(errorSpy).toHaveBeenCalled();
        topic.publish(1);
        expect(received).toHaveBeenCalledWith(1);
        expect(topic.subscriberCount).toBe(1);

        sub.unsubscribe();
        errorSpy.mockRestore();
    });

    it('a throwing onDeactivate does not block destroy/unregister', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const topic = createTopic<number>({
            namespace: 'ns.hooks',
            name: 'x',
            onDeactivate: () => {
                throw new Error('bad hook');
            }
        });

        topic.subscribe(() => {});
        expect(() => topic.destroy()).not.toThrow();
        expect(topic.disposed).toBe(true);
        expect(listTopics('ns.hooks.*')).toHaveLength(0);

        errorSpy.mockRestore();
    });

    it('unsubscribe is idempotent with respect to refCount', () => {
        const onDeactivate = vi.fn();
        const topic = createTopic<number>({ onDeactivate });

        const sub1 = topic.subscribe(() => {});
        const sub2 = topic.subscribe(() => {});

        sub1.unsubscribe();
        sub1.unsubscribe(); // double-unsubscribe must not decrement twice
        expect(onDeactivate).not.toHaveBeenCalled();

        sub2.unsubscribe();
        expect(onDeactivate).toHaveBeenCalledTimes(1);
    });
});

describe('createTopicGroup', () => {
    it('creates typed topics lazily per key', () => {
        const group = createTopicGroup<{ loggedIn: { id: number }; loggedOut: void }>({ namespace: 'auth.events' });

        const received: { id: number }[] = [];
        group.topics.loggedIn.subscribe(user => received.push(user));
        group.topics.loggedIn.publish({ id: 7 });

        expect(received).toEqual([{ id: 7 }]);
        expect(group.topics.loggedIn.namespace).toBe('auth.events');
        expect(group.topics.loggedIn.name).toBe('loggedIn');

        expectTypeOf(group.topics.loggedIn).toEqualTypeOf<Topic<{ id: number }>>();
        expectTypeOf(group.topics.loggedOut).toEqualTypeOf<Topic<void>>();
    });

    it('returns the same topic for repeated key access', () => {
        const group = createTopicGroup<{ a: number }>();
        expect(group.topics.a).toBe(group.topics.a);
    });

    it('destroy() destroys all created topics', () => {
        const group = createTopicGroup<{ a: number; b: string }>({ namespace: 'grp' });
        const a = group.topics.a;
        const b = group.topics.b;

        group.destroy();

        expect(a.disposed).toBe(true);
        expect(b.disposed).toBe(true);
        expect(() => group.topics.a).toThrow(/destroyed topic group/);
    });

    it('does not create topics for prototype/protocol keys', () => {
        const group = createTopicGroup<{ a: number }>({ namespace: 'grp.proto' });

        // stringification, JSON serialization, and thenable checks must not
        // silently create/register topics
        void `${group.topics}`;
        void JSON.stringify(group.topics);
        void (group.topics as { then?: unknown }).then;

        expect(listTopics('grp.proto.*')).toHaveLength(0);
    });
});

describe('production error reporting', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('reports hook and subscriber errors as the bare error, without dev labels', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const boom = new Error('boom');

        const topic = createTopic<number>({
            onActivate: () => {
                throw boom;
            },
            onDeactivate: () => {
                throw boom;
            }
        });
        topic.subscribe(() => {
            throw boom;
        });          // first subscriber → activate → onActivate throws
        topic.publish(1);    // subscriber throws
        topic.destroy();     // last subscriber gone → deactivate throws

        expect(errorSpy).toHaveBeenCalledTimes(3);
        for (const call of errorSpy.mock.calls) {
            expect(call).toEqual([boom]);
        }

        errorSpy.mockRestore();
    });

    it('reports onTopicCreated handler errors with a label in dev', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const boom = new Error('boom');

        const sub = onTopicCreated(() => {
            throw boom;
        });
        const topic = createTopic<number>({ namespace: 'ns.dev', name: 'x' });

        expect(errorSpy).toHaveBeenCalledWith('[sigx] Error in onTopicCreated handler:', boom);

        sub.unsubscribe();
        topic.destroy();
        errorSpy.mockRestore();
    });

    it('reports onTopicCreated handler errors as the bare error', () => {
        vi.stubEnv('NODE_ENV', 'production');
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const boom = new Error('boom');

        const sub = onTopicCreated(() => {
            throw boom;
        });
        const topic = createTopic<number>({ namespace: 'ns.prod', name: 'x' });

        expect(errorSpy).toHaveBeenCalledWith(boom);

        sub.unsubscribe();
        topic.destroy();
        errorSpy.mockRestore();
    });
});
