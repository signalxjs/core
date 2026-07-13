/**
 * ════════════════════════════════════════════════════════════════════════
 *  DESIGN MOCK — usage examples for `useData` / `useAction`
 *  (docs/rfc-async.md). Not wired into the app; open in an editor and
 *  hover the types. Every RFC contract that is type-sensitive is
 *  exercised here: the two useData forms (key is mandatory), tuple-key inference,
 *  `match` narrowing (idle arm, stale error param), all() object/tuple
 *  inference + `.errors`, and the settled RunResult.
 * ════════════════════════════════════════════════════════════════════════
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import { component, signal } from 'sigx';
import { useData, useAction, all, SupersededError } from './use-data';

/** Compile-time assertion helper — fails to typecheck on mismatch. */
function expectType<T>(_v: T): void {}

// ───────────────────────────────────────────────────────────────────────
// Domain types — hover values below: everything is inferred from the
// fetcher. No casts, no `!`.
// ───────────────────────────────────────────────────────────────────────

interface UserProfile {
    id: string;
    name: string;
    plan: 'free' | 'pro';
}

interface Post {
    id: string;
    title: string;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
}

// ───────────────────────────────────────────────────────────────────────
// 1. Keyed read + match — the everyday case. `u` in the ready arm is
//    UserProfile (narrowed); the stale param is UserProfile | null.
//    `loading` is true ONLY while state === 'pending' — the skeleton
//    never flashes over live content during a background refresh.
// ───────────────────────────────────────────────────────────────────────

export const ProfileCard = component(() => {
    const profile = useData('profile', (key, { signal }) =>
        getJson<UserProfile>(`/api/${key}`, signal)
    );

    expectType<UserProfile | null>(profile.value);
    expectType<boolean>(profile.loading);

    return () =>
        profile.match({
            pending: () => <p>Loading…</p>,
            error: (e, retry, stale) => (
                <div>
                    {/* stale keeps last-good content on a failed background refresh */}
                    {stale && <p class="stale">{stale.name}</p>}
                    <p class="error">{e.message}</p>
                    <button onClick={retry}>Retry</button>
                </div>
            ),
            ready: (u) => <p>{u.name} ({u.plan})</p>,
        });
});

// ───────────────────────────────────────────────────────────────────────
// 2. Reactive TUPLE key + conditional fetch + idle arm. The tuple is the
//    ONLY channel: every parameter the fetcher needs is in the key, so
//    key/fetcher desync is unrepresentable. Falsy getter result ⇒ 'idle'.
//    Hover the destructure: uid is string, page is number.
// ───────────────────────────────────────────────────────────────────────

export const PostList = component(() => {
    const userId = signal<string | null>(null);
    const page = signal(1);

    const posts = useData(
        () => userId.value && (['posts', userId.value, page.value] as const),
        ([, uid, pageNo], { signal }) => {
            expectType<string>(uid);
            expectType<number>(pageNo);
            return getJson<Post[]>(`/api/users/${uid}/posts?page=${pageNo}`, signal);
        }
    );

    return () =>
        posts.match({
            idle: () => <p>Select a user to see posts.</p>, // ≠ spinner — typed, first-class
            pending: () => <p>Loading posts…</p>,
            ready: (list) => (
                <ul>
                    {list.map((p) => (
                        <li>{p.title}</li>
                    ))}
                </ul>
            ),
        });
});

// ───────────────────────────────────────────────────────────────────────
// 3. Client-only read — rev 8: still keyed ({ server: false } opts out of
//    SSR: the server renders the pending arm; the client fetches after
//    hydration). There is NO bare-fetcher form — a lone function here is a
//    compile error, killing the silently-untracked trap.
// ───────────────────────────────────────────────────────────────────────

export const LocalClock = component(() => {
    const zone = useData(
        'timezone',
        (key, { signal }) => getJson<{ tz: string }>(`/api/${key}`, signal),
        { server: false }
    );
    return () => zone.match({ ready: (z) => <span>{z.tz}</span> });
});

