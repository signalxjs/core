import { describe, it, expect, vi } from 'vitest';
import { createTopic, toSubscriber } from '../src/messaging';

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
