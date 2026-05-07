import { component } from 'sigx';
import { useRouter, type Route } from '../router';

export const Home = component(() => {
    const router = useRouter();

    function onLink(e: MouseEvent, path: Route): void {
        e.preventDefault();
        router.navigate(path);
    }

    return () => (
        <>
            <h1>Server-rendered SignalX</h1>
            <p>This page was rendered to HTML on the server, then hydrated on the client. View source — the markup is already there.</p>
            <div class="card">
                <p>Each route is rendered server-side. Try loading any of them directly:</p>
                <ul>
                    <li><a href="/" onClick={(e) => onLink(e as MouseEvent, '/')}>/</a> — this page</li>
                    <li><a href="/counter" onClick={(e) => onLink(e as MouseEvent, '/counter')}>/counter</a> — proves hydration is real (the button works)</li>
                    <li><a href="/forms" onClick={(e) => onLink(e as MouseEvent, '/forms')}>/forms</a> — model bindings, props/events, custom Define.Model</li>
                    <li><a href="/about" onClick={(e) => onLink(e as MouseEvent, '/about')}>/about</a> — what this example demonstrates</li>
                </ul>
                <p style="color: #555; font-size: 0.95em;">Reload any page or <code>curl</code> it — the response contains the rendered markup directly.</p>
            </div>
        </>
    );
});