// ───────────────────────────────────────────────────────────────────────
// 4. Write — zero-arg closure over reactive state (the natural sigx
//    form). `.run()` never rejects: the result is a settled RunResult.
//    disabled={save.loading} is the blessed double-submit guard —
//    in-flight actions are never aborted.
// ───────────────────────────────────────────────────────────────────────

export const ProfileForm = component(() => {
    const draft = signal({ name: '' });   // object signal: a proxy — mutate directly, no .value
    const user = useData('profile', (key, { signal }) =>
        getJson<UserProfile>(`/api/${key}`, signal)
    );

    const save = useAction((_, { signal }) =>
        getJson<UserProfile>(`/api/profile?name=${draft.name}`, signal)
    );

    const onSave = async () => {
        // Compile-time proof of the zero-arg contract: TypeScript permits
        // omitting a void-typed parameter, so In = void ⇒ run(). This line
        // IS the test — it fails to typecheck if the contract regresses.
        const r = await save.run();
        if (r.ok) {
            expectType<UserProfile>(r.value);
            void user.refresh(); // refresh() never rejects either
        } else if (!(r.error instanceof SupersededError)) {
            // superseded ≠ failed: it never writes .error, and callers can
            // tell it apart from a real failure here
            console.warn('save failed', r.error.message);
        }
    };

    return () => (
        <form>
            <input value={draft.name} onInput={(e: Event) => {
                draft.name = (e.target as HTMLInputElement).value;
            }} />
            <button type="button" disabled={save.loading} onClick={onSave}>Save</button>
            {save.error && <p class="error">{save.error.message}</p>}
        </form>
    );
});

// ───────────────────────────────────────────────────────────────────────
// 5. Write with a typed input — retry in the error arm re-runs the LAST
//    input (captured — the stale-draft nuance the RFC documents). The
//    options slot is where a pack attaches per-action policy: the open-
//    interface contract (§7) means the `cache` key below exists ONLY
//    because of the augmentation right here — remove the declare block and
//    the option becomes a compile error, exactly as a bare install should.
// ───────────────────────────────────────────────────────────────────────

declare module './use-data' {
    // what a cache pack's .d.ts would ship:
    interface ActionOptions {
        cache?: { invalidates?: readonly string[] };
    }
}

export const DeleteButton = component(() => {
    const remove = useAction(
        (postId: string, { signal }) => getJson<void>(`/api/posts/${postId}?delete`, signal),
        { cache: { invalidates: ['posts'] } }   // typed by the augmentation above
    );

    return () => (
        <div>
            <button disabled={remove.loading} onClick={() => remove.run('post-1')}>Delete</button>
            {remove.match({
                error: (e, retry) => <button onClick={retry}>Delete failed — retry</button>,
                // reset() (rev 8): back to idle — the blessed way to dismiss
                // a success state and make the action reusable.
                ready: () => <button onClick={() => remove.reset()}>Deleted — dismiss</button>,
                pending: () => <span>Deleting…</span>,
            })}
        </div>
    );
});

// ───────────────────────────────────────────────────────────────────────
// 6. all() — object form (named destructure) and tuple form. `.errors`
//    mirrors the input shape. all() is for all-or-nothing gating only.
// ───────────────────────────────────────────────────────────────────────

export const Dashboard = component(() => {
    const user = useData('user', (k, { signal }) => getJson<UserProfile>(`/api/${k}`, signal));
    const posts = useData('posts', (k, { signal }) => getJson<Post[]>(`/api/${k}`, signal));

    const page = all({ user, posts });
    expectType<{ user: UserProfile; posts: Post[] } | null>(page.value);
    expectType<{ user: Error | null; posts: Error | null }>(page.errors);

    const pair = all(user, posts);
    expectType<[UserProfile, Post[]] | null>(pair.value);
    expectType<[Error | null, Error | null]>(pair.errors);

    return () =>
        page.match({
            pending: () => <p>Loading dashboard…</p>,
            error: (e, retry) => <button onClick={retry}>Failed — retry all</button>,
            ready: ({ user: u, posts: p }) => (
                <div>
                    <h1>{u.name}</h1>
                    <p>{p.length} posts</p>
                </div>
            ),
        });
});
