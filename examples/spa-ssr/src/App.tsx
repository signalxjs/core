import { component } from 'sigx';
import { useRouter, type Route } from './router';
import { Home } from './pages/Home';
import { Counter } from './pages/Counter';
import { Forms } from './pages/Forms';
import { About } from './pages/About';

const NAV: Array<{ path: Route; label: string }> = [
    { path: '/', label: 'Home' },
    { path: '/counter', label: 'Counter' },
    { path: '/forms', label: 'Forms' },
    { path: '/about', label: 'About' }
];

export const App = component(() => {
    const router = useRouter();

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
                {router.route.path === '/about' && <About />}
            </main>
        </>
    );
});
