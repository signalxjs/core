import { component, useHead } from 'sigx';

import { useRouter, type Route } from './router';
import { Home } from './pages/Home';
import { Counter } from './pages/Counter';
import { Forms } from './pages/Forms';
import { Data } from './pages/Data';
import { Ai } from './pages/Ai';
import { About } from './pages/About';

const NAV: Array<{ path: Route; label: string }> = [
    { path: '/', label: 'Home' },
    { path: '/counter', label: 'Counter' },
    { path: '/forms', label: 'Forms' },
    { path: '/data', label: 'Data' },
    { path: '/ai', label: 'AI' },
    { path: '/about', label: 'About' }
];

export const App = component(() => {
    const router = useRouter();

    // App-level head defaults; pages override the title via their own
    // useHead (later configs win). The injected <title> replaces the static
    // one the template used to carry.
    useHead({
        title: 'SignalX SPA-SSR',
        titleTemplate: '%s · SignalX'
    });

    return () => (
        <>
            <header>
                <img src="/signalx-logo-150x119.png" alt="SignalX" />
                <strong>SignalX SPA-SSR</strong>
                <nav>
                    {NAV.map(({ path, label }) => (
                        <a
                            href={path}
                            onClick={(e) => { (e as MouseEvent).preventDefault(); router.navigate(path); }}
                            class={router.route.path === path ? 'active' : ''}
                        >{label}</a>
                    ))}
                </nav>
            </header>
            <main>
                {router.route.path === '/' && <Home />}
                {router.route.path === '/counter' && <Counter />}
                {router.route.path === '/forms' && <Forms />}
                {router.route.path === '/data' && <Data />}
                {router.route.path === '/ai' && <Ai />}
                {router.route.path === '/about' && <About />}
            </main>
        </>
    );
});
