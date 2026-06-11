/**
 * ════════════════════════════════════════════════════════════════════════
 *  DESIGN MOCK — usage examples for `useAsync` (docs/rfc-use-async.md).
 *  Not wired into the app; open in an editor and hover the types.
 * ════════════════════════════════════════════════════════════════════════
 */

import { component, ErrorBoundary } from 'sigx';
import { useAsync } from './use-async';

// ───────────────────────────────────────────────────────────────────────
// Domain types — hover `profile.value` below: it's `UserProfile | null`,
// inferred from the fetcher. No casts, no signal naming.
// ───────────────────────────────────────────────────────────────────────

interface UserProfile {
    id: string;
    name: string;
    plan: 'free' | 'pro';
}

interface Article {
    slug: string;
    title: string;
    body: string;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json() as Promise<T>;
}

// ───────────────────────────────────────────────────────────────────────
// 1. The basics: fetch on the server, hydrate without refetching,
//    loading/error/refresh for free.
// ───────────────────────────────────────────────────────────────────────

export const ProfileCard = component(() => {
    const profile = useAsync('profile', ({ signal }) =>
        getJson<UserProfile>('/api/profile', signal));

    return () => {
        if (profile.loading) return <div class="card skeleton" />;
        if (profile.error) return (
            <div class="card error">
                {profile.error.message}
                <button onClick={() => profile.refresh()}>Retry</button>
            </div>
        );
        return (
            <div class="card">
                <h3>{profile.value!.name}</h3>
                <span class={`badge ${profile.value!.plan}`}>{profile.value!.plan}</span>
            </div>
        );
    };
});

// Compare with today's ssr.load version of the same component:
//
//   const profile = (ctx.signal as any)(null, 'profile');   // cast + manual key
//   ctx.ssr.load(async () => {                              // returns nothing
//       profile.value = await getJson('/api/profile');      // data flows by mutation
//   });                                                     // no error/loading/refresh
//   return () => profile.value ? <Card/> : <Skeleton/>;     // error case: page fallback

// ───────────────────────────────────────────────────────────────────────
// 2. Dynamic keys: the key identifies the DATA. Props captured at setup —
//    nothing reaches for getCurrentInstance() inside the async fetcher.
// ───────────────────────────────────────────────────────────────────────

export const ArticlePage = component<{ slug: string }>((ctx) => {
    const { slug } = ctx.props;

    const article = useAsync(`article:${slug}`, ({ signal }) =>
        getJson<Article>(`/api/articles/${slug}`, signal));

    return () => (
        <main>
            {article.loading && <p>Loading…</p>}
            {article.value && (
                <article>
                    <h1>{article.value.title}</h1>
                    <p>{article.value.body}</p>
                </article>
            )}
        </main>
    );
});

// ───────────────────────────────────────────────────────────────────────
// 3. Dedupe: same key in two components = ONE fetch per request, one
//    serialized entry, both restored on hydration.
// ───────────────────────────────────────────────────────────────────────

export const HeaderAvatar = component(() => {
    const profile = useAsync('profile', ({ signal }) =>
        getJson<UserProfile>('/api/profile', signal));
    return () => <img class="avatar" alt={profile.value?.name ?? ''} />;
});
// <ProfileCard/> + <HeaderAvatar/> on one page → /api/profile is hit once.

// ───────────────────────────────────────────────────────────────────────
// 4. Client-only async — browser-dependent work that
//    must NOT run on the server. Just omit the key: unkeyed = client-only.
//    (Keyed + { server: false } also works when you want client dedupe.)
// ───────────────────────────────────────────────────────────────────────

export const GeoGreeting = component(() => {
    // UNKEYED form = client-only by definition (today's useAsync, fixed):
    // SSR ships the loading branch; nothing runs on the server.
    const city = useAsync(
        async () => {
            const pos = await new Promise<GeolocationPosition>((ok, err) =>
                navigator.geolocation.getCurrentPosition(ok, err));
            return getJson<{ city: string }>(
                `/api/geocode?lat=${pos.coords.latitude}&lng=${pos.coords.longitude}`,
                new AbortController().signal);
        }
    );

    return () => <p>{city.value ? `Hello, ${city.value.city}!` : 'Locating…'}</p>;
});

// ───────────────────────────────────────────────────────────────────────
// 5. throwOnError: let an error boundary own the failure UI instead of
//    branching in every component.
// ───────────────────────────────────────────────────────────────────────

const BillingInner = component(() => {
    const invoices = useAsync(
        'invoices',
        ({ signal }) => getJson<Article[]>('/api/invoices', signal),
        { throwOnError: true }  // ← .error access throws → nearest boundary
    );

    return () => (
        <ul>{invoices.value?.map(i => <li>{i.title}</li>)}</ul>
    );
});

export const BillingSection = component(() => {
    return () => (
        <ErrorBoundary fallback={(_err: Error, retry: () => void) => (
            <div class="card error">
                Billing is unavailable. <button onClick={retry}>Retry</button>
            </div>
        )}>
            <BillingInner />
        </ErrorBoundary>
    );
});

// ───────────────────────────────────────────────────────────────────────
// 6. Refresh on user action — polling, "reload" buttons, mutations.
// ───────────────────────────────────────────────────────────────────────

export const Inbox = component(() => {
    const messages = useAsync('inbox', ({ signal }) =>
        getJson<Article[]>('/api/inbox', signal));

    async function markAllRead(): Promise<void> {
        await fetch('/api/inbox/read-all', { method: 'POST' });
        await messages.refresh();  // re-fetch after the mutation
    }

    return () => (
        <section>
            <header>
                Inbox ({messages.value?.length ?? '…'})
                <button onClick={() => messages.refresh()} disabled={messages.loading}>↻</button>
                <button onClick={markAllRead}>Mark all read</button>
            </header>
            <ul>{messages.value?.map(m => <li>{m.title}</li>)}</ul>
        </section>
    );
});
