import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTopic } from '../src/messaging';
import { getTopic, listTopics, subscribeTopics, onTopicCreated } from '../src/inspect';

// The registry is realm-global: destroy whatever a test registered.
afterEach(() => {
    listTopics().forEach(topic => topic.destroy());
});

describe('registry registration', () => {
    it('namespaced topics register; anonymous topics do not', () => {
        createTopic({ namespace: 'app.state', name: 'count' });
        createTopic(); // anonymous
        createTopic({ name: 'only-a-name' }); // no namespace -> not registered

        const registered = listTopics();
        expect(registered).toHaveLength(1);
        expect(registered[0].namespace).toBe('app.state');
    });

    it('destroy() unregisters', () => {
        const topic = createTopic({ namespace: 'app.state', name: 'count' });
        expect(listTopics()).toHaveLength(1);

        topic.destroy();
        expect(listTopics()).toHaveLength(0);
    });
});

describe('getTopic', () => {
    it('finds a live topic by exact namespace and name', () => {
        const topic = createTopic({ namespace: 'todos#1.actions', name: 'save.onDispatched' });

        expect(getTopic('todos#1.actions', 'save.onDispatched')).toBe(topic);
        expect(getTopic('todos#1.actions', 'missing')).toBeUndefined();
    });
});

describe('listTopics patterns', () => {
    it('matches * wildcards over namespace.name', () => {
        createTopic({ namespace: 'todos#1.state', name: 'todos' });
        createTopic({ namespace: 'todos#1.actions', name: 'save.onDispatched' });
        createTopic({ namespace: 'auth#1.state', name: 'user' });

        expect(listTopics('todos#1.*')).toHaveLength(2);
        expect(listTopics('*.state.*')).toHaveLength(2);
        expect(listTopics('*.actions.*')).toHaveLength(1);
        expect(listTopics('nomatch.*')).toHaveLength(0);
    });

    it('escapes regex metacharacters in patterns', () => {
        createTopic({ namespace: 'a+b', name: 'x' });
        expect(listTopics('a+b.x')).toHaveLength(1);
        expect(listTopics('aab.x')).toHaveLength(0);
    });
});

describe('onTopicCreated', () => {
    it('fires for topics registered after the handler attaches', () => {
        const seen: (string | undefined)[] = [];
        const sub = onTopicCreated(topic => seen.push(topic.name));

        createTopic({ namespace: 'ns', name: 'later' });
        expect(seen).toEqual(['later']);

        sub.unsubscribe();
        createTopic({ namespace: 'ns', name: 'after-unsub' });
        expect(seen).toEqual(['later']);
    });

    it('a throwing handler is isolated', () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        onTopicCreated(() => {
            throw new Error('bad tool');
        });

        expect(() => createTopic({ namespace: 'ns', name: 'x' })).not.toThrow();
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });
});

describe('subscribeTopics', () => {
    it('observes existing AND future matching topics with meta', () => {
        const existing = createTopic<number>({ namespace: 'todos#1.state', name: 'count' });

        const events: Array<{ data: unknown; namespace: string; name: string }> = [];
        const sub = subscribeTopics('todos#1.*', (data, meta) => events.push({ data, ...meta }));

        existing.publish(1);

        const future = createTopic<string>({ namespace: 'todos#1.actions', name: 'save' });
        future.publish('go');

        expect(events).toEqual([
            { data: 1, namespace: 'todos#1.state', name: 'count' },
            { data: 'go', namespace: 'todos#1.actions', name: 'save' },
        ]);

        sub.unsubscribe();
        existing.publish(2);
        future.publish('again');
        expect(events).toHaveLength(2);
    });

    it('ignores non-matching topics', () => {
        const handler = vi.fn();
        const sub = subscribeTopics('todos#1.*', handler);

        const other = createTopic<number>({ namespace: 'auth#1.state', name: 'user' });
        other.publish(1);

        expect(handler).not.toHaveBeenCalled();
        sub.unsubscribe();
    });

    it('wildcard subscription activates refCount producers', () => {
        const onActivate = vi.fn();
        createTopic({ namespace: 'todos#1.state', name: 'count', onActivate });

        const sub = subscribeTopics('todos#1.state.*', () => {});

        expect(onActivate).toHaveBeenCalledTimes(1);
        sub.unsubscribe();
    });

    it('drops its attachment when an observed topic is destroyed', () => {
        const topic = createTopic<number>({ namespace: 'todos#1.state', name: 'count' });
        const handler = vi.fn();
        const sub = subscribeTopics('todos#1.*', handler);

        topic.publish(1);
        expect(handler).toHaveBeenCalledTimes(1);

        topic.destroy();

        // a NEW topic with the same path is observed again — proving the
        // dead entry was dropped rather than blocking re-attachment
        const reborn = createTopic<number>({ namespace: 'todos#1.state', name: 'count' });
        reborn.publish(2);
        expect(handler).toHaveBeenCalledTimes(2);

        sub.unsubscribe();
    });

    it('unsubscribe is idempotent', () => {
        const sub = subscribeTopics('todos#1.*', () => {});
        sub.unsubscribe();
        expect(() => sub.unsubscribe()).not.toThrow();
    });
});
