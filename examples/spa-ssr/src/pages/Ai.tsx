import { component, useStream } from 'sigx';
import { useHead } from '@sigx/server-renderer/client';

const ANSWER =
    'SignalX streams this answer over the same HTTP response as the page itself. ' +
    'The component calls useStream() with an async iterable — on the server each ' +
    'token is appended into the page as it arrives (as a text node, never parsed ' +
    'as HTML), and when the stream completes the final markup swaps in and the ' +
    'text is serialized for hydration. Swap the fake generator below for a real ' +
    'LLM SDK call and you have a server-streamed AI page with zero extra wiring.';

/** Fake LLM token source — replace with a real model client. */
async function* fakeLlmTokens(): AsyncGenerator<string> {
    for (const word of ANSWER.split(/(?<= )/)) {
        await new Promise(r => setTimeout(r, 35));
        yield word;
    }
}

export const Ai = component(() => {
    useHead({ title: 'AI streaming' });

    // Server, streaming: tokens append into the page progressively.
    // Server, bot mode: drained fully, complete text inline.
    // Client, hydration: final text restored from state — the "LLM" is not
    // called again. Client navigation: streams live in the browser.
    const answer = useStream('answer', () => fakeLlmTokens());

    return () => (
        <>
            <h1>AI token streaming</h1>
            <p>Reload this page and watch the answer arrive word by word — that is the <em>server</em> streaming tokens into the initial HTML response via <code>useStream()</code>, not client-side JavaScript.</p>
            <div class="card">
                <h3 style="margin-top: 0;">Q: How does sigx serve AI-generated content?</h3>
                <p>{answer.value}</p>
            </div>
            <p style="color: #555; font-size: 0.95em;">Try <code>curl -H "User-Agent: GPTBot" localhost:3000/ai</code> — agents get the complete answer inline, no scripts.</p>
        </>
    );
});
