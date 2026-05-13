import { component } from 'sigx';
import { route, type Route } from './router';
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
    return () => (
        <>
            <header>
                <img src="/signalx-logo-150x119.png" alt="SignalX" />
                <strong>SignalX SPA</strong>
                <nav>
                    {NAV.map(({ path, label }) => (
                        <a href={`#${path}`} class={route.path === path ? 'active' : ''}>{label}</a>
                    ))}
                </nav>
            </header>
            <main>
                {route.path === '/' && <Home />}
                {route.path === '/counter' && <Counter />}
                {route.path === '/forms' && <Forms />}
                {route.path === '/about' && <About />}
            </main>
        </>
    );
}, { name: 'App' });
